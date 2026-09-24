import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as nodePty from "node-pty";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { terminateAndWait } from "./setup/processes.ts";
import { stripAnsi } from "../src/tui/colors.ts";
import { shortPath } from "../src/session-presentation.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(__dirname, "..", "dist", "cli.js");
const nodeBin = process.execPath;
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pty-attach-no-restart-"));
const daemonPids = new Set<number>();

afterAll(async () => {
  await terminateAndWait(daemonPids);
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

function env(root: string): Record<string, string> {
  const result: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PTY_ROOT: root,
    PTY_ROOT_LEGACY_SILENT: "1",
  };
  delete result.PTY_SESSION;
  delete result.PTY_SERVER_CONFIG;
  return result;
}

function runCli(root: string, args: string[]) {
  return spawnSync(nodeBin, [cliPath, ...args], {
    env: env(root),
    encoding: "utf8",
    timeout: 15_000,
  });
}

function waitUntil(predicate: () => boolean, timeoutMs = 8_000): void {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

function readInvocationCount(marker: string): number {
  try {
    return fs.readFileSync(marker, "utf8").trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readEventCount(root: string, name: string, event: string): number {
  const eventsPath = path.join(root, `${name}.events.jsonl`);
  try {
    return fs.readFileSync(eventsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.type === event).length;
  } catch {
    return 0;
  }
}

function spawnRetainedOnce(root: string, name: string, marker: string): void {
  const command = `printf 'started\\n' >> ${JSON.stringify(marker)}; exit 42`;
  const result = runCli(root, [
    "run", "-d", "--id", name, "--tag", "keep=true",
    "--", "sh", "-c", command,
  ]);
  expect(result.status, result.stderr).toBe(0);
  const daemonPid = Number(fs.readFileSync(path.join(root, `${name}.pid`), "utf8").trim());
  daemonPids.add(daemonPid);
  waitUntil(() => {
    try {
      const metadata = JSON.parse(fs.readFileSync(path.join(root, `${name}.json`), "utf8"));
      return metadata.exitCode === 42 && typeof metadata.exitedAt === "string";
    } catch {
      return false;
    }
  });
  // Exit metadata is published before the daemon's deliberate 500ms grace
  // period ends. This fixture models a fully dead retained session.
  waitUntil(() => !processIsAlive(daemonPid));
  expect(readInvocationCount(marker)).toBe(1);
}

function runInTerminal(
  root: string,
  args: string[],
  delayedInput?: { text: string; delayMs: number },
): Promise<{ code: number; signal?: number; output: string }> {
  return new Promise((resolve, reject) => {
    let output = "";
    const proc = nodePty.spawn(nodeBin, [cliPath, ...args], {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      env: env(root),
    });
    const timeout = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
      reject(new Error(`terminal command timed out\n${output}`));
    }, 10_000);
    proc.onData((data) => { output += data; });
    proc.onExit(({ exitCode, signal }) => {
      clearTimeout(timeout);
      resolve({ code: exitCode, signal, output });
    });
    if (delayedInput) {
      setTimeout(() => {
        try { proc.write(delayedInput.text); } catch {}
      }, delayedInput.delayMs);
    }
  });
}

describe("pty attach --no-restart", () => {
  it("advertises the attach-only policy in focused help", () => {
    const root = fs.mkdtempSync(path.join(testRoot, "help-"));
    const result = runCli(root, ["attach", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--no-restart");
    expect(result.stdout).toMatch(/never prompt/);
  });

  it("rejects contradictory restart policies", () => {
    const root = fs.mkdtempSync(path.join(testRoot, "conflict-"));
    const result = runCli(root, ["attach", "--no-restart", "--auto-restart", "missing"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/mutually exclusive/);
  });

  it("returns nonzero without prompting for a missing session", () => {
    const root = fs.mkdtempSync(path.join(testRoot, "missing-"));
    const result = runCli(root, ["attach", "--no-restart", "missing"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Session "missing" not found.');
    expect(result.stdout).not.toContain("Restart?");
  });

  it("refuses an exited session before delayed relay input can restart it", async () => {
    const root = fs.mkdtempSync(path.join(testRoot, "exited-"));
    const marker = path.join(root, "invocations");
    const name = "exited-target";
    spawnRetainedOnce(root, name, marker);

    const result = await runInTerminal(
      root,
      ["attach", "--no-restart", name],
      { text: "future-relay-input\r", delayMs: 250 },
    );

    expect(result.code).not.toBe(0);
    expect(result.output).not.toContain("Restart?");
    expect(result.output).not.toContain("Command was:");
    expect(readInvocationCount(marker)).toBe(1);
    expect(readEventCount(root, name, "session_start")).toBe(1);
    const pidPath = path.join(root, `${name}.pid`);
    if (fs.existsSync(pidPath)) {
      const retainedPid = Number(fs.readFileSync(pidPath, "utf8").trim());
      expect(processIsAlive(retainedPid)).toBe(false);
    }
  });

  it("refuses a vanished session without evaluating its stored command", async () => {
    const root = fs.mkdtempSync(path.join(testRoot, "vanished-"));
    const marker = path.join(root, "must-not-exist");
    const name = "vanished-target";
    fs.writeFileSync(path.join(root, `${name}.json`), JSON.stringify({
      command: "sh",
      args: ["-c", `printf 'restarted\\n' >> ${JSON.stringify(marker)}`],
      displayCommand: "synthetic stored command",
      cwd: root,
      createdAt: new Date().toISOString(),
      tags: { keep: "true" },
    }));

    const result = await runInTerminal(
      root,
      ["attach", "--no-restart", name],
      { text: "future-relay-input\r", delayMs: 250 },
    );

    expect(result.code).not.toBe(0);
    expect(result.output).toContain("is not running");
    expect(result.output).toContain("vanished");
    expect(result.output).not.toContain("Restart?");
    expect(result.output).not.toContain("synthetic stored command");
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("attaches to a running daemon, then exits with it without a second incarnation", async () => {
    const root = fs.mkdtempSync(path.join(testRoot, "running-"));
    const marker = path.join(root, "invocations");
    const name = "running-target";
    const command =
      `printf 'started\\n' >> ${JSON.stringify(marker)}; printf 'ATTACH_READY\\n'; read line; exit 37`;
    const created = runCli(root, [
      "run", "-d", "--id", name, "--tag", "keep=true",
      "--", "sh", "-c", command,
    ]);
    expect(created.status, created.stderr).toBe(0);
    const daemonPid = Number(fs.readFileSync(path.join(root, `${name}.pid`), "utf8").trim());
    daemonPids.add(daemonPid);
    waitUntil(() => readInvocationCount(marker) === 1);

    const attached = nodePty.spawn(nodeBin, [cliPath, "attach", "--no-restart", name], {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      env: env(root),
    });
    let output = "";
    attached.onData((data) => { output += data; });
    const exited = new Promise<{ exitCode: number; signal?: number }>((resolve) => {
      attached.onExit(resolve);
    });
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const poll = () => {
        if (output.includes("ATTACH_READY")) resolve();
        else if (Date.now() - started > 8_000) reject(new Error(`attach did not become ready\n${output}`));
        else setTimeout(poll, 25);
      };
      poll();
    });
    attached.write("finish\r");
    const result = await Promise.race([
      exited,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`attach did not exit\n${output}`)), 8_000)),
    ]);
    expect(result.exitCode).toBe(37);
    expect(output).toMatch(/\[running-target exited with code 37 after \d+[smhd]\]/);
    expect(output).toContain("  restart: pty attach running-target");
    expect(output).toContain(" #keep=true — ");

    try { attached.write("future-relay-input\r"); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(readInvocationCount(marker)).toBe(1);
    expect(readEventCount(root, name, "session_start")).toBe(1);
  }, 20_000);

  it("re-reads a display name changed during attach for its trailer", async () => {
    const root = fs.mkdtempSync(path.join(testRoot, "renamed-live-"));
    const created = runCli(root, ["run", "-d", "--id", "live", "--", "sh", "-c", "echo LIVE_READY; cat"]);
    expect(created.status, created.stderr).toBe(0);
    daemonPids.add(Number(fs.readFileSync(path.join(root, "live.pid"), "utf8").trim()));
    const attached = nodePty.spawn(nodeBin, [cliPath, "attach", "live"], {
      name: "xterm-256color", cols: 100, rows: 30, env: env(root),
    });
    let output = "";
    attached.onData((data) => { output += data; });
    try {
      await new Promise<void>((resolve, reject) => {
        const started = Date.now();
        const poll = () => {
          if (output.includes("LIVE_READY")) resolve();
          else if (Date.now() - started > 8000) reject(new Error(`attach did not become ready\n${output}`));
          else setTimeout(poll, 25);
        };
        poll();
      });
      expect(output).toContain("[attached to");
      expect(output).not.toContain("Renamed Live");
      const renamed = runCli(root, ["rename", "live", "Renamed Live"]);
      expect(renamed.status, renamed.stderr).toBe(0);
      const exited = new Promise<number>((resolve) => attached.onExit(({ exitCode }) => resolve(exitCode)));
      attached.write("\x1c");
      expect(await exited).toBe(0);
      expect(stripAnsi(output)).toContain("Renamed Live (live)");
      expect(output).toContain("reattach: pty attach live");
    } finally {
      try { attached.kill(); } catch {}
    }
  }, 20_000);

  it("prints the renamed display label, command and exact detach hint", async () => {
    const root = fs.mkdtempSync(path.join(testRoot, "detach-"));
    const name = "worker";
    const created = runCli(root, ["run", "-d", "--id", name, "--", "sh", "-c", "echo READY; cat"]);
    expect(created.status, created.stderr).toBe(0);
    daemonPids.add(Number(fs.readFileSync(path.join(root, `${name}.pid`), "utf8").trim()));
    const renamed = runCli(root, ["rename", name, "My Worker"]);
    expect(renamed.status, renamed.stderr).toBe(0);
    const result = await runInTerminal(root, ["attach", name], { text: "\x1c", delayMs: 500 });
    expect(result.code).toBe(0);
    expect(result.output).toContain("[attached to My Worker (worker) — press Ctrl+\\ to detach]");
    expect(result.output).toContain("[detached from worker]");
    expect(stripAnsi(result.output)).toContain(`My Worker (worker) — ${shortPath(process.cwd())} — sh -c echo READY; cat`);
    expect(result.output).toContain("reattach: pty attach worker");
  }, 20_000);

  it("prints a plain follow summary and a peek-specific reattach command", async () => {
    const root = fs.mkdtempSync(path.join(testRoot, "peek-follow-"));
    const name = "follow";
    const created = runCli(root, ["run", "-d", "--id", name, "--", "sh", "-c", "echo PEEK_READY; cat"]);
    expect(created.status, created.stderr).toBe(0);
    daemonPids.add(Number(fs.readFileSync(path.join(root, `${name}.pid`), "utf8").trim()));
    const result = await runInTerminal(root, ["peek", "-f", "--plain", name], { text: "\x1c", delayMs: 500 });
    expect(result.code).toBe(0);
    const afterHeader = result.output.slice(result.output.indexOf("[detached from follow]"));
    expect(afterHeader).toContain("  reattach: pty peek -f follow");
    expect(afterHeader).toContain(` — ${shortPath(process.cwd())} — sh -c echo PEEK_READY; cat`);
    expect(afterHeader).not.toContain("\x1b");
  }, 20_000);

  it("omits restart hint when a session is reaped on exit", async () => {
    const root = fs.mkdtempSync(path.join(testRoot, "reap-"));
    const name = "reaped";
    const created = runCli(root, ["run", "-d", "--id", name, "--", "sh", "-c", "echo READY; read line; exit 7"]);
    expect(created.status, created.stderr).toBe(0);
    daemonPids.add(Number(fs.readFileSync(path.join(root, `${name}.pid`), "utf8").trim()));
    const result = await runInTerminal(root, ["attach", name], { text: "finish\r", delayMs: 500 });
    expect(result.code).toBe(7);
    expect(result.output).toMatch(/\[reaped exited with code 7 after \d+[smhd]\]/);
    expect(result.output).not.toContain("  restart:");
  }, 20_000);

  it("preserves the default prompt-and-restart behavior", async () => {
    const root = fs.mkdtempSync(path.join(testRoot, "legacy-"));
    const marker = path.join(root, "invocations");
    const name = "legacy-target";
    spawnRetainedOnce(root, name, marker);

    const result = await runInTerminal(
      root,
      ["attach", name],
      { text: "future-relay-input\r", delayMs: 250 },
    );

    expect(result.output).toContain("Restart? [Y/n]");
    expect(readInvocationCount(marker)).toBe(2);
    // A restart begins a new event log rather than appending to the old one.
    expect(readEventCount(root, name, "session_start")).toBe(1);
  });

  it("preserves --auto-restart behavior without prompting", async () => {
    const root = fs.mkdtempSync(path.join(testRoot, "automatic-"));
    const marker = path.join(root, "invocations");
    const name = "automatic-target";
    spawnRetainedOnce(root, name, marker);

    const result = await runInTerminal(root, ["attach", "--auto-restart", name]);

    expect(result.output).not.toContain("Restart?");
    expect(readInvocationCount(marker)).toBe(2);
    expect(readEventCount(root, name, "session_start")).toBe(1);
  });
});
