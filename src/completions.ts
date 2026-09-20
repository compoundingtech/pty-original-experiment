// completions.ts — print shell completion scripts for `pty`.
//
// pty dispatches subcommands via a hand-written `switch` in cli.ts and its
// `--help` output is prose, so there is no machine-readable command table to
// derive completions from. Instead this module owns a small declarative spec
// of the command tree (commands → flags, enum-valued flags, positionals) and
// generates fish / bash / zsh from that ONE spec, so the three scripts can't
// drift apart. This mirrors smalltalk's `st completions` design, extended
// with two things pty needs that `st` does not:
//
//   1. Dynamic session completion. Many verbs take a `<ref>` that resolves to
//      a live session (the on-disk id, or a displayName). Rather than
//      hard-coding a static list, the generator emits the per-shell idiom that
//      reads `<root>/*.json` at completion time (the `__pty_sessions` /
//      `names` / `_pty_sessions` helpers proven in the legacy static files).
//      A node is marked `dynamic: 'sessions'` to opt in.
//
//   2. Path completion. `up` / `down` complete a directory holding a
//      pty.toml; `run --cwd` completes a directory. `takesPath` opts in.
//
// Keep the spec in sync with the `switch` dispatch in cli.ts and the
// `COMMAND_HELP` table there. tests/completions.test.ts asserts every key in
// `COMMAND_HELP` has a matching entry here.

// ─── Spec ──────────────────────────────────────────────────────────────────

/** A `--flag`, optionally with one required argument. */
interface FlagSpec {
  name: string;
  desc: string;
  /** `-x` short spelling, for fish `-s` and bash/zsh bundled forms. */
  short?: string;
  argument?:
    | { _tag: "free"; name: string }
    | { _tag: "choices"; name: string; values: readonly string[] };
}

interface SubcommandSpec {
  name: string;
  desc: string;
  flags?: readonly FlagSpec[];
}

/** A top-level command, optionally with one nested subcommand level. */
interface CommandSpec {
  name: string;
  desc: string;
  /** Aliases for the command name (e.g. `a` for `attach`). */
  aliases?: readonly string[];
  /** Flags accepted directly by this command. */
  flags?: readonly FlagSpec[];
  /** Complete live session names for the positional `<ref>` (reads PTY_ROOT). */
  dynamic?: "sessions";
  /** Complete a directory path for the positional (e.g. `up`/`<dir>`). */
  takesPath?: boolean;
  /** A closed set of values for a positional argument. */
  positionalValues?: readonly string[];
  /** One machine-visible command level below the top-level command. */
  subcommands?: readonly SubcommandSpec[];
}

/** Status enum shared by `list` / `ls --status`. */
const STATUS_VALUES = ["running", "exited", "vanished"] as const;

const JSON_FLAG: FlagSpec = { name: "json", desc: "Emit JSON" };

/**
 * The pty command tree. Keep in sync with the `switch` dispatch in cli.ts
 * and the per-command flag parsing in that file.
 */
