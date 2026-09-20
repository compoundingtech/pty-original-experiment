import { spawn, spawnSync, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as tty from "node:tty";
import { fileURLToPath } from "node:url";
import {
  acquireLock, getEventsPath, getSocketPath, readMetadata, releaseLock,
  validateDisplayName,
  hasProcessExitedForReap,
} from "./sessions.ts";
import type { StartupLeaseOptions } from "./startup-lease.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Allow overriding the server module path (used by the bundled supervisor
 *  and test harnesses). When set, takes precedence over both the on-disk
 *  fast path and the CLI delegation fallback. Pass null/empty to clear. */
let _serverModulePath: string | null = null;
export function setServerModulePath(p: string | null): void {
  _serverModulePath = p && p.length > 0 ? p : null;
}

export interface SpawnDaemonOptions {
  name: string;
  command: string;
  args: string[];
  displayCommand: string;
  cwd?: string;
  ephemeral?: boolean;
  rows?: number;
  cols?: number;
  tags?: Record<string, string>;
  /** Optional human-friendly alias for the session, stored in
   *  SessionMetadata.displayName. `name` stays the immutable id. */
  displayName?: string;
  /** When true, strip the daemon's env down to a small allow-list before
   *  spawning the session child — prevents cloud tokens / OAuth / SSH agent
   *  vars from leaking into a session that may be reached via pty-relay.
   *  See BUG-4. */
  isolateEnv?: boolean;
  /** Additional `KEY=VALUE` env entries overlaid on the inherited child
   *  environment, or on the safe allow-list when `isolateEnv` is true. */
  extraEnv?: Record<string, string>;
  /** Environment keys removed from inheritance before `extraEnv` is applied. */
  unsetEnv?: string[];
  /** Use this env dict verbatim for the spawned child — no inheritance from
   *  the daemon's `process.env`, no allow-list. `PTY_SESSION` is always
   *  injected on top so nesting detection and `pty exec` keep working.
   *
   *  Mutually exclusive with `isolateEnv` / `extraEnv` / `unsetEnv` — passing
   *  `env` together with inherited-environment policy will throw at startup. */
  env?: Record<string, string>;
  /** Override the runtime used to launch the detached daemon process.
   *
   *  By default the daemon is spawned with `process.execPath` — the same
   *  runtime as the caller. That breaks when the caller is running under a
   *  non-Node runtime (e.g. Bun): the daemon needs to be launched under Node
   *  so the PTY server can load its `node-pty` native addon.
   *
   *  Set `launcher` to point at a Node binary (and optional leading args) to
   *  route daemon launches through it, regardless of the caller's runtime.
   *
   *  @example
   *  ```ts
   *  await spawnDaemon({
   *    // ...existing fields...
   *    launcher: { command: "/usr/local/bin/node" },
   *  });
   *  ```
   *
   *  Ignored when this lib delegates the spawn to the `pty` CLI (the
   *  bundled-context fallback) — the CLI handles its own runtime selection.
   */
  launcher?: { command: string; args?: string[] };
  /** Bind the daemon's lifetime to this process. When true, the daemon polls
   *  for the spawner's PID every few seconds and shuts down cleanly once the
   *  spawner is gone — preventing orphaned daemons reparented to init when
   *  the spawner exits without calling `disconnect()` / `kill()`.
   *
   *  Off by default to preserve the historical "daemon outlives spawner"
   *  semantics relied on by long-lived supervisors. Opt in when the caller
   *  is the sole owner of the daemon (e.g., short-lived scripts, test
   *  harnesses, `@overeng/pty-effect` scopes).
   *
   *  Implemented via the `PTY_SPAWNER_PID` env var read by the daemon. */
  bindToSpawnerLifetime?: boolean;
  /** Time in ms to wait for the daemon's Unix socket to appear before
   *  giving up. Defaults to 30000 (30s) — generous enough for heavy
   *  startups like `claude --resume` of a large session, while still
   *  bounded so a hung child doesn't block forever. The earlyExit
   *  handler still surfaces immediate failures within milliseconds, so
   *  this only governs the "alive but slow" case. */
  startTimeoutMs?: number;
  /** Env var names to DELETE from the daemon's inherited environment before it
   *  spawns — and therefore before the session child inherits it. Used by the
   *  operator-initiated restart paths to strip the *restarter's* ambient
   *  bus-identity vars (ST_AGENT/ST_ROOT), so a session re-exec'd from a
   *  different shell can't come back under that shell's identity. See the
   *  cos-restart incident. Applied on the spawnViaNode path; the CLI-fallback
   *  path can't express it (a bundled consumer that hits the fallback also
   *  isn't the operator-restart context this guards). */
  scrubEnv?: string[];
  /** @internal PID owning an already-held per-name creation lock. Used only
   *  when a lifecycle operation must keep its CAS lock across CLI fallback. */
  creationLockOwnerPid?: number;
  /** Daemon-owned startup deadline, published as a generation-fenced lifecycle tag. */
  startupLease?: StartupLeaseOptions;
}

