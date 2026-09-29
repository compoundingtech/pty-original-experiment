// One reader for the process table. These tests are about the three answers
// and about a `ps` that misbehaves, because that is what produced the wrong
// answers this module exists to stop.

import { describe, expect, it } from "vitest";
import { hasProcessExitedForReap } from "../src/sessions.ts";
import {
  isDefinitelyAbsent,
  openSource,
  orAbsentWhenUnknown,
  parseProcStat,
  parsePsListing,
  sourceFromShape,
  unknown,
  valueOf,
} from "../src/proc-table.ts";
import { execFileSync, spawn } from "node:child_process";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const me = process.pid;

describe("the truncation guard", () => {
  // `ps` always lists at least the process that ran it. A listing without our
  // own pid was truncated or never produced, and reading it as "the machine
  // has no processes" is the defect this whole module exists for.
  it("treats a listing without our own pid as unreadable, not empty", () => {
    expect(parsePsListing("4242 1 4242 S 100 0.0 Wed Sep  3 11:00:00 2026\n")).toBeNull();
  });

  it("treats an empty listing as unreadable, not empty", () => {
    expect(parsePsListing("")).toBeNull();
    expect(parsePsListing("   \n\n")).toBeNull();
  });

  it("accepts a listing that contains us", () => {
    const rows = parsePsListing(`${me} 1 ${me} S 100 0.5 Wed Sep  3 11:00:00 2026\n`);
    expect(rows).not.toBeNull();
    expect(rows![0]).toMatchObject({ pid: me, ppid: 1, pgid: me, rssKb: 100, cpuPercent: 0.5 });
  });

  // `ps -o lstart=` pads a single-digit day with two spaces, and that text is
  // the registry's on-disk token. Re-joining split fields would rewrite it.
  it("keeps the lstart text exactly as ps printed it", () => {
    const rows = parsePsListing(`${me} 1 ${me} S 100 0.5 Wed Sep  3 11:00:00 2026\n`);
    expect(rows![0].identity).toBe("darwin:Wed Sep  3 11:00:00 2026");
  });
});

