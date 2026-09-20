import {
  isZombie,
  openSource,
  valueOf,
  type LiveIdentity,
  type ProcessSource,
  type Row,
} from "./proc-table.ts";

export interface ProcessIdentity {
  pid: number;
  /** Proof of identity for the length of one command. Not the registry's
   *  `recovery.processStartToken`: see `proc-table.ts`. */
  identity: LiveIdentity;
  depth: number;
}

interface ProcessTreeDeps {
  /** Where process facts come from. Defaults to one source per iteration,
   *  which on Linux reads `/proc` and on macOS is one `ps` call. */
  source?: () => ProcessSource;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  groupExists?: (processGroupId: number) => boolean;
}
export type CompleteProcessTreeSnapshot =
  | { _tag: "Complete"; identities: ProcessIdentity[] }
  | { _tag: "Unavailable"; reason: string; identities: ProcessIdentity[] };

/** Snapshot every live descendant or report that completeness could not be
 * proved. Unlike the historical best-effort snapshot, this never turns an
 * unreadable table or identity into an empty tree. */
export function snapshotDescendantProcessesComplete(
  rootPid: number,
  deps: ProcessTreeDeps = {},
): CompleteProcessTreeSnapshot {
  const source = (deps.source ?? openSource)();
  const answer = source.rows();
  if (answer.kind !== "known") {
    return {
      _tag: "Unavailable",
      reason: answer.kind === "unknown"
        ? `process-${answer.reason}`
        : "process-table-not-present",
      identities: answer.kind === "unknown" && answer.partial
        ? observedDescendantIdentities(rootPid, answer.partial)
        : [],
    };
  }
  const byPid = new Map(answer.value.map((row) => [row.pid, row]));
  const root = byPid.get(rootPid);
  if (!root || isZombie(root) || root.identity === null) {
    return {
      _tag: "Unavailable",
      reason: "root-identity-unavailable",
      identities: observedDescendantIdentities(rootPid, answer.value),
    };
  }
  const children = new Map<number, Row[]>();
  for (const row of answer.value) {
    const siblings = children.get(row.ppid) ?? [];
    siblings.push(row);
    children.set(row.ppid, siblings);
  }
  const identities: ProcessIdentity[] = [];
  const queue = (children.get(rootPid) ?? []).map((row) => ({ row, depth: 1 }));
  const seen = new Set<number>([rootPid]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current.row.pid)) continue;
    seen.add(current.row.pid);
    queue.push(
      ...(children.get(current.row.pid) ?? []).map((row) => ({
        row,
        depth: current.depth + 1,
      })),
    );
    if (isZombie(current.row)) continue;
    if (current.row.identity === null) {
      return {
        _tag: "Unavailable",
        reason: `process-identity-unavailable:${current.row.pid}`,
        identities: observedDescendantIdentities(rootPid, answer.value),
      };
    }
    identities.push({
      pid: current.row.pid,
      identity: current.row.identity,
      depth: current.depth,
    });
  }
  identities.sort((a, b) => b.depth - a.depth || b.pid - a.pid);
  return { _tag: "Complete", identities };
}

/** Recover every exact descendant identity visible in an incomplete table.
 * The result is not called complete, but it is still safe to signal alongside
 * the process-group fallback and includes children that created another PGID. */
const observedDescendantIdentities = (
  rootPid: number,
  rows: Row[],
): ProcessIdentity[] => {
  const children = new Map<number, Row[]>();
  for (const row of rows) {
    const siblings = children.get(row.ppid) ?? [];
    siblings.push(row);
    children.set(row.ppid, siblings);
  }
  const identities: ProcessIdentity[] = [];
  const queue = (children.get(rootPid) ?? []).map((row) => ({ row, depth: 1 }));
  const seen = new Set<number>([rootPid]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current.row.pid)) continue;
    seen.add(current.row.pid);
    queue.push(
      ...(children.get(current.row.pid) ?? []).map((row) => ({
        row,
        depth: current.depth + 1,
      })),
    );
    if (!isZombie(current.row) && current.row.identity !== null) {
      identities.push({
        pid: current.row.pid,
        identity: current.row.identity,
        depth: current.depth,
      });
    }
  }
  return identities.sort((a, b) => b.depth - a.depth || b.pid - a.pid);
};