const COMMANDS: readonly CommandSpec[] = [
  {
    name: "run",
    desc: "Create a session and attach",
    flags: [
      { name: "detach", short: "d", desc: "Create in the background (detached)" },
      { name: "attach", short: "a", desc: "Create OR attach if id already exists" },
      { name: "ephemeral", short: "e", desc: "Ephemeral: auto-remove metadata on clean exit" },
      { name: "id", desc: "Pin on-disk id (charset-validated)" },
      { name: "name", desc: "Display label (trimmed, single-line, ≤ 160 Unicode scalars)" },
      { name: "no-display-name", desc: "Skip the auto-generated label" },
      { name: "tag", desc: "Tag session (k=v, repeatable)" },
      { name: "env", desc: "Overlay child environment (KEY=VALUE, repeatable)" },
      { name: "unset-env", desc: "Remove inherited environment key (repeatable)" },
      { name: "cwd", desc: "Working directory" },
      { name: "isolate-env", desc: "Scrub env to a safe allow-list" },
      { name: "force", desc: "Create even from inside another pty" },
      {
        name: "startup-timeout-ms",
        desc: "Daemon-owned startup deadline in milliseconds",
        argument: { _tag: "free", name: "milliseconds" },
      },
      {
        name: "lifecycle-tag",
        desc: "Generation-fenced lifecycle tag key",
        argument: { _tag: "free", name: "key" },
      },
    ],
  },
  {
    name: "attach",
    aliases: ["a"],
    desc: "Attach to an existing session",
    dynamic: "sessions",
    flags: [
      { name: "auto-restart", short: "r", desc: "Auto-restart if the session is exited" },
      { name: "no-restart", desc: "Attach only; never prompt or restart an exited session" },
      { name: "force", desc: "Attach even from inside another pty" },
      { name: "remote", desc: "Attach a session on a fabric peer" },
      {
        name: "attach-stream-fd-v1",
        desc: "Write framed machine events to an inherited fd",
        argument: { _tag: "free", name: "fd" },
      },
    ],
  },
  {
    name: "exec",
    desc: "Replace the current session process",
    takesPath: true,
  },
  {
    name: "peek",
    desc: "Print current screen (or follow / wait-for-text)",
    dynamic: "sessions",
    flags: [
      { name: "follow", short: "f", desc: "Follow output read-only" },
      { name: "plain", desc: "Plain text (no ANSI)" },
      { name: "full", desc: "Include full scrollback" },
      { name: "wait", desc: "Wait until text appears" },
      { name: "timeout", short: "t", desc: "Timeout (seconds) for --wait" },
      { name: "remote", desc: "Peek a session on a fabric peer" },
    ],
  },
  {
    name: "send",
    desc: "Send text or key events",
    dynamic: "sessions",
    flags: [
      { name: "seq", desc: "Ordered chunk / key event (repeatable)" },
      { name: "with-delay", desc: "Delay between --seq items (sec)" },
      { name: "paste", desc: "Wrap in bracketed-paste markers" },
      { name: "remote", desc: "Send to a session on a fabric peer" },
    ],
  },
  {
    name: "events",
    desc: "Follow event log",
    dynamic: "sessions",
    flags: [
      { name: "all", desc: "Follow every session, interleaved" },
      { name: "recent", desc: "Print recent + exit" },
      JSON_FLAG,
      { name: "wait", desc: "Wait for a specific event type" },
      { name: "timeout", short: "t", desc: "Timeout (seconds) for --wait" },
    ],
  },
  {
    name: "list",
    aliases: ["ls"],
    desc: "List sessions",
    flags: [
      JSON_FLAG,
      { name: "tags", desc: "Include internal bookkeeping tags" },
      { name: "filter-tag", desc: "Filter to k=v (repeatable, ALL match)" },
      { name: "remote", desc: "Include remote sessions via pty-relay" },
      {
        name: "status",
        desc: "Filter by status",
        argument: { _tag: "choices", name: "status", values: STATUS_VALUES },
      },
      { name: "older-than", desc: "Only sessions older than a duration" },
      { name: "newer-than", desc: "Only sessions newer than a duration" },
      { name: "summary", desc: "One-line count summary instead of the list" },
    ],
  },
  {
    name: "stats",
    desc: "Live CPU / memory / PIDs",
    dynamic: "sessions",
    flags: [JSON_FLAG, { name: "all", desc: "Include every session" }],
  },
  {
    name: "restart",
    desc: "SIGTERM + respawn",
    dynamic: "sessions",
    flags: [
      { name: "yes", short: "y", desc: "Skip confirmation" },
      { name: "force", desc: "Attach after restart even from inside another pty" },
    ],
  },
  {
    name: "kill",
    desc: "SIGTERM a running session",
    dynamic: "sessions",
  },
  {
    name: "recover",
    desc: "Rebind a supporting live daemon after registry unlink",
    flags: [
      { name: "snapshot", desc: "Captured capability-bearing metadata file" },
    ],
  },
  {
    name: "rm",
    aliases: ["remove"],
    desc: "Remove exited metadata",
    dynamic: "sessions",
  },
  {
    name: "gc",
    desc: "Reconciliation pass",
    flags: [
      { name: "dry-run", short: "n", desc: "Preview without changing anything" },
      { name: "idle-days", desc: "Reap permanents with no attach in N days" },
      { name: "keep-max-age", desc: "Keep-tag retention for dead sessions (default 7d; 0 = now)" },
      { name: "fast-fail-window", desc: "Fast-fail window (seconds; default 60)" },
      { name: "fast-fail-limit", desc: "Consecutive fast fails before flapping (default 3)" },
      { name: "print-launchd-plist", desc: "Emit a launchd plist that runs pty gc" },
      { name: "interval", desc: "Plist StartInterval seconds (default 30)" },
    ],
  },
  {
    name: "tag",
    desc: "Read / write tags on one session",
    dynamic: "sessions",
    flags: [{ name: "rm", desc: "Remove tag key (repeatable)" }],
  },
  {
    name: "tag-multi",
    desc: "Bulk tag ops across sessions",
    dynamic: "sessions",
    flags: [
      { name: "all", desc: "Selector: every session" },
      { name: "filter-tag", desc: "Selector: k=v (repeatable)" },
      { name: "rm", desc: "Remove tag key (repeatable)" },
      JSON_FLAG,
      { name: "yes", short: "y", desc: "Confirm --all + write" },
    ],
  },
  {
    name: "emit",
    desc: "Publish a user.* event",
    dynamic: "sessions",
    flags: [
      { name: "json", desc: "JSON payload" },
      { name: "text", desc: "Text payload" },
    ],
  },
  {
    name: "rename",
    desc: "Set / show / clear displayName",
    dynamic: "sessions",
    flags: [
      { name: "show", desc: "Print current displayName" },
      { name: "clear", desc: "Remove displayName" },
    ],
  },
  {
    name: "metadata",
    desc: "Atomically patch presentation metadata by stable id",
    flags: [{ name: "id", desc: "Exact stable session id" }],
    positionalValues: ["patch"],
  },
  {
    name: "readiness",
    desc: "Exact socket ownership and lifecycle compare-and-set",
    subcommands: [
      {
        name: "ownership",
        desc: "Prove accepted socket ownership for one held connection",
        flags: [{
          name: "id",
          desc: "Exact stable session id",
          argument: { _tag: "free", name: "id" },
        }],
      },
      {
        name: "cas",
        desc: "Compare-and-set one lifecycle tag value",
        flags: [{
          name: "id",
          desc: "Exact stable session id",
          argument: { _tag: "free", name: "id" },
        }],
      },
    ],
  },
  {
    name: "evidence",
    desc: "Read or remove exact-generation retained exit evidence",
    subcommands: [
      {
        name: "snapshot",
        desc: "Read retained evidence for one exact generation",
        flags: [
          {
            name: "id",
            desc: "Exact stable session id",
            argument: { _tag: "free", name: "id" },
          },
        ],
      },
      {
        name: "remove",
        desc: "Remove only the matching terminal generation",
        flags: [
          {
            name: "id",
            desc: "Exact stable session id",
            argument: { _tag: "free", name: "id" },
          },
          {
            name: "expected-generation",
            desc: "Opaque generation returned by evidence snapshot",
            argument: { _tag: "free", name: "generation" },
          },
        ],
      },
    ],
  },
  {
    name: "up",
    desc: "Start sessions from pty.toml",
    takesPath: true,
  },
  {
    name: "down",
    desc: "Stop sessions from pty.toml",
    takesPath: true,
  },
  {
    name: "test",
    desc: "Run the pty test suite (vitest)",
    flags: [{ name: "t", desc: "Run matching tests" }],
    positionalValues: ["watch"],
  },
  {
    name: "remote-serve",
    desc: "Serve remote access control protocol",
    flags: [
      { name: "stdio", desc: "On-demand: serve one connection over stdio" },
      { name: "socket", desc: "Listening daemon: bind a Unix socket" },
    ],
  },
];

