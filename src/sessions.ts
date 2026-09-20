import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as net from "node:net";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { isZombie, processOf } from "./proc-table.ts";
import {
  assertPrivateRecoveryPaths,
  atomicWritePrivate,
  recoveryRevisionPath,
  readProcessStartToken,
  signRecoveryRevision,
  stampRecoveryMetadata,
} from "./recovery.ts";
// Circular import: events.ts imports getEventsPath/ensureSessionDir from
// this file. Cycle is safe — `appendEventSync` is only called at runtime
// from inside functions, never at module-init time.
import {
  acquireEventLock, appendEventSync, appendEventSyncLocked, releaseEventLock,
  waitForEventLock,
  type EventRecord,
} from "./events.ts";

export const DEFAULT_SESSION_DIR = path.join(os.homedir(), ".local", "state", "pty");

let hasWarnedLegacyRootEnv = false;
let hasWarnedRootMasksLegacy = false;

const VALID_NAME_RE = /^[a-zA-Z0-9._-]+$/;

// Maximum bytes available to `sockaddr_un.sun_path`. Darwin/BSD = 104,
// Linux = 108. Pick the smallest so the same name works everywhere.
const SUN_PATH_MAX = 104;

export function validateName(name: string): void {
  if (!name || name.length === 0) {
    throw new Error("Session name cannot be empty.");
  }
  if (name === "." || name === "..") {
    throw new Error(`Invalid session name "${name}". Names cannot be "." or "..".`);
  }
  if (name.length > 255) {
    throw new Error("Session name too long (max 255 characters).");
  }
  if (!VALID_NAME_RE.test(name)) {
    throw new Error(
      `Invalid session name "${name}". Names may only contain letters, numbers, dots, hyphens, and underscores.`
    );
  }

  // Reject names whose resulting Unix-socket path would exceed the kernel
  // limit. Without this check the daemon's listen() fails with EINVAL inside
  // an error handler that used to silently log and hang. See BUG-1.
  const socketPath = path.join(getSessionDir(), `${name}.sock`);
  const byteLen = Buffer.byteLength(socketPath, "utf-8");
  if (byteLen > SUN_PATH_MAX) {
    const overflow = byteLen - SUN_PATH_MAX;
    throw new Error(
      `Session name "${name}" produces a socket path of ${byteLen} bytes, ` +
      `which exceeds the ${SUN_PATH_MAX}-byte kernel limit by ${overflow}. ` +
      `Shorten the name or set PTY_SESSION_DIR to a shorter path.`
    );
  }
}

/** Validate mutable presentation metadata independently of stable session ids. */
export function validateDisplayName(name: string): void {
  if (name.length === 0) {
    throw new Error("Display name cannot be empty.");
  }
  if (name !== name.trim()) {
    throw new Error("Display name must be trimmed.");
  }
  if (Array.from(name).length > 160) {
    throw new Error("Display name too long (max 160 Unicode scalars).");
  }
  if (/[\p{Cc}\u2028\u2029]/u.test(name)) {
    throw new Error("Display name must be single-line and contain no control characters.");
  }
}

export function getSessionDir(): string {
  const root = process.env.PTY_ROOT;
  const legacy = process.env.PTY_SESSION_DIR;
  if (root && root.length > 0) {
    // PTY_ROOT (canonical) wins. If a caller ALSO set the deprecated
    // PTY_SESSION_DIR — e.g. a test/scratch harness trying to isolate — it's
    // silently masked, so their sessions land under PTY_ROOT instead of the dir
    // they asked for. Warn once (unless silenced) so the masking is visible
    // rather than an invisible leak into the wrong registry.
    if (legacy && legacy.length > 0 && !hasWarnedRootMasksLegacy && !process.env.PTY_ROOT_LEGACY_SILENT) {
      hasWarnedRootMasksLegacy = true;
      process.stderr.write(
        `pty: both PTY_ROOT and PTY_SESSION_DIR are set — using PTY_ROOT (${root}); ` +
        `PTY_SESSION_DIR (${legacy}) is ignored (deprecated). For isolation, set PTY_ROOT.\n`
      );
    }
    return root;
  }
  if (legacy && legacy.length > 0) {
    if (!hasWarnedLegacyRootEnv && !process.env.PTY_ROOT_LEGACY_SILENT) {
      hasWarnedLegacyRootEnv = true;
      process.stderr.write(
        "pty: PTY_SESSION_DIR is deprecated; use PTY_ROOT (same shape, canonical name).\n"
      );
    }
    return legacy;
  }
  return DEFAULT_SESSION_DIR;
}

export function ensureSessionDir(): void {
  fs.mkdirSync(getSessionDir(), { recursive: true, mode: 0o700 });
}

export function getSocketPath(name: string): string {
  return path.join(getSessionDir(), `${name}.sock`);
}

export function getPidPath(name: string): string {
  return path.join(getSessionDir(), `${name}.pid`);
}

export function getMetadataPath(name: string): string {
  return path.join(getSessionDir(), `${name}.json`);
}

export function getEventsPath(name: string): string {
  return path.join(getSessionDir(), `${name}.events.jsonl`);
}

// PUBLIC FORMAT — this is the on-disk shape of `<name>.json`. Any change
// to fields here (add / rename / remove / type change) MUST be reflected in
// `docs/disk-layout.md` and called out under `### Storage format` in the
// next CHANGELOG entry. A smoke test (`tests/disk-layout-docs.test.ts`)
// asserts every field name on this interface appears in the docs.
export interface SessionMetadata {
  /** Opaque daemon-generation token. Cleanup from an older process must not
   *  delete files whose metadata carries a different generation. */
  generation?: string;
  /** PID of the daemon that owns this metadata generation. Unlike the
   *  sidecar pidfile, this survives socket cleanup. Inventory accepts it only
   *  when the recovery process-start token still proves the same OS process. */
  daemonPid?: number;
  /** Capability advertised only by daemons that support authenticated,
   *  signal-free recovery of an unlinked registry. Treat `secret` as opaque. */
  recovery?: import("./recovery.ts").RecoveryCapability;
  command: string;
  args: string[];
  displayCommand: string; // original command as the user typed it
  cwd: string;
  /** Initial terminal geometry used to create the daemon. Persisted so an
   *  operator restart recreates the same launch rather than inheriting the
   *  restarter's terminal size. */
  rows?: number;
  cols?: number;
  /** Launch-time child lifetime/environment settings. Older metadata omits
   *  these fields and therefore retains the historical defaults. */
  ephemeral?: boolean;
  isolateEnv?: boolean;
  extraEnv?: Record<string, string>;
  unsetEnv?: string[];
  env?: Record<string, string>;
  createdAt: string;
  exitCode?: number;
  exitedAt?: string;
  lastLines?: string[];
  tags?: Record<string, string>;
  /** Optional human-friendly alias for the session. Mutable via `pty rename`.
   *  The immutable stable id is always `SessionInfo.name`. Most code should
   *  keep using `name`; `displayName` is a non-unique presentation label and
   *  resolves as a reference only when exactly one session matches it. */
  displayName?: string;
  /** ISO 8601 timestamp of the last non-readonly client ATTACH. Written by
   *  the daemon on every attach. Used by `pty gc --idle-days N` (and the
   *  per-session `strategy.idle-days=N` tag) to decide whether a permanent
   *  session has been abandoned. Absent on sessions that have never had a
   *  client attach — those are excluded from idle-reap (a session that
   *  was just spawned but not yet attached to isn't "idle"). */
  lastAttachAt?: string;
  /** Unix-millisecond timestamp of the last PTY output chunk the daemon processed.
   *  Written by the daemon, debounced to at most one persist per second while
   *  output flows (the daemon already parses every byte, so stamping is O(1)
   *  and adds no observation machinery). Absent on sessions that have produced
   *  no output yet. Consumers — e.g. st2's observed harness state — derive
   *  session activity from this; it is an activity signal, not a delivery or
   *  liveness signal. */
  lastOutputAtMs?: number;
}

export interface SessionInfo {
  name: string;
  socketPath: string;
  pid: number | null;
  /**
   * `running`  — daemon process is alive and its socket is reachable.
   * `exited`   — daemon wrote an exit record (`exitCode` / `exitedAt`) before
   *              shutting down; we know how it ended.
   * `vanished` — the daemon process is gone but no exit record was written.
   *              Most commonly caused by SIGKILL / OOM / power-loss, where the
   *              daemon had no chance to finalise metadata. Same reapability
   *              as `exited` (still cleaned up by `pty gc`), but the exit
   *              details are forever unknown.
   */
  status: "running" | "exited" | "vanished";
  metadata: SessionMetadata | null;
}

export type SessionExitEvidenceTail =
  | { _tag: "present"; lastLines: string[] }
  | { _tag: "unavailable" };

export interface SessionExitEvidence {
  name: string;
  generation: string;
  status: "exited" | "vanished";
  exitCode: number | null;
  stream: "combined";
  tail: SessionExitEvidenceTail;
}

export type SessionExitEvidenceResult =
  | { _tag: "snapshot"; snapshot: SessionExitEvidence }
  | {
    _tag: "unavailable";
    reason:
      | "missing"
      | "running"
      | "busy"
      | "generation-unavailable"
      | "invalid-metadata";
  };

export type RemoveSessionGenerationResult =
  | { _tag: "removed" }
  | { _tag: "missing" }
  | { _tag: "generation-mismatch" }
  | { _tag: "not-terminal" }
  | { _tag: "invalid-metadata" }
  | { _tag: "busy" };

export const SESSION_EXIT_LAST_LINES_LIMIT = 200;
const SESSION_EXIT_EVIDENCE_METADATA_MAX_BYTES = 1024 * 1024;

/** Semantic helper: session has metadata but no live daemon (either `exited`
 *  or `vanished`). Use this wherever the branch is "there's a record and we
 *  might want to re-use cwd/tags/displayName"; reserve `=== "exited"` for
 *  branches that specifically care about clean-exit details. */
export function isGone(status: SessionInfo["status"]): boolean {
  return status === "exited" || status === "vanished";
}

/** Atomic file publish: write to a unique per-writer tmp file in the
 *  same directory, then rename over the target. Readers see either
 *  the old file or the new one, never a half-written intermediate.
 *  Concurrent writers do NOT coordinate — the last rename wins — but
 *  they can't corrupt each other's tmp files because each writer uses
 *  its own unique path. Same-filesystem rename on POSIX is atomic. */
