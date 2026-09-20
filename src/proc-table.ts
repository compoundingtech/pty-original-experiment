/** One reader for the process table.
 *
 * Three wrong answers came from the same shape: a caller ran its own `ps` and
 * treated whatever came back as fact. `ps` is a subprocess. It can be slow,
 * truncated, or silent, and each of those looked exactly like "the process is
 * gone".
 *
 * Node cannot make the syscalls the Rust tool uses, so this does what Node can:
 *
 * **On Linux there is no subprocess at all.** `/proc` carries ppid, pgid, state
 * and starttime, which is every fact the callers ask for.
 *
 * **On macOS `ps` stays, but it is read once per operation** rather than once
 * per process per poll. That is the difference between 240 spawns inside a
 * 1500 ms deadline and 60.
 *
 * **And silence is its own answer everywhere.** Every query returns an
 * {@link Answer}, which separates "the table says this process is not there"
 * from "I could not find out". There is deliberately no default and no
 * conversion that lets the second quietly become the first.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

/** How long `ps` gets before the table is declared unreadable. Under
 *  contention `ps` is exactly the thing that goes quiet. */
const PS_TIMEOUT_MS = 2_000;

/** Why a fact is not available. None of these mean the process is gone. */
export type Unknown =
  /** The table could not be read: `ps` failed, timed out, returned nothing, or
   *  returned something that did not contain this very process. */
  | "table-unreadable"
  /** The table has the process, but this column was empty. */
  | "field-empty";

/** What the process table said about one thing.
 *
 *  **`unknown` is not `not-present`.** Folding them together is the defect this
 *  type exists to prevent, so there is no default and no direct unwrap. A
 *  caller that genuinely wants silence to mean death calls
 *  {@link orAbsentWhenUnknown}, which is named so it shows up in a review and
 *  in a grep. */
export type Answer<T> =
  | { readonly kind: "known"; readonly value: T }
  | { readonly kind: "not-present" }
  | { readonly kind: "unknown"; readonly reason: Unknown; readonly partial?: T };

export const known = <T>(value: T): Answer<T> => ({ kind: "known", value });
export const notPresent = <T>(): Answer<T> => ({ kind: "not-present" });
export const unknown = <T>(reason: Unknown, partial?: T): Answer<T> => (
  partial === undefined ? { kind: "unknown", reason } : { kind: "unknown", reason, partial }
);

/** The value if the table knew it. Silence and absence both yield null, so
 *  this is for callers that have decided the difference does not matter. */
export function valueOf<T>(a: Answer<T>): T | null {
  return a.kind === "known" ? a.value : null;
}

/** Is the process definitely gone? Only `not-present` says so. An unreadable
 *  table never does. */
export function isDefinitelyAbsent<T>(a: Answer<T>): boolean {
  return a.kind === "not-present";
}

/** Deliberately treat silence as absence. Sometimes that is right. It is never
 *  the right default, which is why it has a long name. */
export function orAbsentWhenUnknown<T>(a: Answer<T>): Answer<T> {
  return a.kind === "unknown" ? notPresent<T>() : a;
}

/** A process identity that is only ever compared with another one taken from
 *  the same run.
 *
 *  **This is deliberately not the same type as the registry's
 *  `recovery.processStartToken`, and it must never be compared with it.** That
 *  token is written into session metadata, read by the Rust tool from the same
 *  registry, and its exact text — including the two spaces `ps` puts before a
 *  single-digit day — is a contract between the two. This one is private to a
 *  single command's lifetime. The brand is what stops them meeting. */
export type LiveIdentity = string & { readonly __liveIdentity: unique symbol };
export const liveIdentity = (value: string): LiveIdentity => value as LiveIdentity;

/** One process, as the table saw it. */
export interface Row {
  pid: number;
  ppid: number;
  pgid: number;
  /** `ps` state letters or the `/proc` state character. Empty if unknown. */
  state: string;
  rssKb: number | null;
  cpuPercent: number | null;
  identity: LiveIdentity | null;
}

export const isZombie = (row: Row): boolean => row.state.startsWith("Z");

/** Where process facts come from.
 *
 *  Two implementations, chosen by which is cheaper on the platform. On Linux a
 *  single-process read is a small file read, so asking per process beats
 *  re-reading the machine. On macOS every read is a subprocess, so one snapshot
 *  serves the whole iteration. */
