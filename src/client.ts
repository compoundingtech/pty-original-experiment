import * as net from "node:net";
import * as tty from "node:tty";
import * as fs from "node:fs";
import {
  MessageType,
  PacketReader,
  encodePacket,
  encodeAttach,
  encodeData,
  encodeDetach,
  encodePeek,
  encodeResize,
  encodeStatus,
  decodeExit,
} from "./protocol.ts";
import { getSocketPath, readMetadata, reapOnExitDefault, shouldReapAtExit, type SessionMetadata } from "./sessions.ts";
import { formatDuration } from "./duration.ts";
import { sessionSummary, type SessionPresentation } from "./session-presentation.ts";
import type { RemoteSessionRow } from "./remote.ts";
import { stripAnsi } from "./tui/colors.ts";
import { BRACKETED_PASTE_START, BRACKETED_PASTE_END } from "./paste.ts";

/** Can anything answer on this session's socket?
 *
 *  The Rust tool's `client::is_alive`, which is `connect(name).is_ok()`. A name
 *  that merely EXISTS on disk is not a name that is in use: a record whose
 *  owner is a zombie has no socket to answer, and refusing it would make that
 *  session name unusable until something reaped the corpse.
 */
export function isSessionAlive(name: string, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (alive: boolean) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolve(alive);
    };
    const socket = net.createConnection(getSocketPath(name));
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

const DETACH_KEY = 0x1c; // Ctrl+\ (legacy encoding)
const DETACH_KEY_KITTY = "\x1b[92;5u"; // Ctrl+\ (Kitty keyboard protocol)

/** Replace Kitty keyboard protocol encoding of Ctrl+\ with the legacy byte
 *  so the rest of the detach logic can work with a single representation. */
function normalizeDetachKey(data: Buffer): Buffer {
  const str = data.toString();
  if (!str.includes(DETACH_KEY_KITTY)) return data;
  return Buffer.from(
    str.replaceAll(DETACH_KEY_KITTY, String.fromCharCode(DETACH_KEY))
  );
}

// Reset terminal modes that programs may have enabled. This prevents
// "poisoned" terminals after detach/peek (e.g., mouse tracking, hidden
// cursor, alternate screen buffer, bracketed paste). Does NOT clear
// screen content.
export const TERMINAL_SANITIZE =
  "\x1b[?1049l" + // leave alternate screen buffer (TUI apps: vim, htop, mactop…)
  "\x1b[?1l" + // reset cursor keys to normal mode (DECCKM)
  "\x1b[?7h" + // re-enable autowrap (DECAWM)
  "\x1b[?6l" + // reset origin mode (DECOM)
  "\x1b[?1000l" + // disable mouse click tracking
  "\x1b[?1002l" + // disable mouse button-event tracking
  "\x1b[?1003l" + // disable mouse any-event tracking
  "\x1b[?1004l" + // disable focus event reporting
  "\x1b[?1006l" + // disable SGR mouse mode
  "\x1b[?25h" + // show cursor
  "\x1b[?2004l" + // disable bracketed paste
  "\x1b[4l" + // reset insert mode (IRM) to replace
  "\x1b[r" + // reset scroll region (DECSTBM) to full terminal
  "\x1b[0m" + // reset SGR attributes (colors, bold, etc.)
  "\x1b[0 q" + // reset cursor style to terminal default
  "\x1b>" + // reset application keypad mode (DECKPNM)
  "\x1b(B" + // reset G0 character set to ASCII
  "\x1b[<99u"; // pop all Kitty keyboard protocol levels

// Move cursor to bottom of visible screen so status messages (e.g.
// "[detached]") appear below the session content, not mid-screen.
const CURSOR_TO_BOTTOM = "\x1b[999;1H";

export interface TrailerSource {
  name: string;
  metadata?: SessionMetadata | null;
  row?: RemoteSessionRow;
  peer?: string;
}