export function atomicWriteFileSync(target: string, content: string): void {
  const tmp = `${target}.tmp.${process.pid}.${randomHex(8)}`;
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, target);
  } catch (e) {
    // If writeFileSync or renameSync fails, try to clean up the tmp.
    // Silent — the original target is still intact either way.
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

/** Async twin of `atomicWriteFileSync` for code paths that are already
 *  async (EventWriter, etc). Same semantics, same guarantees. */
export async function atomicWriteFile(target: string, content: string): Promise<void> {
  const tmp = `${target}.tmp.${process.pid}.${randomHex(8)}`;
  try {
    await fsp.writeFile(tmp, content);
    await fsp.rename(tmp, target);
  } catch (e) {
    try { await fsp.unlink(tmp); } catch {}
    throw e;
  }
}

function randomHex(bytes: number): string {
  // Small inline hex generator — keeping sessions.ts free of a `node:crypto`
  // import for this tiny helper. Not cryptographic; just needs low
  // collision probability across concurrent writers in the same dir.
  let out = "";
  for (let i = 0; i < bytes; i++) out += Math.floor(Math.random() * 256).toString(16).padStart(2, "0");
  return out;
}

export interface WriteMetadataHooks {
  /** @internal Deterministic seam for proving recovery revision publication
   *  precedes the metadata rename. */
  afterRecoveryRevisionPublished?: () => void;
}

export function writeMetadata(
  name: string,
  metadata: SessionMetadata,
  hooks: WriteMetadataHooks = {},
): SessionMetadata {
  ensureSessionDir();
  const stamped = stampRecoveryMetadata(metadata);
  const capability = stamped.recovery;
  if (capability && stamped.generation) {
    const root = path.resolve(getSessionDir());
    assertPrivateRecoveryPaths(root, capability);
    atomicWritePrivate(
      recoveryRevisionPath(root, name),
      signRecoveryRevision(capability.secret, {
        protocol: capability.protocol,
        name,
        generation: stamped.generation,
        metadataRevision: capability.metadataRevision,
      }),
    );
    hooks.afterRecoveryRevisionPublished?.();
  }
  // For capability-bearing metadata the signed revision is authoritative
  // first. If this rename fails, the advanced revision intentionally makes the
  // old visible metadata unrecoverable rather than authorizing stale rollback.
  atomicWriteFileSync(getMetadataPath(name), JSON.stringify(stamped, null, 2));
  return stamped;
}

export interface MetadataPatch {
  displayName?: string | null;
  tags?: Record<string, string | null>;
}

/** Total budget a `metadata patch` waits for the creation/attach window
 *  (issue #180) before failing closed with `busy`. The attached child can
 *  start while `pty run` still holds the per-session creation lock, so an
 *  immediate patch from the child would deterministically fail; waiting here
 *  (bounded, never indefinite) makes child-start patching reliable without
 *  pushing poll loops onto every caller. */
export const METADATA_PATCH_WAIT_MS = 8000;

/** Poll interval for creation-lock waits. Short enough that a patch unblocks
 *  promptly after the lock releases; long enough to avoid a hot spin. */
const METADATA_PATCH_POLL_MS = 25;

export interface MetadataPatchResult {
  changed: boolean;
  metadata: SessionMetadata;
}

type MetadataChangeSnapshot = {
  displayName?: string | null;
  tags?: Record<string, string | null>;
};

type MetadataPatchEvent = "metadata_change" | "display_name_change" | "tags_change";

export type MetadataMutationResult =
  | { status: "changed"; metadata: SessionMetadata }
  | { status: "unchanged"; metadata: SessionMetadata }
  | { status: "busy" }
  | { status: "missing" }
  | { status: "generation-mismatch" }
  | { status: "stale" };

/** Serialize one whole-record metadata mutation against lifecycle writers. */
export function mutateMetadataUnderLock(
  name: string,
  mutate: (metadata: SessionMetadata) => boolean,
  options: {
    expectedGeneration?: string;
    expectedMetadata?: SessionMetadata;
    onPublished?: (metadata: SessionMetadata) => void;
    /** Bounded wait for the creation lock before reporting `busy`. Defaults
     *  to 0 (immediate, historical behavior) — only the `metadata patch`
     *  path opts into waiting, so gc/respawn/exec contention semantics are
     *  unchanged. */
    waitMs?: number;
  } = {},
): MetadataMutationResult {
  const waitMs = options.waitMs ?? 0;
  const acquired = waitMs > 0
    ? waitForLockSync(name, waitMs)
    : acquireLock(name);
  if (!acquired) return { status: "busy" };

  try {
    const metadata = readMetadata(name);
    if (!metadata) return { status: "missing" };
    if (
      options.expectedMetadata !== undefined &&
      !metadataMatchesObservation(options.expectedMetadata, metadata)
    ) {
      return { status: "generation-mismatch" };
    }
    if (
      options.expectedGeneration !== undefined &&
      metadata.generation !== options.expectedGeneration
    ) {
      return { status: "generation-mismatch" };
    }

    const observed = JSON.stringify(metadata);
    if (!mutate(metadata)) return { status: "unchanged", metadata };

    const latest = readMetadata(name);
    if (!latest || JSON.stringify(latest) !== observed) return { status: "stale" };
    if (
      options.expectedMetadata !== undefined &&
      !metadataMatchesObservation(options.expectedMetadata, latest)
    ) {
      return { status: "generation-mismatch" };
    }
    if (
      options.expectedGeneration !== undefined &&
      latest.generation !== options.expectedGeneration
    ) {
      return { status: "generation-mismatch" };
    }

    const published = writeMetadata(name, metadata);
    options.onPublished?.(published);
    return { status: "changed", metadata: published };
  } finally {
    releaseLock(name);
  }
}

export type TagCompareAndSetResult =
  | { status: "changed"; value: string }
  | { status: "unchanged"; value: string }
  | { status: "value-mismatch"; value?: string }
  | { status: "busy" }
  | { status: "missing" }
  | { status: "generation-mismatch" }
  | { status: "stale" };

/** Generation-fenced compare-and-set for one exact tag value.
 *
 * This is the metadata primitive used by the daemon protocol. Callers that
 * need a startup lease disarmed must use that live protocol rather than this
 * filesystem helper, because the daemon owns the deadline timer. */
export function compareAndSetTagValue(
  name: string,
  expectedGeneration: string,
  tag: string,
  expectedValue: string,
  value: string,
): TagCompareAndSetResult {
  if (tag.length === 0) throw new Error("tag must not be empty");
  let currentValue: string | undefined;
  let matched = false;
  const result = mutateMetadataUnderLock(name, (metadata) => {
    currentValue = metadata.tags?.[tag];
    if (currentValue !== expectedValue) return false;
    matched = true;
    if (currentValue === value) return false;
    metadata.tags = { ...metadata.tags, [tag]: value };
    return true;
  }, { expectedGeneration });
  if (
    (result.status === "changed" || result.status === "unchanged") &&
    !matched
  ) {
    return currentValue === undefined
      ? { status: "value-mismatch" }
      : { status: "value-mismatch", value: currentValue };
  }
  if (result.status === "changed") return { status: "changed", value };
  if (result.status === "unchanged") return { status: "unchanged", value };
  return result;
}

function validateMetadataPatch(patch: unknown): asserts patch is MetadataPatch {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("Metadata patch must be a JSON object.");
  }
  for (const key of Object.keys(patch)) {
    if (key !== "displayName" && key !== "tags") {
      throw new Error(`Metadata patch has unknown field "${key}". Allowed fields: displayName, tags.`);
    }
  }
  const candidate = patch as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(candidate, "displayName")) {
    if (candidate.displayName !== null && typeof candidate.displayName !== "string") {
      throw new Error("Metadata patch displayName must be a string or null.");
    }
    if (typeof candidate.displayName === "string") {
      try {
        validateDisplayName(candidate.displayName);
      } catch (e) {
        throw new Error(`Invalid displayName: ${(e as Error).message}`);
      }
    }
  }
  if (Object.prototype.hasOwnProperty.call(candidate, "tags")) {
    const tags = candidate.tags;
    if (tags === null || typeof tags !== "object" || Array.isArray(tags)) {
      throw new Error("Metadata patch tags must be a JSON object.");
    }
    for (const [key, value] of Object.entries(tags as Record<string, unknown>)) {
      if (key.length === 0) throw new Error("Metadata patch tag keys must be non-empty.");
      if (value !== null && typeof value !== "string") {
        throw new Error(`Metadata patch tag values must be strings or null (invalid key: "${key}").`);
      }
    }
  }
}

function setRecordValue(record: Record<string, string>, key: string, value: string): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function applyMetadataPatchById(
  id: string,
  patch: MetadataPatch,
  eventType: MetadataPatchEvent,
  /** Remaining bounded wait for the creation lock. The async patch path
   *  pre-acquires the event lock without blocking the event loop; synchronous
   *  callers keep their historical fail-fast event-lock behavior. */
  waitMs: number = 0,
  eventLockHeld: boolean = false,
): MetadataPatchResult {
  validateMetadataPatch(patch);
  const deadline = Date.now() + Math.max(0, waitMs);
  if (!eventLockHeld && !acquireEventLock(id)) {
    throw new Error(`Session id "${id}" event log is busy. Retry the operation.`);
  }
  try {
    let previousTags: Record<string, string> = {};
    let nextTags: Record<string, string> = {};
    const previous: MetadataChangeSnapshot = {};
    const value: MetadataChangeSnapshot = {};
    const result = mutateMetadataUnderLock(id, (metadata) => {
      previousTags = Object.fromEntries(Object.entries(metadata.tags ?? {}));
      nextTags = Object.fromEntries(Object.entries(previousTags));
      if (Object.prototype.hasOwnProperty.call(patch, "displayName")) {
        const before = metadata.displayName ?? null;
        const after = patch.displayName ?? null;
        if (before !== after) {
          previous.displayName = before;
          value.displayName = after;
          if (after === null) delete metadata.displayName;
          else metadata.displayName = after;
        }
      }

      if (patch.tags !== undefined) {
        const changedTagKeys: string[] = [];
        for (const [key, requested] of Object.entries(patch.tags)) {
          const before = Object.prototype.hasOwnProperty.call(previousTags, key)
            ? previousTags[key]
            : null;
          const after = requested ?? null;
          if (before === after) continue;
          changedTagKeys.push(key);
          if (after === null) delete nextTags[key];
          else setRecordValue(nextTags, key, after);
        }
        if (changedTagKeys.length > 0) {
          previous.tags = {};
          value.tags = {};
          for (const key of changedTagKeys.sort()) {
            const before = Object.prototype.hasOwnProperty.call(previousTags, key)
              ? previousTags[key]
              : null;
            const after = Object.prototype.hasOwnProperty.call(nextTags, key)
              ? nextTags[key]
              : null;
            Object.defineProperty(previous.tags, key, { value: before, enumerable: true });
            Object.defineProperty(value.tags, key, { value: after, enumerable: true });
          }
          if (Object.keys(nextTags).length === 0) delete metadata.tags;
          else metadata.tags = nextTags;
        }
      }

      const changed = Object.keys(previous).length > 0;
      if (!changed) return false;

      if (metadata.displayName !== undefined) validateDisplayName(metadata.displayName);
      for (const [key, tagValue] of Object.entries(metadata.tags ?? {})) {
        if (key.length === 0) throw new Error("Resulting metadata contains an empty tag key.");
        if (typeof tagValue !== "string") {
          throw new Error(`Resulting metadata tag "${key}" is not a string.`);
        }
      }

      return true;
    }, {
      onPublished: () => {
        if (eventType === "metadata_change") {
          appendEventSyncLocked(id, {
            session: id,
            type: "metadata_change",
            ts: new Date().toISOString(),
            previous,
            value,
          });
        } else if (eventType === "display_name_change") {
          appendEventSyncLocked(id, {
            session: id,
            type: "display_name_change",
            ts: new Date().toISOString(),
            previous: previous.displayName ?? null,
            value: value.displayName ?? null,
          });
        } else {
          appendEventSyncLocked(id, {
            session: id,
            type: "tags_change",
            ts: new Date().toISOString(),
            previous: previousTags,
            value: nextTags,
          });
        }
      },
      // Share the remaining attach-window budget with the creation lock
      // wait; genuinely stuck locks still report `busy` below.
      waitMs: Math.max(0, deadline - Date.now()),
    });

    if (result.status === "busy") {
      throw new Error(`Session id "${id}" metadata is busy. Retry the operation.`);
    }
    if (result.status === "missing") throw new Error(`Session id "${id}" not found.`);
    if (result.status === "stale" || result.status === "generation-mismatch") {
      throw new Error(`Session id "${id}" metadata changed during the operation. Retry it.`);
    }
    return { changed: result.status === "changed", metadata: result.metadata };
  } finally {
    if (!eventLockHeld) releaseEventLock(id);
  }
}

/** Atomically merge presentation metadata for one exact stable session id.
 *
 *  Waits boundedly (`waitMs`, default `METADATA_PATCH_WAIT_MS`) for the
 *  creation/attach window (issue #180) instead of failing `busy` at once:
 *  an attached child can run before the daemon publishes the record, and
 *  while `pty run` still holds the creation lock. The wait only stretches
 *  while a live creation lock says a creation is in flight — unknown ids
 *  still fail fast, and stuck locks still fail `busy` once the budget is
 *  spent. Never waits indefinitely. */