export interface ProcessSource {
  row(pid: number): Answer<Row>;
  identity(pid: number): Answer<LiveIdentity>;
  /** Alive and not a corpse awaiting reaping. */
  isRunning(pid: number): Answer<boolean>;
  /** Every row, for callers that need the whole tree. */
  rows(): Answer<Row[]>;
}

const onLinux = process.platform === "linux";

/** Open a source for one iteration of work.
 *
 *  On macOS this spawns `ps` once. On Linux it spawns nothing and reads
 *  lazily. Call it once per iteration, not once per question. */
export function openSource(): ProcessSource {
  return onLinux ? new DirectSource() : new SnapshotSource(readPsTable());
}

/** One process, without reading the whole table.
 *
 *  A poll loop asking about a single pid should not pay for every process on
 *  the machine. On Linux this is one small file read and no subprocess.
 *
 *  **On macOS it is still one `ps` per call, and that is Node's floor.** The
 *  Rust tool makes a syscall here; Node cannot without a native module. What
 *  this avoids is the larger whole-table listing, not the spawn.
 */
export function processOf(pid: number): Answer<Row> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return notPresent();
  if (onLinux) return new DirectSource().row(pid);
  let out: string;
  try {
    out = execFileSync(
      "ps",
      ["-o", "pid=,ppid=,pgid=,state=,rss=,pcpu=,lstart=", "-p", String(pid)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: PS_TIMEOUT_MS },
    );
  } catch {
    // `ps` exits non-zero when the pid is not there, which is indistinguishable
    // from `ps` failing. Ask the kernel, which does distinguish them.
    return processExists(pid) ? unknown("table-unreadable") : notPresent();
  }
  // **One parser, not two.** An earlier version handed the subprocess's raw
  // stdout to the single-line parser, which rejected the trailing newline every
  // `ps` prints — so a live process read as "field-empty" and a zombie read as
  // NOT EXITED, which would make the teardown wait out its whole budget for a
  // corpse. That is the corpse defect again, reintroduced on macOS by a second
  // parsing path that Linux never exercised. Found on a real Mac by
  // `Silber.pty` on 2026-09-03.
  //
  // `parsePsListing` splits lines first and checks that the row for the pid we
  // asked about is actually there, so both jobs are done by the code that was
  // already tested.
  const rows = parsePsListing(out, pid);
  const row = rows?.find((r) => r.pid === pid);
  if (row) return known(row);
  // It ran and said nothing about this pid.
  return processExists(pid) ? unknown("field-empty") : notPresent();
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Linux: answer each question from `/proc` as it is asked. */
class DirectSource implements ProcessSource {
  row(pid: number): Answer<Row> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return notPresent();
    let stat: string;
    try {
      stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ESRCH") return notPresent();
      // Permission denied, or /proc not mounted. We did not find out.
      return unknown("table-unreadable");
    }
    const row = parseProcStat(pid, stat);
    return row ? known(row) : unknown("field-empty");
  }

  identity(pid: number): Answer<LiveIdentity> {
    return mapAnswer(this.row(pid), (r) => r.identity);
  }

  isRunning(pid: number): Answer<boolean> {
    const r = this.row(pid);
    return r.kind === "known" ? known(!isZombie(r.value)) : (r as Answer<boolean>);
  }

  rows(): Answer<Row[]> {
    let names: string[];
    try {
      names = fs.readdirSync("/proc");
    } catch {
      return unknown("table-unreadable");
    }
    const out: Row[] = [];
    let incomplete: Unknown | null = null;
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      try {
        const row = parseProcStat(pid, fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
        if (row) out.push(row);
        else incomplete = "field-empty";
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // An exited process is absent. Permission and malformed-I/O failures
        // make a whole-tree answer incomplete, but preserve all safely observed
        // rows so teardown can still exact-signal visible out-of-group children.
        if (code !== "ENOENT" && code !== "ESRCH") incomplete = "table-unreadable";
      }
    }
    if (!out.some((r) => r.pid === process.pid)) {
      return unknown("table-unreadable", out);
    }
    return incomplete === null ? known(out) : unknown(incomplete, out);
  }
}

/** macOS and elsewhere: one `ps` listing, answered from memory. */
class SnapshotSource implements ProcessSource {
  private readonly byPid: Map<number, Row> | null;

  constructor(rows: Row[] | null) {
    this.byPid = rows === null ? null : new Map(rows.map((r) => [r.pid, r]));
  }