const trailerInfo = (source: TrailerSource): SessionPresentation | undefined => {
  if (source.peer) {
    if (!source.row) return undefined;
    return { name: source.name, displayName: source.row.displayName, cwd: source.row.cwd,
      displayCommand: source.row.command, tags: source.row.tags };
  }
  const meta = readMetadata(source.name) ?? source.metadata;
  if (!meta) return undefined;
  return { name: source.name, displayName: meta.displayName, cwd: meta.cwd,
    displayCommand: meta.displayCommand, tags: meta.tags, createdAt: meta.createdAt,
    ephemeral: meta.ephemeral };
};

export const trailer = (
  source: TrailerSource,
  header: string,
  hint?: string,
  plain = false,
  sanitize = true,
): string => {
  const info = trailerInfo(source);
  const lines = [header, ...(info ? [sessionSummary(info)] : []), ...(hint ? [`  ${hint}`] : [])];
  const body = lines.map((line) => plain ? stripAnsi(line) : line).join("\r\n") + "\r\n";
  return (sanitize ? TERMINAL_SANITIZE + CURSOR_TO_BOTTOM : "") + "\r\n" + body;
};

export const exitHeader = (name: string, code: number, info?: SessionPresentation): string => {
  const created = info?.createdAt ? Date.parse(info.createdAt) : NaN;
  const elapsed = Number.isFinite(created) ? ` after ${formatDuration(Math.max(0, Date.now() - created))}` : "";
  return `[${name} exited with code ${code}${elapsed}]`;
};

export interface PeekOptions {
  name: string;
  follow?: boolean; // If true, stay connected and stream (like tail -f). If false, print screen and exit.
  plain?: boolean; // If true, output plain text without ANSI codes.
  full?: boolean; // If true, include full scrollback, not just the viewport.
  onExit?: (code: number) => void;
  onDetach?: () => void;
  /** Speak the peek protocol over this ALREADY-CONNECTED socket instead of
   *  dialing the local `<name>.sock`. Used by `peek --remote`: a fabric-dialed,
   *  control-server-routed socket that transparently pipes to the remote
   *  session's daemon. When set, `name` is only used for display. */
  socket?: net.Socket;
  metadata?: SessionMetadata | null;
  row?: RemoteSessionRow;
  peer?: string;
}