export async function patchMetadataById(
  id: string,
  patch: MetadataPatch,
  waitMs: number = METADATA_PATCH_WAIT_MS,
): Promise<MetadataPatchResult> {
  validateMetadataPatch(patch);
  const deadline = Date.now() + Math.max(0, waitMs);
  while (isCreationLockHeld(id)) {
    if (Date.now() >= deadline) {
      throw new Error(`Session id "${id}" metadata is busy. Retry the operation.`);
    }
    await new Promise((resolve) => setTimeout(resolve, METADATA_PATCH_POLL_MS));
  }
  if (!await getSessionByName(id)) throw new Error(`Session id "${id}" not found.`);
  await waitForEventLock(id, Math.max(0, deadline - Date.now()));
  try {
    return applyMetadataPatchById(
      id,
      patch,
      "metadata_change",
      Math.max(0, deadline - Date.now()),
      true,
    );
  } finally {
    releaseEventLock(id);
  }
}

/** Set or clear the displayName on an existing session. Atomic read-modify-write.
 *  Pass `null` to remove the alias. Throws if `name` doesn't exist. Emits a
 *  `display_name_change` event when (and only when) the value actually
 *  changed — no-op renames don't ping downstream watchers. */
export function setDisplayName(name: string, displayName: string | null): void {
  applyMetadataPatchById(
    name,
    { displayName: displayName === "" ? null : displayName },
    "display_name_change",
  );
}

/** Update tags on an existing session. Performs an atomic read-modify-write.
 *  Emits a `tags_change` event carrying snapshots of the full previous and
 *  new tag maps when the effective tags change. No-op updates (e.g. setting
 *  a key to the same value, removing a key that isn't there) don't emit. */
export function updateTags(
  name: string,
  updates: Record<string, string>,
  removals: string[] = [],
): void {
  const tags: Record<string, string | null> = { ...updates };
  for (const key of removals) tags[key] = null;
  applyMetadataPatchById(name, { tags }, "tags_change");
}

