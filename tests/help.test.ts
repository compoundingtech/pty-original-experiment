import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nodeBin = process.execPath;
const cliPath = path.join(__dirname, "..", "dist", "cli.js");
const cliSource = fs.readFileSync(path.join(__dirname, "..", "src", "cli.ts"), "utf8");

// Canonical subcommands that must each ship focused `--help`.
const COMMANDS = [
  "run", "attach", "exec", "peek", "send", "events", "list", "stats",
  "restart", "kill", "recover", "rm", "gc", "tag", "tag-multi", "emit", "rename", "metadata",
  "up", "down", "test", "remote-serve", "readiness", "evidence",
];
// Aliases that must resolve to the same help.
const ALIASES = ["a", "ls", "remove"];
// Dispatch `case` labels that are NOT per-subcommand commands (no focused
// `Usage: pty …` + example help expected): the interactive TUI, the global
// help/version verbs+flags, and utility generators that ship their own
// lightweight usage (`completions` prints `usage: pty completions <shell>`).
const NON_COMMAND_CASES = new Set([
  "interactive", "i", "help", "--help", "-h", "version", "--version", "-v", "-V",
  "completions",
]);

function help(cmd: string) {
  return spawnSync(nodeBin, [cliPath, cmd, "--help"], {
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env, PTY_ROOT_LEGACY_SILENT: "1" },
  });
}

describe("pty --help — per-subcommand help", () => {
  for (const cmd of [...COMMANDS, ...ALIASES]) {
    it(`\`pty ${cmd} --help\` prints usage + an example and exits 0`, () => {
      const r = help(cmd);
      expect(r.status).toBe(0);
      // Usage synopsis.
      expect(r.stdout).toMatch(/^Usage: pty /);
      // At least one concrete example (an `Examples:` header or a `  pty …` line
      // beyond the synopsis).
      const exampleLines = r.stdout.split("\n").filter((l) => /^ {2}pty /.test(l));
      expect(exampleLines.length).toBeGreaterThan(0);
      // Help must not have executed the command (no session-list / JSON output).
      expect(r.stdout).not.toMatch(/^\[/);
    });
  }

  for (const leaf of ["snapshot", "remove"] as const) {
    it(`\`pty evidence ${leaf} --help\` prints leaf-specific help and exits 0`, () => {
      const r = spawnSync(nodeBin, [cliPath, "evidence", leaf, "--help"], {
        encoding: "utf8",
        timeout: 15000,
        env: { ...process.env, PTY_ROOT_LEGACY_SILENT: "1" },
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toBe("");
      expect(r.stdout).toMatch(new RegExp(`^Usage: pty evidence ${leaf} `));
      expect(r.stdout).toContain("--id <stable-id>");
      if (leaf === "snapshot") {
        expect(r.stdout).not.toContain("--expected-generation");
      } else {
        expect(r.stdout).toContain("--expected-generation <opaque>");
      }
    });
  }

  for (const leaf of ["ownership", "cas"] as const) {
    it(`\`pty readiness ${leaf} --help\` prints leaf-specific help and exits 0`, () => {
      const r = spawnSync(nodeBin, [cliPath, "readiness", leaf, "--help"], {
        encoding: "utf8",
        timeout: 15000,
        env: { ...process.env, PTY_ROOT_LEGACY_SILENT: "1" },
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toBe("");
      expect(r.stdout).toMatch(new RegExp(`^Usage: pty readiness ${leaf} `));
      expect(r.stdout).toContain("--id <stable-id>");
    });
  }
});

describe("pty --help — no drift", () => {
  it("documents accepted key modifier notations", () => {
    const r = help("send");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("key:ctrl+c");
    expect(r.stdout).toContain("key:ctrl-c");
    expect(r.stdout).toContain("key:C-c");
    expect(r.stdout).toContain("_ separators");
  });

  it("documents the repeatable persisted environment overlay", () => {
    const r = help("run");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("--env KEY=VALUE");
    expect(r.stdout).toMatch(/environment variable \(repeatable\)/);
    expect(r.stdout).toContain("--unset-env KEY");
    expect(r.stdout).toMatch(/inherited environment variable \(repeatable\)/);
  });

  it("every dispatch `case` is either a documented command or a known non-command", () => {
    // Extract every `case "X":` label from the dispatcher.
    const cases = [...cliSource.matchAll(/case\s+"([^"]+)":/g)].map((m) => m[1]);
    const documented = new Set([...COMMANDS, ...ALIASES]);
    const uncovered = cases.filter((c) => !documented.has(c) && !NON_COMMAND_CASES.has(c));
    // A new subcommand added without focused help (or without being listed as a
    // non-command) will show up here — add it to COMMAND_HELP + this test.
    expect(uncovered).toEqual([]);
  });

  it("top-level `pty --help` lists every subcommand", () => {
    const r = spawnSync(nodeBin, [cliPath, "--help"], {
      encoding: "utf8",
      timeout: 15000,
      env: { ...process.env, PTY_ROOT_LEGACY_SILENT: "1" },
    });
    expect(r.status).toBe(0);
    for (const cmd of COMMANDS) {
      expect(r.stdout).toContain(`pty ${cmd} `);
    }
  });
});
