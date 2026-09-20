import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compareAndSetLifecycle } from "../src/client.ts";
import {
  compareAndSetTagValue,
  acquireLock,
  getSessionExitEvidence,
  readMetadata,
  writeMetadata,
  releaseLock,
  waitForProcessExit,
} from "../src/sessions.ts";
import { setServerModulePath, spawnDaemon } from "../src/spawn.ts";
import { PtyServer } from "../src/server.ts";
import { systemMonotonicClock } from "../src/startup-lease.ts";
import { terminateAndWait } from "./setup/processes.ts";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const serverModule = path.join(dirname, "..", "dist", "server.js");
const spawnModule = path.join(dirname, "..", "dist", "spawn.js");
setServerModulePath(serverModule);

const roots: string[] = [];
const daemonPids: number[] = [];
afterEach(async () => {
  await terminateAndWait(daemonPids.splice(0));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  delete process.env.PTY_ROOT;
});

const makeRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pty-startup-lease-"));
  roots.push(root);
  process.env.PTY_ROOT = root;
  return root;
};

// These integration cases exercise the real cross-process monotonic clock and
// daemon timer; fake timers cannot advance the detached daemon.
const waitFor = async <TValue>(read: () => TValue | undefined, timeoutMs = 5_000): Promise<TValue> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for startup lease state");
};

const waitForAsync = async <TValue>(
  read: () => Promise<TValue | undefined>,
  timeoutMs = 5_000,
): Promise<TValue> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for startup lease state");
};

const terminalLifecycle = (name: string): { _tag: string; generation: string; cause: string } | undefined => {
  const raw = readMetadata(name)?.tags?.["run.lifecycle"];
  if (!raw) return undefined;
  const value = JSON.parse(raw) as { _tag?: string; generation?: string; cause?: string };
  return value._tag === "terminal" && value.generation && value.cause
    ? { _tag: value._tag, generation: value.generation, cause: value.cause }
    : undefined;
};

