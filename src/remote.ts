import * as net from "node:net";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { listSessions, getSession, getSocketPath, type SessionInfo } from "./sessions.ts";

/** ALPN / fabric service name under which pty exposes its remote-access control
 *  protocol. `fabric expose pty-remote --exec -- pty remote-serve --stdio` on the
 *  remote; `fabric dial <peer> pty-remote` on the client. */
export const PTY_REMOTE_ALPN = "pty-remote";

/** The `fabric` CLI is the only thing pty knows about the cross-machine
 *  transport — it hands us a local Unix socket and we speak our own protocol
 *  over it, exactly like the old `--remote` shelled out to `pty-relay`. pty
 *  never imports iroh. Overridable for tests. */
export const FABRIC_BIN = process.env.PTY_FABRIC_BIN ?? "fabric";

/** One session row as sent over the control protocol. Deliberately the same
 *  shape the local `--remote` host-group renderer already consumes, so remote
 *  results render through the existing path unchanged. */
export interface RemoteSessionRow {
  name: string;
  status: string;
  command?: string;
  cwd?: string;
  tags?: Record<string, string>;
  displayName?: string;
}

/** Control-protocol request (one JSON line, then for `route` the raw per-session
 *  protocol). `list` returns the session set; `route` splices the connection
 *  through to a session's `<name>.sock` so the caller speaks the ordinary
 *  per-session protocol over the fabric hop — this is how peek/send/attach
 *  `--remote` reuse the existing client code unchanged. */
export type RemoteRequest =
  | { op: "list" }
  | { op: "route"; name: string };

export interface RemoteListResponse {
  sessions?: RemoteSessionRow[];
  error?: string;
}

/** Route handshake ack line the server sends once it has connected to the target
 *  session, right before it starts splicing. `dialAndRoute` waits for this so a
 *  routed command reliably knows the route succeeded (or, on `{error}`, failed).*/
const ROUTE_OK = JSON.stringify({ ok: true });

/** The dial reached the peer's control server but it REFUSED the route — the
 *  host is reachable and reports the session is gone/absent. Distinct from a
 *  transport failure (dial/connect/timeout = host unreachable): `attach --remote`
 *  reconnect gives up cleanly on this (the session truly ended) but retries
 *  forever on a transport failure (the outage is recoverable). */
export class RouteRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteRefusedError";
  }
}

function toRow(s: SessionInfo): RemoteSessionRow {
  const m = s.metadata;
  return {
    name: s.name,
    status: s.status,
    ...(m?.displayCommand ? { command: m.displayCommand } : {}),
    ...(m?.cwd ? { cwd: m.cwd } : {}),
    ...(m?.tags ? { tags: m.tags } : {}),
    ...(m?.displayName ? { displayName: m.displayName } : {}),
  };
}

/** Handle ONE remote-control interaction over a generic duplex: read the 1-line
 *  request from `input`, then serve `list` (write the session set) or `route`
 *  (ACK, then splice input <-> the session's `<name>.sock` <-> output). `done`
 *  fires exactly once when the interaction is finished — the caller decides what
 *  that means: the listening server ends the accepted socket; the on-demand
 *  stdio handler exits the process. Shared so both entry points run identical
 *  logic. `input`/`output` are the same object for a socket, or process.stdin/
 *  process.stdout under fabric `--exec`. */
export function handleRemoteConnection(input: Readable, output: Writable, done: () => void): void {
  // Accumulate BYTES (not a string): a `route` request is one JSON line followed
  // by raw per-session protocol bytes; string round-tripping would corrupt them.
  let buf: Buffer = Buffer.alloc(0);
  let handled = false;
  let finished = false;
  const finish = () => { if (finished) return; finished = true; done(); };

  const onData = (chunk: Buffer) => {
    if (handled) return;
    buf = Buffer.concat([buf, chunk]);
    const nl = buf.indexOf(0x0a); // '\n'
    if (nl === -1) return; // wait for the full request line
    handled = true;
    input.pause(); // hold further bytes until we dispatch/splice
    input.removeListener("data", onData);
    const line = buf.subarray(0, nl).toString("utf-8");
    const residual = buf.subarray(nl + 1); // bytes after the request line (route: first frame)
    void dispatch(line, residual);
  };
  input.on("data", onData);
  input.on("error", () => finish());
  input.on("end", () => { if (!handled) finish(); }); // EOF before a full request

  function writeLine(line: string): void {
    output.write(line + "\n", () => finish());
  }

  async function dispatch(line: string, residual: Buffer): Promise<void> {
    let req: { op?: string; name?: unknown };
    try {
      req = JSON.parse(line);
    } catch {
      writeLine(JSON.stringify({ error: "malformed request" }));
      return;
    }
    if (req.op === "list") {
      try {
        writeLine(JSON.stringify({ sessions: (await listSessions()).map(toRow) }));
      } catch (e) {
        writeLine(JSON.stringify({ error: (e as Error).message }));
      }
      return;
    }
    if (req.op === "route" && typeof req.name === "string") {
      await route(req.name, residual);
      return;
    }
    writeLine(JSON.stringify({ error: `unknown op: ${String(req.op)}` }));
  }

  async function route(ref: string, residual: Buffer): Promise<void> {
    let session: SessionInfo | null;
    try {
      session = await getSession(ref);
    } catch (e) {
      writeLine(JSON.stringify({ error: (e as Error).message }));
      return;
    }
    if (!session) {
      writeLine(JSON.stringify({ error: `session "${ref}" not found` }));
      return;
    }
    const target = net.createConnection(getSocketPath(session.name));
    const teardown = () => { try { target.destroy(); } catch {} finish(); };
    target.on("connect", () => {
      // ACK the route BEFORE splicing so the client knows it succeeded (the
      // per-session protocol has no ack). Then wire the bidirectional splice.
      output.write(ROUTE_OK + "\n");
      if (residual.length > 0) target.write(residual);
      input.pipe(target);
      target.pipe(output, { end: false }); // `finish` owns the final teardown
      input.resume(); // was paused at the request-line boundary; pipe is wired
    });
    target.on("error", () => {
      // Reachable-but-gone: the client turns this line into a clean give-up
      // (see RouteRefusedError on the dial side).
      output.write(JSON.stringify({ error: `session "${ref}" not found` }) + "\n", () => teardown());
    });
    target.on("close", teardown);
    input.on("error", teardown);
    input.on("end", teardown);
    input.on("close", teardown);
  }
}