describe("the shape a subprocess actually returns", () => {
  // `ps` prints a trailing newline. An earlier version passed raw stdout to the
  // single-line parser, whose `$` does not match before one, so a live process
  // read as "field-empty" and a zombie read as not exited. There is now one
  // parser and these pin its input shape.
  const row = "94908 94907 94576 Z         0   0.0 Thu Sep  3 14:05:44 2026    ";

  it("parses a row that ends in a newline", () => {
    const rows = parsePsListing(`${row}\n`, 94908);
    expect(rows).not.toBeNull();
    expect(rows![0]).toMatchObject({ pid: 94908, ppid: 94907, pgid: 94576, state: "Z" });
  });

  it("parses a row with no trailing newline", () => {
    expect(parsePsListing(row, 94908)).not.toBeNull();
  });

  it("keeps the lstart text through a trailing newline", () => {
    const rows = parsePsListing(`${row}\n`, 94908);
    expect(rows![0].identity).toBe("darwin:Thu Sep  3 14:05:44 2026");
  });

  // **The seam this bug lived in.** Every other test builds its input the way
  // the parser expects, so all of them agreed with each other and none of them
  // agreed with `ps`. This one runs the real command with the real arguments
  // and feeds the parser exactly what the subprocess wrote, newline and all.
  it("parses what the ps subprocess actually writes", () => {
    const out = execFileSync(
      "ps",
      ["-o", "pid=,ppid=,pgid=,state=,rss=,pcpu=,lstart=", "-p", String(me)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    expect(out.endsWith("\n"), "precondition: ps ends its output with a newline").toBe(true);

    const rows = parsePsListing(out, me);
    expect(rows, `parser rejected real ps output: ${JSON.stringify(out)}`).not.toBeNull();
    const row = rows!.find((r) => r.pid === me);
    expect(row).toBeDefined();
    expect(row!.ppid).toBeGreaterThan(0);
    expect(row!.pgid).toBeGreaterThan(0);
    expect(row!.identity).toBeTruthy();
  });
});

describe("three answers, never two", () => {
  const source = sourceFromShape(`${me} 1 ${me} Ss`);

  it("separates a missing process from an unreadable table", () => {
    expect(isDefinitelyAbsent(source.isRunning(999_999))).toBe(true);
    expect(isDefinitelyAbsent(unknown<boolean>("table-unreadable"))).toBe(false);
  });

  it("makes treating silence as death something you have to ask for by name", () => {
    const silent = unknown<boolean>("table-unreadable");
    expect(isDefinitelyAbsent(silent)).toBe(false);
    expect(isDefinitelyAbsent(orAbsentWhenUnknown(silent))).toBe(true);
  });

  // An empty column is its own answer too: the process is there, `ps` just did
  // not say. This is the defect that shipped in `hasProcessExitedForReap`.
  it("does not turn an unnamed process into an absent one", () => {
    const unnamed = sourceFromShape(`${me} 1 ${me} Ss -`);
    const answer = unnamed.identity(me);
    expect(answer.kind).toBe("unknown");
    expect(isDefinitelyAbsent(answer)).toBe(false);
  });
});

describe("parsing /proc/<pid>/stat", () => {
  // Field 2 is the comm in parentheses and may contain spaces and brackets.
  it("reads relative to the last close paren", () => {
    const row = parseProcStat(7, `7 (a b) c) S 3 5 ${Array.from({ length: 40 }, (_, i) => i).join(" ")}`);
    expect(row).not.toBeNull();
    expect(row!.ppid).toBe(3);
    expect(row!.pgid).toBe(5);
    expect(row!.state).toBe("S");
  });

  it("returns null rather than guessing at a short line", () => {
    expect(parseProcStat(7, "7 (x) S 1 2")).toBeNull();
    expect(parseProcStat(7, "no parens here")).toBeNull();
  });
});

describe("against the real machine", () => {
  it("knows this very process", () => {
    const source = openSource();
    const row = valueOf(source.row(me));
    expect(row).not.toBeNull();
    expect(row!.pid).toBe(me);
    expect(row!.ppid).toBeGreaterThan(0);
    expect(valueOf(source.isRunning(me))).toBe(true);
    expect(valueOf(source.identity(me))).toBeTruthy();
  });

  it("calls a pid that cannot exist definitely absent", () => {
    expect(isDefinitelyAbsent(openSource().isRunning(0x7fffffff))).toBe(true);
  });

  // An unreaped child must never read as running. **The two platforms reach
  // that answer differently, and this asserts the answer.** On Linux the corpse
  // keeps a row with state Z. On macOS `ps` stops listing it the moment it
  // exits. Measured on a real Mac.
  it("never reports an unreaped child as running", async () => {
    const sh = spawn("sh", ["-c", "sleep 0.1 & echo $! ; kill -STOP $$"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    try {
      const pid = await new Promise<number>((resolve) =>
        sh.stdout!.once("data", (d) => resolve(Number(String(d).trim()))),
      );
      let settled: string | null = null;
      for (let i = 0; i < 500; i++) {
        const source = openSource();
        const answer = source.isRunning(pid);
        // Linux: still listed, but a corpse.
        if (answer.kind === "known" && answer.value === false) {
          settled = "listed as not running";
          break;
        }
        // macOS: gone from the listing entirely.
        if (answer.kind === "not-present") {
          settled = "no longer listed";
          break;
        }
        await sleep(10);
      }
      expect(settled, "an exited child still read as running").not.toBeNull();
      // Whichever route, the conclusion callers depend on is the same.
      expect(hasProcessExitedForReap(pid)).toBe(true);
    } finally {
      sh.kill("SIGKILL");
    }
  }, 20_000);
});