  row(pid: number): Answer<Row> {
    if (this.byPid === null) return unknown("table-unreadable");
    const r = this.byPid.get(pid);
    return r ? known(r) : notPresent();
  }

  identity(pid: number): Answer<LiveIdentity> {
    return mapAnswer(this.row(pid), (r) => r.identity);
  }

  isRunning(pid: number): Answer<boolean> {
    const r = this.row(pid);
    return r.kind === "known" ? known(!isZombie(r.value)) : (r as Answer<boolean>);
  }

  rows(): Answer<Row[]> {
    return this.byPid === null ? unknown("table-unreadable") : known([...this.byPid.values()]);
  }
}

function mapAnswer<T, U>(a: Answer<T>, f: (v: T) => U | null): Answer<U> {
  if (a.kind !== "known") return a as Answer<U>;
  const v = f(a.value);
  return v === null ? unknown<U>("field-empty") : known(v);
}

/** `ps -axo pid=,ppid=,pgid=,state=,rss=,pcpu=,lstart=`, or null if the table
 *  could not be read.
 *
 *  **An empty or self-omitting listing is an unreadable table, not an empty
 *  machine.** `ps` always lists at least the process that ran it, so a listing
 *  without our own pid was truncated or never produced. That one comparison is
 *  what turns a silent `ps` into "unknown" instead of "everything is dead". */
export function parsePsListing(listing: string, mustContain = process.pid): Row[] | null {
  const rows: Row[] = [];
  for (const line of listing.split("\n")) {
    const row = parsePsRow(line);
    if (row) rows.push(row);
  }
  return rows.some((r) => r.pid === mustContain) ? rows : null;
}

function readPsTable(): Row[] | null {
  let listing: string;
  try {
    listing = execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,state=,rss=,pcpu=,lstart="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: PS_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  return parsePsListing(listing);
}

function parsePsRow(line: string): Row | null {
  // The tail is taken as raw text rather than re-joined from split fields.
  // `ps -o lstart=` pads a single-digit day with two spaces, and re-joining
  // would quietly rewrite `Wed Sep  3` as `Wed Sep 3`.
  const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)(?:\s+(\S+))?(?:\s+(\S+))?(?:\s+(\S+))?(?:\s+(.*))?$/);
  if (!m) return null;
  const lstart = (m[7] ?? "").trim();
  return {
    pid: Number(m[1]),
    ppid: Number(m[2]),
    pgid: Number(m[3]),
    state: m[4] ?? "",
    rssKb: m[5] !== undefined && /^\d+$/.test(m[5]) ? Number(m[5]) : null,
    cpuPercent: m[6] !== undefined && !Number.isNaN(Number(m[6])) ? Number(m[6]) : null,
    identity: lstart ? liveIdentity(`darwin:${lstart}`) : null,
  };
}

/** `/proc/<pid>/stat`. Field 2 is the comm in parentheses and may contain
 *  spaces and brackets, so everything is read relative to the LAST `)`. */
export function parseProcStat(pid: number, stat: string): Row | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const f = stat.slice(close + 1).trim().split(/\s+/);
  // f[0] is field 3 (state), so field N is f[N - 3].
  if (f.length < 20) return null;
  const ppid = Number(f[1]);
  const pgid = Number(f[2]);
  const startTime = f[19];
  if (!Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgid) || !startTime) return null;
  return {
    pid,
    ppid,
    pgid,
    state: f[0] ?? "",
    rssKb: null,
    cpuPercent: null,
    identity: liveIdentity(`linux:${startTime}`),
  };
}

/** A source built from `pid ppid pgid [state] [identity]` lines, for tests that
 *  care about tree shape rather than about reading a real machine. A literal
 *  `-` in the identity column means the table had the process but could not
 *  name it. */
export function sourceFromShape(spec: string): ProcessSource {
  const rows: Row[] = [];
  for (const line of spec.split("\n")) {
    const f = line.trim().split(/\s+/).filter(Boolean);
    if (f.length < 3) continue;
    rows.push({
      pid: Number(f[0]),
      ppid: Number(f[1]),
      pgid: Number(f[2]),
      state: f[3] ?? "S",
      rssKb: null,
      cpuPercent: null,
      identity: f[4] === "-" ? null : liveIdentity(f[4] ?? `tok:${f[0]}`),
    });
  }
  return new SnapshotSource(rows);
}
