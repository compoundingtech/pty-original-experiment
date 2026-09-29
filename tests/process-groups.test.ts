// The escalation that finishes a kill the daemon could not finish. These tests
// check the machine after the signals, never the signals themselves.

import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import {
  groupsInTree,
  membersOfGroups,
  ownProcessGroup,
  signalGroup,
  sweepGroups,
} from "../src/process-groups.ts";
import { openSource, sourceFromShape } from "../src/proc-table.ts";
import { snapshotDescendantProcesses } from "../src/process-tree.ts";

// daemon 100 (its own group), pty child 200 (setsid: its own group and
// session), 300 under the child, and 400 in a background group of its own.
// 900 is unrelated. This is the shape measured on Linux for both tools on
// 2026-09-03.
const SHAPE = ["100 1 100 Ss", "200 100 200 Ss", "300 200 200 S", "400 300 400 S", "900 1 900 S"].join("\n");
const shaped = () => sourceFromShape(SHAPE);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
const live = (groups: number[]) => membersOfGroups(groups, openSource());

describe("choosing which process groups to sweep", () => {
  it("never targets the daemon's own group", () => {
    const groups = groupsInTree(100, shaped());
    // The pty child calls setsid, so the daemon sits alone in its group and
    // signalling it would reach the daemon and nothing else.
    expect(groups).not.toContain(100);
    expect(groups).toEqual([200, 400]);
  });

  it("never targets an unrelated group", () => {
    expect(groupsInTree(100, shaped())).not.toContain(900);
  });

  // The reason to sweep groups at all.
  it("still targets the group of a descendant whose start token cannot be read", () => {
    // 400 is the one the table cannot name.
    const unnamed = sourceFromShape(
      ["100 1 100 Ss", "200 100 200 Ss", "300 200 200 S", "400 300 400 S -", "900 1 900 S"].join("\n"),
    );
    const snapshot = snapshotDescendantProcesses(100, { source: () => unnamed });
    expect(snapshot.some((i) => i.pid === 400)).toBe(false);
    expect(groupsInTree(100, unnamed)).toContain(400);
  });

  it("reads members back by group", () => {
    expect(membersOfGroups([200], shaped())).toEqual([200, 300]);
    expect(membersOfGroups([], shaped())).toEqual([]);
  });

  // `ps` lists a zombie with its process group. Counting it would make the
  // sweep report a group it has already emptied, and then signal it again.
  it("does not count a zombie as a group member", () => {
    const withCorpse = sourceFromShape("100 1 100 Ss\n200 100 200 Sl\n300 200 200 Z");
    expect(membersOfGroups([200], withCorpse)).toEqual([200]);
  });


});

describe("the sweep", () => {
  function fake(alive: number[][]) {
    const sent: Array<[number, string]> = [];
    let step = 0;
    return {
      sent,
      deps: {
        live: () => alive[step++] ?? [],
        signal: (g: number, s: NodeJS.Signals) => { sent.push([g, s]); },
        sleep: async () => {},
      },
    };
  }

  it("does not kill a group that answers TERM", async () => {
    const f = fake([[]]);
    expect(await sweepGroups([200], 5, 0, 0, f.deps)).toEqual([]);
    expect(f.sent).toEqual([[200, "SIGTERM"]]);
  });

  // A coding agent was measured ignoring SIGTERM for ten seconds. One TERM and
  // hope is already known not to work here.
  it("kills a group that ignores TERM", async () => {
    const f = fake([[300], []]);
    expect(await sweepGroups([200], 5, 0, 0, f.deps)).toEqual([]);
    expect(f.sent).toEqual([[200, "SIGTERM"], [200, "SIGKILL"]]);
  });

  it("returns what outlives SIGKILL rather than swallowing it", async () => {
    const f = fake([[300], [300]]);
    expect(await sweepGroups([200], 5, 0, 0, f.deps)).toEqual([300]);
  });

  it("never signals its own group", async () => {
    const f = fake([[]]);
    await sweepGroups([200], 200, 0, 0, f.deps);
    expect(f.sent).toEqual([]);
  });

  it("never signals group 1 or below", async () => {
    const f = fake([[]]);
    await sweepGroups([0, 1, -1], 999, 0, 0, f.deps);
    expect(f.sent).toEqual([]);
  });
});

describe("the sweep against real processes", () => {
  // The fake tests prove the ordering. This one proves the ordering is about
  // real processes: it builds a real group whose members ignore SIGTERM, runs
  // the real sweep, and checks the process table afterwards.
  it("kills a real group that ignores SIGTERM and verifies it is gone", async () => {
    // `detached: true` gives the child its own process group.
    //
    // **macOS has the `setsid` system call but no `setsid` executable.** An
    // earlier version of this test spawned the binary, so on the one platform
    // where process groups are the whole escalation story, the test could not
    // run at all. Reported from a real Mac.
    const child = spawn("sh", ["-c", "trap '' TERM; sleep 60 & sleep 60"], {
      stdio: "ignore",
      detached: true,
    });
    const leader = child.pid!;
    try {
      const deadline = Date.now() + 5_000;
      while (live([leader]).length < 2 && Date.now() < deadline) await sleep(25);
      expect(live([leader]).length).toBeGreaterThanOrEqual(2);

      // SIGTERM alone must not be enough, or this proves nothing.
      signalGroup(leader, "SIGTERM");
      await sleep(400);
      expect(live([leader]).length).toBeGreaterThan(0);

      const stillThere = await sweepGroups([leader], ownProcessGroup(), 500, 2_000, {
        live,
        signal: signalGroup,
        sleep,
      });
      expect(stillThere).toEqual([]);
      expect(live([leader])).toEqual([]);
    } finally {
      // The leader alone is not the cleanup: if this test fails, its whole
      // group is still running and would leak into the next run.
      signalGroup(leader, "SIGKILL");
    }
  }, 20_000);

  // The command must not signal the group it is running in, or it dies before
  // it can report.
  it("leaves its own process group alone", async () => {
    const own = ownProcessGroup();
    expect(own).toBeGreaterThan(1);
    const stillThere = await sweepGroups([own], own, 0, 0, { live, signal: signalGroup, sleep });
    expect(stillThere).toContain(process.pid);
  });
});
