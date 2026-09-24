import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { Session } from "../src/testing/index.ts";

// ── Reconnect test harness ───────────────────────────────────────────────────
// Covers the attach --remote RECONNECT path. Reconnect fires only on a LOUD
// fabric close, never on a recoverable stall (reconnecting on a stall would be the
// bug — fabric transparently resumes those). The KillableFabricProxy below models
// that seam: `.drop()` severs every live tunnel (a loud close / a server-side TTL
// reap) while the listener stays up, so attach re-dials a FRESH tunnel and
// re-attaches to the still-alive pty session by identity, and the daemon replays
// its screen.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nodeBin = process.execPath;
const cliPath = path.join(__dirname, "..", "dist", "cli.js");
const rand = () => Math.random().toString(36).slice(2, 7);
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * A stand-in for a `fabric dial` tunnel we can sever on demand. It listens on a
 * local socket (what a fake `fabric dial` echoes to the client) and, per
 * incoming connection, opens one to the real `remote-serve` control socket and
 * pipes both ways — exactly the transparent local-socket tunnel fabric provides.
 *
 * `.drop()` destroys every live tunnel (simulating fabric giving up / a loud
 * close) while the listener stays up, so a client re-dial + reconnect can
 * establish a FRESH tunnel — the precise condition attach --remote reconnect
 * must handle.
 */
class KillableFabricProxy {
  readonly socketPath: string;
  private server: net.Server;
  private pairs: Array<[net.Socket, net.Socket]> = [];
  private blocked = false;

  constructor(targetCtrlSock: string, socketPath: string) {
    this.socketPath = socketPath;
    try { fs.unlinkSync(socketPath); } catch { /* no stale socket */ }
    this.server = net.createServer((client) => {
      // Blocked = the peer is unreachable: new dials connect but the tunnel
      // fails immediately (a transport failure, not a "session gone" refusal).
      if (this.blocked) { try { client.destroy(); } catch { /* gone */ } return; }
      const target = net.createConnection(targetCtrlSock);
      const pair: [net.Socket, net.Socket] = [client, target];
      this.pairs.push(pair);
      client.pipe(target);
      target.pipe(client);
      const drop = () => {
        this.pairs = this.pairs.filter((p) => p !== pair);
        try { client.destroy(); } catch { /* already gone */ }
        try { target.destroy(); } catch { /* already gone */ }
      };
      client.on("close", drop);
      target.on("close", drop);
      client.on("error", () => {});
      target.on("error", () => {});
    });
    this.server.listen(socketPath);
  }

  /** Live tunnels right now. */
  activeCount(): number { return this.pairs.length; }

  /** Sever every live tunnel; keep listening so a reconnect can re-dial. */
  drop(): void {
    for (const [client, target] of this.pairs.splice(0)) {
      try { client.destroy(); } catch { /* already gone */ }
      try { target.destroy(); } catch { /* already gone */ }
    }
  }

  /** Simulate the peer going unreachable: new dials fail (transport failure). */
  block(): void { this.blocked = true; }
  /** Peer reachable again: new dials tunnel through normally. */
  unblock(): void { this.blocked = false; }

  close(): void {
    this.drop();
    try { this.server.close(); } catch { /* already closed */ }
    try { fs.unlinkSync(this.socketPath); } catch { /* already gone */ }
  }
}

const srvRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pr-rc-srv-"));
const cliRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pr-rc-cli-"));
const ctrlSock = path.join(os.tmpdir(), `pr-rc-ctrl-${rand()}.sock`);
const proxySock = path.join(os.tmpdir(), `pr-rc-proxy-${rand()}.sock`);
const fakeFabric = path.join(os.tmpdir(), `pr-rc-fabric-${rand()}.sh`);
const bgPids: number[] = [];
let proxy: KillableFabricProxy;

function runCli(root: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(nodeBin, [cliPath, ...args], {
    env: { ...process.env, PTY_ROOT: root, PTY_ROOT_LEGACY_SILENT: "1", ...env },
    encoding: "utf8", timeout: 15000,
  });
}