const mergeIdentities = (
  left: ProcessIdentity[],
  right: ProcessIdentity[],
): ProcessIdentity[] => {
  const identities = [...left];
  for (const candidate of right) {
    if (!identities.some((identity) =>
      identity.pid === candidate.pid && identity.identity === candidate.identity
    )) {
      identities.push(candidate);
    }
  }
  return identities.sort((a, b) => b.depth - a.depth || b.pid - a.pid);
};

const sameIdentities = (
  left: ProcessIdentity[],
  right: ProcessIdentity[],
): boolean => left.length === right.length && left.every((identity, index) =>
  identity.pid === right[index]?.pid &&
  identity.identity === right[index]?.identity
);

/** Freeze the PTY process group and every discovered descendant, rescanning
 * until a complete identity snapshot is stable. Once this succeeds no member
 * of the returned tree can fork before the caller signals it. */
export function freezeDescendantProcesses(
  rootPid: number,
  deps: ProcessTreeDeps = {},
): CompleteProcessTreeSnapshot {
  const snapshot = snapshotDescendantProcessesComplete(rootPid, deps);
  let observed = [...snapshot.identities];
  let unavailableReason = snapshot._tag === "Unavailable"
    ? snapshot.reason
    : "process-tree-did-not-quiesce";
  let previousComplete = snapshot._tag === "Complete" ? snapshot.identities : null;
  const maxAttempts = snapshot._tag === "Complete" ? 8 : 1;
  const sendSignal = deps.signal ?? ((pid, signal) => process.kill(pid, signal));
  try { sendSignal(-rootPid, "SIGSTOP"); } catch {}
  try {
    sendSignal(rootPid, "SIGSTOP");
  } catch {
    return {
      _tag: "Unavailable",
      reason: "root-freeze-failed",
      identities: observed,
    };
  }
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const signalled = signalProcessIdentities(observed, "SIGSTOP", deps);
    if (signalled.length !== observed.length) {
      return {
        _tag: "Unavailable",
        reason: "descendant-freeze-unverified",
        identities: observed,
      };
    }
    const next = snapshotDescendantProcessesComplete(rootPid, deps);
    observed = mergeIdentities(observed, next.identities);
    if (next._tag === "Complete") {
      if (
        previousComplete !== null &&
        sameIdentities(previousComplete, next.identities)
      ) {
        return next;
      }
      previousComplete = next.identities;
    } else {
      return {
        _tag: "Unavailable",
        reason: next.reason,
        identities: observed,
      };
    }
  }
  return {
    _tag: "Unavailable",
    reason: unavailableReason,
    identities: observed,
  };
}

/** Take one parent-chain snapshot before the PTY leader can exit and lose its
 * descendants to init or a subreaper. Every PID is bound to its process start
 * identity so later signals cannot target a reused PID. */
export function snapshotDescendantProcesses(
  rootPid: number,
  deps: ProcessTreeDeps = {},
): ProcessIdentity[] {
  const source = (deps.source ?? openSource)();
  const descendants: ProcessIdentity[] = [];
  for (const { pid, depth } of walkTree(rootPid, source)) {
    const identity = valueOf(source.identity(pid));
    if (identity !== null) descendants.push({ pid, identity, depth });
  }
  return descendants.sort((a, b) => b.depth - a.depth || b.pid - a.pid);
}

/** Walk a tree from `rootPid`, breadth first, recording depth. */
export function walkTree(
  rootPid: number,
  source: ProcessSource,
): Array<{ pid: number; depth: number }> {
  const rows = valueOf(source.rows()) ?? ([] as Row[]);
  const children = new Map<number, number[]>();
  for (const r of rows) children.set(r.ppid, [...(children.get(r.ppid) ?? []), r.pid]);
  const out: Array<{ pid: number; depth: number }> = [];
  const seen = new Set<number>([rootPid]);
  const queue = (children.get(rootPid) ?? []).map((pid) => ({ pid, depth: 1 }));
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current.pid)) continue;
    seen.add(current.pid);
    out.push(current);
    for (const pid of children.get(current.pid) ?? []) {
      queue.push({ pid, depth: current.depth + 1 });
    }
  }
  return out;
}