/** Read-only view of a session. Input is ignored by the server. */
export function peek(options: PeekOptions): void {
  const reader = new PacketReader();
  const socket = options.socket ?? net.createConnection(getSocketPath(options.name));
  const stdout = process.stdout;
  const follow = options.follow ?? false;
  let completed = false;
  let failed = false;

  const onReady = () => {
    socket.write(encodePeek(options.plain, options.full));

    if (follow) {
      // In follow mode, Ctrl+\ detaches
      const stdin = process.stdin;
      if (stdin.isTTY) stdin.setRawMode(true);

      stdin.on("data", (raw: Buffer) => {
        const data = normalizeDetachKey(raw);
        for (let i = 0; i < data.length; i++) {
          if (data[i] === DETACH_KEY) {
            if (stdin.isTTY) stdin.setRawMode(false);
            completed = true;
            socket.destroy();
            stdout.write(trailer(options, `[detached from ${options.name}]`,
              `reattach: pty peek -f ${options.peer ? `--remote ${options.peer} ` : ""}${options.name}`,
              options.plain));
            options.onDetach?.();
            return;
          }
        }
        // All other input is silently ignored (read-only)
      });
      stdin.resume();
    }
  };

  // A caller-supplied socket is already connected (dialed + routed over fabric),
  // so there's no "connect" event to wait for — kick off on the next tick.
  if (options.socket) process.nextTick(onReady);
  else socket.on("connect", onReady);

  // Track whether we ever received a screen. If the connection closes before
  // any screen arrives in one-shot mode, the session isn't serving us (e.g. a
  // `--remote` route to a name that doesn't exist on the peer, where the control
  // server closes the tunnel) — surface that instead of exiting 0 silently.
  let gotScreen = false;

  socket.on("data", (data: Buffer) => {
    let packets;
    try { packets = reader.feed(data); } catch (err: any) {
      failed = true;
      console.error(`pty client: dropping connection — ${err.message}`);
      try { socket.destroy(); } catch {}
      return;
    }
    for (const packet of packets) {
      switch (packet.type) {
        case MessageType.SCREEN:
          gotScreen = true;
          stdout.write(packet.payload);
          if (!follow) {
            if (!options.plain) {
              stdout.write(TERMINAL_SANITIZE + CURSOR_TO_BOTTOM);
            }
            stdout.write("\n");
            completed = true;
            socket.destroy();
            return;
          }
          break;

        case MessageType.DATA:
          if (follow) {
            stdout.write(options.plain ? stripAnsi(packet.payload.toString()) : packet.payload);
          }
          break;

        case MessageType.EXIT: {
          const code = decodeExit(packet.payload);
          completed = true;
          socket.destroy();
          if (!options.plain) {
            stdout.write(TERMINAL_SANITIZE + CURSOR_TO_BOTTOM);
          }
          if (follow) {
            const info = trailerInfo(options);
            const restart = !options.peer && info && !shouldReapAtExit(info.tags, info.ephemeral ?? false, reapOnExitDefault());
            stdout.write(trailer(options, exitHeader(options.name, code, info),
              restart ? `restart: pty attach ${options.name}` : undefined, options.plain, false));
          }
          options.onExit?.(code);
          return;
        }
      }
    }
  });

  socket.on("error", (err: NodeJS.ErrnoException) => {
    failed = true;
    // ECONNRESET/EPIPE also mean "gone": a `--remote` route to a missing session
    // has the control server close the tunnel as we write the first frame.
    const notReachable = err.code === "ENOENT" || err.code === "ECONNREFUSED"
      || err.code === "ECONNRESET" || err.code === "EPIPE";
    if (notReachable) {
      console.error(
        options.socket
          ? `Remote session "${options.name}" not found or not running.`
          : `Session "${options.name}" not found or not running.`,
      );
    } else {
      console.error(`Connection error: ${err.message}`);
    }
    process.exit(1);
  });

  socket.on("close", () => {
    if (process.stdin.isTTY && process.stdin.isRaw) {
      process.stdin.setRawMode(false);
    }
    if (follow && !completed && !failed) {
      completed = true;
      stdout.write(trailer(options, `[${options.name} session ended]`,
        undefined, options.plain, !options.plain));
      options.onExit?.(0);
    }
    // Closed in one-shot mode before any screen — the (possibly remote) session
    // isn't reachable. Don't exit 0 with no output.
    if (!follow && !gotScreen) {
      console.error(
        options.socket
          ? `Remote session "${options.name}" not found or not running.`
          : `Session "${options.name}" not found or not running.`,
      );
      process.exit(1);
    }
  });
}

export interface SendOptions {
  name: string;
  data: string[];
  delayMs?: number;
  /** Wrap the entire payload (all `data` entries taken together) in
   *  bracketed-paste markers (CSI 200 ~ … CSI 201 ~). The receiving TUI
   *  treats everything between the markers as one paste event rather
   *  than a sequence of keystrokes — useful for injecting multi-line
   *  prompts into agent sessions without premature submission. Receiver
   *  must have bracketed paste enabled (DECSET 2004); most modern
   *  shells and TUIs do by default. */
  paste?: boolean;
  /** Speak the send protocol over this ALREADY-CONNECTED socket instead of
   *  dialing the local `<name>.sock`. Used by `send --remote`: a fabric-dialed,
   *  control-server-routed socket. When set, `name` is only used for display. */
  socket?: net.Socket;
}

/** Default spacing (ms) the `pty send` CLI inserts between `--seq` items when
 *  the caller doesn't pass `--with-delay`. A burst of bytes and spaced-out
 *  input are processed differently by terminal programs — a trailing `key:return`
 *  fired with zero delay routinely lands before the program has parsed/rendered
 *  the typed text, submitting an empty or partial line. 0.3s lets each chunk be
 *  consumed. See SKILL.md. This default lives in the CLI layer only; the
 *  library `send()` still treats `delayMs` literally (undefined/0 = no spacing). */