/** Default time we wait for a daemon's Unix socket to appear after
 *  spawn before declaring the start a failure. See SpawnDaemonOptions
 *  for rationale. */
export const DEFAULT_START_TIMEOUT_MS = 30_000;

/**
 * Resolve which strategy to use for spawning a daemon.
 *
 *   1. If `setServerModulePath` was called, run `node <override>` with the
 *      explicit path. Used by test harnesses that want a custom server.
 *   2. If our sibling `dist/server.js` is a real file on disk, run
 *      `node <sibling>` directly — fast path for ordinary npm installs.
 *   3. Otherwise (consumer bundled this package into a single binary;
 *      `import.meta.url` is virtualised; sibling lookup fails), delegate
 *      to the `pty` CLI on PATH. The CLI is always a real on-disk binary
 *      with intact module resolution, so it sidesteps every bundling
 *      failure mode at once: spawning, embedded source materialisation,
 *      child-process module resolution, native-binding loading.
 */
type SpawnStrategy =
  | { kind: "node"; serverModule: string }
  | { kind: "cli" };

function resolveSpawnStrategy(): SpawnStrategy {
  if (_serverModulePath !== null) return { kind: "node", serverModule: _serverModulePath };
  const sibling = path.join(__dirname, "server.js");
  try {
    if (fs.statSync(sibling).isFile()) return { kind: "node", serverModule: sibling };
  } catch {}
  return { kind: "cli" };
}

export async function spawnDaemon(options: SpawnDaemonOptions): Promise<void> {
  if (options.displayName !== undefined) validateDisplayName(options.displayName);
  if (options.env && (options.isolateEnv || options.extraEnv || options.unsetEnv?.length)) {
    throw new Error(
      "SpawnDaemonOptions.env is mutually exclusive with isolateEnv/extraEnv/unsetEnv. " +
        "Use env for verbatim control, or inherited environment policy options — not both.",
    );
  }
  const strategy = resolveSpawnStrategy();
  if (strategy.kind === "cli") return spawnViaCli(options);
  return spawnViaNode(options, strategy.serverModule);
}

/** @internal Own the creation lease through daemon publication. */
export async function spawnDaemonWithCreationLock(
  options: SpawnDaemonOptions,
): Promise<boolean> {
  if (!acquireLock(options.name)) return false;
  try {
    await spawnDaemon({ ...options, creationLockOwnerPid: process.pid });
    return true;
  } finally {
    releaseLock(options.name);
  }
}

