import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { Session } from "../src/testing/index.ts";
import { terminateAndWait } from "./setup/processes.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nodeBin = process.execPath;
const cliPath = path.join(__dirname, "..", "dist", "cli.js");

// Short roots: PTY_ROOT must stay under the 90-byte socket-path backstop.
const rand = () => Math.random().toString(36).slice(2, 7);
const srvRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pr-srv-"));
const cliRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pr-cli-"));
const ctrlSock = path.join(os.tmpdir(), `pr-ctrl-${rand()}.sock`);
const fakeFabric = path.join(os.tmpdir(), `pr-fabric-${rand()}.sh`);
const bgPids: number[] = [];

function runCli(root: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(nodeBin, [cliPath, ...args], {
    env: { ...process.env, PTY_ROOT: root, PTY_ROOT_LEGACY_SILENT: "1", ...env },
    encoding: "utf8",
    timeout: 15000,
  });
}

function waitForFile(p: string, timeoutMs: number): boolean {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { fs.statSync(p); return true; } catch {}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return false;
}

/** Speak the control protocol directly (no fabric): one line {"op":"list"},
 *  read until the server half-closes, parse the JSON response. */
function rawList(sockPath: string): Promise<{ sessions: { name: string }[] }> {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(sockPath);
    let buf = "";
    c.on("connect", () => c.write(JSON.stringify({ op: "list" }) + "\n"));
    c.on("data", (d: Buffer) => { buf += d.toString("utf8"); });
    c.on("end", () => {
      try { resolve(JSON.parse(buf.trim())); } catch (e) { reject(e); }
    });
    c.on("error", reject);
  });
}

