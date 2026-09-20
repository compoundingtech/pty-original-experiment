// SSOT parity + generator-output checks for `pty completions`.
//
// These tests guard the contract in src/completions.ts:
//   - every user-facing command documented in `COMMAND_HELP` (cli.ts) has a
//     matching entry in the completion spec, so the two can't drift;
//   - `pty completions <shell>` emits a script that the target shell accepts
//     syntactically (`fish -n` / `bash -n` / `zsh -n` when installed).
//
// We run the built CLI (dist/cli.js) so the assertions cover the real dispatch
// path that ships — not just the in-process generator.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { execSync } from "node:child_process";
import { COMMANDS } from "../src/completions.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(__dirname, "..", "dist", "cli.js");
const nodeBin = process.execPath;

/** Run `node dist/cli.js completions <shell>` and return stdout. */
function gen(shell: string): string {
  const r = spawnSync(nodeBin, [cliPath, "completions", shell], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(
      `pty completions ${shell} exited ${r.status}\n${r.stderr}`,
    );
  }
  return r.stdout;
}

/** Resolve the list of command names that `cli.ts` documents in COMMAND_HELP. */
function documentedCommandNames(): Set<string> {
  // COMMAND_HELP keys are the canonical, documented command names.
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "cli.ts"),
    "utf8",
  );
  const start = src.indexOf("const COMMAND_HELP:");
  const end = src.indexOf("};", start);
  const block = src.slice(start, end);
  const keys = [
    ...block.matchAll(/^  ([a-z][a-z-]*):\s*`/gm),
  ].map((m) => m[1]);
  return new Set(keys);
}

describe("completion spec parity with COMMAND_HELP", () => {
  it("covers every documented command (name or alias)", () => {
    const documented = documentedCommandNames();
    const specNames = new Set(
      COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]),
    );
    const missing = [...documented].filter((k) => !specNames.has(k));
    expect(missing, `documented commands missing from completions spec: ${missing.join(", ")}`).toEqual([]);
  });

  it("models evidence as leaf-specific snapshot and remove commands", () => {
    expect(COMMANDS.find((command) => command.name === "evidence")).toMatchObject({
      subcommands: [
        {
          name: "snapshot",
          flags: [{ name: "id" }],
        },
        {
          name: "remove",
          flags: [{ name: "id" }, { name: "expected-generation" }],
        },
      ],
    });
  });

  it("models readiness as ownership and CAS leaves with required ids", () => {
    expect(COMMANDS.find((command) => command.name === "readiness")).toMatchObject({
      subcommands: [
        {
          name: "ownership",
          flags: [{ name: "id", argument: { _tag: "free" } }],
        },
        {
          name: "cas",
          flags: [{ name: "id", argument: { _tag: "free" } }],
        },
      ],
    });
  });
});

describe("pty completions <shell>", () => {
  it("matches every checked-in completion artifact", () => {
    for (const shell of ["fish", "bash", "zsh"]) {
      const checkedIn = fs.readFileSync(
        path.join(__dirname, "..", "completions", `pty.${shell}`),
        "utf8",
      );
      expect(gen(shell), `completions/pty.${shell} is stale`).toBe(checkedIn);
    }
  });

  it("offers pty run --env in every generated shell", () => {
    const markers = { fish: "-l env", bash: "--env", zsh: "--env" } as const;
    for (const shell of ["fish", "bash", "zsh"] as const) {
      expect(gen(shell)).toContain(markers[shell]);
    }
  });

  it("completes evidence modes and leaf-specific flags in bash", () => {
    const bash = which("bash");
    if (!bash) return;
    const complete = (words: string, cword: number) => {
      const result = spawnSync(bash, ["-c", `${gen("bash")}
COMP_WORDS=(${words})
COMP_CWORD=${cword}
_pty
printf '%s\\n' "\${COMPREPLY[@]}"`], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim().split("\n").filter(Boolean).sort();
    };

    expect(complete('pty evidence ""', 2)).toEqual(["remove", "snapshot"]);
    expect(complete('pty evidence snapshot "--"', 3)).toEqual(["--id"]);
    expect(complete('pty evidence remove "--"', 3)).toEqual([
      "--expected-generation",
      "--id",
    ]);
  });

  it("completes evidence modes and leaf-specific flags in fish", () => {
    const fish = which("fish");
    if (!fish) return;
    const complete = (line: string) => {
      const result = spawnSync(fish, ["-c", `${gen("fish")}
complete -C '${line}'`], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim().split("\n").filter(Boolean)
        .map((entry) => entry.split(/\s+/)[0]).sort();
    };

    expect(complete("pty evidence ")).toEqual(["remove", "snapshot"]);
    expect(complete("pty evidence snapshot --")).toEqual(["--id"]);
    expect(complete("pty evidence remove --")).toEqual([
      "--expected-generation",
      "--id",
    ]);
  });

  it("generates nested evidence leaves with isolated flags for zsh", () => {
    const output = gen("zsh");
    const start = output.indexOf("        evidence)");
    const end = output.indexOf("        up)", start);
    const block = output.slice(start, end);
    const snapshotStart = block.indexOf("snapshot)");
    const removeStart = block.indexOf("remove)");
    const snapshot = block.slice(snapshotStart, removeStart);
    const remove = block.slice(removeStart);

    expect(block).toContain("snapshot remove");
    expect(snapshot).toContain("--id");
    expect(snapshot).not.toContain("--expected-generation");
    expect(remove).toContain("--id");
    expect(remove).toContain("--expected-generation");
  });

  it("models --attach-stream-fd-v1 as consuming a required free-form value", () => {
    expect(gen("fish")).toContain("-l attach-stream-fd-v1 -x ");
    expect(gen("bash")).toContain('"${prev}" == "--attach-stream-fd-v1"');
    expect(gen("zsh")).toMatch(/--attach-stream-fd-v1\[[^\]]+\]:fd:/);

    const bash = which("bash");
    if (!bash) return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pty-completion-fd-"));
    try {
      fs.writeFileSync(path.join(root, "target.json"), "{}");
      const script = `${gen("bash")}
COMP_WORDS=(pty attach --attach-stream-fd-v1 3 "")
COMP_CWORD=4
_pty
printf '%s\n' "\${COMPREPLY[@]}"`;
      const result = spawnSync(bash, ["-c", script], {
        encoding: "utf8",
        env: { ...process.env, PTY_ROOT: root },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("target");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("prints fish, bash, zsh to stdout", () => {
    for (const shell of ["fish", "bash", "zsh"] as const) {
      const out = gen(shell);
      expect(out.length).toBeGreaterThan(50);
      expect(out, `output for ${shell} should end with a newline`).toMatch(/\n$/);
    }
  });

  it("lets piped stdout drain before exiting", () => {
    const delayedStdout = pathToFileURL(
      path.join(__dirname, "fixtures", "delayed-stdout.mjs"),
    ).href;
    for (const shell of ["fish", "bash", "zsh"]) {
      const r = spawnSync(
        nodeBin,
        ["--import", delayedStdout, cliPath, "completions", shell],
        { encoding: "utf8" },
      );
      const checkedIn = fs.readFileSync(
        path.join(__dirname, "..", "completions", `pty.${shell}`),
        "utf8",
      );

      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout, `${shell} output was truncated`).toBe(checkedIn);
    }
  });

  it("prints usage and exits non-zero for an unknown shell", () => {
    const r = spawnSync(nodeBin, [cliPath, "completions", "tcsh"], {
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unknown shell/i);
  });

  it("prints usage for --help", () => {
    const r = spawnSync(nodeBin, [cliPath, "completions", "--help"], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/usage: pty completions/);
  });

  it("fish output is syntactically valid", () => {
    const fish = which("fish");
    if (!fish) return; // not installed in this environment
    const out = gen("fish");
    const r = spawnSync(fish, ["-n", "-c", out], { encoding: "utf8" });
    expect(r.status, `fish -n failed:\n${r.stderr}\n---\n${out}`).toBe(0);
  });

  it("bash output is syntactically valid", () => {
    const bash = which("bash");
    if (!bash) return;
    const out = gen("bash");
    const r = spawnSync(bash, ["-n", "-c", out], { encoding: "utf8" });
    expect(r.status, `bash -n failed:\n${r.stderr}\n---\n${out}`).toBe(0);
  });

  it("zsh output is syntactically valid", () => {
    const zsh = which("zsh");
    if (!zsh) return;
    const out = gen("zsh");
    const r = spawnSync(zsh, ["-n", "-c", out], { encoding: "utf8" });
    expect(r.status, `zsh -n failed:\n${r.stderr}\n---\n${out}`).toBe(0);
  });
});

/** Best-effort `which`: returns the resolved path or undefined if missing. */
function which(bin: string): string | undefined {
  try {
    return execSync(`command -v ${bin}`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim() || undefined;
  } catch {
    return undefined;
  }
}