export const DEFAULT_SEQ_DELAY_MS = 300;

/** Resolve the `pty send` inter-item delay in ms from the `--with-delay <sec>`
 *  argument: absent → the 0.3s default; an explicit value (including 0, the
 *  straight-stream escape hatch) → that value. Pure; exported for testing. */
export function resolveSeqDelayMs(withDelaySecs: number | undefined): number {
  return withDelaySecs != null ? Math.round(withDelaySecs * 1000) : DEFAULT_SEQ_DELAY_MS;
}

/** Send data to a session without attaching. Silent on success. */
export function send(options: SendOptions): void {
  const socket = options.socket ?? net.createConnection(getSocketPath(options.name));

  const onReady = async () => {
    if (options.paste && options.data.length > 0) {
      socket.write(encodeData(BRACKETED_PASTE_START));
    }
    for (let i = 0; i < options.data.length; i++) {
      if (i > 0 && options.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      socket.write(encodeData(options.data[i]));
    }
    if (options.paste && options.data.length > 0) {
      socket.write(encodeData(BRACKETED_PASTE_END));
    }
    socket.end();
  };

  // A caller-supplied socket is already connected (dialed + routed over fabric).
  if (options.socket) process.nextTick(onReady);
  else socket.on("connect", onReady);

  let finished = false;

  socket.on("error", (err: NodeJS.ErrnoException) => {
    const notReachable = err.code === "ENOENT" || err.code === "ECONNREFUSED"
      || err.code === "ECONNRESET" || err.code === "EPIPE";
    if (notReachable) {
      console.error(
        options.socket
          ? `Remote session "${options.name}" not found or not running.`
          : `Session "${options.name}" not found or not running.`,
      );
    } else {
      console.error(`Connection error: ${err.message}`);
    }
    process.exit(1);
  });

  socket.on("finish", () => {
    finished = true;
    process.exit(0);
  });

  // Closed before our write finished — the (possibly remote) session isn't
  // reachable (e.g. a `--remote` route to a missing session). Don't exit 0.
  socket.on("close", () => {
    if (!finished) {
      console.error(
        options.socket
          ? `Remote session "${options.name}" not found or not running.`
          : `Session "${options.name}" not found or not running.`,
      );
      process.exit(1);
    }
  });
}

export interface ProcessResources {
  rssKb: number;
  cpuPercent: number;
}

export interface StatsResult {
  name: string;
  terminal: {
    cols: number;
    rows: number;
    cursorX: number;
    cursorY: number;
    scrollbackUsed: number;
    scrollbackCapacity: number;
  };
  process: {
    alive: boolean;
    exitCode: number | null;
    pid: number | null;
    resources: ProcessResources | null;
  };
  daemon: {
    pid: number;
    resources: ProcessResources | null;
  };
  clients: {
    total: number;
    attached: number;
    readOnly: number;
    connections?: Array<
      | {
          role: "writable";
          rows: number;
          cols: number;
          lastRequestSequence: number;
          constrains: { rows: boolean; cols: boolean };
        }
      | {
          role: "readonly";
          constrains: { rows: false; cols: false };
        }
    >;
  };
  modes: {
    sgrMouse: boolean;
    cursorHidden: boolean;
    kittyKeyboard: boolean;
    kittyKeyboardFlags: number[];
  };
  uptimeSeconds: number | null;
  createdAt: string | null;
}

/** Query live stats from a running session. */
export function queryStats(name: string, timeoutMs = 2000): Promise<StatsResult> {
  return new Promise((resolve, reject) => {
    const socketPath = getSocketPath(name);
    const reader = new PacketReader();
    const socket = net.createConnection(socketPath);

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timeout querying stats for "${name}"`));
    }, timeoutMs);

    socket.on("connect", () => {
      socket.write(encodeStatus());
    });

    socket.on("data", (data: Buffer) => {
      let packets;
    try { packets = reader.feed(data); } catch (err: any) {
      console.error(`pty client: dropping connection — ${err.message}`);
      try { socket.destroy(); } catch {}
      return;
    }
      for (const packet of packets) {
        if (packet.type === MessageType.STATUS) {
          clearTimeout(timer);
          socket.destroy();
          try {
            resolve(JSON.parse(packet.payload.toString()));
          } catch {
            reject(new Error(`Invalid stats response from "${name}"`));
          }
          return;
        }
      }
    });

    socket.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
        reject(new Error(`Session "${name}" not found or not running.`));
      } else {
        reject(new Error(`Connection error: ${err.message}`));
      }
    });
  });
}

export interface AttachOptions {
  name: string;
  onExit?: (code: number) => void;
  onDetach?: () => void;
  /** Attach over this ALREADY-CONNECTED socket instead of dialing the local
   *  `<name>.sock`. Used by `attach --remote`: a fabric-dialed, control-server-
   *  routed socket. When set, `name` is only used for display. */
  socket?: net.Socket;
  /** Re-establish the (routed) socket after a loud disconnect — e.g. for
   *  `attach --remote`. Contract:
   *   - RESOLVE a socket → reconnected; re-attach over it.
   *   - RESOLVE null → transient/transport failure (host unreachable) → keep
   *     retrying with backoff (unlimited by default — a roaming laptop can
   *     reopen hours later).
   *   - REJECT → clean give-up: the host is reachable but the session is gone.
   *  A recoverable stall keeps the socket open (no close event), so reconnect
   *  fires only on a genuine close (fabric's loud give-up), never on a stall. */
  reconnect?: () => Promise<net.Socket | null>;
  /** Write the ordered v1 machine attach stream to this caller-owned inherited
   *  descriptor. stdin/stdout remain the controlling terminal for input and
   *  geometry; terminal output is emitted only as framed protocol packets. */
  attachStreamFdV1?: number;
  metadata?: SessionMetadata | null;
  row?: RemoteSessionRow;
  peer?: string;
}

/** Validate a dedicated inherited descriptor without taking ownership of it. */
export function validateAttachStreamFdV1(fd: number): void {
  if (!Number.isSafeInteger(fd) || fd < 3) {
    throw new Error(
      `--attach-stream-fd-v1 requires a dedicated inherited file descriptor >= 3 (got ${fd})`,
    );
  }
  try {
    fs.fstatSync(fd);
    fs.writeSync(fd, Buffer.alloc(0));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`--attach-stream-fd-v1 descriptor ${fd} is not writable: ${detail}`);
  }
}

/** Backoff schedule for `attach --remote` reconnect attempts, then a cap. */
const RECONNECT_BACKOFF_MS = [100, 250, 500, 1000, 2000, 5000, 10000];
const RECONNECT_BACKOFF_CAP_MS = 15000;
/** Consecutive transport-failure attempts before giving up. Default: UNLIMITED
 *  while the terminal is open — the faithful roaming behavior (close the laptop,
 *  travel, reopen, and it comes back; the user stops it with Ctrl-\ / Ctrl-C).
 *  A reachable-but-gone session gives up cleanly regardless (a rejected reconnect,
 *  see AttachOptions.reconnect). Env-overridable for a finite bound in scripts. */
const RECONNECT_MAX_ATTEMPTS = (() => {
  const raw = Number(process.env.PTY_RECONNECT_MAX_ATTEMPTS);
  return Number.isInteger(raw) && raw > 0 ? raw : Infinity;
})();

export function attach(options: AttachOptions): void {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const canReconnect = !!options.reconnect;
  const attachStreamFd = options.attachStreamFdV1;
  if (attachStreamFd !== undefined) validateAttachStreamFdV1(attachStreamFd);

  // `socket` is mutable: the reconnect loop swaps in a fresh routed socket, and
  // the (once-wired) input handlers write to whichever socket is current.
  let socket: net.Socket = options.socket ?? net.createConnection(getSocketPath(options.name));
  const firstPreConnected = !!options.socket;
  let reader = new PacketReader();

  let detaching = false;
  let rawWasSet = false;
  let exitCode = 0;
  let protocolFailed = false;
  let exitHandled = false;
  let exitCompleted = false;
  let sessionExited = false; // saw an EXIT packet — the session really ended; don't reconnect
  let reconnecting = false;
  let inputWired = false;
  let stdinDataHandler: ((data: Buffer) => void) | null = null;
  let resizeHandler: (() => void) | null = null;
  let machineInitialState: "geometry" | "screen" | "ready" = "geometry";
  let streamBackpressured = false;
  const attachStream = attachStreamFd === undefined
    ? null
    : fs.createWriteStream("", { fd: attachStreamFd, autoClose: false });

  function enterRawMode(): void {
    if (stdin.isTTY && !stdin.isRaw) { stdin.setRawMode(true); rawWasSet = true; }
  }
  function exitRawMode(): void {
    if (rawWasSet && stdin.isTTY) stdin.setRawMode(false);
  }
  function teardownInput(): void {
    if (stdinDataHandler) { stdin.removeListener("data", stdinDataHandler); stdinDataHandler = null; }
    if (resizeHandler && stdout instanceof tty.WriteStream) { stdout.removeListener("resize", resizeHandler); resizeHandler = null; }
  }
  function cleanExit(): void {
    teardownInput();
    exitRawMode();
    try { socket.destroy(); } catch {}
  }
  function completeExit(code: number): void {
    if (exitCompleted) return;
    exitCompleted = true;
    if (options.onExit) options.onExit(code); else process.exit(code);
  }
  function finish(code: number): void {
    if (exitHandled) return;
    exitHandled = true;
    cleanExit();
    if (attachStream && !attachStream.destroyed && !attachStream.writableEnded) {
      attachStream.end(() => completeExit(code));
    } else {
      completeExit(code);
    }
  }
  function finishDetach(): void {
    if (exitHandled) return;
    exitHandled = true;
    detaching = true;
    const completeDetach = () => {
      if (exitCompleted) return;
      exitCompleted = true;
      options.onDetach?.();
    };
    if (attachStream && !attachStream.destroyed && !attachStream.writableEnded) {
      attachStream.write(encodeDetach());
      try { socket.write(encodeDetach()); } catch {}
      cleanExit();
      attachStream.end(completeDetach);
    } else {
      try { socket.write(encodeDetach()); } catch {}
      cleanExit();
      stdout.write(trailer(options, `[detached from ${options.name}]`,
        `reattach: pty attach ${options.peer ? `--remote ${options.peer} ` : ""}${options.name}`));
      completeDetach();
    }
  }

  attachStream?.on("error", (error) => {
    console.error(`pty attach: machine stream descriptor ${attachStreamFd} failed: ${error.message}`);
    if (exitHandled) {
      cleanExit();
      completeExit(1);
    } else {
      finish(1);
    }
  });

  // Wire stdin/resize forwarding ONCE. Handlers write to the CURRENT `socket`,
  // so they keep working after the reconnect loop swaps the socket.
  function wireInput(): void {
    if (inputWired) return;
    inputWired = true;
    let lastDetachKeyTime = 0;
    const DOUBLE_TAP_MS = 300;
    stdinDataHandler = (raw: Buffer) => {
      const data = normalizeDetachKey(raw);
      // Fast path: no detach key in this chunk
      if (data.indexOf(DETACH_KEY) === -1) { try { socket.write(encodeData(data.toString())); } catch {} return; }
      // Slow path: detach key found — process byte by byte
      const forward: number[] = [];
      for (let i = 0; i < data.length; i++) {
        if (data[i] === DETACH_KEY) {
          const now = Date.now();
          if (now - lastDetachKeyTime < DOUBLE_TAP_MS) {
            // Double-tap: send Ctrl+\ to the process, reset timer
            lastDetachKeyTime = 0;
            forward.push(DETACH_KEY);
          } else {
            // First tap: schedule detach (will fire if no second tap)
            lastDetachKeyTime = now;
            setTimeout(() => {
              if (lastDetachKeyTime === now) {
                finishDetach();
              }
            }, DOUBLE_TAP_MS);
          }
        } else {
          forward.push(data[i]);
        }
      }
      if (forward.length > 0) { try { socket.write(encodeData(Buffer.from(forward).toString())); } catch {} }
    };
    stdin.on("data", stdinDataHandler);
    // Explicitly resume stdin — see the note on readline leaving flowing=false.
    stdin.resume();
    if (stdout instanceof tty.WriteStream) {
      resizeHandler = () => { try { socket.write(encodeResize(stdout.rows, stdout.columns)); } catch {} };
      stdout.on("resize", resizeHandler);
    }
  }

  function onReady(): void {
    enterRawMode();
    const rows = (stdout as tty.WriteStream).rows ?? 24;
    const cols = (stdout as tty.WriteStream).columns ?? 80;
    try { socket.write(encodeAttach(rows, cols)); } catch {}
    wireInput();
  }

  function handleData(data: Buffer): void {
    let packets;
    try { packets = reader.feed(data); }
    catch (err: any) {
      protocolFailed = true;
      console.error(`pty client: dropping connection — ${err.message}`);
      try { socket.destroy(); } catch {}
      return;
    }
    for (const packet of packets) {
      if (attachStream) {
        const isStreamEvent =
          packet.type === MessageType.GEOMETRY ||
          packet.type === MessageType.SCREEN ||
          packet.type === MessageType.DATA ||
          packet.type === MessageType.EXIT;
        if (!isStreamEvent) continue;
        if (machineInitialState === "geometry" && packet.type !== MessageType.GEOMETRY) {
          console.error(
            "pty attach: daemon does not support attach stream v1 (expected GEOMETRY before terminal events)",
          );
          finish(1);
          return;
        }
        if (
          machineInitialState === "screen" &&
          packet.type !== MessageType.GEOMETRY &&
          packet.type !== MessageType.SCREEN
        ) {
          console.error(
            `pty attach: daemon does not support attach stream v1 (expected SCREEN before ${packet.type === MessageType.DATA ? "DATA" : "EXIT"})`,
          );
          finish(1);
          return;
        }
        if (machineInitialState === "geometry" && packet.type === MessageType.GEOMETRY) {
          machineInitialState = "screen";
        } else if (machineInitialState === "screen" && packet.type === MessageType.SCREEN) {
          machineInitialState = "ready";
        }
        if (!attachStream.write(encodePacket(packet.type, packet.payload)) && !streamBackpressured) {
          streamBackpressured = true;
          socket.pause();
          attachStream.once("drain", () => {
            streamBackpressured = false;
            if (!socket.destroyed) socket.resume();
          });
        }
        if (packet.type === MessageType.EXIT) {
          exitCode = decodeExit(packet.payload);
          sessionExited = true;
          finish(exitCode);
          return;
        }
        continue;
      }
      switch (packet.type) {
        case MessageType.DATA:
          stdout.write(packet.payload);
          break;
        case MessageType.SCREEN:
          // Clear screen and write the replayed buffer (also how a reconnect resumes).
          stdout.write("\x1b[2J\x1b[H");
          stdout.write(packet.payload);
          break;
        case MessageType.EXIT:
          exitCode = decodeExit(packet.payload);
          sessionExited = true; // real exit — never reconnect past it
          const info = trailerInfo(options);
          const restart = !options.peer && info && !shouldReapAtExit(info.tags, info.ephemeral ?? false, reapOnExitDefault());
          cleanExit();
          stdout.write(trailer(options, exitHeader(options.name, exitCode, info),
            restart ? `restart: pty attach ${options.name}` : undefined));
          finish(exitCode);
          return;
      }
    }
  }

  function handleDisconnect(err?: NodeJS.ErrnoException): void {
    if (exitHandled || detaching || reconnecting) return;
    if (canReconnect && !sessionExited) { void reconnectLoop(); return; }
    // No reconnect: preserve the original not-found / exit-code behavior.
    if (err) {
      cleanExit();
      if (attachStream && !sessionExited) {
        console.error(`pty attach: machine stream truncated before EXIT: ${err.message}`);
        finish(1);
        return;
      }
      const notReachable = err.code === "ENOENT" || err.code === "ECONNREFUSED"
        || err.code === "ECONNRESET" || err.code === "EPIPE";
      if (notReachable) {
        console.error(options.socket
          ? `Remote session "${options.name}" not found or not running.`
          : `Session "${options.name}" not found or not running.`);
      } else {
        console.error(`Connection error: ${err.message}`);
      }
      finish(1);
    } else {
      if (attachStream && !sessionExited) {
        console.error("pty attach: machine stream truncated before EXIT: connection closed");
        finish(1);
      } else {
        if (!sessionExited && !protocolFailed) {
          cleanExit();
          stdout.write(trailer(options, `[${options.name} session ended]`));
        }
        finish(exitCode);
      }
    }
  }

  function bindSocket(s: net.Socket, preConnected: boolean): void {
    reader = new PacketReader();
    protocolFailed = false;
    machineInitialState = "geometry";
    if (streamBackpressured) s.pause();
    s.on("data", handleData);
    s.on("error", (err: NodeJS.ErrnoException) => handleDisconnect(err));
    s.on("close", () => handleDisconnect());
    if (preConnected) process.nextTick(onReady);
    else s.on("connect", onReady);
  }

  // Re-establish the routed socket on a loud disconnect and re-attach; the
  // daemon replays screen+modes so the session resumes. Only reached when
  // `options.reconnect` is set (attach --remote) and the session didn't EXIT.
  async function reconnectLoop(): Promise<void> {
    if (reconnecting) return;
    reconnecting = true;
    const status = attachStream ? process.stderr : stdout;
    status.write(`\r\n[reconnecting… — Ctrl-\\ or Ctrl-C to stop]\r\n`);
    let attempt = 0;
    while (!detaching && !exitHandled) {
      const delay = RECONNECT_BACKOFF_MS[attempt] ?? RECONNECT_BACKOFF_CAP_MS;
      await new Promise((r) => setTimeout(r, delay));
      if (detaching || exitHandled) break;
      let fresh: net.Socket | null = null;
      try {
        fresh = await options.reconnect!();
      } catch {
        // Reject = reachable host that says the session is gone → clean give-up.
        // (Transport failures resolve null, so we keep retrying below.)
        if (detaching || exitHandled) break;
        reconnecting = false;
        cleanExit();
        status.write(attachStream
          ? `[${options.name} session ended]\n`
          : trailer(options, `[${options.name} session ended]`));
        finish(attachStream ? 1 : 0);
        return;
      }
      if (detaching || exitHandled) { try { fresh?.destroy(); } catch {} break; }
      if (fresh) {
        socket = fresh; // input handlers now target the fresh socket
        reconnecting = false;
        bindSocket(fresh, true); // pre-connected; onReady → encodeAttach → daemon SCREEN replay
        return;
      }
      // Transport failure (host unreachable) — retry, unlimited by default so a
      // laptop closed for hours still reconnects on reopen. Only a finite env cap
      // ends it (besides the user's Ctrl-\ / Ctrl-C).
      if (++attempt >= RECONNECT_MAX_ATTEMPTS) {
        reconnecting = false;
        cleanExit();
        status.write(attachStream
          ? `[connection lost to ${options.name}]\n`
          : trailer(options, `[connection lost to ${options.name}]`,
            `reconnect: pty attach --remote ${options.peer} ${options.name}`));
        finish(1);
        return;
      }
    }
  }

  bindSocket(socket, firstPreConnected);
}
