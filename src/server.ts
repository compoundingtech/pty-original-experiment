import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as pty from "node-pty";
// @xterm/headless is CJS-only, so keep its default import. The serialize addon
// ships native ESM with named exports, so import its runtime namespace.
import type { Terminal } from "@xterm/headless";
import type { SerializeAddon } from "@xterm/addon-serialize";
import xterm from "@xterm/headless";
import * as xtermSerialize from "@xterm/addon-serialize";
import {
  MessageType,
  PacketReader,
  encodeData,
  encodeExit,
  encodeScreen,
  encodeStatusResponse,
  encodeGeometry,
  encodeAcceptedSocketOwnershipResponse,
  encodeLifecycleCompareAndSetResponse,
  decodeAcceptedSocketOwnershipRequest,
  decodeLifecycleCompareAndSetRequest,
  decodeSize,
  type AcceptedSocketOwnershipRequest,
  type AcceptedSocketOwnershipResult,
  type LifecycleCompareAndSetRequest,
  type LifecycleCompareAndSetResult,
} from "./protocol.ts";
import {
  getSocketPath,
  getPidPath,
  getMetadataPath,
  getSessionDir,
  ensureSessionDir,
  cleanupOwnedSocket,
  cleanupOwnedAll,
  writeMetadata,
  readMetadata,
  mutateMetadataUnderLock,
  compareAndSetTagValue,
  shouldReapAtExit,
  reapOnExitDefault,
  SESSION_EXIT_LAST_LINES_LIMIT,
  type SessionMetadata,
  type MetadataMutationResult,
} from "./sessions.ts";
import { EventWriter, clearEvents, EventType, type EventRecord } from "./events.ts";
import {
  RECOVERY_PROTOCOL,
  assertPrivateRecoveryPaths,
  atomicWritePrivate,
  ensureRecoveryDir,
  launchIdentity,
  metadataRevision,
  publishPrivateNoReplace,
  readBoundedJson,
  readProcessStartToken,
  recoveryDir,
  recoveryLockContents,
  recoveryLockIdentity,
  recoveryRequestPath,
  recoveryRevisionPath,
  recoveryResultPath,
  signRecoveryRevision,
  signRecoveryResult,
  stampRecoveryMetadata,
  verifyRecoveryRequest,
  verifyRecoveryRevision,
  type RecoveryCapability,
  type RecoveryRequest,
  type RecoveryRevision,
  type RecoveryResultPayload,
} from "./recovery.ts";
import type { StatsResult } from "./client.ts";
import {
  freezeDescendantProcesses,
  signalProcessIdentities,
  snapshotDescendantProcessesComplete,
  terminateProcessGroup,
  terminateProcessIdentities,
  type ProcessIdentity,
} from "./process-tree.ts";
import { inspectAcceptedSocketOwnershipAsync } from "./socket-ownership.ts";
import {
  armStartupLease,
  startupLeaseDeadlineCause,
  remainingLeaseDelayMs,
  systemMonotonicClock,
  terminalStartupLeaseValue,
  type ArmedStartupLease,
  type StartupLeaseOptions,
  type StartupLeaseTerminalCause,
} from "./startup-lease.ts";

interface Client {
  socket: net.Socket;
  reader: PacketReader;
  rows: number;
  cols: number;
  readonly: boolean;
  attachSeq: number;
  /** DATA/EXIT must not overtake the SCREEN baseline for ATTACH or PEEK. */
  initialScreenPhase: "live" | "settling" | "cutting";
  /** Invalidates a delayed SCREEN when the same socket changes attach mode. */
  initialScreenGeneration: number;
  postCutPackets: Array<{
    type: typeof MessageType.DATA | typeof MessageType.EXIT;
    packet: Buffer;
  }>;
}

const jsonRecord = (payload: Buffer): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(payload.toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
};

export interface ServerOptions {
  name: string;
  generation?: string;
  command: string;
  args: string[];
  displayCommand: string;
  cwd: string;
  rows: number;
  cols: number;
  ephemeral?: boolean;
  tags?: Record<string, string>;
  /** Optional human-friendly alias recorded in SessionMetadata.displayName.
   *  Mutable via `pty rename`; `name` stays the immutable stable id. */
  displayName?: string;
  onExit?: (code: number) => void;
  /** When true, spawn the child with a scrubbed environment containing only
   *  a small allow-list of variables (plus any entries in `extraEnv`).
   *  Intended for contexts where the daemon may have inherited secrets that
   *  shouldn't leak into the session (e.g., a daemon launched by pty-relay
   *  for a remote client). See BUG-4. */
  isolateEnv?: boolean;
  /** Additional `KEY=VALUE` env entries overlaid on the inherited child
   *  environment, or on the safe allow-list when `isolateEnv` is true. */
  extraEnv?: Record<string, string>;
  /** Environment keys removed from the inherited child environment. Applied
   *  before `extraEnv`, so an explicit assignment wins when both mention a key. */
  unsetEnv?: string[];
  /** Use this env dict verbatim for the spawned child — no inheritance from
   *  the daemon's `process.env`, no allow-list. `PTY_SESSION` and the opaque
   *  `PTY_SESSION_GENERATION` owner token are always injected on top so
   *  nesting detection and generation-safe `pty exec` keep working.
   *
   *  Mutually exclusive with `isolateEnv` / `extraEnv` / `unsetEnv` — passing
   *  `env` together with inherited-environment policy throws. Use this when
   *  the caller wants total control of the child environment (e.g., a
   *  launcher shell that injects a shim tmux on `PATH`). */
  env?: Record<string, string>;
  /** Optional daemon-owned hard startup deadline. The daemon publishes the
   *  generation, boot identity, and absolute monotonic deadline in this tag. */
  startupLease?: StartupLeaseOptions;
  /** Called only after the current generation wins the deadline transition. */
  onStartupLeaseDeadline?: () => void;
}

/** Env variables that are safe to pass through to a session child when
 *  `isolateEnv` is on. Keeps terminal/locale/path functionality working
 *  without propagating the operator's shell secrets. */
const ISOLATED_ENV_ALLOWLIST = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL",
  "TERM", "COLORTERM", "LANG", "TZ", "PWD", "TMPDIR",
  // pty-internal
  "PTY_ROOT",
  "PTY_SESSION_DIR",
]);

/** Fallback TERM for child PTYs when no value was inherited. `xterm-256color`
 *  is the lowest common denominator every modern TUI knows how to drive; the
 *  kitty keyboard / modifyOtherKeys handshakes are dynamic CSI probes that
 *  work fine on top of it. Important specifically for daemons launched from
 *  a parent with a minimal env (launchd, systemd, cron, sparse CI runners) —
 *  those contexts drop TERM entirely, and a child without TERM causes many
 *  TUIs (Claude Code, vim, etc.) to fall back to legacy key encoding where
 *  Shift+Enter is indistinguishable from Enter. */
const DEFAULT_CHILD_TERM = "xterm-256color";

/** Apply the TERM default in-place after the env has been assembled. Never
 *  overrides an explicit value — only fills in when it's absent. */
function ensureChildTerm(env: Record<string, string>): void {
  if (!env.TERM) env.TERM = DEFAULT_CHILD_TERM;
}

function buildChildEnv(options: ServerOptions): Record<string, string> {
  // Mutual exclusion: `env` (explicit, verbatim) can't be combined with the
  // inherited-environment policy path. If you want total control you pass
  // `env`; otherwise isolation/removals/assignments compose explicitly. Picking
  // one implicitly would hide intent.
  if (options.env && (options.isolateEnv || options.extraEnv || options.unsetEnv?.length)) {
    throw new Error(
      "ServerOptions.env is mutually exclusive with isolateEnv/extraEnv/unsetEnv. " +
      "Use env for verbatim control, or inherited environment policy options — not both."
    );
  }

  // Explicit verbatim env. No inheritance. PTY's identity and owner token are
  // forced on top so internal tooling can fail closed across same-id reuse.
  if (options.env) {
    const env = { ...options.env };
    env.PTY_SESSION = options.name;
    if (options.generation) env.PTY_SESSION_GENERATION = options.generation;
    ensureChildTerm(env);
    return env;
  }

  const source = process.env as Record<string, string>;

  if (!options.isolateEnv) {
    // Legacy behaviour: full inheritance, minus the server-config handoff.
    const env = { ...source };
    delete env.PTY_SERVER_CONFIG;
    for (const key of options.unsetEnv ?? []) delete env[key];
    if (options.extraEnv) {
      for (const [k, v] of Object.entries(options.extraEnv)) env[k] = v;
    }
    env.PTY_SESSION = options.name;
    if (options.generation) env.PTY_SESSION_GENERATION = options.generation;
    ensureChildTerm(env);
    return env;
  }

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    if (ISOLATED_ENV_ALLOWLIST.has(k) || k.startsWith("LC_")) env[k] = v;
  }
  for (const key of options.unsetEnv ?? []) delete env[key];
  if (options.extraEnv) {
    for (const [k, v] of Object.entries(options.extraEnv)) env[k] = v;
  }
  env.PTY_SESSION = options.name;
  if (options.generation) env.PTY_SESSION_GENERATION = options.generation;
  ensureChildTerm(env);
  return env;
}

export interface ProcessResources {
  rssKb: number;       // Resident set size in KB
  cpuPercent: number;  // CPU usage percentage
}