beforeAll(() => {
  // A real session on the "remote" (srvRoot).
  const r = runCli(srvRoot, ["run", "-d", "--id", "demo", "--name", "Demo Session", "--", "sleep", "300"]);
  expect(r.status).toBe(0);
  try { bgPids.push(Number(fs.readFileSync(path.join(srvRoot, "demo.pid"), "utf8").trim())); } catch {}

  // Real `pty remote-serve` subprocess, reading the remote's PTY_ROOT.
  const serve = spawn(nodeBin, [cliPath, "remote-serve", "--socket", ctrlSock], {
    env: { ...process.env, PTY_ROOT: srvRoot, PTY_ROOT_LEGACY_SILENT: "1" },
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  serve.unref();
  bgPids.push(serve.pid!);
  expect(waitForFile(ctrlSock, 5000)).toBe(true);

  // Fake fabric: `dial <peer> <alpn>` prints the local control socket path.
  fs.writeFileSync(
    fakeFabric,
    `#!/bin/sh\nif [ "$1" = "dial" ]; then printf '%s' "${ctrlSock}"; fi\n`,
    { mode: 0o755 },
  );
});

afterAll(() => {
  for (const pid of bgPids) { try { process.kill(pid, "SIGKILL"); } catch {} }
  for (const p of [ctrlSock, fakeFabric]) { try { fs.rmSync(p, { force: true }); } catch {} }
  for (const d of [srvRoot, cliRoot]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

describe("pty ls --remote over fabric", () => {
  it("lists the remote peer's sessions (json), local root empty", () => {
    const r = runCli(cliRoot, ["ls", "--remote", "testpeer", "--json"], { PTY_FABRIC_BIN: fakeFabric });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.local).toEqual([]);
    expect(out.remote).toHaveLength(1);
    expect(out.remote[0].label).toBe("testpeer");
    expect(out.remote[0].error).toBeNull();
    const names = out.remote[0].sessions.map((s: { name: string }) => s.name);
    expect(names).toContain("demo");
    const demo = out.remote[0].sessions.find((s: { name: string }) => s.name === "demo");
    expect(demo.status).toBe("running");
    expect(demo.command).toBe("sleep 300");
    expect(demo.displayName).toBe("Demo Session");
  }, 20000);

  it("renders the remote host group in human output", () => {
    const r = runCli(cliRoot, ["ls", "--remote", "testpeer"], { PTY_FABRIC_BIN: fakeFabric });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("testpeer");
    expect(r.stdout).toContain("Demo Session");
    expect(r.stdout).toContain("sleep 300");
  }, 20000);

  it("surfaces a fabric-dial failure as a host-group error, not a crash", () => {
    // A fabric shim that exits non-zero → execFileSync throws → error captured.
    const badFabric = path.join(os.tmpdir(), `pr-badfab-${rand()}.sh`);
    fs.writeFileSync(badFabric, `#!/bin/sh\nexit 3\n`, { mode: 0o755 });
    try {
      const r = runCli(cliRoot, ["ls", "--remote", "downpeer", "--json"], { PTY_FABRIC_BIN: badFabric });
      expect(r.status).toBe(0); // still exits cleanly
      const out = JSON.parse(r.stdout);
      expect(out.remote[0].label).toBe("downpeer");
      expect(out.remote[0].error).toBeTruthy();
      expect(out.remote[0].sessions).toEqual([]);
    } finally {
      fs.rmSync(badFabric, { force: true });
    }
  }, 20000);

  it("survives a detached (session-leader) stdin=/dev/null launch and keeps serving", async () => {
    // Topology note: Node `detached: true` calls setsid(), so the spawned pty
    // IS the session leader (PGID==PID) with no controlling TTY — i.e. the exact
    // `setsid pty remote-serve …` shape, NOT a wrapped child. This locks the
    // detached/loop-drain + SIGHUP behavior. CAVEAT: the deeper "pty as session
    // leader dies below the JS layer" failure cos hit is Linux-specific and does
    // NOT reproduce on macOS, so on a Mac this asserts the topology stays up but
    // cannot exercise that Linux-only death; a Linux run would. remote-serve must
    // not exit when stdin closes, and must keep answering `list`.
    const sock = path.join(os.tmpdir(), `pr-svc-${rand()}.sock`);
    const proc = spawn(nodeBin, [cliPath, "remote-serve", "--socket", sock], {
      env: { ...process.env, PTY_ROOT: srvRoot, PTY_ROOT_LEGACY_SILENT: "1" },
      detached: true,
      stdio: ["ignore", "ignore", "ignore"], // stdin = /dev/null
    });
    proc.unref();
    bgPids.push(proc.pid!);
    expect(waitForFile(sock, 5000)).toBe(true);

    // Past the ~2s window where a stdin-dependent loop would have drained.
    await new Promise((r) => setTimeout(r, 2500));
    expect(() => process.kill(proc.pid!, 0)).not.toThrow(); // still alive

    // And still functional over its socket.
    const resp = await rawList(sock);
    expect(resp.sessions.map((s) => s.name)).toContain("demo");

    await terminateAndWait([proc.pid!]);
    try { fs.rmSync(sock, { force: true }); } catch {}
  }, 15000);

  it("ignores SIGHUP and keeps serving (the detached-launch death on Linux)", async () => {
    // The Linux failure: a detached launch is killed by the SIGHUP its
    // launching session sends on teardown (SIGHUP's default action terminates).
    // remote-serve must ignore it. Deterministic everywhere — POSIX SIGHUP.
    const sock = path.join(os.tmpdir(), `pr-hup-${rand()}.sock`);
    const proc = spawn(nodeBin, [cliPath, "remote-serve", "--socket", sock], {
      env: { ...process.env, PTY_ROOT: srvRoot, PTY_ROOT_LEGACY_SILENT: "1" },
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    proc.unref();
    bgPids.push(proc.pid!);
    expect(waitForFile(sock, 5000)).toBe(true);

    process.kill(proc.pid!, "SIGHUP");
    await new Promise((r) => setTimeout(r, 600));
    expect(() => process.kill(proc.pid!, 0)).not.toThrow(); // survived SIGHUP

    const resp = await rawList(sock); // and still functional
    expect(resp.sessions.map((s) => s.name)).toContain("demo");

    await terminateAndWait([proc.pid!]);
    try { fs.rmSync(sock, { force: true }); } catch {}
  }, 15000);
});

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

describe("pty peek --remote over fabric", () => {
  it("peeks a remote session's screen (route-op splice)", () => {
    // A marker session on the "remote" (srvRoot); reachable by the running
    // remote-serve, which resolves <name>.sock live from its PTY_ROOT.
    const c = runCli(srvRoot, ["run", "-d", "--id", "pk", "--", "sh", "-c", "printf 'PEEK_MARKER_9x\\r\\n'; sleep 300"]);
    expect(c.status).toBe(0);
    try { bgPids.push(Number(fs.readFileSync(path.join(srvRoot, "pk.pid"), "utf8").trim())); } catch {}
    sleepSync(500); // let the child render into the daemon's screen buffer

    const p = runCli(cliRoot, ["peek", "--remote", "testpeer", "pk", "--plain"], { PTY_FABRIC_BIN: fakeFabric });
    expect(p.status).toBe(0);
    expect(p.stdout).toContain("PEEK_MARKER_9x");
  }, 20000);

  it("errors (exit 1) peeking a nonexistent remote session", () => {
    const p = runCli(cliRoot, ["peek", "--remote", "testpeer", "does-not-exist", "--plain"], { PTY_FABRIC_BIN: fakeFabric });
    expect(p.status).not.toBe(0);
    expect(p.stderr).toMatch(/not found/); // route ack reports the missing session
  }, 20000);

  it("fails closed and lists stable ids for an ambiguous remote display name", () => {
    for (const id of ["remote-a", "remote-b"]) {
      const c = runCli(srvRoot, ["run", "-d", "--id", id, "--name", "Remote Shared", "--", "sleep", "300"]);
      expect(c.status).toBe(0);
      try { bgPids.push(Number(fs.readFileSync(path.join(srvRoot, `${id}.pid`), "utf8").trim())); } catch {}
    }

    const p = runCli(cliRoot, ["peek", "--remote", "testpeer", "Remote Shared", "--plain"], { PTY_FABRIC_BIN: fakeFabric });
    expect(p.status).not.toBe(0);
    expect(p.stderr).toContain('Session reference "Remote Shared" is ambiguous.');
    expect(p.stderr).toContain("remote-a");
    expect(p.stderr).toContain("remote-b");
  }, 20000);
});

describe("pty send --remote over fabric", () => {
  it("delivers input to a remote session through the route splice", () => {
    // A `cat` session on the "remote" echoes whatever it receives.
    const c = runCli(srvRoot, ["run", "-d", "--id", "sink", "--", "sh", "-c", "cat"]);
    expect(c.status).toBe(0);
    try { bgPids.push(Number(fs.readFileSync(path.join(srvRoot, "sink.pid"), "utf8").trim())); } catch {}
    sleepSync(300);

    const s = runCli(cliRoot, ["send", "--remote", "testpeer", "sink", "--seq", "SEND_REMOTE_OK", "--seq", "key:return"], { PTY_FABRIC_BIN: fakeFabric });
    expect(s.status).toBe(0);
    sleepSync(400);

    // Confirm it landed: peek the same session, cat echoed the text back.
    const p = runCli(cliRoot, ["peek", "--remote", "testpeer", "sink", "--plain"], { PTY_FABRIC_BIN: fakeFabric });
    expect(p.stdout).toContain("SEND_REMOTE_OK");
  }, 20000);

  it("errors (exit 1) sending to a nonexistent remote session", () => {
    const s = runCli(cliRoot, ["send", "--remote", "testpeer", "does-not-exist", "--seq", "x"], { PTY_FABRIC_BIN: fakeFabric });
    expect(s.status).not.toBe(0);
    expect(s.stderr).toMatch(/not found/);
  }, 20000);
});

describe("pty attach --remote over fabric", () => {
  it("attaches a remote session: streams its screen and forwards input bidirectionally", async () => {
    // Unique id per attempt so a retry (retry:2) doesn't collide with a session
    // a prior attempt already created.
    const sid = `shell-${rand()}`;
    const c = runCli(srvRoot, ["run", "-d", "--id", sid, "--", "sh", "-c", "echo ATTACH_READY_MARK; cat"]);
    expect(c.status).toBe(0);
    try { bgPids.push(Number(fs.readFileSync(path.join(srvRoot, `${sid}.pid`), "utf8").trim())); } catch {}
    sleepSync(400);

    // Spawn the interactive `pty attach --remote` in a real PTY. env merges with
    // process.env — the vitest setup has scrubbed PTY_SESSION, so the nesting
    // guard doesn't fire here.
    const session = Session.spawn(nodeBin, [cliPath, "attach", "--remote", "testpeer", sid], {
      rows: 24, cols: 80,
      env: { PTY_ROOT: cliRoot, PTY_ROOT_LEGACY_SILENT: "1", PTY_FABRIC_BIN: fakeFabric },
    });
    try {
      // Screen replayed over the fabric hop on attach.
      await session.waitForText("ATTACH_READY_MARK", 8000);
      // Input forwarded through the splice; cat echoes it back.
      session.sendKeys("PING_OVER_ATTACH\r");
      await session.waitForText("PING_OVER_ATTACH", 8000);
    } finally {
      await session.close();
    }
  }, 25000);
});