/** Global flags offered at the top level (before the subcommand). */
const GLOBAL_FLAGS: readonly FlagSpec[] = [
  { name: "root", desc: "Pin PTY_ROOT for this call" },
  { name: "preselect-new", desc: 'TUI: pre-select "Create new session..."' },
  { name: "filter-tag", desc: "TUI: filter to k=v (repeatable)" },
];

/** Every spelling (name + aliases) of every top-level subcommand. */
const allCommandNames = (): readonly string[] =>
  COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]);

// ─── fish ──────────────────────────────────────────────────────────────────

/** All name spellings of a command, space-joined, for fish guards. */
const fishNames = (c: CommandSpec): string =>
  [c.name, ...(c.aliases ?? [])].join(" ");

/** Single-quote a string for fish (fish only special-cases `'` and `\`). */
function q(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function fishScript(): string {
  const out: string[] = [];
  out.push("# fish completions for pty — generated by `pty completions fish`.");
  out.push(
    "# Regenerate with: pty completions fish > completions/pty.fish",
  );
  out.push("# (kept in sync with src/cli.ts; see src/completions.ts)");
  out.push("");
  out.push("function __pty_root");
  out.push("    if set -q PTY_ROOT");
  out.push("        echo $PTY_ROOT");
  out.push("    else if set -q PTY_SESSION_DIR");
  out.push("        echo $PTY_SESSION_DIR");
  out.push("    else");
  out.push("        echo \"$HOME/.local/state/pty\"");
  out.push("    end");
  out.push("end");
  out.push("");
  out.push("function __pty_sessions");
  out.push("    set -l dir (__pty_root)");
  out.push("    if test -d \"$dir\"");
  out.push("        for f in $dir/*.json");
  out.push("            if test -f \"$f\"");
  out.push("                basename $f .json");
  out.push("            end");
  out.push("        end");
  out.push("    end");
  out.push("end");
  out.push("");
  out.push("function __pty_needs_command");
  out.push("    set -l cmd (commandline -opc)");
  out.push("    test (count $cmd) -eq 1");
  out.push("end");
  out.push("");
  out.push("function __pty_using_command");
  out.push("    set -l cmd (commandline -opc)");
  out.push("    test (count $cmd) -ge 2; and test \"$cmd[2]\" = \"$argv[1]\"");
  out.push("end");
  out.push("");
  out.push("function __pty_needs_subcommand");
  out.push("    set -l cmd (commandline -opc)");
  out.push("    test (count $cmd) -eq 2; and test \"$cmd[2]\" = \"$argv[1]\"");
  out.push("end");
  out.push("");
  out.push("function __pty_using_subcommand");
  out.push("    set -l cmd (commandline -opc)");
  out.push("    test (count $cmd) -ge 3; and test \"$cmd[2]\" = \"$argv[1]\"; and test \"$cmd[3]\" = \"$argv[2]\"");
  out.push("end");
  out.push("");
  out.push("complete -c pty -f");
  out.push("");
  out.push("# ── Global flags ───────────────────────────────────────────────────────");
  for (const f of GLOBAL_FLAGS) {
    const short = f.short ? ` -s ${f.short}` : "";
    out.push(
      `complete -c pty -n __pty_needs_command -l ${f.name} -x${short} -d ${q(f.desc)}`,
    );
  }
  out.push("");
  out.push("# ── Subcommands ────────────────────────────────────────────────────────");
  for (const c of COMMANDS) {
    for (const name of [c.name, ...(c.aliases ?? [])]) {
      out.push(
        `complete -c pty -n __pty_needs_command -a ${name} -d ${q(c.desc)}`,
      );
    }
  }

  for (const c of COMMANDS) {
    const guard = `__pty_using_command ${fishNames(c)}`;
    // Flags.
    for (const f of c.flags ?? []) {
      const short = f.short ? ` -s ${f.short}` : "";
      if (f.argument?._tag === "choices") {
        out.push(
          `complete -c pty -n ${q(guard)} -l ${f.name}${short} -x -a ${q(f.argument.values.join(" "))} -d ${q(f.desc)}`,
        );
      } else if (f.argument?._tag === "free") {
        out.push(
          `complete -c pty -n ${q(guard)} -l ${f.name}${short} -x -d ${q(f.desc)}`,
        );
      } else {
        out.push(
          `complete -c pty -n ${q(guard)} -l ${f.name}${short} -d ${q(f.desc)}`,
        );
      }
    }
    for (const subcommand of c.subcommands ?? []) {
      out.push(
        `complete -c pty -n ${q(`__pty_needs_subcommand ${c.name}`)} -a ${subcommand.name} -d ${q(subcommand.desc)}`,
      );
      const leafGuard = `__pty_using_subcommand ${c.name} ${subcommand.name}`;
      for (const f of subcommand.flags ?? []) {
        const short = f.short ? ` -s ${f.short}` : "";
        if (f.argument?._tag === "choices") {
          out.push(
            `complete -c pty -n ${q(leafGuard)} -l ${f.name}${short} -x -a ${q(f.argument.values.join(" "))} -d ${q(f.desc)}`,
          );
        } else if (f.argument?._tag === "free") {
          out.push(
            `complete -c pty -n ${q(leafGuard)} -l ${f.name}${short} -x -d ${q(f.desc)}`,
          );
        } else {
          out.push(
            `complete -c pty -n ${q(leafGuard)} -l ${f.name}${short} -d ${q(f.desc)}`,
          );
        }
      }
    }
    // Dynamic session positional.
    if (c.dynamic === "sessions") {
      out.push(
        `complete -c pty -n ${q(guard)} -a '(__pty_sessions)' -d 'Session'`,
      );
    }
    // Path positional.
    if (c.takesPath) {
      out.push(`complete -c pty -n ${q(guard)} -F`);
    }
    // Enum positional.
    if (c.positionalValues) {
      out.push(
        `complete -c pty -n ${q(guard)} -x -a ${q(c.positionalValues.join(" "))} -d ${q("Value")}`,
      );
    }
  }

  return out.join("\n") + "\n";
}

// ─── bash ────────────────────────────────────────────────────────────────────
//
// A flat completer using the same dynamic session-name provider as the legacy
// file. Behavioral parity with fish is a non-goal (the task requires fish
// behaviorally); this gives useful subcommand + flag + live-session completion
// and is syntactically sourceable.

function bashScript(): string {
  const tops = allCommandNames().join(" ");
  const lines: string[] = [];
  lines.push("# bash completion for pty — generated by `pty completions bash`.");
  lines.push("# Regenerate with: pty completions bash > completions/pty.bash");
  lines.push("_pty() {");
  lines.push("  local cur prev commands");
  lines.push("  COMPREPLY=()");
  lines.push('  cur="${COMP_WORDS[COMP_CWORD]}"');
  lines.push('  prev="${COMP_WORDS[COMP_CWORD-1]}"');
  lines.push(`  commands="${tops}"`);
  lines.push("");
  lines.push("  if [[ ${COMP_CWORD} -eq 1 ]]; then");
  lines.push('    if [[ "${cur}" == -* ]]; then');
  lines.push(
    `      COMPREPLY=($(compgen -W "${GLOBAL_FLAGS.map((f) => `--${f.name}`).join(" ")}" -- "\${cur}"))`,
  );
  lines.push("    else");
  lines.push('      COMPREPLY=($(compgen -W "${commands}" -- "${cur}"))');
  lines.push("    fi");
  lines.push("    return");
  lines.push("  fi");
  lines.push("");
  lines.push('  local root="${PTY_ROOT:-${PTY_SESSION_DIR:-${HOME}/.local/state/pty}}"');
  lines.push('  local names=""');
  lines.push('  if [[ -d "${root}" ]]; then');
  lines.push('    names=$(ls "${root}"/*.json 2>/dev/null | xargs -I{} basename {} .json)');
  lines.push("  fi");
  lines.push("");
  lines.push('  case "${COMP_WORDS[1]}" in');
  for (const c of COMMANDS) {
    const names = [c.name, ...(c.aliases ?? [])].join("|");
    const flagWords = (c.flags ?? [])
      .map((f) => (f.short ? `-${f.short} --${f.name}` : `--${f.name}`))
      .join(" ");
    const takesSessions = c.dynamic === "sessions";
    const takesPath = c.takesPath;
    const guard = `    ${names})`;
    if (c.subcommands) {
      lines.push(guard);
      lines.push("      if [[ ${COMP_CWORD} -eq 2 ]]; then");
      lines.push(
        `        COMPREPLY=($(compgen -W "${c.subcommands.map((subcommand) => subcommand.name).join(" ")}" -- "\${cur}"))`,
      );
      lines.push("        return");
      lines.push("      fi");
      lines.push('      case "${COMP_WORDS[2]}" in');
      for (const subcommand of c.subcommands) {
        const leafFlags = subcommand.flags ?? [];
        const leafFlagWords = leafFlags
          .map((f) => (f.short ? `-${f.short} --${f.name}` : `--${f.name}`))
          .join(" ");
        lines.push(`        ${subcommand.name})`);
        for (const f of leafFlags) {
          if (!f.argument) continue;
          const spellings = [f.short ? `-${f.short}` : null, `--${f.name}`].filter(Boolean);
          const condition = spellings.map((spelling) => `"\${prev}" == "${spelling}"`).join(" || ");
          lines.push(`          if [[ ${condition} ]]; then`);
          if (f.argument._tag === "choices") {
            lines.push(
              `            COMPREPLY=($(compgen -W "${f.argument.values.join(" ")}" -- "\${cur}"))`,
            );
          }
          lines.push("            return");
          lines.push("          fi");
        }
        lines.push("          if [[ \"${cur}\" == -* ]]; then");
        lines.push(
          `            COMPREPLY=($(compgen -W "${leafFlagWords}" -- "\${cur}"))`,
        );
        lines.push("          fi");
        lines.push("          ;;");
      }
      lines.push("      esac");
      lines.push("      ;;");
    } else if (takesSessions) {
      lines.push(guard);
      for (const f of c.flags ?? []) {
        if (!f.argument) continue;
        const spellings = [f.short ? `-${f.short}` : null, `--${f.name}`].filter(Boolean);
        const condition = spellings.map((spelling) => `"\${prev}" == "${spelling}"`).join(" || ");
        lines.push(`      if [[ ${condition} ]]; then`);
        if (f.argument._tag === "choices") {
          lines.push(
            `        COMPREPLY=($(compgen -W "${f.argument.values.join(" ")}" -- "\${cur}"))`,
          );
        }
        lines.push("        return");
        lines.push("      fi");
      }
      lines.push("      if [[ \"${cur}\" == -* ]]; then");
      lines.push(
        `        COMPREPLY=($(compgen -W "${flagWords}" -- "\${cur}"))`,
      );
      lines.push("      else");
      lines.push('        COMPREPLY=($(compgen -W "${names}" -- "${cur}"))');
      lines.push("      fi");
      lines.push("      ;;");
    } else if (takesPath) {
      lines.push(guard);
      lines.push("      COMPREPLY=($(compgen -o dirnames -- \"${cur}\"))");
      lines.push("      ;;");
    } else if (flagWords) {
      lines.push(guard);
      lines.push(
        `      COMPREPLY=($(compgen -W "${flagWords}" -- "\${cur}"))`,
      );
      lines.push("      ;;");
    } else {
      lines.push(`${guard} ;;`);
    }
  }
  lines.push("  esac");
  lines.push("}");
  lines.push("complete -F _pty pty");
  return lines.join("\n") + "\n";
}

// ─── zsh ─────────────────────────────────────────────────────────────────────
//
// A `#compdef`-style function with the same dynamic session provider. Like
// bash, behavioral parity with fish is a non-goal — useful completion +
// sourceable (`zsh -n`).

function zshScript(): string {
  const lines: string[] = [];
  lines.push("#compdef pty");
  lines.push("# zsh completion for pty — generated by `pty completions zsh`.");
  lines.push("# Regenerate with: pty completions zsh > completions/pty.zsh");
  lines.push("_pty() {");
  lines.push('  local root="${PTY_ROOT:-${PTY_SESSION_DIR:-${HOME}/.local/state/pty}}"');
  lines.push("");
  lines.push("  _pty_sessions() {");
  lines.push("    local -a sessions");
  lines.push('    if [[ -d "${root}" ]]; then');
  lines.push("      sessions=(${root}/*.json(N:t:r))");
  lines.push("    fi");
  lines.push("    _describe 'session' sessions");
  lines.push("  }");
  lines.push("");
  lines.push("  local -a commands");
  lines.push("  commands=(");
  for (const c of COMMANDS) {
    lines.push(`    '${c.name}:${c.desc}'`);
    for (const a of c.aliases ?? []) {
      lines.push(`    '${a}:Alias for ${c.name}'`);
    }
  }
  lines.push("  )");
  lines.push("");
  lines.push("  _arguments -C \\");
  for (const f of GLOBAL_FLAGS) {
    lines.push(`    '(--${f.name})--${f.name}[${f.desc}]:path:_directories' \\`);
  }
  lines.push("    '1:command:->command' \\");
  lines.push("    '*::arg:->args'");
  lines.push("");
  lines.push("  case $state in");
  lines.push("    command)");
  lines.push("      _describe 'command' commands");
  lines.push("      ;;");
  lines.push("    args)");
  lines.push("      case ${words[1]} in");
  for (const c of COMMANDS) {
    const names = [c.name, ...(c.aliases ?? [])].join("|");
    lines.push(`        ${names})`);
    if (c.subcommands) {
      lines.push("          if (( CURRENT == 3 )); then");
      lines.push(
        `            _values 'operation' ${c.subcommands.map((subcommand) => subcommand.name).join(" ")}`,
      );
      lines.push("          else");
      lines.push("            case ${words[2]} in");
      for (const subcommand of c.subcommands) {
        lines.push(`              ${subcommand.name})`);
        const specs = (subcommand.flags ?? []).map((f) => {
          const opt = f.short
            ? `(${f.short} --${f.name}){${f.short},--${f.name}}`
            : `--${f.name}`;
          const argument = f.argument?._tag === "choices"
            ? `:${f.argument.name}:(${f.argument.values.join(" ")})`
            : f.argument?._tag === "free"
              ? `:${f.argument.name}:`
              : "";
          return `'${opt}[${f.desc}]${argument}'`;
        });
        lines.push("                _arguments \\");
        specs.forEach((spec, index) => {
          lines.push(`                  ${spec}${index === specs.length - 1 ? "" : " \\"}`);
        });
        lines.push("                ;;");
      }
      lines.push("            esac");
      lines.push("          fi");
      lines.push("          ;;");
      continue;
    }
    const specs: string[] = [];
    for (const f of c.flags ?? []) {
      const opt = f.short
        ? `(${f.short} --${f.name}){${f.short},--${f.name}}`
        : `--${f.name}`;
      const argument = f.argument?._tag === "choices"
        ? `:${f.argument.name}:(${f.argument.values.join(" ")})`
        : f.argument?._tag === "free"
          ? `:${f.argument.name}:`
          : "";
      specs.push(`'${opt}[${f.desc}]${argument}'`);
    }
    if (c.dynamic === "sessions") specs.push("'1:session:_pty_sessions'");
    if (c.takesPath) specs.push("'1:directory:_directories'");
    if (c.positionalValues)
      specs.push(`'1:mode:(${c.positionalValues.join(" ")})'`);
    if (specs.length > 0) {
      lines.push("          _arguments \\");
      lines.push("            " + specs.join(" \\\n            "));
    }
    lines.push("          ;;");
  }
  lines.push("      esac");
  lines.push("      ;;");
  lines.push("  esac");
  lines.push("}");
  lines.push("");
  lines.push("_pty \"$@\"");
  return lines.join("\n") + "\n";
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

const GENERATORS: Record<string, () => string> = {
  fish: fishScript,
  bash: bashScript,
  zsh: zshScript,
};

const SHELLS = Object.keys(GENERATORS);

function usageText(): string {
  return (
    "usage: pty completions <shell>\n\n" +
    "Print a shell completion script to stdout.\n\n" +
    "Shells:\n" +
    SHELLS.map((s) => `  ${s}`).join("\n") +
    "\n\nExamples:\n" +
    "  pty completions fish > ~/.config/fish/completions/pty.fish\n" +
    "  pty completions bash > /etc/bash_completion.d/pty\n" +
    '  pty completions zsh  > "${fpath[1]}/_pty"\n'
  );
}

/**
 * `pty completions <shell>` — write a completion script for `shell` to stdout.
 * Unknown or missing shell prints usage to stderr and returns 2 (the CLI's
 * usage-error code). `--help`/`-h` prints usage to stdout and returns 0.
 */
export function cmdCompletions(args: readonly string[]): number {
  const shell = args[0];
  if (shell === "--help" || shell === "-h") {
    console.log(usageText());
    return 0;
  }
  if (shell === undefined) {
    console.error(usageText());
    return 2;
  }
  const gen = GENERATORS[shell];
  if (gen === undefined) {
    console.error(`pty completions: unknown shell: ${shell}\n`);
    console.error(usageText());
    return 2;
  }
  process.stdout.write(gen());
  return 0;
}

// Exposed for tests.
export { COMMANDS, SHELLS, fishScript, bashScript, zshScript };