/** Query CPU and memory usage for a process via ps. Returns null on failure. */
function queryProcessResources(pid: number): ProcessResources | null {
  try {
    // The only per-pid `ps` left in the daemon, and only off Linux. Resident
    // set and CPU are not in `/proc/<pid>/stat` in the form this wants, and a
    // stats query is one call for one session rather than one per descendant
    // inside a loop.
    const output = execFileSync("ps", ["-o", "rss=,pcpu=", "-p", String(pid)], {
      encoding: "utf-8",
      timeout: 1000,
    }).trim();
    const parts = output.split(/\s+/);
    if (parts.length < 2) return null;
    return {
      rssKb: parseInt(parts[0], 10),
      cpuPercent: parseFloat(parts[1]),
    };
  } catch {
    return null;
  }
}

/** Validate that cwd is usable for spawning a process. Returns undefined if
 *  valid, or a descriptive error string explaining what's wrong. */
function describeInvalidCwd(cwd: string): string | undefined {
  if (cwd.length === 0) return "Working directory is empty.";

  let stats: fs.Stats;
  try {
    stats = fs.statSync(cwd);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return `Working directory does not exist: ${cwd}`;
    }
    return `Working directory is not accessible: ${cwd} (${err?.message ?? String(err)})`;
  }

  if (!stats.isDirectory()) {
    return `Working directory is not a directory: ${cwd}`;
  }

  try {
    fs.accessSync(cwd, fs.constants.X_OK);
  } catch {
    return `Working directory is not searchable: ${cwd}`;
  }

  return undefined;
}

/** Strip terminal query sequences that should not be forwarded to clients.
 *  Exported for unit testing. */