export function readMetadata(name: string): SessionMetadata | null {
  try {
    const content = fs.readFileSync(getMetadataPath(name), "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export interface ListSessionsOptions {
  /** Overall budget shared by every fallback socket probe in this listing. */
  socketProbeBudgetMs?: number;
  /** Test seam for simulating slow or permission-denied socket probes. */
  socketProbe?: (socketPath: string) => Promise<boolean>;
}

const DEFAULT_SOCKET_PROBE_BUDGET_MS = 500;

/** @internal Testable gc observation/apply token; not part of client-api. */
export interface RawCleanupCandidate {
  name: string;
}

type MetadataArtifactState = "absent" | "valid" | "malformed" | "unreadable";

function inspectMetadataArtifact(
  name: string,
  hasMetadata: boolean,
): MetadataArtifactState {
  if (!hasMetadata) return "absent";
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(getMetadataPath(name), "utf-8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? "valid"
      : "malformed";
  } catch (error) {
    return error instanceof SyntaxError ? "malformed" : "unreadable";
  }
}

/** Inventory registry debris that cannot be represented as a SessionInfo.
 *
 * This is deliberately separate from listSessions: observation never mutates,
 * while gc still needs to discover stale runtime artifacts whose metadata is
 * missing or malformed. A readable dead pid is positive proof that an
 * associated socket is stale; malformed metadata without any runtime files is
 * also reclaimable. Ambiguous startup shapes (socket + missing/invalid pid) are
 * retained. */
export async function inventoryRawCleanupCandidates(
  options: ListSessionsOptions = {},
  onlyNames?: ReadonlySet<string>,
): Promise<RawCleanupCandidate[]> {
  let entries: string[];
  try {
    entries = fs.readdirSync(getSessionDir());
  } catch {
    return [];
  }

  const names = new Set<string>();
  for (const entry of entries) {
    let name: string | undefined;
    if (entry.endsWith(".events.jsonl")) name = entry.slice(0, -".events.jsonl".length);
    else if (entry.endsWith(".sock")) name = entry.slice(0, -".sock".length);
    else if (entry.endsWith(".pid")) name = entry.slice(0, -".pid".length);
    else if (entry.endsWith(".json")) name = entry.slice(0, -".json".length);
    if (name && (!onlyNames || onlyNames.has(name))) names.add(name);
  }

  const entrySet = new Set(entries);
  const candidates = [...names].sort().map((name) => {
    const hasSocket = entrySet.has(`${name}.sock`);
    const hasPid = entrySet.has(`${name}.pid`);
    const hasMetadata = entrySet.has(`${name}.json`);
    const metadataState = inspectMetadataArtifact(name, hasMetadata);
    const pid = hasPid ? readPid(name) : null;
    const pidDead = pid !== null && !isProcessAlive(pid);
    return { name, hasSocket, hasPid, hasMetadata, metadataState, pidDead };
  }).filter(({ metadataState }) =>
    metadataState === "absent" || metadataState === "malformed"
  );

  const socketsToProbe = candidates
    .filter(({ hasSocket, pidDead }) => hasSocket && pidDead)
    .map(({ name }) => getSocketPath(name));
  const reachability = await probeSocketsWithinBudget(
    socketsToProbe,
    options.socketProbeBudgetMs ?? DEFAULT_SOCKET_PROBE_BUDGET_MS,
    options.socketProbe ?? isSocketReachable,
  );

  return candidates.flatMap((candidate) => {
    if (candidate.pidDead) {
      if (
        !candidate.hasSocket ||
        reachability.get(getSocketPath(candidate.name)) === false
      ) {
        return [{ name: candidate.name }];
      }
      return [];
    }
    if (candidate.hasMetadata && !candidate.hasPid && !candidate.hasSocket) {
      return [{ name: candidate.name }];
    }
    return [];
  });
}

/** Apply one raw-artifact cleanup only while owning the per-name creation lock.
 *
 * Re-inventorying under the lock closes the observation/apply race: if a live
 * generation appeared, or the evidence became ambiguous, cleanup is skipped. */
export async function cleanupRawCandidateGuarded(
  candidate: RawCleanupCandidate,
  options: ListSessionsOptions = {},
): Promise<boolean> {
  if (!acquireEventLock(candidate.name)) return false;
  if (!acquireLock(candidate.name)) {
    releaseEventLock(candidate.name);
    return false;
  }
  try {
    const current = await inventoryRawCleanupCandidates(
      options,
      new Set([candidate.name]),
    );
    if (!current.some(({ name }) => name === candidate.name)) return false;

    cleanupSocket(candidate.name);
    try {
      fs.unlinkSync(getMetadataPath(candidate.name));
    } catch {}
    try {
      fs.unlinkSync(getEventsPath(candidate.name));
    } catch {}
    try {
      fs.unlinkSync(recoveryRevisionPath(path.resolve(getSessionDir()), candidate.name));
    } catch {}
    return true;
  } finally {
    releaseLock(candidate.name);
    releaseEventLock(candidate.name);
  }
}

function metadataMatchesObservation(
  observed: SessionMetadata,
  current: SessionMetadata,
): boolean {
  if (observed.generation !== undefined || current.generation !== undefined) {
    return observed.generation !== undefined &&
      observed.generation === current.generation;
  }
  // Legacy records have no generation token. Exact structural equality is a
  // conservative fallback: any intervening tag/launch/exit update makes the
  // observation stale and suppresses cleanup.
  return JSON.stringify(observed) === JSON.stringify(current);
}

/** @internal Remove session artifacts while the caller owns both event and metadata locks. */
export function cleanupAllWhileLocked(name: string): void {
  cleanupSocket(name);
  try {
    fs.unlinkSync(getMetadataPath(name));
  } catch {}
  try {
    fs.unlinkSync(getEventsPath(name));
  } catch {}
  try {
    fs.unlinkSync(recoveryRevisionPath(path.resolve(getSessionDir()), name));
  } catch {}
}

/** @internal Generation-CAS cleanup primitive; not part of client-api. */
export async function cleanupObservedSession(
  session: SessionInfo,
): Promise<boolean> {
  if (!session.metadata || !acquireEventLock(session.name)) return false;
  if (!acquireLock(session.name)) {
    releaseEventLock(session.name);
    return false;
  }
  try {
    const current = readMetadata(session.name);
    if (
      !current ||
      !metadataMatchesObservation(session.metadata, current)
    ) {
      return false;
    }
    cleanupAllWhileLocked(session.name);
    return true;
  } finally {
    releaseLock(session.name);
    releaseEventLock(session.name);
  }
}

type ReapObservedResult =
  | { status: "reaped" }
  | {
    status: "skipped";
    reason: "busy" | "stale" | "signal-failed" | "shutdown-timeout";
    signalled: boolean;
  };

/** Is `pid` gone for reaping purposes? A zombie counts as exited.
 *
 *  Exported because `pty kill` and the spawner both need the same question
 *  answered. `isProcessAlive` is not a substitute: an unreaped process still
 *  answers `kill(pid, 0)` and still has a readable start token, so the cheap
 *  predicates call a corpse alive — a survivor to the one, a live owner to the
 *  other. */
export function hasProcessExitedForReap(pid: number): boolean {
  if (!isProcessAlive(pid)) return true;
  // One `/proc` read on Linux and no subprocess. On macOS this is still one
  // `ps` per call, which is Node's floor without a native module — but it asks
  // about ONE pid rather than reading the whole table, because this sits inside
  // poll loops that run every 25 ms.
  const row = processOf(pid);
  if (row.kind === "known") return isZombie(row.value);
  if (row.kind === "not-present") return true;
  // We did not find out. Ask the kernel once more rather than reading our own
  // silence as a death.
  return !isProcessAlive(pid);
}

/** Read a `ps -o stat=` field. `stillAlive` is asked only when the field is
 *  empty, and it is a FRESH answer rather than the one taken before `ps` ran.
 *
 *  An empty field is two answers wearing one shape: the process is gone, or
 *  `ps` did not manage to say. Reading it as "gone" is a failure folded into an
 *  answer about what is there — so on an empty field we ask the kernel again
 *  instead of reading silence as death. Under load on macOS `ps` is exactly
 *  the thing that goes quiet. */
export function reapedFromPsState(state: string, stillAlive: () => boolean): boolean {
  if (state.startsWith("Z")) return true;
  if (state === "") return !stillAlive();
  return false;
}

/** Signal only after proving ownership, then reacquire after daemon shutdown
 *  so its final event/metadata flush cannot recreate artifacts after cleanup. */
async function reapObservedSession(
  session: SessionInfo,
  event?: Extract<EventRecord, { type: "session_abandoned" }>,
): Promise<ReapObservedResult> {
  if (!session.metadata) return { status: "skipped", reason: "stale", signalled: false };
  if (!acquireEventLock(session.name)) {
    return { status: "skipped", reason: "busy", signalled: false };
  }
  if (!acquireLock(session.name)) {
    releaseEventLock(session.name);
    return { status: "skipped", reason: "busy", signalled: false };
  }
  let signalled = false;
  let signalFailed = false;
  try {
    const current = readMetadata(session.name);
    if (!current || !metadataMatchesObservation(session.metadata, current)) {
      return { status: "skipped", reason: "stale", signalled: false };
    }

    if (session.status === "running" && session.pid != null) {
      try {
        process.kill(session.pid, "SIGTERM");
        signalled = true;
      } catch {
        signalFailed = isProcessAlive(session.pid);
      }
    }
  } finally {
    releaseLock(session.name);
    releaseEventLock(session.name);
  }

  if (signalFailed) {
    return { status: "skipped", reason: "signal-failed", signalled: false };
  }

  if (signalled && session.pid != null) {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline && !hasProcessExitedForReap(session.pid)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!hasProcessExitedForReap(session.pid)) {
      return { status: "skipped", reason: "shutdown-timeout", signalled: true };
    }
  }

  if (!acquireEventLock(session.name)) {
    return { status: "skipped", reason: "busy", signalled };
  }
  if (!acquireLock(session.name)) {
    releaseEventLock(session.name);
    return { status: "skipped", reason: "busy", signalled };
  }
  try {
    const current = readMetadata(session.name);
    if (!current || !metadataMatchesObservation(session.metadata, current)) {
      return { status: "skipped", reason: "stale", signalled };
    }
    if (event) appendEventSyncLocked(session.name, event);
    cleanupAllWhileLocked(session.name);
    return { status: "reaped" };
  } finally {
    releaseLock(session.name);
    releaseEventLock(session.name);
  }
}

/** Return one bounded, read-only observation of the session registry.
 *
 * This function deliberately performs no lifecycle work: it does not create
 * the registry, unlink stale runtime files, repair malformed records, or reap
 * old sessions. Callers that intend to mutate lifecycle state must use an
 * explicit operation such as `gc()` or `cleanupAll()`. */
export async function listSessions(options: ListSessionsOptions = {}): Promise<SessionInfo[]> {
  let entries: string[];
  try {
    entries = fs.readdirSync(getSessionDir());
  } catch {
    return [];
  }

  const sessions: SessionInfo[] = [];
  const seen = new Set<string>();

  // Classify sessions that have .sock files without changing registry state.
  // A live pid or reachable socket proves the daemon is alive. A readable dead
  // pid plus an unreachable socket lets retained metadata report the session as
  // exited/vanished below. An unreadable pid plus an unreachable socket remains
  // ambiguous and stays in the snapshot, reported running defensively unless
  // retained metadata already records exit. The daemon creates its .sock
  // (listen) BEFORE it writes its .pid, and the plain pidfile write can be
  // caught mid-flight.
  // Artifact cleanup belongs exclusively to explicit lifecycle operations such
  // as gc/rm.
  const sockFiles = entries.filter((e) => e.endsWith(".sock")).sort();
  const socketCandidates = sockFiles.map((sockFile) => {
    const name = sockFile.replace(/\.sock$/, "");
    const socketPath = getSocketPath(name);
    const pid = readPid(name);
    const pidAlive = pid !== null && isProcessAlive(pid);
    return { name, socketPath, pid, pidAlive };
  });

  // A reachable control socket proves the daemon is alive independently of
  // the pidfile. Start every necessary fallback concurrently and give the
  // entire fleet one shared deadline: N inaccessible sessions must not cost
  // N × 500ms before `pty list --json` emits anything.
  const needsProbe = socketCandidates.filter((candidate) => !candidate.pidAlive);
  const socketReachability = await probeSocketsWithinBudget(
    needsProbe.map((candidate) => candidate.socketPath),
    options.socketProbeBudgetMs ?? DEFAULT_SOCKET_PROBE_BUDGET_MS,
    options.socketProbe ?? isSocketReachable,
  );

  for (const { name, socketPath, pid, pidAlive } of socketCandidates) {
    seen.add(name);
    const socketReachable = pidAlive || socketReachability.get(socketPath) === true;

    if (pidAlive || socketReachable) {
      // Alive: a live process, or a reachable control socket (busy/mid-startup
      // daemon whose pid we couldn't read). The daemon writes exit metadata
      // before its cleanup delay, so a reachable socket can briefly coexist
      // with exitedAt being set.
      const metadata = readMetadata(name);
      const status = metadata?.exitedAt ? "exited" : "running";
      sessions.push({ name, socketPath, pid, status, metadata });
    } else if (pid !== null) {
      // Positively dead: report the retained record in this same snapshot.
      // Listing is observational; explicit gc/rm owns artifact cleanup.
      const metadata = readMetadata(name);
      if (metadata) {
        const vanished = metadata.exitedAt == null && metadata.exitCode == null;
        sessions.push({
          name,
          socketPath,
          pid: null,
          status: vanished ? "vanished" : "exited",
          metadata,
        });
      }
    } else {
      // pid UNREADABLE and socket unreachable — we can prove neither life nor
      // death (most likely a daemon mid-startup, or a pidfile write that raced
      // our read under load). Do NOT destroy it; report it running defensively
      // (a .sock exists). A later read resolves the true state once the pidfile
      // settles or the socket comes up.
      const metadata = readMetadata(name);
      const status = metadata?.exitedAt ? "exited" : "running";
      sessions.push({ name, socketPath, pid, status, metadata });
    }
  }

  // Find retained sessions (have .json but no socket observed above).
  const jsonFiles = entries.filter((e) => e.endsWith(".json")).sort();
  for (const jsonFile of jsonFiles) {
    const name = jsonFile.replace(/\.json$/, "");
    if (seen.has(name)) continue; // already handled above

    const metadata = readMetadata(name);
    if (!metadata) {
      continue;
    }

    // A live pid remains authoritative even if its socket inode is temporarily
    // absent. Listing observes that mismatch; it never "repairs" it.
    const pid = readPid(name, metadata);
    if (pid !== null && isProcessAlive(pid)) {
      sessions.push({
        name,
        socketPath: getSocketPath(name),
        pid,
        status: metadata.exitedAt ? "exited" : "running",
        metadata,
      });
      continue;
    }

    // Vanished = dead daemon with no exit record. SIGKILL / OOM / crash.
    const vanished =
      metadata.exitedAt == null && metadata.exitCode == null;

    sessions.push({
      name,
      socketPath: getSocketPath(name),
      pid: null,
      status: vanished ? "vanished" : "exited",
      metadata,
    });
  }

  return sessions.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Tag key that exempts a session from the exit-time self-reap in the daemon
 *  AND — for a bounded retention window — from `pty gc`'s sweep of exited
 *  non-permanent sessions. Set it when you want a session's metadata,
 *  `lastLines`, and events file to survive its own death so you can inspect
 *  them afterwards. Mirrors the `keep` field in the agent spec.
 *
 *  The gc exemption is time-boxed (`DEFAULT_KEEP_MAX_AGE_MS`), not eternal:
 *  agents set `keep=true` to protect a session they are debugging *now*, and
 *  nobody comes back to untag it, so an unbounded exemption turns the
 *  registry into an append-only log. Exit-time retention is unconditional —
 *  expiry only ever happens on a gc pass, and only once the session has been
 *  dead longer than the window. */
export const KEEP_TAG = "keep";

/** Values that read as "no" for the `keep` tag; everything else reads as
 *  "yes". The CLI's tag grammar is strictly `key=value`, so the form an
 *  operator types is `--tag keep=true` / `pty tag <ref> keep=true`.
 *
 *  Two deliberate choices. Presence-with-any-other-value counts as yes, so
 *  a tool that writes `keep=1` or `keep=yes` straight into metadata (convoy
 *  translating the agent spec's `keep #true`) gets the safe answer without
 *  having to match our spelling — and the failure mode of a typo is
 *  retaining a session, not destroying one. And `keep=false` explicitly
 *  reads as no, so the exemption can be turned off in place rather than
 *  only by removing the key. */
const KEEP_FALSEY = new Set(["false", "0", "no", "off"]);

/** Returns `true` when `tags` asks for this session to be retained after
 *  death. Callers should read tags from the CURRENT on-disk metadata rather
 *  than from a spawn-time config snapshot — `pty tag <ref> keep=true` on a
 *  *running* session is exactly how an operator pins a session they are
 *  about to debug, and that must be honoured at exit. */
export function isKeepRequested(tags?: Record<string, string>): boolean {
  const raw = tags?.[KEEP_TAG];
  if (raw === undefined) return false;
  return !KEEP_FALSEY.has(raw.trim().toLowerCase());
}

/** How long `keep` holds a dead session against `pty gc`'s sweep, unless the
 *  operator overrides it with `pty gc --keep-max-age <dur>`. Seven days is
 *  long enough that "I killed it Friday, I'll look Monday" still works, and
 *  short enough that a fleet of agents tagging every session cannot grow the
 *  registry without bound. */
export const DEFAULT_KEEP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Has a dead `keep`-tagged session outlived its retention window?
 *
 *  Age is anchored on `exitedAt` when the daemon wrote an exit record, else
 *  `createdAt` (a `vanished` session never wrote one) — the same anchor
 *  precedence `pty list --older-than` uses. Metadata carrying neither, or an
 *  unparseable timestamp, has no age and therefore never expires: retaining
 *  an unaged session is the recoverable failure, deleting it is not.
 *
 *  `maxAgeMs <= 0` expires everything, including unaged records — that is the
 *  explicit "sweep the keep backlog now" request, not an inference from a
 *  timestamp. Callers must apply this to dead sessions only; a RUNNING
 *  session is never a sweep candidate regardless of its age. */
export function isKeepExpired(
  metadata: SessionMetadata | null | undefined,
  nowMs: number,
  maxAgeMs: number,
): boolean {
  if (maxAgeMs <= 0) return true;
  const anchor = metadata?.exitedAt ?? metadata?.createdAt;
  if (!anchor) return false;
  const ts = Date.parse(anchor);
  if (!Number.isFinite(ts)) return false;
  return nowMs - ts >= maxAgeMs;
}

/** Should the daemon remove its own registry entry as it shuts down?
 *
 *  Exit-time reaping is CONFIGURABLE. `defaultReap` is the config default (see
 *  `reapOnExitDefault` — the `PTY_REAP_ON_EXIT` network/global knob), and two
 *  per-session flags override it either way. Precedence, highest first:
 *
 *    1. `keep` — force PRESERVE. Always wins, even over `--ephemeral`, and also
 *       exempts the session from `pty gc`'s sweep. Retains a dead session's
 *       logs and scrollback for debugging past even a gc pass.
 *    2. `--ephemeral` — force REAP. Reaps as the session shuts down (the
 *       aggressive opt-in), even for a `strategy=permanent` session, so a
 *       caller that wants no trace left gets it regardless of the config
 *       default.
 *    3. `strategy=permanent` — force PRESERVE. Its supervisor / `pty gc`'s
 *       respawn step reconciles against the dead session's metadata, so
 *       reaping it would destroy the record the respawn needs.
 *    4. `defaultReap` — the config default when none of the above apply.
 *       `true` reaps a finished non-permanent session at exit; `false`
 *       PRESERVES it (its metadata lingers, peekable, until `pty gc`'s sweep
 *       reclaims it).
 *
 *  A session whose daemon was SIGKILL'd (`status=vanished`) never runs this
 *  code and is reclaimed by gc's sweep. */
export function shouldReapAtExit(
  tags: Record<string, string> | undefined,
  ephemeral: boolean,
  // Optional so existing 2-arg callers (relay/layout/supervisors read this to
  // answer "is this session exempt from reaping?") keep working AND get the
  // correct env-driven default without having to thread it themselves.
  defaultReap: boolean = reapOnExitDefault(),
): boolean {
  if (isKeepRequested(tags)) return false;
  if (ephemeral) return true;
  if (tags?.strategy === "permanent") return false;
  return defaultReap;
}

/** Resolve the config default for exit-time reaping from the environment.
 *
 *  `PTY_REAP_ON_EXIT` is the network/global config knob: the daemon reads its
 *  own env (which the launching network sets), so setting it fleet-wide
 *  configures the default for every session — mirroring the env-var config
 *  style pty already uses for `PTY_SHUTDOWN_DEADLINE_MS`. `false`/`0`/`no`/`off`
 *  → PRESERVE; unset or anything else → REAP (the shipped default). Per-session
 *  `keep` / `--ephemeral` override this default either way. */
export function reapOnExitDefault(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.PTY_REAP_ON_EXIT;
  if (raw === undefined) return true;
  return !KEEP_FALSEY.has(raw.trim().toLowerCase());
}

/** Look up a session by its immutable on-disk id only. */
export async function getSessionByName(name: string): Promise<SessionInfo | null> {
  const sessions = await listSessions();
  return sessions.find((s) => s.name === name) ?? null;
}

async function isSessionGenerationAlive(
  name: string,
  metadata: ExitEvidenceMetadata,
): Promise<boolean> {
  const pids = new Set<number>();
  const sidecarPid = readSessionPid(name);
  if (sidecarPid !== null) pids.add(sidecarPid);
  if (metadata.daemonPid !== undefined) pids.add(metadata.daemonPid);
  if ([...pids].some(isProcessAlive)) return true;

  const socketPath = getSocketPath(name);
  return fs.existsSync(socketPath) && await isSocketReachable(socketPath);
}

interface ExitEvidenceMetadata {
  generation: string;
  daemonPid?: number;
  exitedAt?: string;
  exitCode?: number;
  lastLines?: string[];
}

type ExitEvidenceMetadataRead =
  | { _tag: "valid"; metadata: ExitEvidenceMetadata }
  | { _tag: "missing" }
  | { _tag: "generation-unavailable" }
  | { _tag: "invalid" };

function readExitEvidenceMetadata(name: string): ExitEvidenceMetadataRead {
  const metadataPath = getMetadataPath(name);
  let fd: number;
  try {
    fd = fs.openSync(
      metadataPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { _tag: "missing" }
      : { _tag: "invalid" };
  }

  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > SESSION_EXIT_EVIDENCE_METADATA_MAX_BYTES) {
      return { _tag: "invalid" };
    }

    const content = Buffer.alloc(SESSION_EXIT_EVIDENCE_METADATA_MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < content.length) {
      const read = fs.readSync(
        fd,
        content,
        bytesRead,
        content.length - bytesRead,
        null,
      );
      if (read === 0) break;
      bytesRead += read;
    }
    if (bytesRead > SESSION_EXIT_EVIDENCE_METADATA_MAX_BYTES) {
      return { _tag: "invalid" };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content.subarray(0, bytesRead).toString("utf8"));
    } catch {
      return { _tag: "invalid" };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { _tag: "invalid" };
    }

    const record = parsed as Record<string, unknown>;
    if (!("generation" in record)) return { _tag: "generation-unavailable" };
    if (typeof record.generation !== "string" || record.generation.length === 0) {
      return { _tag: "invalid" };
    }
    if (
      record.daemonPid !== undefined &&
      (!Number.isInteger(record.daemonPid) || (record.daemonPid as number) <= 0)
    ) {
      return { _tag: "invalid" };
    }

    const hasExitedAt = record.exitedAt !== undefined;
    const hasExitCode = record.exitCode !== undefined;
    if (hasExitedAt !== hasExitCode) return { _tag: "invalid" };
    if (
      hasExitedAt &&
      (typeof record.exitedAt !== "string" || record.exitedAt.length === 0 ||
        !Number.isInteger(record.exitCode))
    ) {
      return { _tag: "invalid" };
    }
    if (
      record.lastLines !== undefined &&
      (!Array.isArray(record.lastLines) ||
        record.lastLines.length > SESSION_EXIT_LAST_LINES_LIMIT ||
        !record.lastLines.every((line) => typeof line === "string"))
    ) {
      return { _tag: "invalid" };
    }

    return {
      _tag: "valid",
      metadata: {
        generation: record.generation,
        ...(record.daemonPid !== undefined
          ? { daemonPid: record.daemonPid as number }
          : {}),
        ...(hasExitedAt
          ? {
            exitedAt: record.exitedAt as string,
            exitCode: record.exitCode as number,
          }
          : {}),
        ...(record.lastLines !== undefined
          ? { lastLines: record.lastLines as string[] }
          : {}),
      },
    };
  } catch {
    return { _tag: "invalid" };
  } finally {
    fs.closeSync(fd);
  }
}