describe("generation-fenced lifecycle CAS", () => {
  it("cannot let a stale generation overwrite its replacement", () => {
    makeRoot();
    writeMetadata("worker", {
      generation: "replacement",
      command: "/bin/sh",
      args: [],
      displayCommand: "sh",
      cwd: os.tmpdir(),
      createdAt: new Date().toISOString(),
      tags: { "run.lifecycle": "starting-new" },
    });
    expect(compareAndSetTagValue(
      "worker",
      "stale",
      "run.lifecycle",
      "starting-old",
      "ready-old",
    )).toEqual({ status: "generation-mismatch" });
    expect(readMetadata("worker")?.tags?.["run.lifecycle"]).toBe("starting-new");
  });

  it("returns the persisted teardown-unavailable value for an expired CAS", () => {
    makeRoot();
    const name = "expired-cas-containment";
    const generation = "generation";
    const starting = JSON.stringify({
      _tag: "starting",
      generation,
      bootId: "boot",
      deadlineMonotonicNs: "0",
    });
    const terminal = JSON.stringify({
      _tag: "terminal",
      generation,
      cause: "teardown-unavailable",
    });
    writeMetadata(name, {
      generation,
      command: "/bin/sh",
      args: [],
      displayCommand: "sh",
      cwd: os.tmpdir(),
      createdAt: new Date().toISOString(),
      tags: { "run.lifecycle": starting },
    });

    const harness = Object.create(PtyServer.prototype) as Record<string, unknown>;
    Object.assign(harness, {
      name,
      generation,
      exited: false,
      startupLease: {
        generation,
        lifecycleTag: "run.lifecycle",
        bootId: "boot",
        deadlineMonotonicNs: "0",
        startingValue: starting,
      },
      startupLeaseDisarmed: false,
      startupLeaseTerminalCause: null,
      startupLeaseDeadlineNotified: false,
      startupLeaseTerminalValue: null,
      startupLeaseTimer: null,
      options: {},
      settleStartupLeaseDeadline: () => {
        compareAndSetTagValue(
          name,
          generation,
          "run.lifecycle",
          starting,
          terminal,
        );
        return terminal;
      },
    });
    const compare = Reflect.get(
      PtyServer.prototype,
      "compareAndSetLifecycle",
    );
    if (typeof compare !== "function") throw new Error("lifecycle CAS unavailable");
    const result = Reflect.apply(compare, harness, [{
      expectedGeneration: generation,
      tag: "run.lifecycle",
      expectedValue: starting,
      value: JSON.stringify({ _tag: "ready", generation }),
    }]);
    expect(result).toEqual({ _tag: "DeadlineExpired", value: terminal });
    expect(readMetadata(name)?.tags?.["run.lifecycle"]).toBe(terminal);
  });

  it("shuts down after an expired CAS flushes even when persistence is delayed past the backstop", async () => {
    makeRoot();
    const name = "expired-cas-wire";
    const generation = "wire-generation";
    const shutdown: { current: Promise<void> | null } = { current: null };
    let server!: PtyServer;
    server = new PtyServer({
      name,
      generation,
      command: "/bin/sh",
      args: ["-c", "sleep 30"],
      displayCommand: "sleep 30",
      cwd: os.tmpdir(),
      rows: 24,
      cols: 80,
      startupLease: { timeoutMs: 30_000, lifecycleTag: "run.lifecycle" },
      onStartupLeaseDeadline: () => {
        shutdown.current = server.close({ terminateDescendants: true });
      },
    });
    await server.ready;
    const metadata = readMetadata(name)!;
    expect(acquireLock(name)).toBe(true);
    const lockReleased = new Promise<void>((resolve) => {
      setTimeout(() => {
        releaseLock(name);
        resolve();
      }, 2_200);
    });
    const starting = metadata.tags!["run.lifecycle"];
    const originalNow = systemMonotonicClock.nowNs;
    systemMonotonicClock.nowNs = () =>
      BigInt(JSON.parse(starting).deadlineMonotonicNs);
    try {
      const result = await compareAndSetLifecycle(name, {
        expectedGeneration: generation,
        tag: "run.lifecycle",
        expectedValue: starting,
        value: JSON.stringify({ _tag: "ready", generation }),
      });
      expect(result).toEqual({ _tag: "DeadlineExpired", value: starting });
      await lockReleased;
      await waitFor(() => shutdown.current === null ? undefined : true);
      expect(JSON.parse(readMetadata(name)!.tags!["run.lifecycle"])).toMatchObject({
        _tag: "terminal",
        generation,
        cause: "deadline",
      });
    } finally {
      systemMonotonicClock.nowNs = originalNow;
      releaseLock(name);
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (shutdown.current) await shutdown.current;
      else await server.close({ terminateDescendants: true });
    }
  }, 15_000);

  it("disarms only through the live current-generation CAS", async () => {
    makeRoot();
    const name = "lease-ready";
    await spawnDaemon({
      name,
      command: "/bin/sh",
      args: ["-c", "sleep 30"],
      displayCommand: "sleep 30",
      startupLease: { timeoutMs: 600, lifecycleTag: "run.lifecycle" },
    });
    const metadata = readMetadata(name)!;
    daemonPids.push(metadata.daemonPid!);
    const starting = metadata.tags!["run.lifecycle"];
    const ready = JSON.stringify({ _tag: "ready", generation: metadata.generation });
    await expect(compareAndSetLifecycle(name, {
      expectedGeneration: "stale",
      tag: "run.lifecycle",
      expectedValue: starting,
      value: ready,
    })).resolves.toEqual({ _tag: "GenerationMismatch" });
    await expect(compareAndSetLifecycle(name, {
      expectedGeneration: metadata.generation!,
      tag: "run.lifecycle",
      expectedValue: starting,
      value: ready,
    })).resolves.toEqual({ _tag: "Changed", value: ready });
    await waitFor(() =>
      process.hrtime.bigint() >= BigInt(JSON.parse(starting).deadlineMonotonicNs) + 100_000_000n
        ? true
        : undefined
    );
    expect(readMetadata(name)?.tags?.["run.lifecycle"]).toBe(ready);
    const terminalDown = JSON.stringify({
      _tag: "terminal",
      generation: metadata.generation,
      cause: "down",
    });
    await expect(compareAndSetLifecycle(name, {
      expectedGeneration: metadata.generation!,
      tag: "run.lifecycle",
      expectedValue: ready,
      value: terminalDown,
    })).resolves.toEqual({ _tag: "Changed", value: terminalDown });
    await terminateAndWait([metadata.daemonPid!]);
    expect(readMetadata(name)?.tags?.["run.lifecycle"]).toBe(terminalDown);
  }, 15_000);
});

  it("publishes prototype-named lifecycle tags and retains terminal CAS through natural exit", async () => {
    makeRoot();
    const name = "lease-prototype-tag";
    await spawnDaemon({
      name,
      command: "/bin/sh",
      args: ["-c", "sleep 0.5"],
      displayCommand: "short startup",
      startupLease: { timeoutMs: 5_000, lifecycleTag: "__proto__" },
    });
    const metadata = readMetadata(name)!;
    daemonPids.push(metadata.daemonPid!);
    expect(Object.hasOwn(metadata.tags!, "__proto__")).toBe(true);
    const starting = metadata.tags!["__proto__"];
    const terminal = JSON.stringify({
      _tag: "terminal",
      generation: metadata.generation,
      cause: "down",
    });
    await expect(compareAndSetLifecycle(name, {
      expectedGeneration: metadata.generation!,
      tag: "__proto__",
      expectedValue: starting,
      value: terminal,
    })).resolves.toEqual({ _tag: "Changed", value: terminal });
    expect(await waitForProcessExit(metadata.daemonPid!, 5_000)).toBe(true);
    expect(readMetadata(name)?.tags?.["__proto__"]).toBe(terminal);
  }, 15_000);