/** Is this still the same process, and still running?
 *
 *  **A corpse is not a survivor.** On Linux an unreaped descendant keeps its
 *  `/proc` row and its identity, so matching on identity alone counted it as
 *  alive: the teardown would wait out its whole TERM budget for a process that
 *  had already died, then report it as having survived a SIGKILL. That is the
 *  kill over-claiming again, in the other direction. macOS never had this,
 *  because `ps` stops listing a process the moment it exits.
 *
 *  **An unreadable source answers false, and that is deliberate**: it says
 *  "do not signal", never "it is gone". Every caller here wants the safe
 *  direction for a signal. */
function isSameProcess(identity: ProcessIdentity, source: ProcessSource): boolean {
  const row = valueOf(source.row(identity.pid));
  if (row === null || isZombie(row)) return false;
  return row.identity === identity.identity;
}

/** Signal only identities that still match their snapshot. A token mismatch
 * means the original process exited and the PID may now belong to anything. */
export function signalProcessIdentities(
  identities: ProcessIdentity[],
  signal: NodeJS.Signals,
  deps: ProcessTreeDeps = {},
): number[] {
  if (identities.length === 0) return [];
  const source = (deps.source ?? openSource)();
  const sendSignal = deps.signal ?? ((pid, value) => process.kill(pid, value));
  const signalled: number[] = [];
  for (const identity of identities) {
    if (!isSameProcess(identity, source)) continue;
    try {
      sendSignal(identity.pid, signal);
      signalled.push(identity.pid);
    } catch {}
  }
  return signalled;
}

async function waitForIdentitiesToExit(
  identities: ProcessIdentity[],
  timeoutMs: number,
  deps: ProcessTreeDeps,
): Promise<ProcessIdentity[]> {
  const openIteration = deps.source ?? openSource;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + timeoutMs;
  // **One source per iteration, not one question per process.** On macOS every
  // question used to be a `ps` spawn: at 25 ms polling inside a 1500 ms budget,
  // four descendants cost 240 spawns, and at the 10.9 ms a spawn was measured to
  // take that is 2.6 seconds of spawning inside a 1.5 second deadline. The loop
  // could not meet its own deadline on an idle machine. It is now one `ps` per
  // iteration there, and no subprocess at all on Linux.
  let source = openIteration();
  let survivors = identities.filter((identity) => isSameProcess(identity, source));
  while (survivors.length > 0 && Date.now() < deadline) {
    await sleep(25);
    source = openIteration();
    survivors = survivors.filter((identity) => isSameProcess(identity, source));
  }
  return survivors;
}

/** Stop an exact descendant snapshot without a process-group signal. TERM
 * gives cooperative servers time to release sockets. KILL is a bounded
 * backstop for descendants that ignore TERM. */
export async function terminateProcessIdentities(
  identities: ProcessIdentity[],
  options: { termWaitMs?: number; killWaitMs?: number } = {},
  deps: ProcessTreeDeps = {},
): Promise<ProcessIdentity[]> {
  if (identities.length === 0) return [];
  signalProcessIdentities(identities, "SIGTERM", deps);
  const afterTerm = await waitForIdentitiesToExit(
    identities,
    options.termWaitMs ?? 1_500,
    deps,
  );
  if (afterTerm.length === 0) return [];
  signalProcessIdentities(afterTerm, "SIGKILL", deps);
  return waitForIdentitiesToExit(afterTerm, options.killWaitMs ?? 500, deps);
}

/** Bounded fallback when a complete descendant table is unavailable. The PTY
 * leader is its process-group leader, so this still reaches the ordinary tree
 * without converting unknown descendants into an empty successful snapshot. */
export async function terminateProcessGroup(
  rootPid: number,
  options: { termWaitMs?: number; killWaitMs?: number } = {},
  deps: ProcessTreeDeps = {},
): Promise<boolean> {
  const sendSignal = deps.signal ?? ((pid, signal) => process.kill(pid, signal));
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const groupExists = deps.groupExists ?? ((groupId: number) => {
    try {
      process.kill(-groupId, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  });
  try { sendSignal(-rootPid, "SIGTERM"); } catch {}
  if (options.termWaitMs !== 0) await sleep(options.termWaitMs ?? 1_500);
  if (!groupExists(rootPid)) return true;
  try { sendSignal(-rootPid, "SIGKILL"); } catch {}
  if (options.killWaitMs !== 0) await sleep(options.killWaitMs ?? 500);
  return !groupExists(rootPid);
}