export function stripTerminalQueries(data: string): string {
  return data
    .replace(/\x1b\]1[01];\?\x07/g, "")           // OSC 10/11 with BEL
    .replace(/\x1b\]1[01];\?\x1b\\/g, "")         // OSC 10/11 with ST
    .replace(/\x1b\]4;\d+;\?\x07/g, "")           // OSC 4 with BEL
    .replace(/\x1b\]4;\d+;\?\x1b\\/g, "")         // OSC 4 with ST
    .replace(/\x1b\[c/g, "")                       // DA1
    .replace(/\x1b\[>c/g, "")                      // DA2
    .replace(/\x1b\[6n/g, "")                      // DSR cursor position
    .replace(/\x1b\[>0q/g, "");                    // XTVERSION
}

export class PtyServer {
  private terminal: Terminal;
  private serialize: SerializeAddon;
  private ptyProcess: pty.IPty;
  private socketServer: net.Server;
  private retiredSocketServers: net.Server[] = [];
  private clients = new Map<net.Socket, Client>();
  private exited = false;
  private exitCode = 0;
  /** Epoch ms of the last PTY output chunk this daemon processed. Stamped in
   *  the onData path (O(1) — the chunk is already being parsed), persisted to
   *  session metadata through the debounced `scheduleActivityPersist` so a
   *  chatty session costs at most one metadata write per second. Consumers
   *  (st2 observed harness state) read the persisted value to derive session
   *  activity; this field is the in-memory source of truth between persists. */
  private lastOutputAtMs = 0;
  private activityPersistScheduled = false;
  private name: string;
  private options: ServerOptions;
  private attachCounter = 0;
  private sgrMouseMode = false;
  private cursorHidden = false;
  private kittyKeyboardStack: number[] = [];
  // Alt-screen buffer state (DEC private modes ?1049 / ?1047 / ?47). Set when
  // the child process enters the alternate screen buffer; cleared when it
  // leaves. Replayed to attaching clients so the SCREEN snapshot lands in the
  // right host-terminal buffer — without this, a TUI's alt-screen frames get
  // painted into the host's main buffer, which under tmux means every frame
  // enters scrollback (see #41).
  private altScreenActive = false;
  // Mouse tracking modes — these are separate DEC private modes (set/cleared
  // independently by the child process) that control WHICH events the
  // terminal should report. SGR mode (1006) only controls the ENCODING of
  // reports, not whether tracking is active. Clients attaching to a session
  // that's already mid-stream need all active modes replayed so their own
  // mouse forwarding logic sees the correct state.
  private mouseTracking1000 = false; // button press/release tracking
  private mouseTracking1002 = false; // button-motion tracking
  private mouseTracking1003 = false; // any-motion tracking
  private lastResizeTime = 0;
  private eventWriter: EventWriter;
  private generation: string;
  private startupLease: ArmedStartupLease | null = null;
  private startupLeaseTimer: NodeJS.Timeout | null = null;
  private startupLeaseDisarmed = false;
  private startupLeaseTerminalCause: StartupLeaseTerminalCause | null = null;
  private startupLeaseDeadlineNotified = false;
  private startupLeaseDeadlineNotificationPending = false;
  private startupLeaseDeadlineResponseReleased = false;
  private startupLeaseTerminalValue: string | null = null;
  private recoveryCapability: RecoveryCapability | null = null;
  private recoveryRoot = "";
  private recoveryInFlight = false;
  private recoveryWatcher: fs.FSWatcher | null = null;
  private lastTitle = "";
  private shutdownDescendants: ProcessIdentity[] = [];
  private shutdownTreeUnavailable: string | null = null;
  private shutdownTreeSnapshotted = false;
  readonly ready: Promise<void>;
  // Resolves when the child process's onExit has fired — used by close() to
  // make sure session_exit has been queued to the event chain before we
  // flush and exit the daemon. See flake #2.
  private childExited: Promise<void>;
  private resolveChildExited!: () => void;

  constructor(options: ServerOptions) {
    this.name = options.name;
    this.options = options;
    this.generation = options.generation ?? randomBytes(16).toString("hex");
    if (options.startupLease) {
      this.startupLease = armStartupLease(options.startupLease, this.generation);
    }
    this.eventWriter = new EventWriter(options.name);
    this.childExited = new Promise<void>((resolve) => {
      this.resolveChildExited = resolve;
    });

    // Set up xterm-headless for screen buffer tracking
    this.terminal = new xterm.Terminal({
      rows: options.rows,
      cols: options.cols,
      scrollback: 10000,
      allowProposedApi: true,
    });
    this.serialize = new xtermSerialize.SerializeAddon();
    this.terminal.loadAddon(this.serialize);

    // Track terminal modes not exposed by xterm's serialize addon
    this.terminal.parser.registerCsiHandler(
      { prefix: "?", final: "h" },
      (params) => {
        for (const p of params) {
          const v = typeof p === "number" ? p : p[0];
          if (v === 1006) this.sgrMouseMode = true;
          if (v === 1000) this.mouseTracking1000 = true;
          if (v === 1002) this.mouseTracking1002 = true;
          if (v === 1003) this.mouseTracking1003 = true;
          if (v === 1049 || v === 1047 || v === 47) this.altScreenActive = true;
          if (v === 25) {
            if (this.cursorHidden) this.emitEvent(EventType.CURSOR_VISIBLE);
            this.cursorHidden = false;
          }
          if (v === 1004) this.emitEvent(EventType.FOCUS_REQUEST);
        }
        return false;
      }
    );
    this.terminal.parser.registerCsiHandler(
      { prefix: "?", final: "l" },
      (params) => {
        for (const p of params) {
          const v = typeof p === "number" ? p : p[0];
          if (v === 1006) this.sgrMouseMode = false;
          if (v === 1000) this.mouseTracking1000 = false;
          if (v === 1002) this.mouseTracking1002 = false;
          if (v === 1003) this.mouseTracking1003 = false;
          if (v === 1049 || v === 1047 || v === 47) this.altScreenActive = false;
          if (v === 25) this.cursorHidden = true;
        }
        return false;
      }
    );
    this.terminal.parser.registerCsiHandler(
      { prefix: ">", final: "u" },
      (params) => {
        const flags = typeof params[0] === "number" ? params[0] : params[0][0];
        this.kittyKeyboardStack.push(flags);
        return false;
      }
    );
    this.terminal.parser.registerCsiHandler(
      { prefix: "<", final: "u" },
      () => {
        this.kittyKeyboardStack.pop();
        return false;
      }
    );

    // Respond to DA1 (Primary Device Attribute) queries from the child process.
    // Shells like fish 4.x send ESC[c at startup and block for up to 10s waiting
    // for a response. Since xterm-headless doesn't reply, we intercept the query
    // in the output stream and write a VT220 response back to the pty process.
    this.terminal.parser.registerCsiHandler(
      { final: "c" },
      (params) => {
        if (params.length === 0 || params[0] === 0) {
          this.ptyProcess.write("\x1b[?62;22c");
        }
        return false;
      }
    );

    // ── Event detection ──

    this.terminal.onBell(() => {
      this.emitEvent(EventType.BELL);
    });

    this.terminal.onTitleChange((title: string) => {
      if (title !== this.lastTitle) {
        this.lastTitle = title;
        this.emitEvent(EventType.TITLE_CHANGE, { value: title });
      }
    });

    // iTerm2 desktop notification (OSC 9)
    this.terminal.parser.registerOscHandler(9, (data: string) => {
      this.emitEvent(EventType.NOTIFICATION, { body: data, source: "osc9" });
      return false;
    });

    // Kitty notification (OSC 99) — key=value;key=value payload
    this.terminal.parser.registerOscHandler(99, (data: string) => {
      const fields: Record<string, string> = {};
      for (const part of data.split(";")) {
        const eq = part.indexOf("=");
        if (eq !== -1) {
          fields[part.slice(0, eq)] = part.slice(eq + 1);
        }
      }
      this.emitEvent(EventType.NOTIFICATION, {
        title: fields["title"] ?? fields["t"],
        body: fields["body"] ?? fields["b"],
        source: "osc99",
      });
      return false;
    });

    // rxvt notification (OSC 777) — notify;title;body
    this.terminal.parser.registerOscHandler(777, (data: string) => {
      const parts = data.split(";");
      if (parts[0] === "notify" && parts.length >= 2) {
        this.emitEvent(EventType.NOTIFICATION, {
          title: parts[1],
          body: parts.slice(2).join(";"),
          source: "osc777",
        });
      }
      return false;
    });

    // ── Terminal query responses ──
    // Programs send queries expecting the terminal to respond on stdin.
    // xterm-headless doesn't answer, so the query leaks to the client's
    // real terminal, whose response comes back as garbage input. We
    // intercept common queries and respond directly to the PTY process.

    // OSC 10: foreground color query (less, vim)
    // Return true to consume the sequence so it doesn't leak to clients.
    this.terminal.parser.registerOscHandler(10, (data: string) => {
      if (data === "?") {
        this.ptyProcess.write("\x1b]10;rgb:c0c0/c0c0/c0c0\x1b\\");
        return true; // consume — don't pass to client
      }
      return false;
    });
    // OSC 11: background color query (less, vim)
    this.terminal.parser.registerOscHandler(11, (data: string) => {
      if (data === "?") {
        this.ptyProcess.write("\x1b]11;rgb:0000/0000/0000\x1b\\");
        return true;
      }
      return false;
    });
    // OSC 4: palette color query (vim, emacs)
    this.terminal.parser.registerOscHandler(4, (data: string) => {
      if (data.includes("?")) {
        const idx = parseInt(data, 10);
        if (!isNaN(idx)) {
          this.ptyProcess.write(`\x1b]4;${idx};rgb:0000/0000/0000\x1b\\`);
        }
        return true;
      }
      return false;
    });
    // DA2: secondary device attributes (vim, tmux)
    this.terminal.parser.registerCsiHandler(
      { prefix: ">", final: "c" },
      (_params) => {
        // Respond as xterm version 382
        this.ptyProcess.write("\x1b[>0;382;0c");
        return false;
      }
    );
    // DSR: cursor position query (CSI 6 n, vim, readline)
    this.terminal.parser.registerCsiHandler(
      { final: "n" },
      (params) => {
        if (params.length === 1 && params[0] === 6) {
          const buf = this.terminal.buffer.active;
          this.ptyProcess.write(`\x1b[${buf.cursorY + 1};${buf.cursorX + 1}R`);
        }
        return false;
      }
    );
    // XTVERSION: terminal version query (CSI > 0 q, vim)
    this.terminal.parser.registerCsiHandler(
      { prefix: ">", final: "q" },
      (_params) => {
        this.ptyProcess.write("\x1bP>|pty(0.8)\x1b\\");
        return false;
      }
    );

    // Spawn the child process in a PTY via a shell, so that shell scripts,
    // symlinks, and shebangs all work reliably (like tmux/screen do).
    // `exec "$@"` replaces the shell with the actual process.
    const childEnv = buildChildEnv({ ...options, generation: this.generation });

    const invalidCwd = describeInvalidCwd(options.cwd);
    if (invalidCwd !== undefined) {
      throw new Error(
        `${invalidCwd}\nCannot start session "${options.name}" for command "${options.command}".`
      );
    }

    // Publish the owner sidecar BEFORE spawning the child (issue #180). The
    // child can otherwise run ancestry checks before the pidfile exists —
    // the listen callback used to be its first publication point, after the
    // spawn. Written while `pty run` still holds the creation lock, so no
    // competing writer can interleave.
    ensureSessionDir();
    fs.writeFileSync(getPidPath(options.name), process.pid.toString());

    try {
      // NOTE: intentionally no `name:` option here — node-pty's `name`
      // unconditionally clobbers env.TERM, which would hide any TERM the
      // caller inherited or set explicitly. `buildChildEnv` guarantees
      // childEnv.TERM is populated (defaulting to xterm-256color if absent),
      // so node-pty will pick it up naturally. Was `name: "xterm-256color"`
      // before; removing it lets inherited values like `xterm-kitty` flow
      // through and lets TUIs negotiate the richer capabilities they allow.
      this.ptyProcess = pty.spawn(
        "/bin/sh",
        ["-c", 'exec "$@"', "sh", options.command, ...options.args],
        {
          cols: options.cols,
          rows: options.rows,
          cwd: options.cwd,
          env: childEnv as Record<string, string>,
        }
      );
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (msg.includes("posix_spawnp") || msg.includes("spawn")) {
        throw new Error(
          `Failed to spawn PTY shell "/bin/sh" for command "${options.command}" in cwd "${options.cwd}": ${msg}`
        );
      }
      throw err;
    }

    // Feed PTY output into xterm-headless and broadcast to clients.
    // Query sequences (OSC 10/11, DA1, etc.) are intercepted by parser
    // handlers above and must NOT be forwarded to clients — otherwise the
    // client's terminal responds and its response appears as garbage input.
    this.ptyProcess.onData((data: string) => {
      this.lastOutputAtMs = Date.now();
      this.scheduleActivityPersist();
      this.terminal.write(data);
      const cleaned = stripTerminalQueries(data);
      if (cleaned.length > 0) {
        this.broadcast(MessageType.DATA, encodeData(cleaned));
      }
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      this.exited = true;
      // A signal death (e.g. an OS OOM SIGKILL) arrives from node-pty with a
      // nonzero `signal` and often exitCode 0 — if we recorded only the raw
      // exitCode, a killed process would look like a clean finish and any
      // consumer gating on "nonzero exit" (convoy's crash→ding) would miss it.
      this.settleStartupLease("exit");
      // Surface it the way a shell does: 128 + signal (SIGKILL 9 → 137).
      const code = signal ? 128 + signal : exitCode;
      this.exitCode = code;
      this.broadcast(MessageType.EXIT, encodeExit(code));
      this.emitEvent(EventType.SESSION_EXIT, {
        exitCode: code,
        ...(signal ? { signal } : {}),
      });
      // Save exit status immediately so the session shows as "exited"
      // in pty list during the cleanup window. lastLines may be incomplete
      // here since PTY data could still be in-flight — close() will
      // update with the final output.
      const exitMetadataStatus = this.saveExitMetadata(code);
      if (exitMetadataStatus === "busy" || exitMetadataStatus === "stale") {
        // Startup may still hold the creation lock for this generation. Retry
        // within the existing 500ms client grace so exit metadata is observable
        // before shutdown cleanup, while close() retains the final bounded retry.
        void this.saveExitMetadataUntilSettled(code, 400).catch(() => {});
      }
      this.resolveChildExited();
      options.onExit?.(code);
    });

    // Create Unix socket server
    ensureSessionDir();
    this.recoveryRoot = path.resolve(getSessionDir());
    const processStartToken = readProcessStartToken(process.pid);
    try {
      ensureRecoveryDir(this.recoveryRoot);
      const paths = assertPrivateRecoveryPaths(this.recoveryRoot);
      if (processStartToken === null) throw new Error("process start identity unavailable");
      const identity = launchIdentity({
        command: options.command,
        args: options.args,
        displayCommand: options.displayCommand,
        cwd: options.cwd,
        rows: options.rows,
        cols: options.cols,
        ephemeral: options.ephemeral,
        isolateEnv: options.isolateEnv,
        extraEnv: options.extraEnv,
        env: options.env,
      });
      this.recoveryCapability = {
        protocol: RECOVERY_PROTOCOL,
        secret: randomBytes(32).toString("hex"),
        processStartToken,
        launchIdentity: identity,
        ...paths,
        metadataRevision: "",
      };
      this.startRecoveryWatcher();
    } catch {}
    clearEvents(this.name);
    const socketPath = getSocketPath(this.name);

    // Remove stale socket if it exists
    try {
      fs.unlinkSync(socketPath);
    } catch {}

    this.socketServer = net.createServer((socket) =>
      this.handleClient(socket)
    );
    // Tighten umask around listen() so the socket inode is never transiently
    // group/world-readable (BUG-5). The chmodSync below is kept as
    // belt-and-suspenders for good measure.
    const prevUmask = process.umask(0o077);
    this.ready = new Promise((resolve, reject) => {
      let settled = false;
      this.socketServer.once("error", (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
      this.socketServer.listen(socketPath, () => {
        try { fs.chmodSync(socketPath, 0o600); } catch {}
        const publishedTags: Record<string, string> = Object.assign(
          Object.create(null),
          options.tags ?? {},
        );
        if (this.startupLease) {
          publishedTags[this.startupLease.lifecycleTag] = this.startupLease.startingValue;
        }
        writeMetadata(this.name, {
          generation: this.generation,
          daemonPid: process.pid,
          ...(this.recoveryCapability ? { recovery: this.recoveryCapability } : {}),
          command: options.command,
          args: options.args,
          displayCommand: options.displayCommand,
          cwd: options.cwd,
          rows: options.rows,
          cols: options.cols,
          ephemeral: options.ephemeral === true,
          createdAt: new Date().toISOString(),
          ...(Object.keys(publishedTags).length > 0 ? { tags: publishedTags } : {}),
          ...(options.displayName ? { displayName: options.displayName } : {}),
          ...(options.isolateEnv ? { isolateEnv: true } : {}),
          ...(options.extraEnv && Object.keys(options.extraEnv).length > 0 ? { extraEnv: options.extraEnv } : {}),
          ...(options.unsetEnv && options.unsetEnv.length > 0 ? { unsetEnv: options.unsetEnv } : {}),
          ...(options.env ? { env: options.env } : {}),
        });
        this.emitEvent(EventType.SESSION_START, {
          ...(Object.keys(publishedTags).length > 0 ? { tags: publishedTags } : {}),
        });
        if (this.exited) this.settleStartupLease("exit");
        else this.scheduleStartupLeaseDeadline();
        if (settled) return;
        settled = true;
        resolve();
      });
    });
    process.umask(prevUmask);

    // Post-listen errors (e.g., socket file unlinked out from under us) must
    // not crash the process, but they also mustn't interfere with the
    // initial ready resolution above.
    this.socketServer.on("error", (err) => {
      console.error(`Socket server error: ${err.message}`);
    });
  }

  private startRecoveryWatcher(): void {
    const requestPath = recoveryRequestPath(this.recoveryRoot, this.name);
    this.recoveryWatcher = fs.watch(
      recoveryDir(this.recoveryRoot),
      { persistent: false },
      (_event, filename) => {
        if (
          filename === path.basename(requestPath) &&
          fs.existsSync(requestPath) &&
          !this.recoveryInFlight
        ) {
          void this.handleRecoveryRequest();
        }
      },
    );
  }

  private recoveryMetadata(
    observed: SessionMetadata,
    capability: RecoveryCapability,
  ): SessionMetadata {
    return stampRecoveryMetadata({
      ...observed,
      generation: this.generation,
      daemonPid: process.pid,
      recovery: capability,
    });
  }

  private async handleRecoveryRequest(): Promise<void> {
    const capability = this.recoveryCapability;
    if (!capability || this.recoveryInFlight) return;
    this.recoveryInFlight = true;
    const requestPath = recoveryRequestPath(this.recoveryRoot, this.name);
    const resultPath = recoveryResultPath(this.recoveryRoot, this.name);
    let request: RecoveryRequest | null = null;
    let result: RecoveryResultPayload | null = null;
    try {
      assertPrivateRecoveryPaths(this.recoveryRoot, capability);
      request = readBoundedJson<RecoveryRequest>(requestPath);
      const currentStart = readProcessStartToken(process.pid);
      const metadataCapability = request.metadata?.recovery;
      const lockPath = path.join(this.recoveryRoot, `${this.name}.lock`);
      const lockContents = recoveryLockContents(process.pid, request.lockIdentity);
      const expectedLockIdentity = recoveryLockIdentity({
        name: request.name,
        daemonPid: request.daemonPid,
        processStartToken: request.processStartToken,
        rootDevice: request.rootDevice,
        rootInode: request.rootInode,
        recoveryDirDevice: capability.recoveryDirDevice,
        recoveryDirInode: capability.recoveryDirInode,
      });
      const revision = readBoundedJson<RecoveryRevision>(
        recoveryRevisionPath(this.recoveryRoot, this.name),
      );
      const exact =
        request.protocol === RECOVERY_PROTOCOL &&
        request.name === this.name &&
        request.daemonPid === process.pid &&
        request.generation === this.generation &&
        request.processStartToken === capability.processStartToken &&
        request.launchIdentity === capability.launchIdentity &&
        request.rootDevice === capability.rootDevice &&
        request.rootInode === capability.rootInode &&
        currentStart === capability.processStartToken &&
        request.lockIdentity === expectedLockIdentity &&
        fs.readFileSync(lockPath, "utf8") === lockContents &&
        metadataCapability?.protocol === capability.protocol &&
        metadataCapability.secret === capability.secret &&
        metadataCapability.processStartToken === capability.processStartToken &&
        metadataCapability.launchIdentity === capability.launchIdentity &&
        metadataCapability.rootDevice === capability.rootDevice &&
        metadataCapability.rootInode === capability.rootInode &&
        metadataCapability.recoveryDirDevice === capability.recoveryDirDevice &&
        metadataCapability.recoveryDirInode === capability.recoveryDirInode &&
        metadataCapability.metadataRevision === metadataRevision(request.metadata) &&
        revision.protocol === RECOVERY_PROTOCOL &&
        revision.name === this.name &&
        revision.generation === this.generation &&
        revision.metadataRevision === metadataCapability.metadataRevision &&
        verifyRecoveryRevision(capability.secret, revision) &&
        verifyRecoveryRequest(capability.secret, request);
      if (!exact) throw new Error("recovery identity or authentication mismatch");

      const socketPath = getSocketPath(this.name);
      const pidPath = getPidPath(this.name);
      const metadataPath = getMetadataPath(this.name);
      for (const target of [socketPath, pidPath, metadataPath]) {
        if (fs.existsSync(target)) throw new Error("recovery target is no longer empty");
      }

      const replacement = net.createServer((socket) => this.handleClient(socket));
      await new Promise<void>((resolve, reject) => {
        replacement.once("error", reject);
        assertPrivateRecoveryPaths(this.recoveryRoot, capability);
        replacement.listen(socketPath, resolve);
      });
      replacement.on("error", (error) => {
        console.error(`Socket server error: ${error.message}`);
      });
      let socketIdentity: { dev: number; ino: number } | null = null;
      let publishedPid = false;
      let publishedMetadata = false;
      let rotatedCapability: RecoveryCapability | null = null;
      try {
        fs.chmodSync(socketPath, 0o600);
        const socketStat = fs.lstatSync(socketPath);
        socketIdentity = { dev: socketStat.dev, ino: socketStat.ino };
        if (fs.existsSync(pidPath) || fs.existsSync(metadataPath)) {
          throw new Error("recovery sidecar appeared during publication");
        }
        assertPrivateRecoveryPaths(this.recoveryRoot, capability);
        const rotated: RecoveryCapability = {
          ...capability,
          secret: randomBytes(32).toString("hex"),
          metadataRevision: "",
        };
        const recoveredMetadata = this.recoveryMetadata(request.metadata, rotated);
        rotatedCapability = recoveredMetadata.recovery!;
        // Advance the authoritative signed revision before any rotated
        // capability-bearing metadata becomes visible. A later publication
        // failure intentionally leaves recovery unavailable rather than
        // allowing the old snapshot/secret to roll metadata back.
        assertPrivateRecoveryPaths(this.recoveryRoot, capability);
        atomicWritePrivate(
          recoveryRevisionPath(this.recoveryRoot, this.name),
          signRecoveryRevision(rotatedCapability.secret, {
            protocol: RECOVERY_PROTOCOL,
            name: this.name,
            generation: this.generation,
            metadataRevision: rotatedCapability.metadataRevision,
          }),
        );
        publishPrivateNoReplace(pidPath, process.pid.toString());
        publishedPid = true;
        publishPrivateNoReplace(metadataPath, JSON.stringify(recoveredMetadata, null, 2));
        publishedMetadata = true;
        const finalSocket = fs.lstatSync(socketPath);
        if (finalSocket.dev !== socketIdentity.dev || finalSocket.ino !== socketIdentity.ino) {
          throw new Error("recovery pathname was replaced during publication");
        }

        const previous = this.socketServer;
        this.socketServer = replacement;
        this.recoveryCapability = rotatedCapability;
        // Node remembers a Unix server's pathname and unlinks it on close.
        // The old listener still remembers the same string even though its
        // inode was externally unlinked; closing it now would unlink the new
        // listener. Keep the unreachable fd unref'd until daemon shutdown.
        previous.unref();
        this.retiredSocketServers.push(previous);
        result = {
          protocol: RECOVERY_PROTOCOL,
          name: this.name,
          nonce: request.nonce,
          ok: true,
          daemonPid: process.pid,
          generation: this.generation,
          processStartToken: capability.processStartToken,
          launchIdentity: capability.launchIdentity,
        };
      } catch (error) {
        try { replacement.close(); } catch {}
        if (publishedMetadata && rotatedCapability) {
          try {
            const current = readMetadata(this.name);
            if (current?.recovery?.secret === rotatedCapability.secret) {
              fs.unlinkSync(metadataPath);
            }
          } catch {}
        }
        if (publishedPid) {
          try {
            if (fs.readFileSync(pidPath, "utf8").trim() === String(process.pid)) {
              fs.unlinkSync(pidPath);
            }
          } catch {}
        }
        if (socketIdentity) {
          try {
            const current = fs.lstatSync(socketPath);
            if (current.dev === socketIdentity.dev && current.ino === socketIdentity.ino) {
              fs.unlinkSync(socketPath);
            }
          } catch {}
        }
        throw error;
      }
    } catch (error) {
      result = {
        protocol: RECOVERY_PROTOCOL,
        name: this.name,
        nonce: request?.nonce ?? "",
        ok: false,
        error: error instanceof Error ? error.message : "recovery refused",
      };
    } finally {
      try {
        assertPrivateRecoveryPaths(this.recoveryRoot, capability);
        if (result) {
          atomicWritePrivate(
            resultPath,
            signRecoveryResult(capability.secret, result),
          );
        }
        fs.unlinkSync(requestPath);
      } catch {}
      this.recoveryInFlight = false;
    }
  }

  private scheduleStartupLeaseDeadline(retryMs?: number): void {
    if (!this.startupLease || this.startupLeaseDisarmed) return;
    clearTimeout(this.startupLeaseTimer ?? undefined);
    const delay = retryMs ?? remainingLeaseDelayMs(
      this.startupLease.deadlineMonotonicNs,
      systemMonotonicClock.nowNs(),
    );
    this.startupLeaseTimer = setTimeout(() => {
      this.startupLeaseTimer = null;
      if (!this.startupLease || this.startupLeaseDisarmed) return;
      const remaining = remainingLeaseDelayMs(
        this.startupLease.deadlineMonotonicNs,
        systemMonotonicClock.nowNs(),
      );
      if (remaining > 0) {
        this.scheduleStartupLeaseDeadline();
        return;
      }
      this.settleStartupLeaseDeadline();
    }, delay);
  }

  private settleStartupLeaseDeadline(notify = true): string | undefined {
    if (!this.shutdownTreeSnapshotted) {
      const snapshot = freezeDescendantProcesses(this.ptyProcess.pid);
      this.shutdownTreeSnapshotted = true;
      this.shutdownDescendants = snapshot.identities;
      if (snapshot._tag === "Unavailable") {
        this.shutdownTreeUnavailable = snapshot.reason;
        console.error(
          `pty daemon "${this.name}": complete child containment unavailable: ${snapshot.reason}; ` +
          `publishing teardown-unavailable and exact-signalling ` +
          `${snapshot.identities.length} observed descendant(s) plus process-group fallback`,
        );
      }
    }
    return this.settleStartupLease(startupLeaseDeadlineCause(
      this.shutdownTreeUnavailable === null,
    ), notify);
  }

  private resumePreparedDeadlineTeardown(): void {
    try { process.kill(-this.ptyProcess.pid, "SIGCONT"); } catch {}
    try { this.ptyProcess.kill("SIGCONT"); } catch {}
    signalProcessIdentities(this.shutdownDescendants, "SIGCONT");
  }

  private releaseStartupLeaseDeadlineResponse(): void {
    this.startupLeaseDeadlineResponseReleased = true;
    this.notifyStartupLeaseDeadline();
  }

  private notifyStartupLeaseDeadline(): void {
    if (
      !this.startupLeaseDeadlineNotificationPending ||
      this.startupLeaseDeadlineNotified
    ) return;
    this.startupLeaseDeadlineNotificationPending = false;
    this.startupLeaseDeadlineNotified = true;
    this.options.onStartupLeaseDeadline?.();
  }

  private settleStartupLease(
    cause: StartupLeaseTerminalCause,
    notify = true,
  ): string | undefined {
    const lease = this.startupLease;
    const effectiveCause = cause === "exit"
      ? this.startupLeaseTerminalCause ?? cause
      : cause;
    this.startupLeaseTerminalCause = effectiveCause;
    if (!lease) return undefined;
    if (this.startupLeaseTerminalValue !== null) return this.startupLeaseTerminalValue;
    const terminalValue = terminalStartupLeaseValue(this.generation, effectiveCause);
    const result = mutateMetadataUnderLock(this.name, (metadata) => {
      if (metadata.tags?.[lease.lifecycleTag] === terminalValue) return false;
      metadata.tags = { ...metadata.tags, [lease.lifecycleTag]: terminalValue };
      return true;
    }, { expectedGeneration: this.generation });
    if (result.status === "changed" || result.status === "unchanged") {
      this.startupLeaseDisarmed = true;
      clearTimeout(this.startupLeaseTimer ?? undefined);
      this.startupLeaseTimer = null;
      this.startupLeaseTerminalValue = terminalValue;
      if (effectiveCause !== "exit") {
        this.startupLeaseDeadlineNotificationPending = true;
        if (notify || this.startupLeaseDeadlineResponseReleased) {
          this.notifyStartupLeaseDeadline();
        }
      }
    } else if (
      result.status === "busy" || result.status === "stale" || result.status === "missing"
    ) {
      clearTimeout(this.startupLeaseTimer ?? undefined);
      this.startupLeaseTimer = setTimeout(() => {
        this.startupLeaseTimer = null;
        this.settleStartupLease(effectiveCause, notify);
      }, 10);
    } else if (result.status === "generation-mismatch") {
      this.startupLeaseDisarmed = true;
      if (cause !== "exit" && this.shutdownTreeSnapshotted) {
        this.resumePreparedDeadlineTeardown();
      }
      clearTimeout(this.startupLeaseTimer ?? undefined);
      this.startupLeaseTimer = null;
    }
    return terminalValue;
  }

  private async acceptedSocketOwnership(
    request: AcceptedSocketOwnershipRequest,
  ): Promise<AcceptedSocketOwnershipResult> {
    if (request.expectedGeneration !== this.generation) {
      return { _tag: "Unavailable", reason: "generation-mismatch" };
    }
    if (this.exited) return { _tag: "Unavailable", reason: "child-exited" };
    const before = readMetadata(this.name);
    if (!before) return { _tag: "Unavailable", reason: "metadata-unavailable" };
    if (before.generation !== this.generation) {
      return { _tag: "Unavailable", reason: "generation-mismatch" };
    }
    const result = await inspectAcceptedSocketOwnershipAsync(
      this.ptyProcess.pid,
      request.connection,
    );
    if (this.exited || this.startupLeaseDeadlineNotified) {
      return { _tag: "Unavailable", reason: "child-exited" };
    }
    const after = readMetadata(this.name);
    if (!after) return { _tag: "Unavailable", reason: "metadata-unavailable" };
    return after.generation === this.generation
      ? result
      : { _tag: "Unavailable", reason: "generation-mismatch" };
  }

  private compareAndSetLifecycle(
    request: LifecycleCompareAndSetRequest,
  ): LifecycleCompareAndSetResult {
    if (request.expectedGeneration !== this.generation) {
      return { _tag: "GenerationMismatch" };
    }
    const current = readMetadata(this.name);
    if (!current) return { _tag: "Missing" };
    if (current.generation !== this.generation) {
      return { _tag: "GenerationMismatch" };
    }
    if (this.exited) {
      const value = this.settleStartupLease("exit") ??
        terminalStartupLeaseValue(this.generation, "exit");
      const after = readMetadata(this.name);
      if (!after) return { _tag: "Missing" };
      if (after.generation !== this.generation) {
        return { _tag: "GenerationMismatch" };
      }
      return { _tag: "Terminal", value };
    }
    const lease = this.startupLease;
    if (
      lease &&
      !this.startupLeaseDisarmed &&
      systemMonotonicClock.nowNs() >= BigInt(lease.deadlineMonotonicNs)
    ) {
      this.settleStartupLeaseDeadline(false);
      const after = readMetadata(this.name);
      if (!after) return { _tag: "Missing" };
      if (after.generation !== this.generation) {
        return { _tag: "GenerationMismatch" };
      }
      const value = after.tags?.[lease.lifecycleTag];
      return value === undefined
        ? { _tag: "ValueMismatch" }
        : { _tag: "DeadlineExpired", value };
    }

    const result = compareAndSetTagValue(
      this.name,
      request.expectedGeneration,
      request.tag,
      request.expectedValue,
      request.value,
    );
    if (result.status === "changed" || result.status === "unchanged") {
      if (
        lease &&
        request.tag === lease.lifecycleTag &&
        request.expectedValue === lease.startingValue &&
        request.value !== lease.startingValue
      ) {
        this.startupLeaseDisarmed = true;
        clearTimeout(this.startupLeaseTimer ?? undefined);
        this.startupLeaseTimer = null;
      }
      if (lease && request.tag === lease.lifecycleTag) {
        try {
          const lifecycle: unknown = JSON.parse(request.value);
          if (
            typeof lifecycle === "object" &&
            lifecycle !== null &&
            !Array.isArray(lifecycle) &&
            (lifecycle as Record<string, unknown>)._tag === "terminal" &&
            (lifecycle as Record<string, unknown>).generation === this.generation
          ) {
            this.startupLeaseTerminalValue = request.value;
          }
        } catch {}
      }
      return result.status === "changed"
        ? { _tag: "Changed", value: result.value }
        : { _tag: "Unchanged", value: result.value };
    }
    if (result.status === "value-mismatch") {
      return result.value === undefined
        ? { _tag: "ValueMismatch" }
        : { _tag: "ValueMismatch", value: result.value };
    }
    if (result.status === "missing") return { _tag: "Missing" };
    if (result.status === "generation-mismatch") return { _tag: "GenerationMismatch" };
    return { _tag: "Busy" };
  }

  private handleClient(socket: net.Socket): void {
    const client: Client = {
      socket,
      reader: new PacketReader(),
      rows: this.terminal.rows,
      cols: this.terminal.cols,
      readonly: false,
      attachSeq: 0,
      initialScreenPhase: "live",
      initialScreenGeneration: 0,
      postCutPackets: [],
    };
    this.clients.set(socket, client);

    socket.on("data", (data: Buffer) => {
      let packets;
      try {
        packets = client.reader.feed(data);
      } catch (err: any) {
        // BUG-3: peer sent an oversize length header (or some other malformed
        // frame) — drop them rather than buffer unbounded.
        console.error(`Rejected client packet: ${err.message}`);
        try { socket.destroy(); } catch {}
        return;
      }
      for (const packet of packets) {
        switch (packet.type) {
          case MessageType.ATTACH: {
            if (packet.payload.length < 4) break;
            const size = decodeSize(packet.payload);
            // Read before negotiateSize(): a smaller client shrinks the session
            // to its own size, which would then look like it had matched.
            const sizeMatched =
              size.rows === this.terminal.rows && size.cols === this.terminal.cols;
            client.readonly = false;
            client.rows = size.rows;
            client.cols = size.cols;
            client.attachSeq = ++this.attachCounter;
            client.initialScreenPhase = "settling";
            client.postCutPackets = [];
            const initialScreenGeneration = ++client.initialScreenGeneration;
            const resized = this.negotiateSize();
            if (!resized) {
              socket.write(encodeGeometry(this.terminal.rows, this.terminal.cols));
            }
            // Best-effort: a concurrent metadata command wins this attach
            // stamp, but neither writer can overwrite the other's snapshot.
            try {
              mutateMetadataUnderLock(this.name, (meta) => {
                meta.lastAttachAt = new Date().toISOString();
                return true;
              }, { expectedGeneration: this.generation });
            } catch {}

            const sendScreen = () => {
              this.beginInitialScreenCut(
                client,
                initialScreenGeneration,
                () => this.getModePrefix(true) + this.serialize.serialize(),
                () => {
                  // The serialize addon's output is an approximation — ECH/CUF
                  // sequences may not perfectly reproduce what the app originally
                  // drew (e.g., background fills in ratatui). Nudge the child
                  // with a SIGWINCH so it does a fresh full redraw, whose DATA
                  // overwrites any serialize artifacts on the client.
                  //
                  // Skipped when the client attached at the size the session
                  // already has: the child is drawn for that geometry, so the
                  // nudge buys nothing and wakes an otherwise idle process every
                  // time someone connects.
                  if (!this.exited && !sizeMatched) this.nudgeRedraw();
                }
              );
            };

            if (!this.exited) {
              // If the PTY was just resized (either by this attach or
              // recently by another client), wait for the process to
              // redraw before serializing. Without this delay, the client
              // sees a transient mid-redraw state.
              const sinceLast = Date.now() - this.lastResizeTime;
              const REDRAW_SETTLE_MS = 80;
              if (resized || sinceLast < REDRAW_SETTLE_MS) {
                const delay = resized ? REDRAW_SETTLE_MS : REDRAW_SETTLE_MS - sinceLast;
                setTimeout(sendScreen, delay);
              } else {
                sendScreen();
              }
            } else {
              sendScreen();
            }
            break;
          }

          case MessageType.PEEK: {
            client.readonly = true;
            client.initialScreenPhase = "settling";
            client.postCutPackets = [];
            const initialScreenGeneration = ++client.initialScreenGeneration;
            const resized = this.negotiateSize();
            if (!resized) {
              socket.write(encodeGeometry(this.terminal.rows, this.terminal.cols));
            }
            const flags = packet.payload.length > 0 ? packet.payload.readUInt8(0) : 0;
            const plain = (flags & 1) !== 0;
            const full = (flags & 2) !== 0;

            this.beginInitialScreenCut(client, initialScreenGeneration, () => {
              if (plain) {
                return full ? this.getFullPlainScreen() : this.getPlainScreen();
              }
              // scrollback: 0 for viewport only, omit for full scrollback
              const serializeOpts = full ? undefined : { scrollback: 0 };
              return this.getModePrefix() + this.serialize.serialize(serializeOpts);
            });
            break;
          }

          case MessageType.DATA: {
            if (!this.exited && !client.readonly) {
              this.ptyProcess.write(packet.payload.toString());
            }
            break;
          }

          case MessageType.RESIZE: {
            if (!client.readonly && client.attachSeq > 0 && packet.payload.length >= 4) {
              const size = decodeSize(packet.payload);
              client.rows = size.rows;
              client.cols = size.cols;
              client.attachSeq = ++this.attachCounter;
              this.negotiateSize();
            }
            break;
          }

          case MessageType.DETACH: {
            socket.end();
            break;
          }

          case MessageType.STATUS: {
            const stats = this.collectStats();
            socket.write(encodeStatusResponse(JSON.stringify(stats)));
            break;
          }

          case MessageType.ACCEPTED_SOCKET_OWNERSHIP: {
            const request = decodeAcceptedSocketOwnershipRequest(jsonRecord(packet.payload));
            if (request === undefined) {
              socket.write(encodeAcceptedSocketOwnershipResponse({
                _tag: "Unavailable",
                reason: "invalid-request",
              }));
            } else {
              void this.acceptedSocketOwnership(request).then((result) => {
                if (!socket.destroyed) {
                  socket.write(encodeAcceptedSocketOwnershipResponse(result));
                }
              });
            }
            break;
          }

          case MessageType.LIFECYCLE_CAS: {
            const request = decodeLifecycleCompareAndSetRequest(jsonRecord(packet.payload));
            const result = request === undefined
              ? { _tag: "InvalidRequest" as const, reason: "invalid request payload" }
              : this.compareAndSetLifecycle(request);
            const deferDeadlineShutdown =
              this.startupLeaseTerminalCause !== null &&
              this.startupLeaseTerminalCause !== "exit" &&
              !this.startupLeaseDeadlineNotified;
            socket.write(
              encodeLifecycleCompareAndSetResponse(result),
              deferDeadlineShutdown
                ? () => setImmediate(() => this.releaseStartupLeaseDeadlineResponse())
                : undefined,
            );
            if (deferDeadlineShutdown) {
              const shutdownBackstop = setTimeout(() => {
                this.releaseStartupLeaseDeadlineResponse();
              }, 2_000);
              shutdownBackstop.unref();
            }
            break;
          }
        }
      }
    });

    socket.on("close", () => {
      this.clients.delete(socket);
      this.negotiateSize();
    });

    socket.on("error", () => {
      this.clients.delete(socket);
      this.negotiateSize();
    });
  }

  private getModePrefix(includeAltScreen = false): string {
    let prefix = "";
    // Alt-screen mode is only prefixed for the ATTACH path, not PEEK. A
    // non-follow `pty peek` prints the snapshot to the caller's shell and
    // exits, so entering ?1049h would hide the output when the client-side
    // TERMINAL_SANITIZE exits alt-screen on close. Attaching clients want
    // the alt buffer to persist for the duration of the attach.
    if (includeAltScreen && this.altScreenActive) prefix += "\x1b[?1049h";
    if (this.mouseTracking1000) prefix += "\x1b[?1000h";
    if (this.mouseTracking1002) prefix += "\x1b[?1002h";
    if (this.mouseTracking1003) prefix += "\x1b[?1003h";
    if (this.sgrMouseMode) prefix += "\x1b[?1006h";
    if (this.cursorHidden) prefix += "\x1b[?25l";
    for (const flags of this.kittyKeyboardStack) {
      prefix += `\x1b[>${flags}u`;
    }
    return prefix;
  }

  private collectStats(): StatsResult {
    const buf = this.terminal.buffer.active;
    const meta = readMetadata(this.name);

    let attached = 0;
    let readOnly = 0;
    const connections: NonNullable<StatsResult["clients"]["connections"]> = [];
    for (const c of this.clients.values()) {
      if (c.readonly) {
        readOnly++;
        connections.push({
          role: "readonly",
          constrains: { rows: false, cols: false },
        });
      } else if (c.attachSeq > 0) {
        attached++;
        connections.push({
          role: "writable",
          rows: c.rows,
          cols: c.cols,
          lastRequestSequence: c.attachSeq,
          constrains: {
            rows: c.rows === this.terminal.rows,
            cols: c.cols === this.terminal.cols,
          },
        });
      }
    }

    const createdAt = meta?.createdAt ?? null;
    const uptimeSeconds = createdAt
      ? Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000)
      : null;

    const childPid = this.exited ? null : this.ptyProcess.pid;
    const daemonPid = process.pid;

    return {
      name: this.name,
      terminal: {
        cols: this.terminal.cols,
        rows: this.terminal.rows,
        cursorX: buf.cursorX,
        cursorY: buf.cursorY,
        scrollbackUsed: buf.length,
        scrollbackCapacity: this.terminal.rows + (this.terminal.options.scrollback ?? 10000),
      },
      process: {
        alive: !this.exited,
        exitCode: this.exited ? this.exitCode : null,
        pid: childPid,
        resources: childPid ? queryProcessResources(childPid) : null,
      },
      daemon: {
        pid: daemonPid,
        resources: queryProcessResources(daemonPid),
      },
      clients: {
        total: attached + readOnly,
        attached,
        readOnly,
        connections,
      },
      modes: {
        sgrMouse: this.sgrMouseMode,
        cursorHidden: this.cursorHidden,
        kittyKeyboard: this.kittyKeyboardStack.length > 0,
        kittyKeyboardFlags: [...this.kittyKeyboardStack],
      },
      uptimeSeconds,
      createdAt,
    };
  }

  /** Resize the PTY to the smallest dimensions across all connected writable clients.
   *  Returns true if the size actually changed. */
  private negotiateSize(): boolean {
    let rows = 0;
    let cols = 0;

    for (const client of this.clients.values()) {
      if (!client.readonly && client.attachSeq > 0) {
        rows = rows === 0 ? client.rows : Math.min(rows, client.rows);
        cols = cols === 0 ? client.cols : Math.min(cols, client.cols);
      }
    }

    if (rows > 0 && cols > 0) {
      if (rows !== this.terminal.rows || cols !== this.terminal.cols) {
        this.terminal.resize(cols, rows);
        this.broadcastGeometry(rows, cols);
        this.ptyProcess.resize(cols, rows);
        this.lastResizeTime = Date.now();
        return true;
      }
    }
    return false;
  }

  private broadcastGeometry(rows: number, cols: number): void {
    const packet = encodeGeometry(rows, cols);
    for (const client of this.clients.values()) {
      if (client.attachSeq > 0 || client.readonly) {
        client.socket.write(packet);
      }
    }
  }

  /** Briefly resize the PTY by 1 column and back to trigger SIGWINCH,
   *  forcing the child to do a complete redraw. The xterm-headless terminal
   *  is resized in sync so its buffer stays correct. */
  private nudgeRedraw(): void {
    const cols = this.terminal.cols;
    const rows = this.terminal.rows;
    this.ptyProcess.resize(cols - 1, rows);
    this.terminal.resize(cols - 1, rows);
    this.ptyProcess.resize(cols, rows);
    this.terminal.resize(cols, rows);
  }

  private emitEvent(type: EventType, fields?: Record<string, unknown>): void {
    this.eventWriter.append({
      session: this.name,
      type,
      ts: new Date().toISOString(),
      ...fields,
    } as EventRecord);
  }

  private beginInitialScreenCut(
    client: Client,
    generation: number,
    getScreen: () => string,
    onLive?: () => void
  ): void {
    if (
      client.socket.destroyed ||
      client.initialScreenGeneration !== generation
    ) return;

    client.initialScreenPhase = "cutting";
    /** xterm parses writes asynchronously. This empty write is an ordered
     *  marker: its callback runs after every earlier write and before later
     *  writes, giving SCREEN an exact parser cut. */
    this.terminal.write("", () => {
      if (
        client.socket.destroyed ||
        client.initialScreenGeneration !== generation
      ) return;

      const postCutPackets = client.postCutPackets;
      client.postCutPackets = [];
      const hasPostCutExit = postCutPackets.some(
        (pending) => pending.type === MessageType.EXIT
      );

      client.socket.write(encodeScreen(getScreen()));
      client.initialScreenPhase = "live";
      /** node-pty drains PTY data before its public exit event, so a queued
       *  EXIT is already source-ordered after DATA. A pre-cut EXIT is not in
       *  this queue and is synthesized only after any final post-cut DATA. */
      for (const pending of postCutPackets) {
        client.socket.write(pending.packet);
      }
      if (this.exited && !hasPostCutExit) {
        client.socket.write(encodeExit(this.exitCode));
      }
      onLive?.();
    });
  }

  private broadcast(
    type: typeof MessageType.DATA | typeof MessageType.EXIT,
    packet: Buffer
  ): void {
    for (const client of this.clients.values()) {
      if (client.initialScreenPhase === "settling") continue;
      if (client.initialScreenPhase === "cutting") {
        client.postCutPackets.push({ type, packet });
        continue;
      }
      client.socket.write(packet);
    }
  }

  private getPlainScreen(): string {
    // Viewport only: last `rows` lines (where the cursor is)
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    const start = Math.max(0, buffer.baseY);
    const end = buffer.length;
    for (let i = start; i < end; i++) {
      const line = buffer.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n");
  }

  private getFullPlainScreen(): string {
    // Full scrollback + viewport
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n");
  }

  private getLastLines(): string[] {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (line) {
        lines.push(line.translateToString(true));
      }
    }
    // Trim trailing empty lines, then take last N
    while (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    return lines.slice(-SESSION_EXIT_LAST_LINES_LIMIT);
  }

  /** Trailing-edge debounce: the first output chunk after an idle period
   *  schedules one persist ~1s out; bursts inside the window coalesce into
   *  that single write carrying the newest stamp. Skipped once exited — the
   *  exit path persists the final stamp via `saveExitMetadata`. */
  private scheduleActivityPersist(): void {
    if (this.activityPersistScheduled) return;
    this.activityPersistScheduled = true;
    setTimeout(() => {
      this.activityPersistScheduled = false;
      if (this.exited || this.lastOutputAtMs === 0) return;
      const stampedAtMs = this.lastOutputAtMs;
      try {
        mutateMetadataUnderLock(this.name, (metadata) => {
          if (metadata.lastOutputAtMs === stampedAtMs) return false;
          metadata.lastOutputAtMs = stampedAtMs;
          return true;
        });
      } catch {
        // Best-effort: a lost activity stamp reads as a slightly staler
        // activity sample; it must never take the daemon down.
      }
    }, 1000);
  }

  private saveExitMetadata(exitCode: number): MetadataMutationResult["status"] {
    const result = mutateMetadataUnderLock(this.name, (metadata) => {
      metadata.exitCode = exitCode;
      metadata.exitedAt = new Date().toISOString();
      metadata.lastLines = this.getLastLines();
      if (this.lastOutputAtMs > 0) {
        metadata.lastOutputAtMs = this.lastOutputAtMs;
      }
      return true;
    }, { expectedGeneration: this.generation });
    return result.status;
  }

  private async saveExitMetadataUntilSettled(
    exitCode: number,
    waitMs = 2_000,
  ): Promise<void> {
    const deadline = Date.now() + waitMs;
    while (true) {
      const status = this.saveExitMetadata(exitCode);
      if (
        status === "changed" ||
        status === "unchanged" ||
        status === "missing" ||
        status === "generation-mismatch"
      ) return;
      if (Date.now() >= deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** Clean up resources. Does not call process.exit(). */
  close(options: { terminateDescendants?: boolean } = {}): Promise<void> {
    if (options.terminateDescendants && !this.shutdownTreeSnapshotted) {
      const snapshot = snapshotDescendantProcessesComplete(this.ptyProcess.pid);
      this.shutdownTreeSnapshotted = true;
      this.shutdownDescendants = snapshot.identities;
      if (snapshot._tag === "Unavailable") {
        this.shutdownTreeUnavailable = snapshot.reason;
        console.error(
          `pty daemon "${this.name}": complete child snapshot unavailable: ${snapshot.reason}; ` +
          `exact-signalling ${snapshot.identities.length} observed descendant(s) plus process-group fallback`,
        );
      }
    }
    if (this.recoveryRoot) {
      try { this.recoveryWatcher?.close(); } catch {}
      this.recoveryWatcher = null;
    }
    // Update exit metadata with final output — by the time close() runs,
    // all PTY data has been delivered to the terminal buffer. This overwrites
    // the initial save from onExit which may have had incomplete lastLines.
    if (this.exited) {
      this.saveExitMetadata(this.exitCode);
    }

    return new Promise((resolve) => {
      for (const client of this.clients.values()) {
        client.socket.destroy();
      }
      for (const retired of this.retiredSocketServers.splice(0)) {
        try { retired.close(); } catch {}
      }
      this.socketServer.close(async () => {
        cleanupOwnedSocket(this.name, {
          generation: this.generation,
          pid: process.pid,
        });
        try {
          if (this.startupLeaseDeadlineNotified) this.ptyProcess.kill("SIGKILL");
          else this.ptyProcess.kill();
        } catch {}
        const groupFallback = options.terminateDescendants && this.shutdownTreeUnavailable !== null
          ? terminateProcessGroup(this.ptyProcess.pid, {
            ...(this.startupLeaseDeadlineNotified ? { termWaitMs: 0 } : {}),
          })
          : Promise.resolve(true);
        const descendantsDone = options.terminateDescendants
          ? terminateProcessIdentities(this.shutdownDescendants, {
            ...(this.startupLeaseDeadlineNotified ? { termWaitMs: 0 } : {}),
          })
          : Promise.resolve([]);
        // Wait for the child's onExit to fire (which enqueues session_exit)
        // before draining the writer. Without this, SIGTERM-initiated
        // shutdowns race: kill() returns synchronously but onExit fires
        // later, after we've already flushed. Bound with a short timeout in
        // case the child never exits (shouldn't happen — we just killed it).
        const childExited = await Promise.race([
          this.childExited.then(() => true),
          new Promise<false>((r) => setTimeout(() => r(false), 2000)),
        ]);
        if (!childExited) {
          try { this.ptyProcess.kill("SIGKILL"); } catch {}
          await Promise.race([
            this.childExited,
            new Promise<void>((r) => setTimeout(r, 500)),
          ]);
        }
        const survivingDescendants = await descendantsDone;
        const processGroupGone = await groupFallback;
        if (!processGroupGone) {
          console.error(
            `pty daemon "${this.name}": process-group fallback could not verify teardown ` +
            `after incomplete snapshot (${this.shutdownTreeUnavailable})`,
          );
        }
        if (survivingDescendants.length > 0) {
          const pids = survivingDescendants.map((d) => d.pid);
          console.error(
            `pty daemon "${this.name}": ${survivingDescendants.length} child process(es) ` +
            `did not exit after exact TERM and KILL signals: ${pids.join(", ")}`,
          );
          // And somewhere a person can find it. The warning above goes to this
          // daemon's standard error, which has had no reader since the command
          // that launched it stopped listening — so the one moment it has
          // something worth saying is the one moment nobody is there.
          this.emitEvent(EventType.SESSION_DESCENDANTS_SURVIVED, { data: { pids } });
        }
        if (this.exited) await this.saveExitMetadataUntilSettled(this.exitCode);
        try { await this.eventWriter.flush(); } catch {}
        resolve();
      });
    });
  }

  /** Hard-kill the child with SIGKILL, bypassing the graceful SIGHUP that
   *  close() sends. Used by the shutdown backstop: when a graceful close()
   *  has wedged (e.g. a frozen child that ignores SIGHUP), the daemon is about
   *  to force-exit and must not leave the child orphaned to init still alive.
   *  Best-effort — a SIGKILL is unblockable, but the child may already be gone. */
  forceKillChild(): void {
    try { this.ptyProcess.kill("SIGKILL"); } catch {}
    signalProcessIdentities(this.shutdownDescendants, "SIGKILL");
    if (this.shutdownTreeUnavailable !== null) {
      try { process.kill(-this.ptyProcess.pid, "SIGKILL"); } catch {}
    }
  }
}

/** How often the spawner-PID watchdog checks for liveness. 5s is fast enough
 *  that a leaked daemon is reclaimed promptly without producing meaningful
 *  CPU load. */
const SPAWNER_POLL_INTERVAL_MS = 5000;

/** Returns true if `pid` refers to a live process this user can signal.
 *  `kill(pid, 0)` is the standard POSIX liveness probe — sends no signal,
 *  only validates the target. ESRCH means dead; EPERM means alive but
 *  unsignalable (still "alive" for our purposes). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function installSpawnerWatchdog(cleanShutdown: (code: number) => Promise<never>): void {
  const raw = process.env.PTY_SPAWNER_PID;
  if (!raw) return;
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 1) return;
  if (!isProcessAlive(pid)) {
    // Already dead by the time we boot — exit before clients can connect.
    void cleanShutdown(0);
    return;
  }
  const interval = setInterval(() => {
    if (isProcessAlive(pid)) return;
    clearInterval(interval);
    void cleanShutdown(0);
  }, SPAWNER_POLL_INTERVAL_MS);
  // Don't keep the event loop alive just for this poll.
  interval.unref?.();
}

/** Entry point when this file is run as the daemon process. */
if (process.argv[1]?.endsWith("/server.js")) {
  // Name the daemon process so it shows up as "pty-daemon" in ps/top/htop/btm
  // rather than "MainThread" (V8's default main-thread name under Node 24+).
  // This is set only inside the daemon-entry guard — server.ts is also imported
  // as a library (PtyServer), and we must not rename those host processes.
  // `process.title` is the only override for /proc/<pid>/comm and Linux caps it
  // at 15 chars (TASK_COMM_LEN), so "pty-daemon" (10 chars) stays well under.
  try { process.title = "pty-daemon"; } catch {}

  const config = JSON.parse(process.env.PTY_SERVER_CONFIG ?? "{}");
  if (!config.name || !config.command) {
    console.error("PTY_SERVER_CONFIG env var required");
    process.exit(1);
  }

  const isEphemeral = config.ephemeral === true;
  const generation =
    typeof config.generation === "string" && config.generation.length > 0
      ? config.generation
      : randomBytes(16).toString("hex");
  const cleanupOwner = { generation, pid: process.pid };

  // Exit-time cleanup policy. Deliberately re-reads metadata at shutdown
  // instead of trusting `config.tags` (the spawn-time snapshot): `pty tag
  // <name> keep` and `pty tag <name> strategy=permanent` both mutate a
  // RUNNING session's tags on disk, and pinning a session you are about to
  // debug is the main reason anyone sets `keep` at all. A stale read here
  // would reap exactly the session the operator asked us to preserve.
  //
  // Falls back to `config.tags` only if the metadata file is unreadable
  // (already `pty rm`'d, or a truncated write) — a missing file means
  // there is nothing left to reap anyway.
  //
  // `externalKill` scopes the policy to the case it is actually about: the
  // session's own work ENDED. A daemon can shut down for two very different
  // reasons, and only one of them is an "exit":
  //
  //   - the child process terminated on its own (cleanly or by crashing)
  //     — the session is finished; whether it self-reaps is the config
  //     default (`reapOnExitDefault`, via `PTY_REAP_ON_EXIT`), unless a
  //     per-session `keep`/`--ephemeral` overrides it.
  //   - someone stopped the daemon from outside (`pty kill` → SIGTERM,
  //     SIGINT, or the spawner watchdog reclaiming a leaked daemon) — the
  //     child had not finished; an operator interrupted it, almost always
  //     to go look at what it was doing. `pty kill` is documented as
  //     stop-and-keep, deliberately distinct from `pty rm`. Collapsing the
  //     two would delete the evidence the operator killed the session to
  //     inspect. Keep.
  //
  // Startup-lease generations always retain their terminal lifecycle and exit
  // evidence; explicit evidence removal remains generation-fenced.
  let externalKill = false;
  function reapAtExit(): boolean {
    const metadata = readMetadata(config.name);
    if (
      metadata?.generation !== undefined &&
      metadata.generation !== generation
    ) {
      return false;
    }
    if (config.startupLease) return false;
    if (externalKill && !isEphemeral) return false;
    const tags = metadata?.tags ?? config.tags;
    // `PTY_REAP_ON_EXIT` (network/global config) sets the default when no
    // per-session `keep`/`--ephemeral` override applies; shipped default reaps.
    return shouldReapAtExit(tags, isEphemeral, reapOnExitDefault());
  }

  // Hard deadline for a graceful shutdown before the daemon force-exits. The
  // graceful path (server.close()) is itself only internally bounded on the
  // child-exit wait (~2s); the outer promise can still hang indefinitely if
  // socketServer.close()'s callback never fires (a lingering/untracked socket)
  // or eventWriter.flush() stalls. That is exactly how a restart wedged the
  // daemon alive+orphaned (ppid=1), needing kill -9. This backstop guarantees
  // the daemon exits — and reaps its child — regardless. Env-overridable so
  // tests can force the backstop path deterministically.
  const SHUTDOWN_DEADLINE_MS = (() => {
    const raw = Number(process.env.PTY_SHUTDOWN_DEADLINE_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 5000;
  })();

  // Idempotent: SIGTERM, SIGINT, the child's onExit, and the spawner watchdog
  // can all trigger shutdown, sometimes overlapping. Only the first arms the
  // deadline and drives close(); later callers get the same in-flight promise.
  let shutdownPromise: Promise<never> | null = null;
  function cleanShutdown(code: number): Promise<never> {
    if (shutdownPromise) return shutdownPromise;
    const deadline = setTimeout(() => {
      console.error(
        `pty daemon "${config.name}": graceful shutdown exceeded ` +
        `${SHUTDOWN_DEADLINE_MS}ms — forcing exit (child reaped)`,
      );
      // Don't leave a frozen child orphaned, and don't leave a stale pid/sock
      // pointing at a daemon that's about to vanish.
      server.forceKillChild();
      try {
        if (reapAtExit()) cleanupOwnedAll(config.name, cleanupOwner);
        else cleanupOwnedSocket(config.name, cleanupOwner);
      } catch {}
      process.exit(code);
    }, SHUTDOWN_DEADLINE_MS);
    shutdownPromise = server.close({ terminateDescendants: externalKill }).then(() => {
      clearTimeout(deadline);
      // `close()` has already re-flushed exit metadata with the final
      // `lastLines`, so this reads the same tags a `pty gc` sweep would
      // have read one tick later — the decision is identical, only the
      // latency changes.
      if (reapAtExit()) cleanupOwnedAll(config.name, cleanupOwner);
      process.exit(code);
    });
    return shutdownPromise;
  }

  const server = new PtyServer({
    name: config.name,
    generation,
    command: config.command,
    args: config.args ?? [],
    displayCommand: config.displayCommand,
    cwd: config.cwd ?? process.cwd(),
    rows: config.rows ?? 24,
    cols: config.cols ?? 80,
    ephemeral: config.ephemeral === true,
    tags: config.tags,
    displayName: config.displayName,
    isolateEnv: config.isolateEnv === true,
    extraEnv: config.extraEnv,
    unsetEnv: config.unsetEnv,
    env: config.env,
    startupLease: config.startupLease,
    onStartupLeaseDeadline: () => {
      externalKill = true;
      void cleanShutdown(124);
    },
    onExit: (code) => {
      // Give clients a moment to receive the exit message, then shut down
      setTimeout(() => cleanShutdown(code), 500);
    },
  });

  // Set the flag BEFORE calling cleanShutdown: the child's own onExit will
  // re-enter cleanShutdown moments later (we kill the child during close()),
  // and cleanShutdown is idempotent, so whichever caller arrives first wins.
  // Flagging first guarantees the external-kill verdict is the one in effect
  // when the reap decision is finally made.
  const killedExternally = (code: number) => {
    externalKill = true;
    return cleanShutdown(code);
  };
  process.on("SIGTERM", () => killedExternally(0));
  process.on("SIGINT", () => killedExternally(0));

  // Spawner-PID watchdog (opt-in via PTY_SPAWNER_PID).
  //
  // `detached: true` puts the daemon in its own session, so the kernel sends
  // no signal when the spawner exits — and the daemon ends up reparented to
  // init, surviving forever. When the spawner sets PTY_SPAWNER_PID, we poll
  // for its liveness and call cleanShutdown() once it's gone. Off when the
  // env var is absent, so existing callers see no behaviour change.
  // The watchdog reclaims a daemon whose spawner died. The child was still
  // running, so this is a stop-from-outside like `pty kill`, not an exit —
  // keep the metadata.
  installSpawnerWatchdog(killedExternally);
}