describe("daemon-owned startup deadline", () => {
  it("terminates the exact generation and retains terminal evidence", async () => {
    makeRoot();
    const name = "lease-deadline";
    await spawnDaemon({
      name,
      command: "/bin/sh",
      args: ["-c", "trap '' HUP TERM; sleep 30 & wait"],
      displayCommand: "stubborn startup",
      startupLease: { timeoutMs: 300, lifecycleTag: "run.lifecycle" },
    });
    const metadata = readMetadata(name)!;
    daemonPids.push(metadata.daemonPid!);
    const terminal = await waitFor(() => terminalLifecycle(name));
    expect(terminal).toEqual({
      _tag: "terminal",
      generation: metadata.generation,
      cause: "deadline",
    });
    const evidence = await waitForAsync(async () => {
      const result = await getSessionExitEvidence(name);
      return result._tag === "snapshot" ? result : undefined;
    });
    expect(evidence._tag).toBe("snapshot");
  }, 15_000);

  it("retains terminal exit lifecycle and evidence after natural child exit", async () => {
    makeRoot();
    const name = "lease-natural-exit";
    await spawnDaemon({
      name,
      command: "/bin/sh",
      args: ["-c", "sleep 0.4; exit 7"],
      displayCommand: "natural exit",
      startupLease: { timeoutMs: 5_000, lifecycleTag: "run.lifecycle" },
    });
    const metadata = readMetadata(name)!;
    daemonPids.push(metadata.daemonPid!);
    expect(await waitForProcessExit(metadata.daemonPid!, 5_000)).toBe(true);
    expect(terminalLifecycle(name)).toEqual({
      _tag: "terminal",
      generation: metadata.generation,
      cause: "exit",
    });
    await expect(getSessionExitEvidence(name)).resolves.toMatchObject({
      _tag: "snapshot",
      snapshot: {
        generation: metadata.generation,
        exitCode: 7,
      },
    });
  }, 15_000);

  it("survives the initiating caller and enforces the original deadline", async () => {
    const root = makeRoot();
    const name = "lease-caller-crash";
    const script = `
      import { setServerModulePath, spawnDaemon } from ${JSON.stringify(pathToFileURL(spawnModule).href)};
      setServerModulePath(${JSON.stringify(serverModule)});
      await spawnDaemon({
        name: ${JSON.stringify(name)},
        command: "/bin/sh",
        args: ["-c", "trap '' HUP TERM; sleep 30 & wait"],
        displayCommand: "caller crash fixture",
        startupLease: { timeoutMs: 700, lifecycleTag: "run.lifecycle" },
      });
    `;
    const caller = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, PTY_ROOT: root },
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(caller.status, caller.stderr).toBe(0);
    const metadata = readMetadata(name)!;
    daemonPids.push(metadata.daemonPid!);
    expect(terminalLifecycle(name)).toBeUndefined();
    expect(await waitFor(() => terminalLifecycle(name))).toEqual({
      _tag: "terminal",
      generation: metadata.generation,
      cause: "deadline",
    });
  }, 15_000);
});