async function spawnViaNode(options: SpawnDaemonOptions, serverModule: string): Promise<void> {
  const stdout = process.stdout as tty.WriteStream;
  const rows = options.rows ?? stdout.rows ?? 24;
  const cols = options.cols ?? stdout.columns ?? 80;

  const config = JSON.stringify({
    name: options.name,
    command: options.command,
    args: options.args,
    displayCommand: options.displayCommand,
    cwd: options.cwd ?? process.cwd(),
    rows,
    cols,
    ephemeral: options.ephemeral ?? false,
    ...(options.tags && Object.keys(options.tags).length > 0 ? { tags: options.tags } : {}),
    ...(options.displayName ? { displayName: options.displayName } : {}),
    ...(options.isolateEnv ? { isolateEnv: true } : {}),
    ...(options.extraEnv && Object.keys(options.extraEnv).length > 0 ? { extraEnv: options.extraEnv } : {}),
    ...(options.unsetEnv && options.unsetEnv.length > 0 ? { unsetEnv: options.unsetEnv } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.startupLease ? { startupLease: options.startupLease } : {}),
  });

  const launcherCmd = options.launcher?.command ?? process.execPath;
  const launcherArgs = options.launcher?.args ?? [];
  // PTY_SPAWNER_PID lets the daemon poll for spawner liveness and shut down
  // when its spawner is gone. Off by default — opt in via
  // `bindToSpawnerLifetime` when the caller owns the daemon's lifetime.
  const env: Record<string, string> = { ...process.env, PTY_SERVER_CONFIG: config };
  // Strip caller-requested vars (e.g. the restarter's leaked bus identity)
  // before the daemon — and thus the session child — can inherit them.
  if (options.scrubEnv) {
    for (const key of options.scrubEnv) delete env[key];
  }
  if (options.bindToSpawnerLifetime) env.PTY_SPAWNER_PID = String(process.pid);
  const child = spawn(launcherCmd, [...launcherArgs, serverModule], {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
    env,
  });

  let stderrOutput = "";
  child.stderr?.on("data", (data: Buffer) => { stderrOutput += data.toString(); });

  let earlyExit = false;
  let earlyExitCode: number | null = null;
  child.on("exit", (code) => { earlyExit = true; earlyExitCode = code; });

  (child.stderr as { unref?: () => void } | null)?.unref?.();
  child.unref();

  try {
    const timeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    const startedAt = Date.now();
    const checkEarlyExit = () => {
      if (earlyExit) {
        const details = stderrOutput.trim();
        const msg = `Daemon process exited immediately (code ${earlyExitCode ?? "unknown"}).`;
        throw new Error(details ? `${msg}\n${details}` : `${msg} Is the command valid?`);
      }
    };
    await waitForSocket(options.name, timeoutMs, checkEarlyExit);
    while (true) {
      const metadata = readMetadata(options.name);
      const startPublished = metadata !== null &&
        metadata.daemonPid === child.pid &&
        hasPublishedSessionStart(options.name, metadata.createdAt);
      if (startPublished) break;
      // **Read the fact that is already there before waiting for one that is
      // not.** If somebody else has published this name, this attempt can never
      // win: the check above compares against our own pid and stays false for
      // the rest of the budget. The only other way out of this loop is noticing
      // our own daemon die, so when that is slow — a loaded machine, a daemon
      // still starting up — the loop spends the whole start timeout and then
      // reports a timeout, when the true answer was on disk in the first pass.
      //
      // Measured on a Mac by Silber.pty on 2026-09-03: the losing `pty run`
      // took 30.06 s against a 30 s budget and said "Timed out waiting for
      // daemon publication" instead of "is already running".
      // **NOT `isProcessAlive`.** A zombie answers `kill(pid, 0)`, so the cheap
      // predicate calls a corpse live — and a corpse recorded as the owner would
      // make this session name refuse every future `pty run`, which is precisely
      // the failure this check exists to avoid.
      const ownerLive = (pid: number) => !hasProcessExitedForReap(pid);
      if (publishedElsewhere(metadata?.daemonPid ?? null, child.pid ?? -1, ownerLive, () =>
        metadata !== null && hasPublishedSessionStart(options.name, metadata.createdAt),
      )) {
        // Deliberately the same sentence `pty run` prints when it sees a
        // running session before it spawns. Losing the race later should not
        // produce a different explanation of the same situation.
        throw new Error(
          `Session "${options.name}" is already running. Use "pty attach ${options.name}" to connect.`,
        );
      }
      checkEarlyExit();
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for daemon publication for session "${options.name}".`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } catch (err) {
    if (!earlyExit && child.pid) {
      try { process.kill(child.pid, "SIGTERM"); } catch {}
    }
    throw err;
  }
}

/** Has this session been published by a live process that is not us?
 *
 *  All three conditions matter. **Published**, or we would refuse a name whose
 *  metadata is still being written. **By a different pid**, or we would refuse
 *  our own success. **By a live one**, or stale metadata from a daemon that died
 *  would make the name permanently unusable.
 *
 *  "Live" means `hasProcessExitedForReap`, never `isProcessAlive`. **A zombie
 *  answers `kill(pid, 0)`**, measured on Linux 2026-09-03, so the cheap
 *  predicate calls a corpse live. An unreaped daemon is the precise case this
 *  has to get right.
 *
 *  Kept separate from the registry so all four ways of answering "no" can be
 *  tested rather than raced for. */
export function publishedElsewhere(
  owner: number | null,
  mine: number,
  alive: (pid: number) => boolean,
  published: () => boolean,
): boolean {
  if (owner === null) return false;
  return owner !== mine && alive(owner) && published();
}

function hasPublishedSessionStart(name: string, createdAt: string): boolean {
  try {
    return fs.readFileSync(getEventsPath(name), "utf8")
      .trimEnd()
      .split("\n")
      .some((line) => {
        const event = JSON.parse(line);
        return event.session === name &&
          event.type === "session_start" &&
          typeof event.ts === "string" &&
          event.ts >= createdAt;
      });
  } catch {
    return false;
  }
}

/**
 * Bundled-context fallback: shell out to `pty run -d ...` on PATH.
 *
 * Only the inputs that the CLI surface supports are passed through. Initial
 * size, an alternate display command, an exact replacement env, and a custom
 * launcher remain Node-path-only; the restart-relevant CLI settings
 * (ephemeral, cwd, display name, tags, isolation, env overlay, env removal,
 * and startup lease) all have lossless flag equivalents.
 *
 * `isolateEnv` maps to `--isolate-env`. `cwd` to `--cwd`. `tags` to
 * repeated `--tag k=v`. `name` to `--id` (the on-disk identifier under the
 * decoupled name/displayName model). `displayName` maps to `--name`, and
 * `unsetEnv` to repeated `--unset-env KEY`.
 * The session command is positional after `--`.
 */
function spawnViaCli(options: SpawnDaemonOptions): Promise<void> {
  const cliArgs: string[] = ["run", "-d", "--id", options.name];
  if (options.displayName) {
    cliArgs.push("--name", options.displayName);
  } else {
    // No display label requested — match spawnDaemon's behavior of leaving
    // displayName unset (rather than CLI's default of auto-generating one).
    cliArgs.push("--no-display-name");
  }
  if (options.cwd) cliArgs.push("--cwd", options.cwd);
  if (options.ephemeral) cliArgs.push("--ephemeral");
  if (options.isolateEnv) cliArgs.push("--isolate-env");
  if (options.extraEnv) {
    for (const [k, v] of Object.entries(options.extraEnv)) {
      cliArgs.push("--env", `${k}=${v}`);
    }
  }
  for (const key of options.unsetEnv ?? []) {
    cliArgs.push("--unset-env", key);
  }
  if (options.tags) {
    for (const [k, v] of Object.entries(options.tags)) {
      cliArgs.push("--tag", `${k}=${v}`);
    }
  }
  if (options.startupLease) {
    cliArgs.push("--startup-timeout-ms", String(options.startupLease.timeoutMs));
    cliArgs.push("--lifecycle-tag", options.startupLease.lifecycleTag);
  }
  cliArgs.push("--", options.command, ...options.args);

  const env = { ...process.env };
  if (options.creationLockOwnerPid !== undefined) {
    env.PTY_CREATION_LOCK_OWNER_PID = String(options.creationLockOwnerPid);
  } else {
    delete env.PTY_CREATION_LOCK_OWNER_PID;
  }

  const result = spawnSync("pty", cliArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    env,
  });
  if (result.error !== undefined) {
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new Error(
        `@compoundingtech/pty: bundled-context spawn requires the \`pty\` CLI on PATH. ` +
          `Install @compoundingtech/pty so its \`bin/pty\` is available, or call ` +
          `setServerModulePath() with a real on-disk server.js before spawnDaemon.`,
      );
    }
    throw err;
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    const stdout = (result.stdout ?? "").trim();
    const detail = stderr || stdout || `exit ${result.status}`;
    throw new Error(`pty CLI failed: ${detail}`);
  }
  return waitForSocket(options.name, 3000);
}

export function waitForSocket(
  name: string,
  timeoutMs: number,
  earlyCheck?: () => void
): Promise<void> {
  const socketPath = getSocketPath(name);
  const start = Date.now();

  return new Promise((resolve, reject) => {
    function check(): void {
      try {
        earlyCheck?.();
      } catch (e) {
        reject(e);
        return;
      }

      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timeout waiting for session "${name}" to start`));
        return;
      }

      try {
        const stat = fs.statSync(socketPath);
        if (stat) {
          setTimeout(resolve, 100);
          return;
        }
      } catch {}

      setTimeout(check, 50);
    }
    check();
  });
}

export function resolveCommand(cmd: string): string {
  if (path.isAbsolute(cmd)) {
    if (!fs.existsSync(cmd)) {
      throw new Error(`Command not found: ${cmd}`);
    }
    return cmd;
  }

  if (cmd.includes("/")) {
    const resolved = path.resolve(cmd);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Command not found: ${cmd}`);
    }
    return resolved;
  }

  try {
    return execFileSync("which", [cmd], { encoding: "utf8" }).trim();
  } catch {
    throw new Error(`Command not found: ${cmd}`);
  }
}