/** Read the bounded retained terminal evidence for one exact daemon generation.
 *
 * The per-name creation lock keeps a replacement from publishing between the
 * generation read and the returned snapshot. `lastLines` is copied exactly as
 * persisted; absence remains explicit instead of being synthesized as an empty
 * combined stream. */
export async function getSessionExitEvidence(
  name: string,
): Promise<SessionExitEvidenceResult> {
  validateName(name);
  if (!acquireLock(name)) return { _tag: "unavailable", reason: "busy" };

  try {
    const read = readExitEvidenceMetadata(name);
    if (read._tag === "missing") {
      return { _tag: "unavailable", reason: "missing" };
    }
    if (read._tag === "generation-unavailable") {
      return { _tag: "unavailable", reason: "generation-unavailable" };
    }
    if (read._tag === "invalid") {
      return { _tag: "unavailable", reason: "invalid-metadata" };
    }
    const metadata = read.metadata;
    if (await isSessionGenerationAlive(name, metadata)) {
      return { _tag: "unavailable", reason: "running" };
    }

    const exited = metadata.exitCode !== undefined;

    return {
      _tag: "snapshot",
      snapshot: {
        name,
        generation: metadata.generation,
        status: exited ? "exited" : "vanished",
        exitCode: exited ? metadata.exitCode! : null,
        stream: "combined",
        tail: metadata.lastLines !== undefined
          ? { _tag: "present", lastLines: [...metadata.lastLines] }
          : { _tag: "unavailable" },
      },
    };
  } finally {
    releaseLock(name);
  }
}