/** Serve the pty remote-access control protocol on a plain Unix socket. pty
 *  stays transport-agnostic: fabric (or anything) exposes this socket to peers.
 *  Reads sessions from the ambient $PTY_ROOT, so run it in the same env the
 *  sessions use. Returns the listening server. (The on-demand fabric `--exec`
 *  path uses `runRemoteServeStdio` instead — same handler, no daemon.) */
export function serveRemoteControl(socketPath: string): net.Server {
  try {
    fs.unlinkSync(socketPath);
  } catch {
    // no stale socket to clear
  }
  const server = net.createServer((sock) => {
    // A socket is a single duplex — input and output are the same stream.
    handleRemoteConnection(sock, sock, () => { try { sock.end(); } catch {} });
    sock.on("error", () => { /* client vanished mid-request; nothing to do */ });
  });
  server.listen(socketPath);
  return server;
}

/** On-demand handler for fabric `--exec`: fabric spawns this ONCE per tunnel
 *  session and pipes the connection to stdin/stdout (`pty remote-serve --stdio`).
 *  Run the shared handler on stdin/stdout and exit when the interaction ends. No
 *  persistent daemon — fabric owns the accept, the persistence, and roaming (a
 *  drop/reconnect reuses THIS process by stalling then resuming the pipes), so
 *  there's nothing to re-implement here. */
export function runRemoteServeStdio(): void {
  handleRemoteConnection(process.stdin, process.stdout, () => process.exit(0));
  process.stdin.resume();
}

/** Resolve the peer's control socket before starting any routed session stream. */
export function dialPeer(peer: string, timeoutMs = 10000): string {
  const dialSock = execFileSync(FABRIC_BIN, ["dial", peer, PTY_REMOTE_ALPN], {
    encoding: "utf-8",
    timeout: timeoutMs,
  }).trim();
  if (!dialSock) throw new Error(`fabric dial ${peer} returned no socket`);
  return dialSock;
}

/** Route a dialed control socket to a remote session. Install client listeners
 * immediately after this promise resolves: the route is already live. */
export function routeSocket(dialSock: string, name: string, timeoutMs = 10000): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(dialSock);
    let acked = false;
    let buf: Buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      if (!acked) { sock.destroy(); reject(new Error("route handshake timed out")); }
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl === -1) return; // wait for the full ack line
      acked = true;
      clearTimeout(timer);
      sock.removeListener("data", onData);
      const line = buf.subarray(0, nl).toString("utf-8");
      const rest = buf.subarray(nl + 1); // bytes after the ack (normally none)
      let resp: { ok?: boolean; error?: string };
      try {
        resp = JSON.parse(line);
      } catch {
        sock.destroy();
        reject(new Error(`bad route response: ${line.slice(0, 80)}`));
        return;
      }
      if (resp.error || !resp.ok) {
        // Reached the host; it refused the route (session gone). Distinct from a
        // transport failure so reconnect can give up cleanly vs retry forever.
        sock.destroy();
        reject(new RouteRefusedError(resp.error ?? "route refused"));
        return;
      }
      // Hand back anything that arrived after the ack line so the caller's
      // per-session protocol sees it (defensive — the server splices only after
      // acking, so in practice `rest` is empty).
      if (rest.length > 0) sock.unshift(rest);
      resolve(sock);
    };
    sock.once("connect", () => {
      sock.write(JSON.stringify({ op: "route", name }) + "\n");
    });
    sock.on("data", onData);
    sock.on("error", (e) => { clearTimeout(timer); if (!acked) reject(e); });
    sock.on("close", () => {
      clearTimeout(timer);
      if (!acked) reject(new Error(`remote session "${name}" not reachable`));
    });
  });
}

/** Dial and route when no metadata lookup is needed (send and reconnect). */
export async function dialAndRoute(peer: string, name: string, timeoutMs = 10000): Promise<net.Socket> {
  return routeSocket(dialPeer(peer, timeoutMs), name, timeoutMs);
}

/** Connect to a control socket (a local path, or one handed to us by
 *  `fabric dial`), request the session list, and return the rows. */
export function fetchRemoteList(socketPath: string, timeoutMs = 10000): Promise<RemoteSessionRow[]> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("remote list timed out"));
    }, timeoutMs);
    sock.on("connect", () => {
      const req: RemoteRequest = { op: "list" };
      sock.write(JSON.stringify(req) + "\n");
    });
    sock.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
    });
    sock.on("end", () => {
      clearTimeout(timer);
      try {
        const resp = JSON.parse(buf.trim()) as RemoteListResponse;
        if (resp.error) {
          reject(new Error(resp.error));
          return;
        }
        resolve(resp.sessions ?? []);
      } catch (e) {
        reject(new Error(`bad remote response: ${(e as Error).message}`));
      }
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