function waitForFile(p: string, timeoutMs: number): boolean {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { fs.statSync(p); return true; } catch { /* not yet */ }
    sleepSync(50);
  }
  return false;
}

beforeAll(() => {
  // A remote shell (cat echoes input) on the "remote" root.
  const c = runCli(srvRoot, ["run", "-d", "--id", "rshell", "--", "sh", "-c", "echo RECONNECT_READY; cat"]);
  expect(c.status).toBe(0);
  try { bgPids.push(Number(fs.readFileSync(path.join(srvRoot, "rshell.pid"), "utf8").trim())); } catch {}

  // Real remote-serve on ctrlSock, reading the remote root.
  const proc = spawn(nodeBin, [cliPath, "remote-serve", "--socket", ctrlSock], {
    env: { ...process.env, PTY_ROOT: srvRoot, PTY_ROOT_LEGACY_SILENT: "1" },
    detached: true, stdio: ["ignore", "ignore", "ignore"],
  });
  proc.unref();
  bgPids.push(proc.pid!);
  expect(waitForFile(ctrlSock, 5000)).toBe(true);

  // Killable tunnel in front of remote-serve; fake `fabric dial` echoes its path.
  proxy = new KillableFabricProxy(ctrlSock, proxySock);
  fs.writeFileSync(fakeFabric, `#!/bin/sh\nif [ "$1" = "dial" ]; then printf '%s' "${proxySock}"; fi\n`, { mode: 0o755 });
});