function unlinkIfPresent(target: string): void {
  try {
    fs.unlinkSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Remove one terminal session only if the retained record still carries the
 * caller's opaque generation. I/O failures propagate, and metadata is removed
 * last so a failed cleanup retains the evidence needed for a retry. */
export async function removeSessionGeneration(
  name: string,
  expectedGeneration: string,
): Promise<RemoveSessionGenerationResult> {
  validateName(name);
  if (expectedGeneration.length === 0) {
    throw new Error("Expected session generation cannot be empty.");
  }
  if (!acquireEventLock(name)) return { _tag: "busy" };
  if (!acquireLock(name)) {
    releaseEventLock(name);
    return { _tag: "busy" };
  }

  try {
    let read = readExitEvidenceMetadata(name);
    if (read._tag === "missing") return { _tag: "missing" };
    if (read._tag === "generation-unavailable") {
      return { _tag: "generation-mismatch" };
    }
    if (read._tag !== "valid") return { _tag: "invalid-metadata" };
    let metadata = read.metadata;
    if (metadata.generation !== expectedGeneration) {
      return { _tag: "generation-mismatch" };
    }
    if (await isSessionGenerationAlive(name, metadata)) {
      return { _tag: "not-terminal" };
    }

    read = readExitEvidenceMetadata(name);
    if (read._tag === "missing") return { _tag: "missing" };
    if (read._tag === "generation-unavailable") {
      return { _tag: "generation-mismatch" };
    }
    if (read._tag !== "valid") return { _tag: "invalid-metadata" };
    metadata = read.metadata;
    if (metadata.generation !== expectedGeneration) {
      return { _tag: "generation-mismatch" };
    }

    unlinkIfPresent(getSocketPath(name));
    unlinkIfPresent(getPidPath(name));
    unlinkIfPresent(getEventsPath(name));
    unlinkIfPresent(recoveryRevisionPath(path.resolve(getSessionDir()), name));
    unlinkIfPresent(getMetadataPath(name));
    return { _tag: "removed" };
  } finally {
    releaseLock(name);
    releaseEventLock(name);
  }
}

/** Look up a session by either its stable `name` (immutable id) or its mutable
 *  `displayName`. An exact stable-id match always wins. A display name resolves
 *  only when it identifies exactly one session; ambiguous labels fail closed
 *  and report the stable ids callers can use instead. */
export async function getSession(ref: string): Promise<SessionInfo | null> {
  const sessions = await listSessions();
  const byName = sessions.find((s) => s.name === ref);
  if (byName) return byName;
  const byDisplay = sessions.filter((s) => s.metadata?.displayName === ref);
  if (byDisplay.length <= 1) return byDisplay[0] ?? null;
  const ids = byDisplay.map((s) => s.name).sort();
  throw new Error(
    `Session reference "${ref}" is ambiguous. Matching stable session IDs:\n` +
    ids.map((id) => `  ${id}`).join("\n") +
    "\nUse a stable session ID instead."
  );
}

/** Return every immutable session id currently claimed by a live or exited session. */
export async function allSessionNames(): Promise<Set<string>> {
  return new Set((await listSessions()).map((session) => session.name));
}

/** Result of a `gc()` reconciliation pass. Five buckets correspond to the
 *  reconciliation steps: orphan-kill (step 1), abandoned-reap (step 1.5),
 *  permanent respawn success / failure (step 2), and the sweep of exited
 *  non-permanent sessions (step 3 — the historic `gc()` behavior). */
export interface GcResult {
  /** Names of exited/vanished non-permanent sessions whose metadata was
   *  removed. Empty under `dryRun: true` callers should treat the same
   *  list as the preview. */
  removed: string[];
  /** Dead non-permanent sessions left in place because they carry the
   *  `keep` tag and are still inside its retention window. Reported rather
   *  than silently skipped so an operator can see why `pty ls` still shows
   *  a dead session after a gc pass. */
  kept: string[];
  /** Dead non-permanent sessions swept DESPITE a `keep` tag because they
   *  outlived the retention window (`opts.keepMaxAgeMs`). Disjoint from
   *  `removed`, which holds the untagged sweep, so a caller can report
   *  "the keep tag expired" separately from ordinary stale-session
   *  cleanup. Under `dryRun: true` this is the preview. */
  keepExpired: string[];
  /** Children killed because their `parent=` referent is dead or missing. */
  killedOrphanChildren: { name: string; parent: string; reason: "missing" | "dead" }[];
  /** Live `strategy=permanent` sessions reaped because they've been
   *  detected as abandoned. `cwd-gone` fires on-by-default when the
   *  session's cwd no longer resolves; `idle` fires only when an
   *  `idleDays` threshold is set (via CLI flag or per-session tag)
   *  and `lastAttachAt` is older than that threshold. */
  abandoned: { name: string; reason: "cwd-gone" | "idle"; idleDays?: number }[];
  /** Reaps that could not complete safely. `signalled` distinguishes initial
   *  contention (the process was untouched) from a race after shutdown began. */
  reapSkipped: {
    name: string;
    operation: "orphan" | "abandoned";
    reason: "busy" | "stale" | "signal-failed" | "shutdown-timeout";
    signalled: boolean;
  }[];
  /** Permanent sessions respawned this pass. `ptyfileReread` indicates
   *  whether the spawn used a fresh `pty.toml` read (when the session
   *  carries `ptyfile` + `ptyfile.session` tags) or its stored metadata. */
  respawned: { name: string; ptyfileReread: boolean }[];
  /** Permanent sessions where respawn was attempted but failed (e.g. the
   *  binary is on an unmounted volume). Cron interval is the rate limit;
   *  next tick tries again. */
  respawnFailed: { name: string; error: string }[];
  /** Permanent sessions the fast-fail cap flipped to `flapping` on this
   *  tick. Each entry records the counter at the moment of flip plus the
   *  effective `limit`/`window` in play. Sessions already flagged before
   *  this tick are silently skipped from the respawn loop and do NOT
   *  appear here — this bucket is transitions only. */
  flapped: { name: string; counter: number; limit: number; window: number }[];
  /** Permanent sessions skipped this tick because they are already
   *  `strategy.status=flapping`. Distinct from `flapped` (transitions),
   *  `respawnFailed` (attempted + failed), and `respawned` (attempted +
   *  succeeded). Consumers can render "N flapping" without having to
   *  read tags themselves. */
  flappingSkipped: string[];
}

/** Default fast-fail respawn cap window (seconds). A permanent session
 *  that exits within `DEFAULT_FAST_FAIL_WINDOW_SEC` of its previous gc
 *  respawn counts as a fast fail. Overridden by `opts.fastFailWindowSec`
 *  or the per-session `strategy.fast-fail-window` tag. */
export const DEFAULT_FAST_FAIL_WINDOW_SEC = 60;

/** Default fast-fail limit. `DEFAULT_FAST_FAIL_LIMIT` consecutive fast
 *  fails flip the session to `strategy.status=flapping` and stop future
 *  respawns until the operator intervenes (or the stored command changes,
 *  which auto-resets). Overridden by `opts.fastFailLimit` or the
 *  per-session `strategy.fast-fail-limit` tag. */
export const DEFAULT_FAST_FAIL_LIMIT = 3;

/** @internal Commit one gc flapping transition against the observed generation. */
export function commitObservedFlapping(
  name: string,
  observed: SessionMetadata,
  bookkeeping: Record<string, string>,
  event: { counter: number; limit: number; window: number },
): boolean {
  if (!acquireEventLock(name)) return false;
  try {
    const result = mutateMetadataUnderLock(name, (metadata) => {
      metadata.tags = { ...(metadata.tags ?? {}), ...bookkeeping };
      return true;
    }, {
      expectedMetadata: observed,
      onPublished: () => appendEventSyncLocked(name, {
        session: name,
        type: "session_flapping",
        ts: new Date().toISOString(),
        counter: event.counter,
        limit: event.limit,
        window: event.window,
      }),
    });
    return result.status === "changed";
  } finally {
    releaseEventLock(name);
  }
}

/** SHA-256 of a session's respawn command line, used to auto-reset the
 *  fast-fail counter when the operator edits the pty.toml (or otherwise
 *  changes the stored command). Kept short — the tag surface is user-
 *  facing, not a cryptographic identifier. */
function commandFingerprint(command: string, args: string[]): string {
  const h = createHash("sha256");
  h.update(command);
  h.update("\0");
  h.update(args.join("\0"));
  return h.digest("hex").slice(0, 16);
}

/** Reconciliation pass driven by `pty gc`. Stateless: every invocation
 *  re-derives intent from on-disk metadata. Four steps run in order:
 *
 *    1.   Orphan-kill: children with a `parent=<name>` tag whose parent's
 *         metadata is gone OR whose parent's pid isn't alive get SIGTERM'd
 *         and `cleanupAll`'d. Runs first so a permanent child whose parent
 *         has died isn't immediately respawned by step 2.
 *    1.5. Abandoned-reap: live `strategy=permanent` sessions whose recorded
 *         cwd is gone from disk are SIGTERM'd + `cleanupAll`'d + get a
 *         `session_abandoned` event. When `opts.idleDays` is set OR the
 *         session carries a `strategy.idle-days=N` tag, sessions whose
 *         `lastAttachAt` is older than that threshold are also reaped
 *         with reason `idle`. Runs before step 2 so a session reaped for
 *         abandonment isn't immediately respawned by permanent-restart.
 *    2.   Permanent respawn: every `strategy=permanent` session that's
 *         exited/vanished is respawned via `spawnDaemon` (lazy-imported to
 *         avoid the `sessions ↔ spawn` cycle). Sessions with `ptyfile` +
 *         `ptyfile.session` tags re-read the toml to pick up any edits.
 *         A fast-fail cap prevents a crash-looping leaf from being
 *         respawned forever: `strategy.fast-fail-limit` consecutive
 *         respawns whose leaf exited within `strategy.fast-fail-window`
 *         seconds flip the session to `strategy.status=flapping` and
 *         skip it on subsequent ticks. Auto-reset when the stored command
 *         changes; manual reset via `pty tag <name> --rm strategy.status`.
 *    3.   Residual sweep: exited/vanished sessions that aren't permanent
 *         get `cleanupAll`'d. A `keep`-tagged session is exempt only until
 *         it has been dead longer than `opts.keepMaxAgeMs` (default
 *         `DEFAULT_KEEP_MAX_AGE_MS`), after which it is swept and reported
 *         under `keepExpired` instead of `removed`.
 *
 *  Step 3 is now a BACKSTOP rather than the primary path: a non-permanent
 *  session that runs to completion reaps itself as it shuts down (see
 *  `shouldReapAtExit`). It is NOT redundant, though — everything below
 *  still reaches it, so step 3 cannot simply be deleted:
 *
 *    - `pty kill`'d sessions. This is the most common residual case, and
 *      easy to miss: the exit path deliberately retains a session stopped
 *      from outside, but the child's `onExit` still wrote an exit record,
 *      so the session lands here as `status=exited` and gets swept. The
 *      retention is until the next sweep, not forever — `keep` extends it
 *      to the retention window.
 *    - `status=vanished` sessions — the daemon was SIGKILL'd / OOM-killed
 *      / lost to a reboot, so no exit-time code ran at all. This is the
 *      case exit-time cleanup structurally *cannot* cover, since the
 *      process that would do the cleaning is the one that died. Note a
 *      reboot puts EVERY non-permanent session in this bucket at once.
 *    - sessions created before the exit-time policy existed, and any
 *      whose final `cleanupAll` lost a race with an external `pty rm`.
 *    - sessions demoted out of `strategy=permanent` after they died. */
export async function gc(
  opts: {
    dryRun?: boolean;
    idleDays?: number;
    fastFailWindowSec?: number;
    fastFailLimit?: number;
    /** Retention window for `keep`-tagged dead sessions. Defaults to
     *  `DEFAULT_KEEP_MAX_AGE_MS`; `0` sweeps every dead `keep` session on
     *  this pass. Never applies to running sessions. */
    keepMaxAgeMs?: number;
  } = {},
): Promise<GcResult> {
  const dryRun = !!opts.dryRun;
  const globalIdleDays = opts.idleDays;
  const globalFastFailWindow = opts.fastFailWindowSec;
  const globalFastFailLimit = opts.fastFailLimit;
  const keepMaxAgeMs = opts.keepMaxAgeMs ?? DEFAULT_KEEP_MAX_AGE_MS;
  const rawCandidates = await inventoryRawCleanupCandidates();
  const rawRemoved: string[] = [];
  if (dryRun) {
    rawRemoved.push(...rawCandidates.map(({ name }) => name));
  } else {
    for (const candidate of rawCandidates) {
      if (await cleanupRawCandidateGuarded(candidate)) {
        rawRemoved.push(candidate.name);
      }
    }
  }
  const initial = await listSessions();

  // STEP 1: orphan-children. Sort by name so cycles (A→B, B→A) resolve
  // deterministically — whichever name sorts first wins this tick; the
  // loser dies; on the next tick the winner has no live parent either
  // and dies too. No cycle detection needed.
  const killedOrphanChildren: GcResult["killedOrphanChildren"] = [];
  const reapSkipped: GcResult["reapSkipped"] = [];
  const withParent = initial
    .filter((s) => s.metadata?.tags?.parent)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const s of withParent) {
    const parentRef = s.metadata!.tags!.parent;
    const parentMeta = readMetadata(parentRef);
    const parentPid = parentMeta ? readPid(parentRef, parentMeta) : null;
    const parentAlive = parentMeta != null && parentPid !== null && isProcessAlive(parentPid);
    if (parentAlive) continue;
    const reason: "missing" | "dead" = parentMeta ? "dead" : "missing";
    if (!dryRun) {
      const result = await reapObservedSession(s);
      if (result.status === "skipped") {
        reapSkipped.push({
          name: s.name,
          operation: "orphan",
          reason: result.reason,
          signalled: result.signalled,
        });
        continue;
      }
    }
    killedOrphanChildren.push({ name: s.name, parent: parentRef, reason });
  }

  // STEP 1.5: abandoned-reap. Live permanent sessions whose cwd is gone,
  // or (opt-in) whose lastAttachAt is older than the idle threshold, get
  // SIGTERM'd + cleaned up + emit `session_abandoned`. Runs before step 2
  // so the reap isn't racing an immediate respawn on the same tick.
  const afterStep1 = dryRun ? initial : await listSessions();
  const abandoned: GcResult["abandoned"] = [];
  for (const s of afterStep1) {
    if (s.metadata?.tags?.strategy !== "permanent") continue;
    const decision = classifyAbandoned(s, globalIdleDays);
    if (!decision) continue;

    if (!dryRun) {
      const result = await reapObservedSession(s, {
          session: s.name,
          type: "session_abandoned",
          ts: new Date().toISOString(),
          reason: decision.reason,
          ...(decision.idleDays !== undefined ? { idleDays: decision.idleDays } : {}),
      });
      if (result.status === "skipped") {
        reapSkipped.push({
          name: s.name,
          operation: "abandoned",
          reason: result.reason,
          signalled: result.signalled,
        });
        continue;
      }
    }
    abandoned.push({
      name: s.name,
      reason: decision.reason,
      ...(decision.idleDays !== undefined ? { idleDays: decision.idleDays } : {}),
    });
  }

  // STEP 2: permanent respawn. Re-list since steps 1 and 1.5 may have
  // removed some metadata. In dryRun mode we filter out anything step
  // 1.5 would have reaped so the preview reflects the same intent.
  const afterStep15 = dryRun
    ? initial.filter((s) => !abandoned.some((a) => a.name === s.name))
    : await listSessions();
  const respawned: GcResult["respawned"] = [];
  const respawnFailed: GcResult["respawnFailed"] = [];
  const flapped: GcResult["flapped"] = [];
  const flappingSkipped: GcResult["flappingSkipped"] = [];
  for (const s of afterStep15) {
    if (s.metadata?.tags?.strategy !== "permanent") continue;
    if (!isGone(s.status)) continue;
    const ptyfileReread = !!s.metadata?.tags?.ptyfile;

    // Fast-fail classifier: was the previous respawn a fast crash? What's
    // the running counter? Should we flip to flapping? Runs before any
    // spawn so a session at the limit boundary flaps this tick instead
    // of respawning one more time.
    const decision = classifyFlapping(
      s,
      new Date(),
      globalFastFailWindow,
      globalFastFailLimit,
    );

    if (decision.action === "skip-flapping") {
      flappingSkipped.push(s.name);
      continue;
    }

    if (dryRun) {
      if (decision.action === "flap-now") {
        flapped.push({
          name: s.name,
          counter: decision.counter,
          limit: decision.effectiveLimit,
          window: decision.effectiveWindow,
        });
        continue;
      }
      respawned.push({ name: s.name, ptyfileReread });
      continue;
    }

    if (decision.action === "flap-now") {
      if (!commitObservedFlapping(
        s.name,
        s.metadata!,
        decision.newBookkeeping,
        {
          counter: decision.counter,
          limit: decision.effectiveLimit,
          window: decision.effectiveWindow,
        },
      )) continue;
      flapped.push({
        name: s.name,
        counter: decision.counter,
        limit: decision.effectiveLimit,
        window: decision.effectiveWindow,
      });
      continue;
    }

    try {
      if (await respawnPermanent(s.name, s.metadata!, decision.newBookkeeping)) {
        respawned.push({ name: s.name, ptyfileReread });
      }
    } catch (err: any) {
      respawnFailed.push({ name: s.name, error: err?.message ?? String(err) });
    }
  }

  // STEP 3: historic sweep. Exited/vanished non-permanent sessions get
  // their metadata removed. Permanent sessions are handled by step 2 —
  // if their respawn succeeded they're back to `running` and skipped;
  // if it failed we leave the metadata around so the next tick can try
  // again.
  const finalList = dryRun ? initial : await listSessions();
  const nowMs = Date.now();
  const removed: string[] = [...rawRemoved];
  const kept: string[] = [];
  const keepExpired: string[] = [];
  for (const s of finalList) {
    if (!isGone(s.status)) continue;
    if (s.metadata?.tags?.strategy === "permanent") continue;
    // `keep` must mean the same thing to both reapers. The daemon's
    // exit-time cleanup already honours it; if gc did not, a `keep`
    // session would merely survive its own exit only to be swept moments
    // later by the next tick — which is not "keep" in any useful sense.
    // The exemption is bounded, though: once the session has been dead
    // longer than the retention window it is swept like any other stale
    // record, just reported under its own bucket so the reason is visible.
    const keepRequested = isKeepRequested(s.metadata?.tags);
    if (keepRequested && !isKeepExpired(s.metadata, nowMs, keepMaxAgeMs)) {
      kept.push(s.name);
      continue;
    }
    const bucket = keepRequested ? keepExpired : removed;
    if (dryRun) {
      bucket.push(s.name);
    } else if (await cleanupObservedSession(s)) {
      bucket.push(s.name);
    }
  }

  return {
    removed,
    kept,
    keepExpired,
    killedOrphanChildren,
    abandoned,
    reapSkipped,
    respawned,
    respawnFailed,
    flapped,
    flappingSkipped,
  };
}

/** Decide whether a permanent session is abandoned. Order:
 *
 *    1. cwd-gone (`fs.statSync` throws `ENOENT` on `metadata.cwd`) —
 *       strong low-false-positive signal, on-by-default. Escape hatch:
 *       `strategy.abandon-if-cwd-gone=false` tag opts a session out.
 *    2. idle (only if `idleDays` is resolved from CLI or per-session
 *       `strategy.idle-days=N` tag) — requires `lastAttachAt` to be set
 *       AND to be older than the threshold.
 *
 *  Returns `null` when the session is NOT abandoned. A cwd-gone verdict
 *  always wins over an idle verdict — the session is abandoned regardless
 *  of attach recency once the cwd is gone. */
function classifyAbandoned(
  s: SessionInfo,
  globalIdleDays?: number,
): { reason: "cwd-gone" | "idle"; idleDays?: number } | null {
  const cwd = s.metadata?.cwd;
  const optOutCwd = s.metadata?.tags?.["strategy.abandon-if-cwd-gone"] === "false";
  if (cwd && !optOutCwd) {
    let cwdGone = false;
    try {
      fs.statSync(cwd);
    } catch (err: any) {
      if (err?.code === "ENOENT") cwdGone = true;
    }
    if (cwdGone) return { reason: "cwd-gone" };
  }

  const tagIdle = s.metadata?.tags?.["strategy.idle-days"];
  const perSessionIdleDays = tagIdle !== undefined ? parseInt(tagIdle, 10) : NaN;
  const effectiveIdleDays = Number.isFinite(perSessionIdleDays) && perSessionIdleDays > 0
    ? perSessionIdleDays
    : (globalIdleDays !== undefined && globalIdleDays > 0 ? globalIdleDays : undefined);
  if (effectiveIdleDays === undefined) return null;

  const lastAttach = s.metadata?.lastAttachAt;
  if (!lastAttach) return null;

  const lastAttachMs = Date.parse(lastAttach);
  if (!Number.isFinite(lastAttachMs)) return null;
  const ageDays = Math.floor((Date.now() - lastAttachMs) / (1000 * 60 * 60 * 24));
  if (ageDays < effectiveIdleDays) return null;
  return { reason: "idle", idleDays: ageDays };
}

/** Decide whether a `strategy=permanent` session that's exited/vanished
 *  should be respawned, marked flapping, or silently skipped because
 *  it's already flapping. Reads three bookkeeping tags from the session:
 *    - `strategy.last-respawn-at` (ISO ts): when gc last respawned it
 *    - `strategy.consecutive-fast-fails` (int): running fast-fail counter
 *    - `strategy.command-hash` (16-char hex): command fingerprint at last
 *      respawn. If the current fingerprint differs, the operator edited
 *      the pty.toml (or otherwise changed the command); reset the
 *      counter and clear any stale `strategy.status=flapping`.
 *
 *  Effective window/limit resolution:
 *    per-session tag (strategy.fast-fail-window / -limit)
 *    → global opt (CLI --fast-fail-window / --fast-fail-limit)
 *    → DEFAULT_FAST_FAIL_WINDOW_SEC / DEFAULT_FAST_FAIL_LIMIT.
 *
 *  Returned `newBookkeeping` MUST be merged onto the session's tags map
 *  before/instead of respawn. The `flap-now` action never respawns; the
 *  `respawn` action does; the `skip-flapping` action skips entirely. */
interface FlappingDecision {
  action: "respawn" | "flap-now" | "skip-flapping";
  effectiveWindow: number;
  effectiveLimit: number;
  /** Fast-fail counter after this tick's classification. Only meaningful
   *  for `respawn` (stamped on the session) and `flap-now` (the counter
   *  that crossed the threshold, surfaced in the event payload). */
  counter: number;
  /** Tag deltas to persist. Empty for `skip-flapping`. For `respawn`,
   *  carries the fresh timestamp, counter, and command hash. For
   *  `flap-now`, adds `strategy.status=flapping` on top. */
  newBookkeeping: Record<string, string>;
}

function classifyFlapping(
  s: SessionInfo,
  now: Date,
  globalWindowSec: number | undefined,
  globalLimit: number | undefined,
): FlappingDecision {
  const tags = s.metadata?.tags ?? {};

  const tagWindow = parseInt(tags["strategy.fast-fail-window"] ?? "", 10);
  const effectiveWindow = Number.isFinite(tagWindow) && tagWindow > 0
    ? tagWindow
    : (globalWindowSec !== undefined && globalWindowSec > 0
      ? globalWindowSec
      : DEFAULT_FAST_FAIL_WINDOW_SEC);

  const tagLimit = parseInt(tags["strategy.fast-fail-limit"] ?? "", 10);
  const effectiveLimit = Number.isFinite(tagLimit) && tagLimit > 0
    ? tagLimit
    : (globalLimit !== undefined && globalLimit > 0
      ? globalLimit
      : DEFAULT_FAST_FAIL_LIMIT);

  const command = s.metadata?.command ?? "";
  const args = s.metadata?.args ?? [];
  const currentHash = commandFingerprint(command, args);
  const storedHash = tags["strategy.command-hash"];
  const commandChanged = storedHash !== undefined && storedHash !== currentHash;

  // Command change wins over an existing flapping mark: the operator has
  // edited the pty.toml (or manually mutated the command), so give it a
  // fresh chance. `strategy.status` clears; counter resets to 0.
  if (tags["strategy.status"] === "flapping" && !commandChanged) {
    return {
      action: "skip-flapping",
      effectiveWindow,
      effectiveLimit,
      counter: parseInt(tags["strategy.consecutive-fast-fails"] ?? "0", 10) || 0,
      newBookkeeping: {},
    };
  }

  // Was the previous respawn a fast fail? Compare the exit timestamp
  // against the last-respawn stamp; anything under `window` seconds is
  // fast. If no prior stamp exists (never respawned by gc) or the exit
  // is missing (vanished session), treat as slow — the counter resets.
  const lastRespawnAt = tags["strategy.last-respawn-at"];
  const exitedAt = s.metadata?.exitedAt;
  let liveMs: number | null = null;
  if (lastRespawnAt && exitedAt) {
    const lr = Date.parse(lastRespawnAt);
    const ex = Date.parse(exitedAt);
    if (Number.isFinite(lr) && Number.isFinite(ex)) liveMs = ex - lr;
  }
  const wasFastFail = liveMs !== null && liveMs >= 0 && liveMs < effectiveWindow * 1000;

  const prevCounter = parseInt(tags["strategy.consecutive-fast-fails"] ?? "0", 10) || 0;
  const nextCounter = commandChanged ? 0 : (wasFastFail ? prevCounter + 1 : 0);

  if (nextCounter >= effectiveLimit) {
    // Threshold crossed. Mark flapping, don't respawn. The counter goes
    // into the tags at its final value so subsequent listers can see how
    // deep the streak went.
    const bookkeeping: Record<string, string> = {
      "strategy.status": "flapping",
      "strategy.consecutive-fast-fails": String(nextCounter),
      "strategy.command-hash": currentHash,
    };
    if (lastRespawnAt) bookkeeping["strategy.last-respawn-at"] = lastRespawnAt;
    return {
      action: "flap-now",
      effectiveWindow,
      effectiveLimit,
      counter: nextCounter,
      newBookkeeping: bookkeeping,
    };
  }

  // Respawn. Stamp fresh bookkeeping. If we're clearing a stale flap
  // mark from a command change, drop `strategy.status` explicitly by
  // storing an empty string — updateTags treats that as a remove.
  const bookkeeping: Record<string, string> = {
    "strategy.last-respawn-at": now.toISOString(),
    "strategy.consecutive-fast-fails": String(nextCounter),
    "strategy.command-hash": currentHash,
  };
  return {
    action: "respawn",
    effectiveWindow,
    effectiveLimit,
    counter: nextCounter,
    newBookkeeping: bookkeeping,
  };
}

/** Restart a `strategy=permanent` session whose daemon is gone. If the
 *  session was toml-managed (`ptyfile` + `ptyfile.session` tags), re-read
 *  the pty.toml so the new daemon picks up command/env edits since the
 *  last spawn. On any read error fall back to the stored metadata
 *  verbatim (last-known-good) so a temporarily-missing toml doesn't
 *  prevent restart.
 *
 *  `bookkeepingOverlay` (optional) carries pty-internal tags that must
 *  survive the pty.toml re-read: gc backoff state (`strategy.last-*`,
 *  `strategy.command-hash`, `strategy.consecutive-fast-fails`). Passed
 *  by `gc()` STEP-2; ignored by other callers.
 *
 *  Lazy-imports `spawn.ts` so the `sessions.ts ↔ spawn.ts` cycle doesn't
 *  bite at module-init time. After spawn, appends a `session_respawn`
 *  event to the session's event log so consumers see the restart.
 *
 *  @internal Generation-CAS primitive; not part of client-api. */
export async function respawnPermanent(
  name: string,
  metadata: SessionMetadata,
  bookkeepingOverlay: Record<string, string> = {},
): Promise<boolean> {
  let command = metadata.command;
  let args = metadata.args;
  let displayCommand = metadata.displayCommand;
  let cwd = metadata.cwd;
  let tags: Record<string, string> | undefined = metadata.tags;
  const displayName = metadata.displayName;
  let extraEnv = metadata.extraEnv;
  let unsetEnv = metadata.unsetEnv;
  let exactEnv = metadata.env;

  const ptyfilePath = metadata.tags?.ptyfile;
  const ptyfileSession = metadata.tags?.["ptyfile.session"];
  if (ptyfilePath && ptyfileSession) {
    try {
      const { readPtyFile } = await import("./ptyfile.ts");
      const dir = path.dirname(ptyfilePath);
      const ptyFile = readPtyFile(dir);
      const sessDef = ptyFile.sessions.find((s) => s.shortName === ptyfileSession);
      if (sessDef) {
        command = "/bin/sh";
        args = ["-c", sessDef.command];
        displayCommand = sessDef.command;
        cwd = sessDef.cwd ?? ptyFile.dir;
        extraEnv = sessDef.env;
        unsetEnv = undefined;
        exactEnv = undefined;
        tags = {
          ...sessDef.tags,
          ptyfile: ptyfilePath,
          "ptyfile.session": ptyfileSession,
        };
      }
    } catch {
      // pty.toml unreadable (volume not mounted yet, file deleted, parse
      // error). Fall back to stored metadata — better to respawn with
      // last-known-good than to give up.
    }
  }

  // Merge gc's backoff bookkeeping last so it survives the pty.toml
  // overlay above. Callers pass an empty overlay when they aren't gc.
  // If a command change is clearing a stale flap mark, the caller
  // omits `strategy.status` from the overlay; we also clear any
  // existing flag on the merged map so a rebuilt tags dict doesn't
  // silently carry it forward from the previous metadata.
  tags = { ...(tags ?? {}), ...bookkeepingOverlay };
  if (bookkeepingOverlay["strategy.status"] === undefined) {
    delete tags["strategy.status"];
  }

  // Serialize compare-and-swap cleanup + replacement creation under the same
  // per-name lock. If the observed generation changed while gc was planning,
  // this tick is stale and must not touch the replacement.
  if (!acquireEventLock(name)) return false;
  if (!acquireLock(name)) {
    releaseEventLock(name);
    return false;
  }
  let eventLocked = true;
  try {
    const current = readMetadata(name);
    if (!current || !metadataMatchesObservation(metadata, current)) {
      return false;
    }

    // Wipe stale socket/pid/events before respawn so spawnDaemon doesn't trip
    // over leftovers from the dead daemon. Keep the creation lock held until
    // the replacement has published its socket.
    cleanupAllWhileLocked(name);
    releaseEventLock(name);
    eventLocked = false;

    const { spawnDaemon } = await import("./spawn.ts");
    await spawnDaemon({
      name, command, args, displayCommand, cwd, tags,
      creationLockOwnerPid: process.pid,
      ...(displayName ? { displayName } : {}),
      ...(metadata.rows !== undefined ? { rows: metadata.rows } : {}),
      ...(metadata.cols !== undefined ? { cols: metadata.cols } : {}),
      ...(metadata.ephemeral !== undefined ? { ephemeral: metadata.ephemeral } : {}),
      ...(metadata.isolateEnv ? { isolateEnv: true } : {}),
      ...(extraEnv && Object.keys(extraEnv).length > 0 ? { extraEnv } : {}),
      ...(unsetEnv && unsetEnv.length > 0 ? { unsetEnv } : {}),
      ...(exactEnv ? { env: exactEnv } : {}),
    });
  } finally {
    releaseLock(name);
    if (eventLocked) releaseEventLock(name);
  }

  // Best-effort event; respawn already succeeded if we got here.
  try {
    appendEventSync(name, {
      session: name,
      type: "session_respawn",
      ts: new Date().toISOString(),
    });
  } catch {}
  return true;
}

/**
 * Layout tool tag keys follow `:l<pid>-<rand>` where the PID is the
 * pty-layout process that owns the view. When that process dies the
 * tag becomes an orphan. Same shape as the `:` reserved prefix
 * documented in `isReservedTagKey`.
 */
const ORPHAN_LAYOUT_TAG_RE = /^:l(\d+)-[a-z0-9]+$/;

export interface PrunedTagResult {
  name: string;
  removedKeys: string[];
}

/**
 * Walk **running** sessions and remove `:l<pid>-<rand>` tag keys whose
 * encoded PID no longer exists. Called by `pty gc` to clean up after a
 * pty-layout process that exited without clearing its tags.
 *
 * Returns a list of sessions that had at least one tag pruned, and
 * which keys were removed from each. `dryRun: true` performs the same
 * walk but doesn't call `updateTags`.
 */
export async function pruneOrphanLayoutTags(
  opts: { dryRun?: boolean } = {},
): Promise<PrunedTagResult[]> {
  const sessions = await listSessions();
  const results: PrunedTagResult[] = [];
  for (const s of sessions) {
    if (s.status !== "running") continue;
    const tags = s.metadata?.tags;
    if (!tags) continue;
    const toRemove: string[] = [];
    for (const key of Object.keys(tags)) {
      const match = ORPHAN_LAYOUT_TAG_RE.exec(key);
      if (!match) continue;
      const pid = parseInt(match[1], 10);
      if (!Number.isFinite(pid) || pid <= 0) {
        toRemove.push(key);
        continue;
      }
      if (!isProcessAlive(pid)) toRemove.push(key);
    }
    if (toRemove.length === 0) continue;
    if (!opts.dryRun) {
      try {
        updateTags(s.name, {}, toRemove);
      } catch {
        // Session metadata disappeared between listing and update — ignore.
        continue;
      }
    }
    results.push({ name: s.name, removedKeys: toRemove });
  }
  return results;
}

export function readSessionPid(name: string): number | null {
  try {
    const content = fs.readFileSync(getPidPath(name), "utf-8").trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function readPid(name: string, metadata?: SessionMetadata | null): number | null {
  const sidecarPid = readSessionPid(name);
  if (sidecarPid !== null) return sidecarPid;

  const retained = metadata ?? readMetadata(name);
  const daemonPid = retained?.daemonPid;
  const processStartToken = retained?.recovery?.processStartToken;
  if (daemonPid === undefined || processStartToken === undefined) return null;
  return readProcessStartToken(daemonPid) === processStartToken ? daemonPid : null;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // POSIX reserves EPERM for "the process exists, but this caller may not
    // signal it." Sandboxed seats routinely hit this for peer-owned daemons;
    // treating it as death both lies about status and triggers slow socket
    // fallbacks for every session in the fleet.
    if (
      process.platform !== "win32" &&
      (error as NodeJS.ErrnoException | undefined)?.code === "EPERM"
    ) {
      return true;
    }
    return false;
  }
}

/** Poll until `pid` is gone (or `timeoutMs` elapses). Returns true if the
 *  process exited within the budget, false if it was still alive at timeout.
 *  Used by `pty kill` to wait for the daemon's shutdown (which re-flushes exit
 *  metadata) to finish before returning, so a following `pty rm` can't race it. */
export async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (hasProcessExitedForReap(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return hasProcessExitedForReap(pid);
}

async function probeSocketsWithinBudget(
  socketPaths: string[],
  budgetMs: number,
  probe: (socketPath: string) => Promise<boolean>,
): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();
  if (socketPaths.length === 0) return results;

  const probes = socketPaths.map(async (socketPath) => {
    try {
      results.set(socketPath, await probe(socketPath));
    } catch {
      results.set(socketPath, false);
    }
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.all(probes),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, budgetMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return results;
}

function isSocketReachable(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 500);
    socket.on("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/** Remove socket and pid files (but keep metadata). */
export function cleanupSocket(name: string): void {
  try {
    fs.unlinkSync(getSocketPath(name));
  } catch {}
  try {
    fs.unlinkSync(getPidPath(name));
  } catch {}
}

/** Remove everything including metadata. */
export function cleanupAll(name: string): void {
  if (!acquireEventLock(name)) {
    throw new Error(`Session id "${name}" event log is busy. Retry the operation.`);
  }
  if (!acquireLock(name)) {
    releaseEventLock(name);
    throw new Error(`Session id "${name}" metadata is busy. Retry the operation.`);
  }
  try {
    cleanupAllWhileLocked(name);
  } finally {
    releaseLock(name);
    releaseEventLock(name);
  }
}

export interface SessionGenerationOwner {
  generation: string;
  pid: number;
}

/** Does the current registry entry still belong to `owner`?
 *
 * Call only while holding the per-name creation lock. Metadata is the primary
 * generation marker; the pidfile closes the startup window before metadata is
 * published. Older metadata without a generation falls back to PID ownership. */
function isCurrentGenerationOwner(name: string, owner: SessionGenerationOwner): boolean {
  const metadata = readMetadata(name);
  if (metadata?.generation !== undefined && metadata.generation !== owner.generation) {
    return false;
  }
  const pid = readSessionPid(name);
  if (pid !== null && pid !== owner.pid) {
    return false;
  }
  return true;
}

/** Generation-safe daemon cleanup.
 *
 * The creation lock makes the ownership check + unlink sequence atomic with
 * respect to `pty run`. If a replacement is currently starting, cleanup skips
 * rather than unlinking its socket/pid. */
export function cleanupOwnedSocket(name: string, owner: SessionGenerationOwner): boolean {
  if (!acquireLock(name)) return false;
  try {
    if (!isCurrentGenerationOwner(name, owner)) return false;
    cleanupSocket(name);
    return true;
  } finally {
    releaseLock(name);
  }
}

/** Generation-safe full cleanup used by a daemon reaping its own session. */
export function cleanupOwnedAll(name: string, owner: SessionGenerationOwner): boolean {
  if (!acquireEventLock(name)) return false;
  if (!acquireLock(name)) {
    releaseEventLock(name);
    return false;
  }
  try {
    if (!isCurrentGenerationOwner(name, owner)) return false;
    cleanupSocket(name);
    try {
      fs.unlinkSync(getMetadataPath(name));
    } catch {}
    try {
      fs.unlinkSync(getEventsPath(name));
    } catch {}
    try {
      fs.unlinkSync(recoveryRevisionPath(path.resolve(getSessionDir()), name));
    } catch {}
    return true;
  } finally {
    releaseLock(name);
    releaseEventLock(name);
  }
}

function getLockPath(name: string): string {
  return path.join(getSessionDir(), `${name}.lock`);
}

/** @internal Verify an explicitly delegated creation lock without acquiring it. */
export function isLockOwnedByPid(name: string, ownerPid: number): boolean {
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return false;
  try {
    return parseInt(fs.readFileSync(getLockPath(name), "utf-8").trim(), 10) === ownerPid &&
      isProcessAlive(ownerPid);
  } catch {
    return false;
  }
}

/**
 * Acquire an exclusive filesystem lock at an exact path.
 * Returns true if acquired, false if another process holds it.
 *
 * BUG-2 fix: the whole acquisition is built on `open(O_CREAT|O_EXCL)` via
 * `openSync(..., "wx")`. Two racing processes can't both win because
 * `O_EXCL` is a kernel-level atomic create. When the lock looks stale, we
 * unlink it and retry the exclusive open: whichever process wins the
 * post-unlink open owns the lock; the other gets EEXIST and gives up.
 */
export function acquireFileLock(lockPath: string): boolean {
  ensureSessionDir();

  const tryCreate = (): boolean => {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeSync(fd, process.pid.toString());
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (e: any) {
      if (e.code === "EEXIST") return false;
      throw e;
    }
  };

  if (tryCreate()) return true;

  // Lock file exists — inspect the holder.
  let holderAlive = false;
  try {
    const pid = parseInt(fs.readFileSync(lockPath, "utf-8").trim(), 10);
    if (!isNaN(pid)) {
      holderAlive = isProcessAlive(pid);
    }
  } catch {
    // Garbage content, unreadable, or holder dead → treat as stale.
  }

  if (holderAlive) return false;

  // Stale lock. Unlink and retry the exclusive create exactly once. If
  // another process is racing us to steal, only one wins the wx open; the
  // loser returns false instead of stomping on the winner's lock.
  try {
    fs.unlinkSync(lockPath);
  } catch (e: any) {
    // Someone else unlinked it first — that's fine, fall through to create.
    if (e.code !== "ENOENT") return false;
  }
  return tryCreate();
}

/** Fail-closed lock acquisition for recovery.
 *
 * Unlike normal creation, recovery must not probe or steal an existing lock:
 * any competing owner is grounds to refuse, and the recovery path promises no
 * process signal (including a liveness-only signal 0 probe). */
export function acquireRecoveryLock(name: string, contents: string): boolean {
  ensureSessionDir();
  try {
    const fd = fs.openSync(getLockPath(name), "wx", 0o600);
    try {
      fs.writeSync(fd, contents);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      try {
        return fs.readFileSync(getLockPath(name), "utf8") === contents;
      } catch {
        return false;
      }
    }
    throw error;
  }
}

/** Release only the recovery lock still owned by the authenticated identity. */
export function releaseRecoveryLock(name: string, contents: string): void {
  try {
    if (fs.readFileSync(getLockPath(name), "utf8") === contents) {
      fs.unlinkSync(getLockPath(name));
    }
  } catch {}
}

export function releaseFileLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {}
}

export function acquireLock(name: string): boolean {
  return acquireFileLock(getLockPath(name));
}

export function releaseLock(name: string): void {
  releaseFileLock(getLockPath(name));
}

/** Blocking sleep for the sync lock waits. `Atomics.wait` parks the thread
 *  without a hot spin and works on the main thread in Node. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

/** Non-destructive check: is the per-name creation lock currently held by a
 *  live process? Never creates, steals, or otherwise touches the lock —
 *  purely observational, for deciding whether a missing record is worth
 *  waiting for (issue #180). */
export function isCreationLockHeld(name: string): boolean {
  try {
    const pid = parseInt(fs.readFileSync(getLockPath(name), "utf-8").trim(), 10);
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    return isProcessAlive(pid);
  } catch {
    return false;
  }
}

/** @internal Acquire the per-name creation lock with bounded polling. Returns
 *  `false` on timeout — fail-closed, never indefinite. A dead holder's stale
 *  lock is still reclaimed by `acquireFileLock` while waiting. */
export function waitForLockSync(name: string, waitMs: number): boolean {
  const deadline = Date.now() + Math.max(0, waitMs);
  while (true) {
    if (acquireLock(name)) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    sleepSync(Math.min(METADATA_PATCH_POLL_MS, remaining));
  }
}

// Keep backward compat for server.ts close()
export { cleanupSocket as cleanup };