afterAll(() => {
  try { proxy?.close(); } catch { /* ignore */ }
  for (const pid of bgPids) { try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ } }
  for (const p of [ctrlSock, proxySock, fakeFabric]) { try { fs.rmSync(p, { force: true }); } catch { /* ignore */ } }
  for (const d of [srvRoot, cliRoot]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

describe("attach --remote reconnect harness", () => {
  it("KillableFabricProxy tunnels attach --remote, and .drop() severs it", async () => {
    // Proves the harness itself: attach streams over the proxy tunnel, and
    // drop() actually tears the live tunnel down. (This is what the reconnect
    // test drives; the reconnect *reaction* is asserted in the skipped test.)
    const session = Session.spawn(nodeBin, [cliPath, "attach", "--remote", "testpeer", "rshell"], {
      rows: 24, cols: 80,
      env: { PTY_ROOT: cliRoot, PTY_ROOT_LEGACY_SILENT: "1", PTY_FABRIC_BIN: fakeFabric },
    });
    try {
      await session.waitForText("RECONNECT_READY", 8000); // tunnel forwards ✓
      session.sendKeys("PRE_DROP\r");
      await session.waitForText("PRE_DROP", 8000);        // bidirectional ✓
      expect(proxy.activeCount()).toBeGreaterThan(0);     // a live tunnel exists

      proxy.drop();                                        // sever it
      expect(proxy.activeCount()).toBe(0);                 // tunnel gone immediately ✓
      // (attach --remote will now re-dial + re-attach — that's the reconnect test below)
    } finally {
      await session.close();
    }
  }, 25000);

  it("shows the remote peer in the detach hint and the dial-time session row", async () => {
    const session = Session.spawn(nodeBin, [cliPath, "attach", "--remote", "testpeer", "rshell"], {
      rows: 24, cols: 80,
      env: { PTY_ROOT: cliRoot, PTY_ROOT_LEGACY_SILENT: "1", PTY_FABRIC_BIN: fakeFabric },
    });
    try {
      await session.waitForText("RECONNECT_READY", 8000);
      session.sendKeys("\x1c");
      await session.waitForText("reattach: pty attach --remote testpeer rshell", 8000);
      await session.waitForText("rshell)", 8000);
    } finally {
      await session.close();
    }
  }, 20000);

  it("survives a tunnel drop: re-dials, re-attaches, and resumes without exiting", async () => {
    const session = Session.spawn(nodeBin, [cliPath, "attach", "--remote", "testpeer", "rshell"], {
      rows: 24, cols: 80,
      env: { PTY_ROOT: cliRoot, PTY_ROOT_LEGACY_SILENT: "1", PTY_FABRIC_BIN: fakeFabric },
    });
    try {
      await session.waitForText("RECONNECT_READY", 8000);  // attached
      session.sendKeys("BEFORE_DROP\r");
      await session.waitForText("BEFORE_DROP", 8000);       // input works pre-drop (cat echoes)

      proxy.drop();                                          // simulate a LOUD fabric close
      // attach must NOT exit: it re-dials (fresh tunnel via fake fabric) + re-attaches,
      // and the daemon replays the screen. The remote cat session persisted, so input
      // flows again and echoes back — which only happens if reconnect succeeded.
      // NB: async wait (not sleepSync) — the proxy runs in THIS process, so the loop
      // must stay live to accept the child's reconnect dial.
      await new Promise((r) => setTimeout(r, 3000));         // let the backoff + local re-dial complete
      session.sendKeys("AFTER_RECONNECT\r");
      await session.waitForText("AFTER_RECONNECT", 12000);   // resumed end-to-end
    } finally {
      await session.close();
    }
  }, 40000);

  it("survives a LONG transport outage (unlimited retry) and reconnects when the peer returns", async () => {
    const session = Session.spawn(nodeBin, [cliPath, "attach", "--remote", "testpeer", "rshell"], {
      rows: 24, cols: 80,
      env: { PTY_ROOT: cliRoot, PTY_ROOT_LEGACY_SILENT: "1", PTY_FABRIC_BIN: fakeFabric },
    });
    try {
      await session.waitForText("RECONNECT_READY", 8000);

      // Peer goes unreachable (transport failure), and the live tunnel drops.
      // With unlimited-while-open retry, attach must NOT give up — it keeps
      // re-dialing (all failing) through many backoff cycles.
      proxy.block();
      proxy.drop();
      await session.waitForText("reconnecting", 8000);       // shows the reconnecting indicator
      await new Promise((r) => setTimeout(r, 6000));         // outage spanning several failed retries

      // Peer reachable again → the next retry succeeds → session resumes.
      proxy.unblock();
      await new Promise((r) => setTimeout(r, 6000));         // let a retry land + re-attach
      session.sendKeys("AFTER_OUTAGE\r");
      await session.waitForText("AFTER_OUTAGE", 12000);      // reconnected + resumed after the outage
    } finally {
      proxy.unblock();
      await session.close();
    }
  }, 60000);

  it("gives up cleanly when the peer is reachable but the session is gone (no infinite spin)", async () => {
    // A throwaway session we kill mid-attach so the route-op returns 'no such
    // session' (reachable host, session gone) — a clean give-up, not retry-forever.
    const sid = `gone-${rand()}`;
    const c = runCli(srvRoot, ["run", "-d", "--id", sid, "--", "sh", "-c", "echo GONE_READY; cat"]);
    expect(c.status).toBe(0);
    try { bgPids.push(Number(fs.readFileSync(path.join(srvRoot, `${sid}.pid`), "utf8").trim())); } catch {}
    sleepSync(400);

    const session = Session.spawn(nodeBin, [cliPath, "attach", "--remote", "testpeer", sid], {
      rows: 24, cols: 80,
      env: { PTY_ROOT: cliRoot, PTY_ROOT_LEGACY_SILENT: "1", PTY_FABRIC_BIN: fakeFabric },
    });
    try {
      await session.waitForText("GONE_READY", 8000);
      // Kill the remote session, then drop the tunnel. The reconnect re-dials
      // successfully (host reachable) but the route-op refuses (session gone) →
      // attach gives up cleanly with "session ended", not an infinite reconnect.
      runCli(srvRoot, ["kill", sid]);
      sleepSync(400);
      proxy.drop();
      await session.waitForText("session ended", 12000);
    } finally {
      await session.close();
    }
  }, 30000);
});
