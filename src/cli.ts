import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { spawnSync, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { attach, peek, send, queryStats, resolveSeqDelayMs, validateAttachStreamFdV1, type StatsResult,
  isSessionAlive,
} from "./client.ts";
import { plainLabel, renderLabel, renderTags, shortPath, strategyMarker } from "./session-presentation.ts";
import { printVersion } from "./version.ts";
import { parseSeqValue } from "./keys.ts";
import {
  listSessions,
  getSession,
  getSessionByName,
  gc,
  pruneOrphanLayoutTags,
  isGone,
  cleanupAll,
  cleanupAllWhileLocked,
  cleanupSocket,
  cleanupOwnedAll,
  waitForProcessExit,
  validateName,
  validateDisplayName,
  acquireLock,
  acquireRecoveryLock,
  isLockOwnedByPid,
  releaseLock,
  releaseRecoveryLock,
  updateTags,
  setDisplayName,
  patchMetadataById,
  getSessionExitEvidence,
  removeSessionGeneration,
  mutateMetadataUnderLock,
  allSessionNames,
  readMetadata,
  readSessionPid,
  writeMetadata,
  atomicWriteFileSync,
  getSessionDir,
  getSocketPath,
  getPidPath,
  getMetadataPath,
  DEFAULT_SESSION_DIR,
  hasProcessExitedForReap,
  DEFAULT_KEEP_MAX_AGE_MS,
  type SessionInfo,
  type SessionMetadata,
} from "./sessions.ts";
import { snapshotDescendantProcesses } from "./process-tree.ts";
import { aftermathOf, allGone, killOutcomeLines, verifiedEmpty } from "./kill-report.ts";
import {
  groupsInTree, membersOfGroups, ownProcessGroup, signalGroup, sweepGroups,
} from "./process-groups.ts";
import { openSource, valueOf } from "./proc-table.ts";
import { spawnDaemon, resolveCommand } from "./spawn.ts";
import {
  acquireEventLock, appendEventSyncLocked, EventFollower, EventWriter, EventType, releaseEventLock,
  readRecentEvents, formatEvent,
  emitUserEvent,
} from "./events.ts";
import { readPtyFile, type PtySessionDef } from "./ptyfile.ts";
import { extractFilterTags as extractFilterTagsImpl, matchesAllTags } from "./tags.ts";
import { parseDuration, formatDuration } from "./duration.ts";
import { serveRemoteControl, runRemoteServeStdio, fetchRemoteList, dialPeer, routeSocket, dialAndRoute, RouteRefusedError, PTY_REMOTE_ALPN, FABRIC_BIN, type RemoteSessionRow } from "./remote.ts";
import {
  RECOVERY_PROTOCOL,
  assertPrivateRecoveryPaths,
  atomicWritePrivate,
  readBoundedJson,
  readProcessStartToken,
  recoveryLockContents,
  recoveryLockIdentity,
  recoveryRequestPath,
  recoveryResultPath,
  signRecoveryRequest,
  verifyRecoveryResult,
  type RecoveryResult,
} from "./recovery.ts";

// Name this process so it shows up meaningfully in ps/top/htop/btm instead of
// "MainThread" (V8's default main-thread name under Node 24+). `process.title`
// is the only thing that overrides /proc/<pid>/comm, and only when set from
// within the running process after V8 init — launch flags like `node --title`
// or `exec -a` do not work. Linux truncates comm at 15 chars (TASK_COMM_LEN).
// This module is only ever an entrypoint (it calls main() on load), so setting
// the title at module scope is safe.
try { process.title = "pty"; } catch {}

// Lazy-load the interactive TUI so non-interactive commands don't crash when
// the caller's cwd was deleted (the TUI module evaluates process.cwd() at load).
async function runInteractive(options?: { preselectNew?: boolean; filterTags?: Record<string, string>; force?: boolean }): Promise<void> {
  ensureNotNested("interactive", {
    force: options?.force,
    hint:
      "  The interactive picker would render inside your current session and detach would route to the outer client.\n" +
      "  Detach first (Ctrl+\\) and run `pty` from outside, or pass --force to open the picker anyway.",
  });
  const mod = await import("./tui/interactive.ts");
  await mod.runInteractive(options);
}

/** CLI wrapper around `extractFilterTags` that exits on invalid input. */
function extractFilterTags(args: string[]): Record<string, string> {
  try {
    return extractFilterTagsImpl(args);
  } catch (e: any) {
    console.error(e.message);
    process.exit(1);
  }
}

// Per-subcommand help. `pty <cmd> --help` (or `-h`) prints the matching entry:
// usage synopsis, every flag, and at least one concrete example. Kept here as
// the single source so the deprecation/error paths and --help never drift.
// A test (tests/help.test.ts) asserts every subcommand has an entry.
const COMMAND_HELP: Record<string, string> = {
  run: `Usage: pty run [flags] -- <command> [args...]

Create a session and attach to it (use -d to leave it running in the background).

Flags:
  --id <id>            Pin the on-disk id (sock/json filename; charset-validated, ≤ 104-byte sock path)
  --name <label>       Display label (trimmed, single-line, ≤ 160 Unicode scalars)
  --no-display-name    Skip the auto cwd+command label — just the id
  -d, --detach         Create in the background; don't attach
  -a, --attach         Create, OR attach if a session with the same id already exists
  -e, --ephemeral      Force self-removal at exit even for strategy=permanent
                       (non-permanent sessions already self-remove by default)
  --tag key=value      Tag the session (repeatable)
  --env KEY=VALUE      Overlay a child environment variable (repeatable)
  --unset-env KEY      Remove an inherited environment variable (repeatable)
  --tag keep=true      Exempt from reaping: keep metadata/logs after exit
  --cwd <path>         Working directory for the command
  --isolate-env        Scrub the child env to a safe allow-list (for remote-reachable sessions)
  --force              Create even from inside another pty session (bypass the nesting guard)

Examples:
  pty run -- node server.js
  pty run -d --name "API" --tag role=web --env PORT=3000 -- node server.js`,

  attach: `Usage: pty attach [-r|--no-restart] [--force] [--remote <peer>] [--attach-stream-fd-v1 <fd>] <ref>

Reconnect to a session (alias: pty a). Detach again with Ctrl+\\.

Flags:
  -r, --auto-restart   Auto-restart the session if it has exited
  --no-restart         Attach only while the session is running; never prompt
                       or execute its stored command
  --force              Attach even from inside another pty session (nested)
  --remote <peer>      Attach a session on a fabric peer (over fabric); <ref> is
                       the session's name/id ON THE REMOTE
  --attach-stream-fd-v1 <fd>
                       Machine mode for a running session. Write ordered framed
                       GEOMETRY, SCREEN, DATA, and terminal EXIT or DETACH outcome
                       to inherited fd (>= 3); keep stdin/stdout controlling TTY

Examples:
  pty attach myserver
  pty attach -r myserver
  pty attach --no-restart myserver
  pty attach --remote hetzner myshell`,

  exec: `Usage: pty exec -- <command> [args...]

Replace the current session's leaf process with a new command. Run INSIDE a
session (uses $PTY_SESSION); the session keeps its id and metadata.

Examples:
  pty exec -- codex
  pty exec -- bash -l`,

  peek: `Usage: pty peek [-f] [--plain] [--full] [--wait <text> [-t <sec>]] [--remote <peer>] <ref>

Print a session's screen (or follow it, or wait for text) without attaching.

Flags:
  --plain              Plain text, no ANSI escapes (best for scripts / agents)
  --full               Full scrollback, not just the visible viewport
  -f, --follow         Follow output read-only (Ctrl+\\ to stop)
  --wait <text>        Block until <text> appears on screen
  -t, --timeout <sec>  Timeout (seconds) for --wait
  --remote <peer>      Peek a session on a fabric peer (over fabric); <ref> is
                       the session's name/id ON THE REMOTE (--wait not yet supported)

Examples:
  pty peek --plain myserver
  pty peek --remote hetzner myserver
  pty peek --wait "Listening" -t 10 --plain myserver`,

  send: `Usage: pty send <ref> "text"
       pty send <ref> --seq <chunk> [--seq key:<name>] ...
       pty send --remote <peer> <ref> "text"

Send text or key events to a session. Raw text is sent with NO implicit newline —
to send text followed by Enter, use --seq (see the second example).

Flags:
  --seq <value>        Ordered chunk or key event (repeatable). key:<name> sends a
                       key, e.g. key:return, key:ctrl+c, key:ctrl-c, key:C-c.
                       Modifiers also accept _ separators; names ignore case.
  --with-delay <sec>   Delay (seconds) between --seq items. DEFAULT 0.3s so a
                       trailing key:return doesn't race ahead of the program
                       parsing the text. --with-delay 0 = straight stream (no gap).
  --paste "<text>"     Wrap the payload in bracketed-paste markers
  --remote <peer>      Send to a session on a fabric peer (over fabric); <ref> is
                       the session's name/id ON THE REMOTE

Examples:
  pty send myserver "hello"
  pty send myserver --seq "git status" --seq key:return        # 0.3s gap by default
  pty send --remote hetzner myserver --seq "ls" --seq key:return`,

  events: `Usage: pty events [--all | <ref>] [--recent] [--json] [--wait <type> [-t <sec>]]

Follow a session's event log (bell, title, notifications, tag/rename changes, user.* events).

Flags:
  --all                Follow every session, interleaved (omit <ref>)
  --recent             Print recent events and exit (don't follow)
  --json               Emit raw JSONL
  --wait <type>        Block until an event of <type> appears
  -t, --timeout <sec>  Timeout (seconds) for --wait

Examples:
  pty events myserver
  pty events --recent --json myserver`,

  list: `Usage: pty list [--json] [--tags] [--filter-tag k=v] [--remote [<peer>]] [--status <s>] [--summary]

List sessions (alias: pty ls). User tags show by default.

Flags:
  --json               Emit JSON
  --tags               Include internal bookkeeping tags (ptyfile*, strategy.*)
  --filter-tag k=v     Only sessions with the tag (repeatable, ALL must match)
  --remote <peer>      Also list a fabric peer's sessions (over fabric; the peer
                       runs 'pty remote-serve' exposed as 'fabric expose pty-remote')
  --remote             Bare (no peer): include pty-relay hosts (when installed)
  --status <state>     Filter by status: running | exited | vanished
  --older-than <dur>   Only sessions older than a duration (e.g. 30m, 2h, 3d)
  --newer-than <dur>   Only sessions newer than a duration
  --summary            Print a one-line count summary instead of the list

Examples:
  pty list
  pty list --remote hetzner
  pty list --filter-tag role=web --json`,

  "remote-serve": `Usage: pty remote-serve (--stdio | --socket <path>)

Serve the remote-access control protocol so a fabric peer can expose pty and
other machines can 'pty <cmd> --remote <this-peer>'. Reads sessions from the
ambient PTY_ROOT — run it in the same env the sessions use. Two forms:

  --stdio            On-demand: serve ONE connection over stdin/stdout, then exit.
                     fabric spawns it per dial and owns accept + persistence +
                     roaming (a drop/reconnect reuses the SAME process). No
                     persistent pty daemon. The recommended fabric form.
  --socket <path>    Listening daemon: bind a Unix socket for a fabric peer to
                     expose. Pick a path OUTSIDE PTY_ROOT (a control socket inside
                     it is mis-scanned as a phantom session). Run it WRAPPED —
                     'setsid sh -c "…"', systemd, launchd — so pty is a CHILD of
                     the session leader (exec'd as a bare session leader without a
                     TTY it can exit on detach). Being retired in favor of --stdio.

Flags:
  PTY_REMOTE_SERVE_DEBUG=1   Env: log signal/exit/exception lifecycle to stderr

Examples:
  fabric expose pty-remote --exec -- pty remote-serve --stdio   # on-demand (recommended)
  pty remote-serve --socket ~/.local/state/pty-remote.sock      # listening daemon
  setsid sh -c 'pty remote-serve --socket ~/.local/state/pty-remote.sock' </dev/null &   # wrapped
  fabric expose pty-remote --socket ~/.local/state/pty-remote.sock   # expose the listening form`,

  stats: `Usage: pty stats [--json] [--all] [<ref>]

Live CPU / memory / PIDs. Omit <ref> for every session.

Flags:
  --json               Emit stats as JSON (one snapshot)
  --all                Include every session (with an explicit <ref> given)

Examples:
  pty stats
  pty stats --json myserver`,

  restart: `Usage: pty restart [-y] [--force] <ref>

SIGTERM the session's daemon and respawn it from stored metadata (command, cwd,
tags, displayName). Prompts first if it's still running.

Flags:
  -y, --yes            Skip the "kill and restart?" prompt
  --force              Attach after restart even from inside another pty session

Examples:
  pty restart myserver
  pty restart -y myserver`,

  kill: `Usage: pty kill <ref>

Terminate a running session's daemon and exact descendant tree. Metadata is kept —
restart or \`pty rm\` it later.

The daemon tears the tree down on its way out, which races its own exit. So once
the daemon has gone, \`pty kill\` re-reads the process table, signals any process
group the session left behind, and reports what is still there. It exits non-zero
unless it verified the tree is empty.

A descendant that calls setsid leaves the session and the group, and neither the
tree walk nor the group sweep can reach it.

Examples:
  pty kill myserver`,

  recover: `Usage: pty recover <name> --snapshot <metadata.json>

Ask the original supporting daemon to republish an externally unlinked socket
and registry without signaling or restarting its PTY child.

The snapshot must have been captured from the same selected PTY_ROOT before
the registry was unlinked and must advertise a recovery capability.

Example:
  pty --root /state/pty recover myserver --snapshot ./myserver.json`,

  rm: `Usage: pty rm <ref>

Remove an exited session's files (socket/pid/json/events) (alias: pty remove).
Won't remove a running session — kill it first.

Examples:
  pty rm myserver`,

  gc: `Usage: pty gc [-n] [--idle-days N] [--keep-max-age <dur>] [--fast-fail-window=N] [--fast-fail-limit=N]
       pty gc --print-launchd-plist [--interval=N]

One reconciliation pass: sweep exited/vanished, orphan-kill \`parent=<name>\` children,
reap abandoned permanents, respawn \`strategy=permanent\` sessions.

Non-permanent sessions remove themselves as they exit, so the sweep is a backstop:
it mainly catches \`vanished\` sessions, whose daemon was killed outright and so
never ran its own cleanup. A session tagged \`keep\` is swept only once it has been
dead longer than --keep-max-age; running sessions are never swept.

Flags:
  -n, --dry-run           Preview without changing anything
  --idle-days N           Also reap permanents with no attach in N days
  --keep-max-age <dur>    How long \`keep\` holds a DEAD session against the sweep
                          (default 7d; 0 sweeps every dead keep session now)
  --fast-fail-window=N    Fast-fail window seconds (default 60; per-session tag wins)
  --fast-fail-limit=N     Consecutive fast fails before flapping (default 3; per-session tag wins)
  --print-launchd-plist   Print a macOS launchd plist that runs 'pty gc' on an interval
  --interval=N            Plist StartInterval seconds (default 30)

Examples:
  pty gc --dry-run
  pty gc --keep-max-age 0
  pty gc --print-launchd-plist > ~/Library/LaunchAgents/com.compoundingtech.pty.gc.plist`,

  tag: `Usage: pty tag <ref>                           Show tags
       pty tag <ref> key=value [key=value...]   Set tags
       pty tag <ref> --rm key [--rm key...]     Remove tags

Read or write tags on one session. Updates apply before removals.

Flags:
  --rm <key>           Remove a tag key (repeatable)

Examples:
  pty tag myserver role=web env=prod
  pty tag myserver --rm env`,

  "tag-multi": `Usage: pty tag-multi <selector> [ops...]

Bulk read / write tags across many sessions.
  Selector (one of): --all | --filter-tag k=v (repeatable) | <ref>...
  Ops (any of):      key=value | --rm key

Flags:
  --all                Select every session
  --filter-tag k=v     Select sessions with the tag (repeatable)
  --rm <key>           Remove a tag key (repeatable)
  --json               Read mode: emit tags as JSON
  -y, --yes            Required to write when the selector is --all

Examples:
  pty tag-multi --filter-tag role=web env=prod
  pty tag-multi --all --json`,

  emit: `Usage: pty emit <type> [--json <payload>] [--text <string>]
       pty emit <ref> <type> [--json <payload>] [--text <string>]

Publish a user.* event to a session's event log. Inside a session the ref
defaults to $PTY_SESSION. Types must start with "user." — "session_*", "state.*",
"bell", etc. are reserved.

Flags:
  --json <payload>     Attach a JSON payload
  --text <string>     Attach a text payload

Examples:
  pty emit user.build-done
  pty emit user.progress --json '{"pct": 40}'
  pty emit myserver user.tests-passed --json '{"n": 42}'`,

  rename: `Usage: pty rename <new-display-name>          Inside a session: set displayName
       pty rename <ref> <new-display-name>    Outside: set displayName on <ref>
       pty rename --show <ref>                Show the current displayName
       pty rename --clear [ref]               Clear the displayName

displayName is a mutable, non-unique label; the session's stable id (name) never changes.
An ambiguous displayName must be replaced with one of the reported stable ids.

Examples:
  pty rename my-friendly-name
  pty rename webapp "Web Frontend"
  pty rename --show webapp`,

  metadata: `Usage: pty metadata patch --id <stable-id>

Atomically merge displayName and tags for one exact stable session id. Reads
one JSON object from stdin; it never resolves display-name aliases.

Patch fields:
  displayName   string to set, null to clear, omitted to preserve
  tags          object of string values to set and null values to remove

Examples:
  pty metadata patch --id a1b2c3d4 < patch.json
  printf '%s' '{"displayName":"Worker","tags":{"role":"worker"}}' | pty metadata patch --id a1b2c3d4
  printf '%s' '{"displayName":null,"tags":{"temporary":null}}' | pty metadata patch --id a1b2c3d4`,

  evidence: `Usage: pty evidence snapshot --id <stable-id>
       pty evidence remove --id <stable-id> --expected-generation <opaque>

Read retained terminal evidence for one exact stable session generation, or
remove that generation after the caller has durably consumed the evidence.
Both operations emit exactly one tagged JSON document on stdout. Semantic
outcomes exit 0; invalid arguments and operational failures exit nonzero.

Examples:
  pty evidence snapshot --id a1b2c3d4
  pty evidence remove --id a1b2c3d4 --expected-generation 7f44b35e`,

  up: `Usage: pty up [<dir>] [<name>...]

Start sessions declared in a pty.toml. With no args, reads ./pty.toml and starts all.

Examples:
  pty up
  pty up ./backend
  pty up web worker`,

  down: `Usage: pty down [<dir>] [<name>...]

Stop sessions declared in a pty.toml.

Examples:
  pty down
  pty down web`,

  test: `Usage: pty test [watch | -t "<pattern>"]

Run the pty test suite (a thin vitest passthrough).

Examples:
  pty test
  pty test -t "peek"`,
};

const EVIDENCE_LEAF_HELP = {
  snapshot: `Usage: pty evidence snapshot --id <stable-id>

Emit one tagged JSON snapshot of retained terminal evidence for the exact
stable session id.

Example:
  pty evidence snapshot --id a1b2c3d4`,
  remove: `Usage: pty evidence remove --id <stable-id> --expected-generation <opaque>

Remove one terminal session only when it still carries the opaque generation
returned by an earlier snapshot. Emits one tagged JSON result.

Example:
  pty evidence remove --id a1b2c3d4 --expected-generation 7f44b35e`,
} as const;

/** Print a subcommand's focused help. Resolves aliases; returns false for an
 *  unknown command so the caller can fall through. */
function printCommandHelp(cmd: string): boolean {
  const canonical = ({ a: "attach", ls: "list", remove: "rm" } as Record<string, string>)[cmd] ?? cmd;
  const help = COMMAND_HELP[canonical];
  if (!help) return false;
  console.log(help);
  return true;
}

function usage(): void {
  console.log(`Usage:
  pty                                     Interactive session manager (fullscreen TUI)
  pty --preselect-new                     Open the TUI with "Create new session..." pre-selected
  pty --filter-tag key=value              Filter the TUI to sessions matching the tag (repeatable);
                                          new sessions inherit the tag

Create sessions:
  pty run -- <command> [args...]          Create a session and attach (random id + auto display label)
  pty run --id <id> -- <command>          Pin the on-disk id (sock / json filename; charset-validated)
  pty run --name <label> -- <command>     Set a trimmed, single-line display label (≤ 160 Unicode scalars)
  pty run --no-display-name -- <cmd>      Skip the friendly cwd+command label (just an id)
  pty run -d -- <command>                 Create in the background (detached)
  pty run -a -- <command>                 Create OR attach if a session with the same id already exists
  pty run -e -- <command>                 Ephemeral: auto-remove metadata on clean exit
  pty run --tag key=value -- <command>    Tag a session (repeatable)
  pty run --env KEY=VALUE -- <command>    Overlay child environment (repeatable; persisted for restart)
  pty run --unset-env KEY -- <command>    Remove inherited environment (repeatable; persisted for restart)
  pty run --cwd /path -- <command>        Run in a specific directory
  pty run --isolate-env -- <command>      Scrub the child env to a safe allow-list
                                          (intended for remote-reachable sessions)
  pty run --force -- <command>            Create even from inside another pty session (nested)

Attach & interact:
  pty attach <ref>                        Attach to an existing session (alias: pty a)
  pty attach --force <ref>                Attach even from inside another pty session (nested)
  pty attach -r <ref>                     Attach, auto-restart if the session is exited
  pty attach --no-restart <ref>            Attach only; fail if the session is not running
  pty attach --remote <peer> <ref>        Attach a session on a fabric peer (over fabric)
  pty exec -- <command> [args...]         Replace the current session's process (inside a session)
  pty send <ref> "text"                   Send raw text (no implicit newline)
  pty send <ref> --seq "text" --seq key:return   Send an ordered sequence of chunks / key events
                                          (0.3s gap between items by default)
  pty send <ref> --with-delay <sec> --seq ...    Override the gap; --with-delay 0 = straight stream
  pty send <ref> --paste "<big text>"     Wrap the payload in bracketed-paste markers
  pty send --remote <peer> <ref> "text"   Send to a session on a fabric peer (over fabric)

Observe:
  pty peek <ref>                          Print current screen and exit
  pty peek --plain <ref>                  Print current screen as plain text (no ANSI)
  pty peek --full <ref>                   Print full scrollback (not just the viewport)
  pty peek --wait "text" [-t N] <ref>     Wait until text appears (optional timeout in seconds)
  pty peek -f <ref>                       Follow output read-only (Ctrl+\\ to stop)
  pty peek --remote <peer> <ref>          Peek a session on a fabric peer (over fabric)
  pty events <ref>                        Follow events from a session
  pty events --all                        Follow events from every session, interleaved
  pty events --recent <ref>               Print recent events and exit
  pty events --json <ref>                 Emit raw JSONL
  pty stats                               Live CPU / memory / PIDs for every session
  pty stats <ref>                         Live metrics for a single session
  pty stats --json                        Emit stats as JSON (one snapshot)
  pty list                                List sessions (text; alias: pty ls)
  pty list --json                         List sessions as JSON
  pty list --tags                         Include internal bookkeeping tags (ptyfile*, strategy.*)
  pty list --filter-tag key=value         Filter to sessions with the tag (repeatable, ALL must match)
  pty list --remote <peer>                List a fabric peer's sessions (over fabric)
  pty list --remote                       Include remote sessions via pty-relay (when installed)
  pty remote-serve --stdio                Serve remote access on-demand (fabric --exec spawns it per dial)
  pty remote-serve --socket <path>        Serve remote access as a listening daemon (being retired)

Modify:
  pty metadata patch --id <id>            Atomically merge displayName/tags from JSON stdin
  pty evidence snapshot --id <id>         Read exact-generation retained exit evidence as JSON
  pty rename <label>                      Inside a session: set its displayName
  pty rename <ref> <label>                Outside: set displayName on <ref>
  pty rename --show <ref>                 Print the current displayName
  pty rename --clear [ref]                Remove the displayName
  pty tag <ref>                           Show tags on a session
  pty tag <ref> key=value [key=value...]  Set tags
  pty tag <ref> --rm key [--rm key...]    Remove tags
  pty tag-multi <selector> [ops...]       Bulk read / write tags across sessions
                                          Selector (one of): --all | --filter-tag k=v | <ref>...
                                          Ops (any of): key=value | --rm key
                                          --all + write requires --yes
  pty emit user.<type> [--json <p>] [--text <s>]     Publish a user.* event (inside a session)
  pty emit <ref> user.<type> [...]        Same, targeting a specific session

Lifecycle:
  pty restart <ref>                       SIGTERM + respawn using stored metadata (prompts if running)
  pty restart -y <ref>                    Same, no prompt
  pty kill <ref>                          Terminate a running session and its descendants
  pty recover <name> --snapshot <file>    Rebind a supporting live daemon after registry unlink
  pty rm <ref>                            Remove an exited session's metadata (alias: pty remove)
  pty evidence remove --id <id> --expected-generation <opaque>
                                          Remove only the matching terminal generation
  pty gc                                  Reconciliation pass: orphan-kill, abandoned-reap,
                                          permanent-respawn, exited-sweep
  pty gc --dry-run                        Preview without changing anything (alias: -n)
  pty gc --idle-days N                    Also reap permanents with no attach in N days
  pty gc --keep-max-age <dur>             How long a \`keep\` tag holds a DEAD session against
                                          the sweep (default 7d; 0 sweeps the backlog now)
  pty gc --fast-fail-window=N             Fast-fail window (seconds) for the respawn cap
                                          (default 60; per-session strategy.fast-fail-window wins)
  pty gc --fast-fail-limit=N              Consecutive fast fails before a permanent is flagged
                                          flapping (default 3; per-session tag wins)
  pty gc --print-launchd-plist [--interval=N]
                                          Print a launchd plist that runs 'pty gc' every N seconds
                                          (default 30); Label + logPath derived from PTY_ROOT

Multi (pty.toml):
  pty up                                  Start every session in ./pty.toml
  pty up <dir>                            Start sessions in <dir>/pty.toml
  pty up <name> [<name>...]               Start specific sessions from ./pty.toml
  pty down                                Stop every session in ./pty.toml
  pty down <dir>                          Stop sessions in <dir>/pty.toml
  pty down <name> [<name>...]             Stop specific sessions

Global:
  pty --root <path> <subcommand> [...]    Pin the state registry for this call (== PTY_ROOT env)
  pty help | pty --help | pty -h          Show this usage
  pty version | pty --version | pty -v    Print the version (<semver>+<short-sha>)
  pty test [watch | -t "pattern"]         Run the pty test suite (vitest passthrough)

Session references (<ref>): the on-disk id (validated: [A-Za-z0-9._-], ≤ 255 chars,
socket path ≤ 104 bytes), or a displayName. Stable ids always win; a displayName
resolves only when unique. Inside a session, most commands default to $PTY_SESSION
when the ref is omitted (see 'pty rename', 'pty exec', 'pty emit').

Env:
  PTY_ROOT                Registry dir (default ~/.local/state/pty). Canonical.
  PTY_SESSION_DIR         Deprecated alias for PTY_ROOT; still works, one-time notice.
  PTY_ROOT_LEGACY_SILENT  Suppress the PTY_SESSION_DIR deprecation notice.
  PTY_SESSION             Set by the daemon inside a session; drives nesting detection.

Detach from an attached session with Ctrl+\\ (press twice to send Ctrl+\\ to the child).`);
}

/** Resolve a user-supplied session reference (name OR displayName) to the
 *  stable `name`. Errors and exits if no session matches. Use this whenever
 *  a command is about to hit the socket, metadata file, or anything else
 *  keyed by the stable id — it ensures typing the displayName works the
 *  same as typing the underlying name. */
async function resolveRef(ref: string): Promise<string> {
  const session = await getSession(ref);
  if (!session) {
    console.error(`Session "${ref}" not found.`);
    process.exit(1);
  }
  return session.name;
}

/** Refuse a command that would start a nested client inside an existing
 *  pty session. Several commands (attach, restart-then-attach, the
 *  interactive picker, run -a when the target is running) silently created
 *  a client-inside-a-client, routing detach keybindings to the outer
 *  client and tangling the user up. `--force` opts back into the old
 *  behavior for the rare cases where nesting is intentional (debugging,
 *  screen-sharing demos). Prints + exits; does not return on refusal. */
function ensureNotNested(
  cmd: string,
  opts: { force?: boolean; hint?: string } = {},
): void {
  if (opts.force) return;
  const nested = process.env.PTY_SESSION;
  if (!nested) return;
  console.error(`pty ${cmd}: already inside pty session "${nested}".`);
  if (opts.hint) console.error(opts.hint);
  else console.error("  Pass --force to override.");
  process.exit(1);
}

/** Generate a short random session id. Base32 (Crockford-ish, no 0/O/1/I
 *  confusion). 8 chars = 40 bits — plenty of headroom against collisions
 *  even with thousands of sessions per machine. */
function randomSessionName(): string {
  const alphabet = "23456789abcdefghjkmnpqrstuvwxyz";
  const bytes = randomBytes(8);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

/** Generate a session name from the cwd and command. */
function autoName(cmd: string, cmdArgs: string[]): string {
  // Directory component: last part of cwd
  const dirPart = path.basename(process.cwd());

  // Command component: base name of the command + first meaningful arg
  const cmdBase = path.basename(cmd);
  const firstArg = cmdArgs.find(a => !a.startsWith("-") && a.length < 30);
  let cmdPart = cmdBase;
  if (firstArg) {
    // Strip extension and path, keep only alphanumeric/dash/dot
    const argBase = path.basename(firstArg).replace(/\.[^.]+$/, "");
    if (argBase && /^[a-zA-Z0-9._-]+$/.test(argBase)) {
      cmdPart = `${cmdBase}-${argBase}`;
    }
  }

  return `${dirPart}-${cmdPart}`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Global --root <path>: pin the state registry for this invocation.
  // Consumed here so every subcommand transparently scopes via
  // getSessionDir(). Equivalent to PTY_ROOT=<path> for one call.
  // Scanned across the full argv because no subcommand uses --root.
  const rootIdx = args.indexOf("--root");
  if (rootIdx !== -1) {
    const val = args[rootIdx + 1];
    if (!val || val.startsWith("-")) {
      console.error("pty: --root requires a path (e.g. pty --root /var/lib/pty-eval list)");
      process.exit(1);
    }
    process.env.PTY_ROOT = val;
    args.splice(rootIdx, 2);
  }

  // Fail-loud backstop for the sockaddr_un.sun_path 104-byte kernel limit.
  // `validateName()` already catches a too-long root at spawn time by
  // computing the full socket path, but its error message reads as if
  // the name were the problem, and it fires per-invocation only when a
  // spawn happens. This check catches the pathological deep-PTY_ROOT
  // case at startup — before any subcommand runs — and points the
  // finger at the root, not the name.
  //
  // Threshold: an 8-char random session id (the default `pty run`
  // shape) produces a socket suffix of `/xxxxxxxx.sock` = 14 bytes.
  // A root whose length + 14 exceeds 104 can't host a default-id
  // session and is unusable. Callers who intentionally want tiny
  // 1-char names on a nearly-full root can side-step by shortening
  // the root; there's no correct behavior for a genuinely-too-long
  // root, so we fail rather than limp.
  const resolvedRoot = process.env.PTY_ROOT ?? process.env.PTY_SESSION_DIR;
  if (resolvedRoot && resolvedRoot.length > 0) {
    const SUN_PATH_MAX = 104;
    const SOCK_SUFFIX_BYTES = "/".length + 8 + ".sock".length;
    const rootBytes = Buffer.byteLength(resolvedRoot, "utf-8");
    if (rootBytes + SOCK_SUFFIX_BYTES > SUN_PATH_MAX) {
      const usable = SUN_PATH_MAX - SOCK_SUFFIX_BYTES;
      console.error(
        `pty: PTY_ROOT is too long — ${rootBytes} bytes; must be ≤ ${usable} bytes for the socket path to fit the ${SUN_PATH_MAX}-byte kernel limit.\n` +
        `  root: ${resolvedRoot}\n` +
        `  Shorten the root (or use \`pty --root <shorter-path>\` for a one-off).`
      );
      process.exit(1);
    }
  }

  // Interactive-mode flags (--preselect-new, --filter-tag) can appear before
  // the subcommand. Peek at the subcommand without consuming flags; if it's
  // the interactive TUI (none, "i", or "interactive"), consume those flags
  // here. Otherwise leave them in args for the subcommand to parse itself.
  //
  // Detect the subcommand: first positional that isn't a flag or a value for
  // a known flag that takes a value (currently just --filter-tag).
  let subcommand = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--filter-tag") { i++; continue; }
    if (a.startsWith("-")) continue;
    subcommand = a;
    break;
  }

  let preselectNew = false;
  let interactiveFilterTags: Record<string, string> = {};
  let interactiveForce = false;
  if (!subcommand || subcommand === "i" || subcommand === "interactive") {
    preselectNew = args.includes("--preselect-new");
    interactiveForce = args.includes("--force");
    interactiveFilterTags = extractFilterTags(args);
  }
  const dispatchArgs = args.filter((a) => a !== "--preselect-new" && a !== "--force");

  if (dispatchArgs.length === 0) {
    await runInteractive({ preselectNew, filterTags: interactiveFilterTags, force: interactiveForce });
    return;
  }

  const command = dispatchArgs[0];

  // A subcommand's own `--help` / `-h` (in the first position after the command)
  // prints that command's focused help and exits 0. `--root <path>` is already
  // spliced out of `args` above, so `args[1]` is the token after the subcommand.
  // First-position only, so `pty send <ref> --help` still sends "--help" as text.
  if ((args[1] === "-h" || args[1] === "--help") && printCommandHelp(command)) {
    return;
  }

  switch (command) {
    case "interactive":
    case "i": {
      await runInteractive({ preselectNew, filterTags: interactiveFilterTags, force: interactiveForce });
      break;
    }

    case "run": {
      // Parse flags before the -- separator. The flag model:
      //   --id <id>     explicit on-disk id (sock/json filename). Validated:
      //                 charset, sock-path length, no existing-ref collision.
      //   --name <dn>   explicit display label (arbitrary length / chars,
      //                 within the permissive validateDisplayName rules).
      //                 Replaces the auto-generated cwd+cmd label.
      //   --no-display-name  skip displayName entirely.
      //   Both omitted → random short id + auto-generated displayName.
      let detach = false;
      let attachExisting = false;
      let ephemeral = false;
      let isolateEnv = false;
      let noDisplayName = false;
      let force = false;
      let explicitId: string | null = null;
      let explicitDisplayName: string | null = null;
      let cwd: string | null = null;
      const tags: Record<string, string> = {};
      const extraEnv: Record<string, string> = {};
      const unsetEnv: string[] = [];
      let i = 1;
      while (i < args.length && args[i] !== "--") {
        if (args[i] === "-d" || args[i] === "--detach") { detach = true; i++; }
        else if (args[i] === "-a" || args[i] === "--attach") { attachExisting = true; i++; }
        else if (args[i] === "-e" || args[i] === "--ephemeral") { ephemeral = true; i++; }
        else if (args[i] === "--isolate-env") { isolateEnv = true; i++; }
        else if (args[i] === "--no-display-name") { noDisplayName = true; i++; }
        else if (args[i] === "--force") { force = true; i++; }
        else if (args[i] === "--id" && i + 1 < args.length) { explicitId = args[i + 1]; i += 2; }
        else if (args[i] === "--name" && i + 1 < args.length) { explicitDisplayName = args[i + 1]; i += 2; }
        else if (args[i] === "--cwd" && i + 1 < args.length) { cwd = args[i + 1]; i += 2; }
        else if (args[i] === "--tag" && i + 1 < args.length) {
          const eq = args[i + 1].indexOf("=");
          if (eq === -1) {
            console.error(`Invalid tag format: "${args[i + 1]}". Use --tag key=value`);
            process.exit(1);
          }
          tags[args[i + 1].slice(0, eq)] = args[i + 1].slice(eq + 1);
          i += 2;
        }
        else if (args[i] === "--env" && i + 1 < args.length) {
          const assignment = args[i + 1];
          const eq = assignment.indexOf("=");
          if (eq <= 0) {
            console.error(`Invalid env format: "${assignment}". Use --env KEY=VALUE`);
            process.exit(1);
          }
          extraEnv[assignment.slice(0, eq)] = assignment.slice(eq + 1);
          i += 2;
        }
        else if (args[i] === "--unset-env" && i + 1 < args.length) {
          const key = args[i + 1];
          if (key.length === 0 || key.includes("=")) {
            console.error(`Invalid env key: "${key}". Use --unset-env KEY`);
            process.exit(1);
          }
          if (!unsetEnv.includes(key)) unsetEnv.push(key);
          i += 2;
        }
        else break;
        // Note: unknown flags or positional args before -- break the loop
      }

      // Everything after -- is the command
      const dashDash = args.indexOf("--", i);
      let cmd: string;
      let cmdArgs: string[];

      if (dashDash !== -1) {
        // Anything between flags and -- that isn't a flag is a legacy
        // positional that's now interpreted as the display name. The
        // previous semantics (positional = on-disk id) is gone — use --id.
        const between = args.slice(i, dashDash);
        if (between.length > 0 && !explicitDisplayName) {
          explicitDisplayName = between[0];
          console.error(`Hint: use --name instead: pty run --name ${between[0]} -- ...`);
        }
        cmd = args[dashDash + 1];
        cmdArgs = args.slice(dashDash + 2);
      } else {
        // No -- separator: legacy positional format
        // pty run mydisplayname node server.js
        const rest = args.slice(i);
        if (!explicitDisplayName && rest.length >= 2) {
          explicitDisplayName = rest[0];
          cmd = rest[1];
          cmdArgs = rest.slice(2);
          console.error(`Hint: use --name instead: pty run --name ${rest[0]} -- ${cmd} ${cmdArgs.join(" ")}`.trimEnd());
        } else {
          cmd = rest[0];
          cmdArgs = rest.slice(1);
        }
      }

      if (!cmd) {
        console.error("Usage: pty run [--id <id>] [--name <displayName>] [-d] [-a] -- <command> [args...]");
        process.exit(1);
      }

      const autoNameCmd = cmd;
      const displayCmd = [cmd, ...cmdArgs].join(" ");
      try {
        cmd = resolveCommand(cmd);
      } catch (e: any) {
        console.error(e.message);
        process.exit(1);
      }

      // Nesting prevention: if inside a pty session and not detaching, exec
      // directly — a plain nested `run` runs the command in-place rather than
      // spawning a background session the caller can't see. Two escape hatches
      // bypass this and create a real (nested) session:
      //   * -d/--detach — create a background session and return.
      //   * --force     — create a nested session and attach to it. This is the
      //                   documented `--force` contract ("Create even from
      //                   inside another pty session") and mirrors attach's /
      //                   restart's --force symmetry. Nested clients tangle
      //                   detach keys, so it's opt-in, but when explicitly
      //                   asked for we honor it instead of silently running
      //                   in-place.
      if (process.env.PTY_SESSION && !detach && !force) {
        // Nested + no --force: a plain `run` execs directly. The narrower -a
        // branch refuses instead when the caller asked to attach-if-running
        // and the target IS running (attaching would nest a client) — the
        // --force path above is the documented way to override that.
        const lookupRef = explicitId ?? explicitDisplayName;
        if (attachExisting && lookupRef) {
          const existing = explicitId
            ? await getSessionByName(explicitId)
            : await getSession(lookupRef);
          if (existing && existing.status === "running") {
            ensureNotNested("run -a", {
              force: false,
              hint:
                `  Target session "${lookupRef}" is already running; attaching would nest a client inside the current session.\n` +
                "  Pass --force to attach anyway, or detach first (Ctrl+\\) and re-run from outside.",
            });
          }
        }
        console.error(
          `Already inside pty session "${process.env.PTY_SESSION}", running directly.`
        );
        const directEnv = { ...process.env };
        for (const key of unsetEnv) delete directEnv[key];
        Object.assign(directEnv, extraEnv);
        const result = spawnSync(cmd, cmdArgs, {
          stdio: "inherit",
          env: directEnv,
        });
        process.exit(result.status ?? 1);
      }

      const existingNames = await allSessionNames();

      // Resolve `name` (the on-disk id). If --id was passed, validate and use
      // it verbatim; otherwise generate a short random id. Charset, length,
      // and stable-id uniqueness checks are all done up front so automation fails
      // loudly rather than hitting EINVAL/ENAMETOOLONG deep in spawn.
      //
      // Uniqueness exception: under `-a` (attach-or-create), a collision
      // with an existing session is the *expected* path — cmdRun attaches
      // a running session or recreates an exited one. Defer to cmdRun.
      let name: string;
      if (explicitId) {
        try {
          validateName(explicitId);
        } catch (e: any) {
          console.error(e.message);
          process.exit(1);
        }
        // **"In use" has to mean in use by something alive.** A name that
        // merely exists on disk is not taken: a record whose owner is a zombie
        // has no socket to answer, and refusing it would make that session name
        // unusable until something reaped the corpse — the exact failure the
        // liveness check in `spawn.ts` exists to prevent, one command earlier.
        //
        // The Rust tool asks `session_exists(name) && client::is_alive(name)`
        // here. This is the same question. Measured on a Mac by Silber.pty on
        // 2026-09-03: with a zombie owner, Rust created a replacement in 186 ms
        // and Node exited 1.
        if (existingNames.has(explicitId) && !attachExisting && await isSessionAlive(explicitId)) {
          console.error(`Session id "${explicitId}" is already in use.`);
          process.exit(1);
        }
        name = explicitId;
      } else {
        let candidate: string | null = null;
        for (let attempt = 0; attempt < 8; attempt++) {
          const c = randomSessionName();
          if (!existingNames.has(c)) { candidate = c; break; }
        }
        if (!candidate) {
          console.error("Could not generate a unique session id after 8 attempts.");
          process.exit(1);
        }
        name = candidate;
      }

      // Resolve `displayName`. Precedence:
      //   1. --no-display-name → null
      //   2. --name <x>         → x (validated permissively)
      //   3. otherwise          → auto cwd+cmd label (sanitized)
      let displayName: string | null = null;
      if (!noDisplayName) {
        if (explicitDisplayName) {
          try {
            validateDisplayName(explicitDisplayName);
          } catch (e: any) {
            console.error(`Invalid displayName: ${e.message}`);
            process.exit(1);
          }
          displayName = explicitDisplayName;
        } else {
          let candidate = autoName(autoNameCmd, cmdArgs);
          candidate = candidate.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
          displayName = candidate;
        }
      }

      await cmdRun(
        name, cmd, cmdArgs, detach, attachExisting, displayCmd, ephemeral,
        tags, cwd, isolateEnv, displayName, extraEnv, unsetEnv,
      );
      break;
    }

    case "attach":
    case "a": {
      let autoRestart = false;
      let noRestart = false;
      let force = false;
      let attachName: string | null = null;
      let attachRemotePeer: string | null = null;
      let attachStreamFdV1: number | undefined;
      for (let ai = 1; ai < args.length; ai++) {
        const a = args[ai];
        if (a === "--auto-restart" || a === "-r") autoRestart = true;
        else if (a === "--no-restart") noRestart = true;
        else if (a === "--force") force = true;
        else if (a === "--remote" && ai + 1 < args.length) { attachRemotePeer = args[++ai]; }
        else if (a === "--attach-stream-fd-v1") {
          if (ai + 1 >= args.length) {
            console.error("pty attach: --attach-stream-fd-v1 requires a file descriptor");
            process.exit(1);
          }
          attachStreamFdV1 = Number(args[++ai]);
        }
        else if (!attachName) attachName = a;
        else {
          console.error(`pty attach: unexpected argument "${a}"`);
          process.exit(1);
        }
      }
      if (!attachName) {
        console.error("Usage: pty attach [-r|--auto-restart|--no-restart] [--force] [--remote <peer>] <name>");
        process.exit(1);
      }
      if (autoRestart && noRestart) {
        console.error("pty attach: --auto-restart and --no-restart are mutually exclusive");
        process.exit(1);
      }
      if (attachStreamFdV1 !== undefined) {
        try {
          validateAttachStreamFdV1(attachStreamFdV1);
        } catch (error) {
          console.error(`pty attach: ${(error as Error).message}`);
          process.exit(1);
        }
        if (autoRestart) {
          console.error("pty attach: --attach-stream-fd-v1 and --auto-restart are mutually exclusive");
          process.exit(1);
        }
      }
      // Nesting guard runs BEFORE name validation / ref resolution. A nested
      // caller gets the informative nesting message even if they mistyped
      // the session name — otherwise they'd fix the typo, try again, and
      // only then discover they shouldn't attach at all. Applies to --remote
      // too: a nested remote attach tangles detach keys just the same.
      ensureNotNested("attach", {
        force,
        hint:
          "  Attaching now would nest a client inside the current session — detach keys route to the outer client and get tangled.\n" +
          "  Detach first (Ctrl+\\) or, from inside pty-layout, use ^]n to pick a session.\n" +
          "  Pass --force to attach anyway (nested clients are usually a mistake).",
      });
      if (attachRemotePeer) {
        // The name is the session's id ON THE REMOTE — don't resolve locally.
        await cmdAttachRemote(attachRemotePeer, attachName, attachStreamFdV1);
      } else {
        const resolvedAttachName = await resolveRef(attachName);
        const restartPolicy: AttachRestartPolicy =
          attachStreamFdV1 !== undefined || noRestart ? "never" : autoRestart ? "always" : "prompt";
        await cmdAttach(resolvedAttachName, restartPolicy, force, attachStreamFdV1);
      }
      break;
    }

    case "exec": {
      // pty exec -- <command> [args...]
      const dashDash = args.indexOf("--", 1);
      if (dashDash === -1 || dashDash + 1 >= args.length) {
        console.error("Usage: pty exec -- <command> [args...]");
        process.exit(1);
      }
      const execCmd = args[dashDash + 1];
      const execArgs = args.slice(dashDash + 2);
      await cmdExec(execCmd, execArgs);
      break;
    }

    case "peek": {
      let follow = false;
      let plain = false;
      let full = false;
      const waitPatterns: string[] = [];
      let timeoutSec = 0;
      let remotePeer: string | null = null;
      let pi = 1;
      while (pi < args.length && args[pi].startsWith("-")) {
        if (args[pi] === "-f" || args[pi] === "--follow") { follow = true; pi++; }
        else if (args[pi] === "--plain") { plain = true; pi++; }
        else if (args[pi] === "--full") { full = true; pi++; }
        else if (args[pi] === "--wait" && pi + 1 < args.length) { waitPatterns.push(args[pi + 1]); pi += 2; }
        else if ((args[pi] === "-t" || args[pi] === "--timeout") && pi + 1 < args.length) { timeoutSec = parseFloat(args[pi + 1]); pi += 2; }
        else if (args[pi] === "--remote" && pi + 1 < args.length) { remotePeer = args[pi + 1]; pi += 2; }
        else break;
      }
      const peekName = args[pi];
      if (!peekName) {
        console.error("Usage: pty peek [-f] [--plain] [--full] [--wait <pattern>] [-t <seconds>] [--remote <peer>] <name>");
        process.exit(1);
      }
      if (remotePeer) {
        if (waitPatterns.length > 0) {
          console.error("pty peek --wait is not supported with --remote yet.");
          process.exit(1);
        }
        // The name is the session's id/name ON THE REMOTE host — don't resolve
        // it against local sessions.
        await cmdPeekRemote(remotePeer, peekName, follow, plain, full);
      } else {
        const resolvedPeekName = await resolveRef(peekName);
        if (waitPatterns.length > 0) {
          await cmdPeekWait(resolvedPeekName, waitPatterns, timeoutSec, plain);
        } else {
          cmdPeek(resolvedPeekName, follow, plain, full);
        }
      }
      break;
    }

    case "send": {
      // Extract `--remote <peer>` from anywhere (it takes the peer as its value)
      // before the positional name/text parsing.
      let sendRemotePeer: string | null = null;
      const rawSend = args.slice(1);
      const filteredSend: string[] = [];
      for (let k = 0; k < rawSend.length; k++) {
        if (rawSend[k] === "--remote") {
          sendRemotePeer = rawSend[k + 1] ?? null;
          if (!sendRemotePeer) {
            console.error("pty send --remote requires a <peer>.");
            process.exit(1);
          }
          k++; // skip the value
          continue;
        }
        filteredSend.push(rawSend[k]);
      }
      const sendName = filteredSend[0];
      if (!sendName) {
        console.error('Usage: pty send [--remote <peer>] <name> "text"  or  pty send <name> --seq "text" --seq key:return');
        process.exit(1);
      }

      let sendArgs = filteredSend.slice(1);
      // --paste can appear anywhere; pull it out before the rest of the
      // parsing so its position relative to --seq / text doesn't matter.
      let paste = false;
      sendArgs = sendArgs.filter((a) => {
        if (a === "--paste") { paste = true; return false; }
        return true;
      });
      let delaySecs: number | undefined;
      if (sendArgs[0] === "--with-delay") {
        sendArgs = sendArgs.slice(1);
        const val = parseFloat(sendArgs[0]);
        if (isNaN(val) || val < 0) {
          console.error("--with-delay requires a non-negative number (seconds).");
          process.exit(1);
        }
        delaySecs = val;
        sendArgs = sendArgs.slice(1);
      }

      const hasSeq = sendArgs.includes("--seq");
      const hasPositional = sendArgs.length > 0 && !sendArgs[0].startsWith("--");

      if (hasSeq && hasPositional) {
        console.error("Cannot mix positional text with --seq flags.");
        process.exit(1);
      }

      // Common typos for "send a return key" — accepted nowhere; suggest
      // the real syntax so agents / humans don't silently lose a keystroke.
      const ENTER_TYPOS = new Set(["--enter", "--newline", "--return", "--cr"]);
      for (const a of sendArgs) {
        if (ENTER_TYPOS.has(a)) {
          console.error(`Unknown flag "${a}". Use \`--seq "<text>" --seq key:return\` to send text followed by Enter.`);
          process.exit(1);
        }
      }

      let data: string[];
      if (hasSeq) {
        data = [];
        for (let j = 0; j < sendArgs.length; j++) {
          if (sendArgs[j] === "--seq") {
            j++;
            if (j >= sendArgs.length) {
              console.error("--seq requires a value.");
              process.exit(1);
            }
            data.push(parseSeqValue(sendArgs[j]));
          } else {
            console.error(`Unexpected argument: ${sendArgs[j]}`);
            process.exit(1);
          }
        }
      } else if (hasPositional) {
        // Mirror the --seq branch's strictness: reject any trailing args
        // after the positional text so unknown flags (e.g. --enter) no
        // longer get silently dropped on the floor (closes #20).
        if (sendArgs.length > 1) {
          console.error(`Unexpected argument: ${sendArgs[1]}`);
          process.exit(1);
        }
        data = [sendArgs[0]];
      } else {
        console.error("Nothing to send.");
        process.exit(1);
      }

      // Default to a 0.3s inter-item gap so a trailing key:return doesn't race
      // ahead of the program parsing the typed text. `--with-delay 0` opts out.
      const sendDelayMs = resolveSeqDelayMs(delaySecs);
      if (sendRemotePeer) {
        // The name is the session's id ON THE REMOTE — don't resolve locally.
        await cmdSendRemote(sendRemotePeer, sendName, data, sendDelayMs, paste);
      } else {
        const resolvedSendName = await resolveRef(sendName);
        send({
          name: resolvedSendName,
          data,
          delayMs: sendDelayMs,
          ...(paste ? { paste: true } : {}),
        });
      }
      break;
    }

    case "events": {
      let all = false;
      let recent = false;
      let json = false;
      let waitEventType: string | null = null;
      let eventsTimeout = 0;
      let ei = 1;
      while (ei < args.length && args[ei].startsWith("-")) {
        if (args[ei] === "--all") { all = true; ei++; }
        else if (args[ei] === "--recent") { recent = true; ei++; }
        else if (args[ei] === "--json") { json = true; ei++; }
        else if (args[ei] === "--wait" && ei + 1 < args.length) { waitEventType = args[ei + 1]; ei += 2; }
        else if ((args[ei] === "-t" || args[ei] === "--timeout") && ei + 1 < args.length) { eventsTimeout = parseFloat(args[ei + 1]); ei += 2; }
        else break;
      }
      const eventsName = args[ei];

      if (!all && !eventsName) {
        console.error("Usage: pty events [--all] [--recent] [--json] [--wait <type>] [-t <seconds>] [<name>]");
        process.exit(1);
      }

      let resolvedEventsName: string | null = null;
      if (eventsName) {
        resolvedEventsName = await resolveRef(eventsName);
      }

      await cmdEvents(resolvedEventsName, { all, recent, json, waitEventType, timeout: eventsTimeout });
      break;
    }

    case "list":
    case "ls": {
      const listArgs = args.slice();
      const listFilterTags = extractFilterTags(listArgs);

      // Consume optional flag+value pairs (--status / --older-than / --newer-than)
      // in a single pass so they can appear in any order. Presence checks for
      // boolean flags happen after this loop.
      let statusFilter: "running" | "exited" | "vanished" | null = null;
      let olderThanMs: number | null = null;
      let newerThanMs: number | null = null;
      let remoteFlag = false;
      let remotePeer: string | null = null;
      const consumed = new Set<number>();
      for (let i = 1; i < listArgs.length; i++) {
        const arg = listArgs[i];
        const val = listArgs[i + 1];
        if (arg === "--status") {
          if (val !== "running" && val !== "exited" && val !== "vanished") {
            console.error(`--status expects one of: running, exited, vanished`);
            process.exit(1);
          }
          statusFilter = val;
          consumed.add(i); consumed.add(i + 1);
          i++;
        } else if (arg === "--older-than" || arg === "--newer-than") {
          const parsed = val == null ? null : parseDuration(val);
          if (parsed == null) {
            console.error(`${arg} expects a duration like 30s, 5m, 2h, 1d`);
            process.exit(1);
          }
          if (arg === "--older-than") olderThanMs = parsed;
          else newerThanMs = parsed;
          consumed.add(i); consumed.add(i + 1);
          i++;
        } else if (arg === "--remote") {
          // `--remote <peer>` lists that peer's sessions over fabric. Bare
          // `--remote` (no peer, or followed by another flag) keeps the legacy
          // pty-relay aggregate. A following non-flag token is the peer name.
          remoteFlag = true;
          if (val && !val.startsWith("-")) {
            remotePeer = val;
            consumed.add(i); consumed.add(i + 1);
            i++;
          } else {
            consumed.add(i);
          }
        }
      }
      const remainingArgs = listArgs.filter((_, i) => !consumed.has(i));

      const jsonFlag = remainingArgs.includes("--json");
      const tagsFlag = remainingArgs.includes("--tags");
      const summaryFlag = remainingArgs.includes("--summary");
      await cmdList({
        json: jsonFlag,
        showTags: tagsFlag,
        remote: remoteFlag,
        remotePeer,
        filterTags: listFilterTags,
        statusFilter,
        olderThanMs,
        newerThanMs,
        summary: summaryFlag,
      });
      break;
    }

    case "remote-serve": {
      // On-demand fabric `--exec` form: serve ONE connection over stdin/stdout
      // then exit. fabric spawns it per dial and owns accept + persistence +
      // roaming. The recommended (fabric-only) shape — no persistent daemon.
      if (args.includes("--stdio")) {
        runRemoteServeStdio();
        break;
      }
      // Listening-daemon form (being retired): bind a Unix socket for a fabric
      // peer to expose.
      const sockIdx = args.indexOf("--socket");
      const sockPath = sockIdx >= 0 ? args[sockIdx + 1] : null;
      if (!sockPath) {
        console.error("Usage: pty remote-serve (--stdio | --socket <path>)");
        console.error(
          "Serve the remote-access control protocol for a fabric peer to expose.\n" +
          "  --stdio          on-demand, spawned by fabric per dial (recommended):\n" +
          "                   fabric expose pty-remote --exec -- pty remote-serve --stdio\n" +
          "  --socket <path>  listening daemon (fabric expose pty-remote --socket <path>)\n" +
          "Run in the same PTY_ROOT env as the sessions; put --socket OUTSIDE PTY_ROOT."
        );
        process.exit(1);
      }
      await cmdRemoteServe(sockPath);
      break;
    }

    case "stats": {
      let statsJson = false;
      let statsAll = false;
      let statsName: string | undefined;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--json") statsJson = true;
        else if (args[i] === "--all") statsAll = true;
        else if (!statsName) statsName = args[i];
      }
      await cmdStats(statsName, statsJson, statsAll);
      break;
    }

    case "restart": {
      // -y / --yes: skip the "kill and restart?" prompt when already running
      // --force: also skip the nesting guard (restart + attach even when
      //          already inside a pty session — nested client, caveat emptor)
      let yes = false;
      let force = false;
      let restartName: string | null = null;
      for (let ai = 1; ai < args.length; ai++) {
        const a = args[ai];
        if (a === "-y" || a === "--yes") yes = true;
        else if (a === "--force") force = true;
        else if (!restartName) restartName = a;
        else {
          console.error(`pty restart: unexpected argument "${a}"`);
          process.exit(1);
        }
      }
      if (!restartName) {
        console.error("Usage: pty restart [-y] [--force] <name>");
        process.exit(1);
      }
      const resolvedRestartName = await resolveRef(restartName);
      await cmdRestart(resolvedRestartName, yes, force);
      break;
    }

    case "kill": {
      if (args.length < 2) {
        console.error("Usage: pty kill <name>");
        process.exit(1);
      }
      const resolvedKillName = await resolveRef(args[1]);
      await cmdKill(resolvedKillName);
      break;
    }

    case "recover": {
      const recoverName = args[1];
      const snapshotIndex = args.indexOf("--snapshot");
      const snapshotPath = snapshotIndex >= 0 ? args[snapshotIndex + 1] : null;
      if (!recoverName || !snapshotPath) {
        console.error("Usage: pty recover <name> --snapshot <metadata.json>");
        process.exit(1);
      }
      try {
        await cmdRecover(recoverName, snapshotPath);
      } catch (error) {
        console.error(`pty recover: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
      break;
    }

    case "gc": {
      const gcArgs = args.slice(1);
      const dryRun = gcArgs.some((a) => a === "--dry-run" || a === "-n");
      const printPlist = gcArgs.includes("--print-launchd-plist");
      let interval = 30;
      let idleDays: number | undefined;
      let fastFailWindowSec: number | undefined;
      let fastFailLimit: number | undefined;
      let keepMaxAgeMs: number | undefined;
      const parsePositive = (flag: string, raw: string): number => {
        const v = parseInt(raw, 10);
        if (!Number.isFinite(v) || v <= 0) {
          console.error(`pty gc: ${flag} expects a positive integer (got "${raw}")`);
          process.exit(1);
        }
        return v;
      };
      // Durations, unlike the integer flags, have a meaningful zero: `0`
      // means "the keep exemption is over, sweep the backlog now". The
      // unit-less spelling is accepted only for zero, since `--keep-max-age 7`
      // would otherwise be ambiguous between seconds and days.
      const parseAge = (flag: string, raw: string): number => {
        if (raw.trim() === "0") return 0;
        const ms = parseDuration(raw);
        if (ms == null) {
          console.error(`pty gc: ${flag} expects a duration like 12h, 7d, or 0 (got "${raw}")`);
          process.exit(1);
        }
        return ms;
      };
      for (let i = 0; i < gcArgs.length; i++) {
        const a = gcArgs[i];
        if (a === "--interval" && i + 1 < gcArgs.length) {
          interval = parsePositive("--interval", gcArgs[++i]);
        } else if (a.startsWith("--interval=")) {
          interval = parsePositive("--interval", a.slice("--interval=".length));
        } else if (a === "--idle-days" && i + 1 < gcArgs.length) {
          idleDays = parsePositive("--idle-days", gcArgs[++i]);
        } else if (a.startsWith("--idle-days=")) {
          idleDays = parsePositive("--idle-days", a.slice("--idle-days=".length));
        } else if (a === "--fast-fail-window" && i + 1 < gcArgs.length) {
          fastFailWindowSec = parsePositive("--fast-fail-window", gcArgs[++i]);
        } else if (a.startsWith("--fast-fail-window=")) {
          fastFailWindowSec = parsePositive("--fast-fail-window", a.slice("--fast-fail-window=".length));
        } else if (a === "--fast-fail-limit" && i + 1 < gcArgs.length) {
          fastFailLimit = parsePositive("--fast-fail-limit", gcArgs[++i]);
        } else if (a.startsWith("--fast-fail-limit=")) {
          fastFailLimit = parsePositive("--fast-fail-limit", a.slice("--fast-fail-limit=".length));
        } else if (a === "--keep-max-age" && i + 1 < gcArgs.length) {
          keepMaxAgeMs = parseAge("--keep-max-age", gcArgs[++i]);
        } else if (a.startsWith("--keep-max-age=")) {
          keepMaxAgeMs = parseAge("--keep-max-age", a.slice("--keep-max-age=".length));
        }
      }
      if (printPlist) {
        printLaunchdPlist(interval);
        break;
      }
      await cmdGc({ dryRun, idleDays, fastFailWindowSec, fastFailLimit, keepMaxAgeMs });
      break;
    }

    case "tag": {
      const tagName = args[1];
      if (!tagName) {
        console.error("Usage: pty tag <name> [key=value...] [--rm key...]");
        process.exit(1);
      }
      const resolvedTagName = await resolveRef(tagName);

      // Bulk-friendly parsing. Multiple `key=value` and `--rm <key>` may
      // appear in any order; updates apply before removals (see updateTags
      // in sessions.ts), so `pty tag X k=v --rm k` ends with k removed.
      const updates: Record<string, string> = {};
      const removals: string[] = [];
      for (let i = 2; i < args.length; i++) {
        if (args[i] === "--rm") {
          if (i + 1 >= args.length) {
            console.error("pty tag: --rm requires a key (e.g. --rm role)");
            process.exit(1);
          }
          const rmKey = args[i + 1];
          if (rmKey === "") {
            console.error("pty tag: --rm requires a non-empty key");
            process.exit(1);
          }
          removals.push(rmKey);
          i++;
          continue;
        }
        const eq = args[i].indexOf("=");
        if (eq === -1) {
          console.error(`pty tag: invalid argument "${args[i]}". Use key=value or --rm key.`);
          process.exit(1);
        }
        const key = args[i].slice(0, eq);
        if (key === "") {
          console.error(`pty tag: empty key in "${args[i]}". Tag keys must be non-empty.`);
          process.exit(1);
        }
        updates[key] = args[i].slice(eq + 1);
      }

      // No updates or removals — show current tags
      if (Object.keys(updates).length === 0 && removals.length === 0) {
        const meta = readMetadata(resolvedTagName);
        if (!meta) {
          console.error(`Session "${tagName}" not found.`);
          process.exit(1);
        }
        if (!meta.tags || Object.keys(meta.tags).length === 0) {
          console.log(`No tags on "${resolvedTagName}".`);
        } else {
          for (const [k, v] of Object.entries(meta.tags)) {
            console.log(`  ${k}=${v}`);
          }
        }
        break;
      }

      try {
        // Check if session is managed by a pty.toml before modifying
        const beforeMeta = readMetadata(resolvedTagName);
        const ptyfilePath = beforeMeta?.tags?.ptyfile;

        updateTags(resolvedTagName, updates, removals);
        const meta = readMetadata(resolvedTagName);
        if (!meta?.tags || Object.keys(meta.tags).length === 0) {
          console.log(`Tags cleared on "${resolvedTagName}".`);
        } else {
          console.log(`Tags on "${resolvedTagName}":`);
          for (const [k, v] of Object.entries(meta.tags)) {
            console.log(`  ${k}=${v}`);
          }
        }

        if (ptyfilePath) {
          console.error(`\nWarning: this session is managed by ${ptyfilePath}`);
          console.error("Running 'pty up' will sync tags from the toml and may overwrite this change.");
          console.error("To make it permanent, edit the pty.toml file directly.");
        }
      } catch (e: any) {
        console.error(e.message);
        process.exit(1);
      }
      break;
    }

    case "tag-multi": {
      await cmdTagMulti(args.slice(1));
      break;
    }

    case "emit": {
      await cmdEmit(args.slice(1));
      break;
    }

    case "up": {
      // pty up [dir] [name...]  (--help handled by the central interceptor)
      const upArgs = args.slice(1);
      let dir: string | undefined;
      const names: string[] = [];

      for (const arg of upArgs) {
        if (arg.startsWith("-")) break;
        if (!dir && names.length === 0 && hasPtyFile(arg)) {
          dir = arg;
        } else {
          names.push(arg);
        }
      }

      await cmdUp(dir, names);
      break;
    }

    case "down": {
      // pty down [dir] [name...]  (--help handled by the central interceptor)
      const downArgs = args.slice(1);
      let dir: string | undefined;
      const names: string[] = [];

      for (const arg of downArgs) {
        if (arg.startsWith("-")) break;
        if (!dir && names.length === 0 && hasPtyFile(arg)) {
          dir = arg;
        } else {
          names.push(arg);
        }
      }

      await cmdDown(dir, names);
      break;
    }

    case "rename": {
      await cmdRename(args.slice(1));
      break;
    }

    case "metadata": {
      await cmdMetadata(args.slice(1));
      break;
    }

    case "evidence": {
      await cmdEvidence(args.slice(1));
      break;
    }

    case "rm":
    case "remove": {
      if (args.length < 2) {
        console.error("Usage: pty rm <name>");
        process.exit(1);
      }
      const resolvedRmName = await resolveRef(args[1]);
      await cmdRm(resolvedRmName);
      break;
    }

    case "test": {
      await cmdTest(args.slice(1));
      break;
    }

    case "completions": {
      // `pty completions <shell>` — print a fish/bash/zsh completion script.
      const { cmdCompletions } = await import("./completions.ts");
      process.exitCode = cmdCompletions(args.slice(1));
      return;
    }

    case "version":
    case "--version":
    case "-v":
    case "-V": {
      printVersion();
      break;
    }

    case "help":
    case "--help":
    case "-h": {
      usage();
      break;
    }

    default: {
      // Look for pty-<command> in PATH (like git does with git-<command>)
      const ext = `pty-${command}`;
      let extPath: string | null = null;
      try {
        extPath = execFileSync("which", [ext], { encoding: "utf8" }).trim();
      } catch {}

      if (extPath) {
        const result = spawnSync(extPath, args.slice(1), {
          stdio: "inherit",
          env: process.env,
        });
        process.exit(result.status ?? 1);
      }

      console.error(`Unknown command: ${command}`);
      usage();
      process.exit(1);
    }
  }
}

async function cmdRun(
  name: string,
  command: string,
  args: string[],
  detach = false,
  attachExisting = false,
  displayCommand: string,
  ephemeral = false,
  tags: Record<string, string> = {},
  explicitCwd: string | null = null,
  isolateEnv = false,
  displayName: string | null = null,
  extraEnv: Record<string, string> = {},
  unsetEnv: string[] = [],
): Promise<void> {
  let session = await getSessionByName(name);

  const delegatedOwner = Number(process.env.PTY_CREATION_LOCK_OWNER_PID);
  const inheritedCreationLock =
    Number.isSafeInteger(delegatedOwner) &&
    isLockOwnedByPid(name, delegatedOwner);
  // This is a one-hop control value for the CLI process, not session env.
  delete process.env.PTY_CREATION_LOCK_OWNER_PID;
  let ownsEventLock = false;
  let ownsCreationLock = false;
  if (!inheritedCreationLock) {
    if (!acquireEventLock(name)) {
      console.error(`Session "${name}" event log is busy. Try again.`);
      process.exit(1);
    }
    ownsEventLock = true;
    if (!acquireLock(name)) {
      releaseEventLock(name);
      console.error(
        `Session "${name}" is being created by another process. Try again.`
      );
      process.exit(1);
    }
    ownsCreationLock = true;
    session = await getSessionByName(name);
  }

  if (session?.status === "running") {
    if (ownsCreationLock) {
      releaseLock(name);
      ownsCreationLock = false;
    }
    if (ownsEventLock) {
      releaseEventLock(name);
      ownsEventLock = false;
    }
    if (attachExisting) {
      console.log(`Session "${name}" already running, attaching.`);
      doAttach(name);
      return;
    }
    console.error(
      `Session "${name}" is already running. Use "pty attach ${name}" to connect.`
    );
    process.exit(1);
  }

  // Clean up any dead session with the same name, but preserve cwd and tags
  // so that `run -a` re-creates the session in the original directory with original tags.
  const previousCwd = session && isGone(session.status) ? session.metadata?.cwd : undefined;
  const previousTags = session && isGone(session.status) ? session.metadata?.tags : undefined;
  const previousExtraEnv = session && isGone(session.status) ? session.metadata?.extraEnv : undefined;
  const previousUnsetEnv = session && isGone(session.status) ? session.metadata?.unsetEnv : undefined;
  try {
    if (session && isGone(session.status) && !inheritedCreationLock) {
      cleanupAllWhileLocked(name);
    }
    if (ownsEventLock) {
      releaseEventLock(name);
      ownsEventLock = false;
    }
    const tagOpt = Object.keys(tags).length > 0 ? tags : previousTags;
    const cwdOpt = explicitCwd ?? previousCwd;
    // If the session had a previous displayName (e.g., it was renamed before
    // exiting), prefer preserving it over the fresh auto-generated label so
    // `pty run -a` re-creates the session feeling-identical to the last one.
    const prevDisplayName = session && isGone(session.status) ? session.metadata?.displayName : undefined;
    const displayNameOpt = displayName ?? prevDisplayName;
    const extraEnvOpt = Object.keys(extraEnv).length > 0 ? extraEnv : previousExtraEnv;
    const unsetEnvOpt = unsetEnv.length > 0 ? unsetEnv : previousUnsetEnv;
    await spawnDaemon({
      name, command, args, displayCommand, cwd: cwdOpt, ephemeral, tags: tagOpt,
      creationLockOwnerPid: inheritedCreationLock ? delegatedOwner : process.pid,
      ...(displayNameOpt ? { displayName: displayNameOpt } : {}),
      ...(isolateEnv ? { isolateEnv: true } : {}),
      ...(extraEnvOpt && Object.keys(extraEnvOpt).length > 0 ? { extraEnv: extraEnvOpt } : {}),
      ...(unsetEnvOpt && unsetEnvOpt.length > 0 ? { unsetEnv: unsetEnvOpt } : {}),
    });
  } finally {
    if (ownsEventLock) releaseEventLock(name);
    if (ownsCreationLock) releaseLock(name);
  }

  console.log(`Session "${name}" created.`);

  if (detach) {
    return;
  }

  doAttach(name);
}

type AttachRestartPolicy = "prompt" | "always" | "never";

async function cmdAttach(
  name: string,
  restartPolicy: AttachRestartPolicy = "prompt",
  _force = false,
  attachStreamFdV1?: number,
): Promise<void> {
  // Nesting guard runs in the dispatcher (before name resolution) so the
  // user gets the nesting hint even for typo'd refs. cmdAttach itself is
  // only reached once that check has passed; _force is retained in the
  // signature for clarity and potential future use.
  void _force;
  const session = await getSession(name);

  if (!session) {
    console.error(`Session "${name}" not found.`);
    process.exit(1);
  }

  if (session.status === "running") {
    doAttach(name, attachStreamFdV1);
    return;
  }

  // Attach-only callers are relays/supervisors that must never turn future
  // input into permission to execute retained launch metadata. Refuse before
  // entering the dead-session presentation/restart path.
  if (restartPolicy === "never") {
    console.error(`Session "${name}" is not running (status: ${session.status}).`);
    process.exit(1);
  }

  // Dead session — show last lines and offer to restart
  await handleDeadSession(session, restartPolicy === "always");
}

async function handleDeadSession(
  session: SessionInfo,
  autoRestart = false,
): Promise<void> {
  const meta = session.metadata;
  if (!meta) {
    console.error(`Session "${session.name}" exited (no metadata available).`);
    cleanupAll(session.name);
    process.exit(1);
  }

  // Show last lines
  if (meta.lastLines && meta.lastLines.length > 0) {
    console.log("");
    for (const line of meta.lastLines) {
      console.log(`  ${line}`);
    }
    console.log("");
  }

  console.log(
    `Session "${session.name}" exited with code ${meta.exitCode ?? "unknown"}.`
  );

  const cmd = [meta.displayCommand, ...(meta.args ?? [])].join(" ");
  console.log(`Command was: ${cmd}`);
  console.log("");

  if (!autoRestart) {
    const answer = await ask("Restart? [Y/n] ");
    if (answer.toLowerCase() === "n") {
      process.exit(0);
    }
  }

  // Restart. Preserve displayName (and tags) so the respawned session keeps its
  // name instead of falling back to the raw id.
  cleanupAll(session.name);
  await spawnDaemon({
    name: session.name, command: meta.command, args: meta.args, displayCommand: meta.displayCommand, cwd: meta.cwd, tags: meta.tags,
    ...(meta.displayName ? { displayName: meta.displayName } : {}),
    ...persistedLaunchOptions(meta),
    scrubEnv: RESTART_SCRUBBED_ENV,
  });
  console.log(`Session "${session.name}" restarted.`);
  doAttach(session.name);
}

function doAttach(name: string, attachStreamFdV1?: number): void {
  const metadata = readMetadata(name);
  if (attachStreamFdV1 === undefined) {
    process.stderr.write(`[attached to ${plainLabel({ name, displayName: metadata?.displayName })} — press Ctrl+\\ to detach]\n`);
  }
  attach({
    name,
    metadata,
    ...(attachStreamFdV1 !== undefined ? { attachStreamFdV1 } : {}),
    onDetach: () => process.exit(0),
    onExit: (code) => process.exit(code),
  });
}

async function cmdExec(command: string, cmdArgs: string[]): Promise<void> {
  const sessionName = process.env.PTY_SESSION;
  if (!sessionName) {
    console.error("pty exec: not inside a pty session (PTY_SESSION not set).");
    process.exit(1);
  }
  const ownerGeneration = process.env.PTY_SESSION_GENERATION;
  if (!ownerGeneration) {
    throw new Error(
      "pty exec: current session has no generation owner token; restart it before using pty exec.",
    );
  }

  const meta = readMetadata(sessionName);
  if (!meta) {
    console.error(`pty exec: session "${sessionName}" metadata not found.`);
    process.exit(1);
  }

  // Resolve the command to an absolute path
  let resolved: string;
  try {
    resolved = resolveCommand(command);
  } catch (e: any) {
    console.error(e.message);
    process.exit(1);
  }

  const displayCommand = [command, ...cmdArgs].join(" ");
  if (!acquireEventLock(sessionName)) {
    throw new Error(`pty exec: session "${sessionName}" event log is busy; retry the operation.`);
  }
  try {
    let previousCommand = "";
    const result = mutateMetadataUnderLock(sessionName, (current) => {
      if (current.tags?.ptyfile) {
        throw new Error(
          `pty exec: session "${sessionName}" is managed by ${current.tags.ptyfile}. ` +
          "Edit the pty.toml to change the command instead.",
        );
      }
      previousCommand = current.displayCommand ??
        [current.command, ...(current.args ?? [])].join(" ");
      current.command = resolved;
      current.args = cmdArgs;
      current.displayCommand = displayCommand;
      return true;
    }, {
      expectedGeneration: ownerGeneration,
      onPublished: () => appendEventSyncLocked(sessionName, {
        session: sessionName,
        type: EventType.SESSION_EXEC,
        ts: new Date().toISOString(),
        previousCommand,
        command: displayCommand,
      }),
    });

    if (result.status !== "changed") {
      const reason = result.status === "generation-mismatch"
        ? "belongs to a replacement generation"
        : `could not be updated (${result.status})`;
      throw new Error(`pty exec: session "${sessionName}" ${reason}; command was not run.`);
    }
  } finally {
    releaseEventLock(sessionName);
  }

  // Replace this process with the new command
  const result = spawnSync(resolved, cmdArgs, {
    stdio: "inherit",
    env: process.env,
  });
  process.exit(result.status ?? 1);
}

async function cmdPeekWait(name: string, patterns: string[], timeoutSec: number, plain: boolean): Promise<void> {
  const { peekScreen } = await import("./connection.ts");
  const start = Date.now();
  const timeoutMs = timeoutSec > 0 ? timeoutSec * 1000 : 0;
  const matchesAny = (text: string) => patterns.some((p) => text.includes(p));
  const patternDesc = patterns.length === 1 ? `"${patterns[0]}"` : patterns.map((p) => `"${p}"`).join(" or ");

  while (true) {
    if (timeoutMs > 0 && Date.now() - start > timeoutMs) {
      console.error(`Timed out after ${timeoutSec}s waiting for ${patternDesc}.`);
      process.exit(1);
    }

    // Try live session first
    try {
      const screen = await peekScreen({ name, plain: true });
      if (matchesAny(screen)) {
        if (plain) {
          process.stdout.write(screen + "\n");
        } else {
          const ansiScreen = await peekScreen({ name, plain: false });
          process.stdout.write(ansiScreen + "\n");
        }
        return;
      }
    } catch {
      // Session might have exited — check metadata for lastLines
      const meta = readMetadata(name);
      if (meta?.exitedAt && meta.lastLines) {
        const lastOutput = meta.lastLines.join("\n");
        if (matchesAny(lastOutput)) {
          process.stdout.write(lastOutput + "\n");
          return;
        }
        // Session exited but pattern not found in last lines
        console.error(`Session "${name}" exited (code ${meta.exitCode ?? "?"}) without matching ${patternDesc}.`);
        if (meta.lastLines.length > 0) {
          console.error("Last output:");
          for (const line of meta.lastLines) {
            console.error(`  ${line}`);
          }
        }
        process.exit(1);
      }
      // No exitedAt — might be a transient connection error, retry
    }

    await new Promise((r) => setTimeout(r, 200));
  }
}

async function cmdPeek(name: string, follow: boolean, plain: boolean, full = false): Promise<void> {
  // Dead daemon (cleanly exited or vanished) — fall back to saved lastLines.
  const session = await getSession(name);
  if (session && isGone(session.status)) {
    const meta = session.metadata;
    if (meta?.lastLines && meta.lastLines.length > 0) {
      process.stdout.write(meta.lastLines.join("\n") + "\n");
    } else {
      const verb = session.status === "vanished" ? "vanished" : "exited";
      console.error(`Session "${name}" has ${verb} with no saved output.`);
    }
    return;
  }

  peek({
    name,
    metadata: session?.metadata,
    follow,
    plain,
    full,
    onDetach: () => process.exit(0),
    onExit: (code) => process.exit(code),
  });
}

/** `pty peek --remote <peer> <name>`: dial the peer's exposed pty control
 *  socket over fabric, route it to the named remote session, and run the
 *  ordinary peek protocol over that tunnel. */
async function cmdPeekRemote(
  peer: string,
  name: string,
  follow: boolean,
  plain: boolean,
  full: boolean,
): Promise<void> {
  let socket;
  let row: RemoteSessionRow | undefined;
  try {
    const socketPath = dialPeer(peer);
    row = follow ? await fetchPeerRow(socketPath, name) : undefined;
    socket = await routeSocket(socketPath, name);
  } catch (e) {
    console.error(`pty peek --remote ${peer}: ${(e as Error).message}`);
    process.exit(1);
  }
  peek({
    name,
    row,
    peer,
    follow,
    plain,
    full,
    socket,
    onDetach: () => process.exit(0),
    onExit: (code) => process.exit(code),
  });
}

/** `pty send --remote <peer> <name> …`: dial the peer's exposed pty control
 *  socket over fabric, route it to the named remote session, and send over the
 *  same tunnel the local `pty send` uses. */
async function cmdSendRemote(
  peer: string,
  name: string,
  data: string[],
  delayMs: number,
  paste: boolean,
): Promise<void> {
  let socket;
  try {
    socket = await dialAndRoute(peer, name);
  } catch (e) {
    console.error(`pty send --remote ${peer}: ${(e as Error).message}`);
    process.exit(1);
  }
  send({
    name,
    data,
    delayMs,
    socket,
    ...(paste ? { paste: true } : {}),
  });
}

// Query before opening the routed socket: otherwise the daemon can send its
// first packet while the CLI awaits metadata and no client listener exists.
async function fetchPeerRow(socketPath: string, name: string): Promise<RemoteSessionRow | undefined> {
  try {
    return (await fetchRemoteList(socketPath)).find((row) => row.name === name);
  } catch {
    return undefined;
  }
}

/** `pty attach --remote <peer> <name>`: dial the peer's exposed pty control
 *  socket over fabric, route it to the named remote session, and attach over
 *  that tunnel — the resilient shell is a long-lived remote pty you attach to. */
async function cmdAttachRemote(peer: string, name: string, attachStreamFdV1?: number): Promise<void> {
  let socket;
  let row: RemoteSessionRow | undefined;
  try {
    const socketPath = dialPeer(peer);
    row = await fetchPeerRow(socketPath, name);
    socket = await routeSocket(socketPath, name);
  } catch (e) {
    console.error(`pty attach --remote ${peer}: ${(e as Error).message}`);
    process.exit(1);
  }
  if (attachStreamFdV1 === undefined) {
    process.stderr.write(`[attached to ${plainLabel({ name, displayName: row?.displayName })} — press Ctrl+\\ to detach]\n`);
  }
  attach({
    name,
    row,
    peer,
    socket,
    ...(attachStreamFdV1 !== undefined ? { attachStreamFdV1 } : {}),
    // On a loud fabric close, re-dial + re-route to the same remote session and
    // re-attach (the daemon replays its screen, so the session resumes). A
    // recoverable transport stall keeps the socket open, so it's just waited out.
    // Contract: null = transport failure (host unreachable) → attach keeps
    // retrying; throw = the host is reachable but the session is gone → attach
    // gives up cleanly.
    reconnect: async () => {
      try {
        return await dialAndRoute(peer, name);
      } catch (e) {
        if (e instanceof RouteRefusedError) throw e; // reachable-but-gone → clean give-up
        return null; // transport failure → keep retrying (unlimited by default)
      }
    },
    onDetach: () => process.exit(0),
    onExit: (code) => process.exit(code),
  });
}

interface ListOptions {
  json?: boolean;
  showTags?: boolean;
  remote?: boolean;
  /** When set, list this fabric peer's sessions over fabric (the new path);
   *  `remote` without a peer keeps the legacy pty-relay aggregate. */
  remotePeer?: string | null;
  filterTags?: Record<string, string>;
  statusFilter?: "running" | "exited" | "vanished" | null;
  olderThanMs?: number | null;
  newerThanMs?: number | null;
  summary?: boolean;
}

async function cmdRemoteServe(socketPath: string): Promise<void> {
  // Diagnostics for the detached-liveness investigation — off unless
  // PTY_REMOTE_SERVE_DEBUG is set, so normal service logs stay quiet.
  const debug = !!process.env.PTY_REMOTE_SERVE_DEBUG;
  const dlog = (m: string) => { if (debug) console.error(`[remote-serve ${new Date().toISOString()}] ${m}`); };

  const server = serveRemoteControl(socketPath);
  server.on("error", (e) => {
    console.error(`pty remote-serve: ${e.message}`);
    process.exit(1);
  });
  server.on("listening", () => {
    console.log(`pty remote-serve listening on ${socketPath}`);
    dlog(`up pid=${process.pid} stdinTTY=${!!process.stdin.isTTY}`);
  });

  // Belt: pin the event loop so nothing about stdin/handle-refcounting can drain
  // it. Suspenders (the real fix): a detached service must outlive the terminal
  // or session that launched it. SIGHUP's default action is termination, so a
  // plain `… </dev/null &` / setsid / fabric-shell launch is killed by the
  // hangup the moment its launching session tears down (the ref'd timer can't
  // save a process from an unhandled terminating signal — which is why the
  // timer alone didn't hold on Linux). Ignore SIGHUP, like a daemon should.
  // SIGTERM/SIGINT remain the graceful way to stop it.
  const keepAlive = setInterval(() => {}, 1 << 30);
  process.on("SIGHUP", () => dlog("SIGHUP received — ignoring (detached service stays up)"));

  if (debug) {
    process.on("beforeExit", (code) => dlog(`beforeExit code=${code}`));
    process.on("exit", (code) => dlog(`exit code=${code}`));
    process.on("uncaughtException", (e) => dlog(`uncaughtException: ${(e as Error)?.stack ?? String(e)}`));
    process.on("unhandledRejection", (r) => dlog(`unhandledRejection: ${String(r)}`));
  }

  await new Promise<void>((resolve) => {
    const stop = (sig: string) => {
      dlog(`${sig} — shutting down`);
      clearInterval(keepAlive);
      try { server.close(); } catch {}
      try { fs.unlinkSync(socketPath); } catch {}
      resolve();
    };
    process.on("SIGTERM", () => stop("SIGTERM"));
    process.on("SIGINT", () => stop("SIGINT"));
  });
}

async function cmdList(opts: ListOptions = {}): Promise<void> {
  const {
    json = false,
    showTags = false,
    remote = false,
    remotePeer = null,
    filterTags = {},
    statusFilter = null,
    olderThanMs = null,
    newerThanMs = null,
    summary = false,
  } = opts;

  let sessions = await listSessions();
  if (Object.keys(filterTags).length > 0) {
    sessions = sessions.filter((s) => matchesAllTags(s.metadata?.tags, filterTags));
  }
  if (statusFilter) {
    sessions = sessions.filter((s) => s.status === statusFilter);
  }
  if (olderThanMs != null || newerThanMs != null) {
    const now = Date.now();
    sessions = sessions.filter((s) => {
      // Anchor age on exitedAt when available (true exit), else createdAt.
      // Running sessions have no exit yet, so use createdAt. Missing
      // metadata entirely means we can't filter on age — include by default.
      const anchor = s.metadata?.exitedAt ?? s.metadata?.createdAt;
      if (!anchor) return olderThanMs == null && newerThanMs == null;
      const ageMs = now - new Date(anchor).getTime();
      if (olderThanMs != null && ageMs < olderThanMs) return false;
      if (newerThanMs != null && ageMs > newerThanMs) return false;
      return true;
    });
  }

  // Stable display order: ASCII sort on the user-visible label (displayName
  // when set, otherwise the stable id). Without this, `fs.readdirSync` on
  // APFS returns sessions in roughly insertion order, which drifts as
  // sessions come and go and reads like accidental chaos to the eye.
  const sortKey = (s: SessionInfo): string => s.metadata?.displayName ?? s.name;
  sessions = [...sessions].sort((a, b) => {
    const ka = sortKey(a), kb = sortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  // Fetch relay hosts if --remote
  let remoteHosts: {
    label: string;
    sessions: {
      name: string;
      status: string;
      command?: string;
      cwd?: string;
      tags?: Record<string, string>;
      displayName?: string;
    }[];
    error: string | null;
  }[] = [];
  if (remotePeer) {
    // Fabric path: `fabric dial <peer> pty-remote` prints a local Unix socket
    // that tunnels to the peer's exposed `pty remote-serve`; we speak our own
    // list protocol over it and render it as one host group.
    let error: string | null = null;
    let sessions: typeof remoteHosts[number]["sessions"] = [];
    try {
      const dialSock = execFileSync(FABRIC_BIN, ["dial", remotePeer, PTY_REMOTE_ALPN], {
        encoding: "utf-8", timeout: 10000,
      }).trim();
      if (!dialSock) throw new Error(`fabric dial ${remotePeer} returned no socket`);
      sessions = await fetchRemoteList(dialSock);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    remoteHosts = [{ label: remotePeer, sessions, error }];
  } else if (remote) {
    try {
      const relayBin = execFileSync("which", ["pty-relay"], { encoding: "utf-8" }).trim();
      const result = spawnSync(relayBin, ["ls", "--json"], { encoding: "utf-8", timeout: 5000 });
      if (result.status === 0 && result.stdout.trim()) {
        remoteHosts = JSON.parse(result.stdout);
      }
    } catch {}
  }

  // Build the summary payload — used by both --json --summary and the
  // human-facing --summary rendering below. Oldest/newest are picked from
  // the filtered `sessions` so they match whatever the caller narrowed to.
  const buildSummary = () => {
    const byStatus: Record<string, number> = {
      running: 0, exited: 0, vanished: 0,
    };
    for (const s of sessions) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;

    let oldest: SessionInfo | null = null;
    let newest: SessionInfo | null = null;
    let oldestTs = Infinity;
    let newestTs = -Infinity;
    for (const s of sessions) {
      const anchor = s.metadata?.createdAt;
      if (!anchor) continue;
      const ts = new Date(anchor).getTime();
      if (ts < oldestTs) { oldestTs = ts; oldest = s; }
      if (ts > newestTs) { newestTs = ts; newest = s; }
    }
    const now = Date.now();
    const pickEndpoint = (s: SessionInfo | null, ts: number) => {
      if (!s) return null;
      return {
        name: s.name,
        status: s.status,
        ageSeconds: Math.max(0, Math.floor((now - ts) / 1000)),
        ...(s.metadata?.displayName ? { displayName: s.metadata.displayName } : {}),
      };
    };
    return {
      total: sessions.length,
      byStatus,
      oldest: pickEndpoint(oldest, oldestTs),
      newest: pickEndpoint(newest, newestTs),
    };
  };

  if (json) {
    if (summary) {
      console.log(JSON.stringify(buildSummary()));
      return;
    }
    const localOutput = sessions.map((s) => ({
      name: s.name,
      status: s.status,
      pid: s.pid,
      command: s.metadata
        ? s.metadata.displayCommand
        : null,
      cwd: s.metadata?.cwd ?? null,
      createdAt: s.metadata?.createdAt ?? null,
      exitCode: s.metadata?.exitCode ?? null,
      exitedAt: s.metadata?.exitedAt ?? null,
      ...(s.metadata?.tags ? { tags: s.metadata.tags } : {}),
      ...(s.metadata?.displayName ? { displayName: s.metadata.displayName } : {}),
    }));
    if (remote && remoteHosts.length > 0) {
      console.log(JSON.stringify({ local: localOutput, remote: remoteHosts }));
    } else {
      console.log(JSON.stringify(localOutput));
    }
    return;
  }

  if (summary) {
    const s = buildSummary();
    if (s.total === 0) {
      console.log("No matching sessions.");
      return;
    }
    const parts: string[] = [];
    if (s.byStatus.running) parts.push(`${s.byStatus.running} running`);
    if (s.byStatus.exited) parts.push(`${s.byStatus.exited} exited`);
    if (s.byStatus.vanished) parts.push(`${s.byStatus.vanished} vanished`);
    console.log(`${s.total} session${s.total === 1 ? "" : "s"} — ${parts.join(", ")}`);
    const label = (e: { name: string; status: string; displayName?: string }) =>
      e.displayName ? `${e.displayName} (${e.name})` : e.name;
    if (s.oldest) {
      console.log(`oldest: ${label(s.oldest)} (${s.oldest.status}, ${formatDuration(s.oldest.ageSeconds * 1000)})`);
    }
    if (s.newest && (!s.oldest || s.newest.name !== s.oldest.name)) {
      console.log(`newest: ${label(s.newest)} (${s.newest.status}, ${formatDuration(s.newest.ageSeconds * 1000)})`);
    }
    return;
  }

  if (sessions.length === 0 && remoteHosts.length === 0) {
    console.log("No active sessions.");
    return;
  }

  const running = sessions.filter((s) => s.status === "running");
  const exited = sessions.filter((s) => s.status === "exited");
  const vanished = sessions.filter((s) => s.status === "vanished");

  if (running.length > 0) {
    console.log("Active sessions:");
    for (const session of running) {
      const cmd = session.metadata
        ? session.metadata.displayCommand
        : "unknown";
      const cwd = session.metadata?.cwd
        ? shortPath(session.metadata.cwd)
        : "";
      const tagStr = renderTags(session.metadata?.tags, showTags);
      const marker = strategyMarker(session.metadata?.tags);
      const label = renderLabel(session.name, session.metadata?.displayName, "\x1b[1;36m");
      console.log(`  ${label}${marker}${tagStr} (pid: ${session.pid}) — ${cwd} — \x1b[2m${cmd}\x1b[0m`);
    }
  }

  if (exited.length > 0) {
    if (running.length > 0) console.log("");
    console.log("Exited sessions:");
    for (const session of exited) {
      const meta = session.metadata;
      const code = meta?.exitCode ?? "?";
      const ago = meta?.exitedAt ? timeAgo(new Date(meta.exitedAt)) : "unknown";
      const cwd = meta?.cwd ? shortPath(meta.cwd) : "";
      const cmd = meta
        ? meta.displayCommand
        : "";
      const tagStr = renderTags(meta?.tags, showTags);
      const marker = strategyMarker(meta?.tags);
      const label = renderLabel(session.name, session.metadata?.displayName, "\x1b[1m");
      console.log(`  ${label}${marker}${tagStr} (exited with code ${code}, ${ago}) — ${cwd} — \x1b[2m${cmd}\x1b[0m`);
    }
  }

  if (vanished.length > 0) {
    if (running.length > 0 || exited.length > 0) console.log("");
    // Dim-yellow header because vanished is a warning state — daemon was
    // killed (SIGKILL / OOM / crash) without writing an exit record, so we
    // can't say *why* it's gone, only that the socket stopped responding.
    // `pty gc` cleans these up alongside normal exits.
    console.log("\x1b[33mVanished sessions (no exit record — killed or crashed):\x1b[0m");
    for (const session of vanished) {
      const meta = session.metadata;
      const ago = meta?.createdAt ? timeAgo(new Date(meta.createdAt)) : "unknown";
      const cwd = meta?.cwd ? shortPath(meta.cwd) : "";
      const cmd = meta ? meta.displayCommand : "";
      const tagStr = renderTags(meta?.tags, showTags);
      const marker = strategyMarker(meta?.tags);
      const label = renderLabel(session.name, session.metadata?.displayName, "\x1b[1;33m");
      console.log(`  \u26a0 ${label}${marker}${tagStr} (vanished, started ${ago}) — ${cwd} — \x1b[2m${cmd}\x1b[0m`);
    }
  }

  // Remote hosts — render with the same treatment as local: displayName
  // in parens after the id, strategy marker, user-facing tags inline.
  for (const host of remoteHosts) {
    console.log("");
    if (host.error) {
      console.log(`\x1b[1m${host.label}\x1b[0m \x1b[31m(error: ${host.error})\x1b[0m`);
      continue;
    }
    console.log(`\x1b[1m${host.label}\x1b[0m (${host.sessions.length} sessions):`);
    const sortedRemote = [...host.sessions].sort((a, b) => {
      const ka = a.displayName ?? a.name;
      const kb = b.displayName ?? b.name;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    for (const s of sortedRemote) {
      const icon = s.status === "running" ? "\u25cf" : "\u25cb";
      const cwd = s.cwd ? shortPath(s.cwd) : "";
      const cmd = s.command ?? "";
      const labelBase = s.displayName
        ? `\x1b[1;36m${s.displayName}\x1b[0m \x1b[2m(${s.name})\x1b[0m`
        : `\x1b[1;36m${s.name}\x1b[0m`;
      const tagStr = renderTags(s.tags, showTags);
      const marker = strategyMarker(s.tags);
      console.log(`  ${icon} ${labelBase}${marker}${tagStr} — ${cwd} — \x1b[2m${cmd}\x1b[0m`);
    }
  }
}

async function cmdStats(
  name?: string,
  json = false,
  all = false,
): Promise<void> {
  if (name) {
    const session = await getSession(name);
    if (!session) {
      console.error(`Session "${name}" not found.`);
      process.exit(1);
    }
    if (isGone(session.status)) {
      if (json) {
        console.log(JSON.stringify({
          name: session.name,
          status: session.status,
          exitCode: session.metadata?.exitCode ?? null,
          exitedAt: session.metadata?.exitedAt ?? null,
          ...(session.metadata?.tags ? { tags: session.metadata.tags } : {}),
        }));
      } else if (session.status === "vanished") {
        console.log(`Session "${name}" has vanished (no exit record — killed or crashed).`);
      } else {
        const code = session.metadata?.exitCode ?? "?";
        console.log(`Session "${name}" has exited (code ${code}).`);
      }
      return;
    }

    try {
      // Use the resolved stable `name` so queryStats connects to the right
      // socket when the caller passed a `displayName`.
      const stats = await queryStats(session.name);
      if (json) {
        console.log(JSON.stringify(stats));
      } else {
        printStats(stats, session.metadata);
      }
    } catch (e: any) {
      console.error(e.message);
      process.exit(1);
    }
    return;
  }

  // All sessions
  const sessions = await listSessions();
  const running = sessions.filter((s) => s.status === "running");
  const gone = sessions.filter((s) => isGone(s.status));

  if (running.length === 0 && (!all || gone.length === 0)) {
    console.log("No running sessions.");
    return;
  }

  // Query all running sessions in parallel
  const results = await Promise.all(
    running.map(async (s) => {
      try {
        const stats = await queryStats(s.name);
        return { session: s, stats, error: null as string | null };
      } catch (e: any) {
        return { session: s, stats: null as StatsResult | null, error: e.message as string };
      }
    }),
  );

  if (json) {
    const output = [
      ...results.map((r) => r.stats ?? { name: r.session.name, error: r.error }),
      ...(all
        ? gone.map((s) => ({
            name: s.name,
            status: s.status,
            exitCode: s.metadata?.exitCode ?? null,
            exitedAt: s.metadata?.exitedAt ?? null,
            ...(s.metadata?.tags ? { tags: s.metadata.tags } : {}),
          }))
        : []),
    ];
    console.log(JSON.stringify(output));
    return;
  }

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.stats) {
      printStats(r.stats, r.session.metadata);
    } else {
      console.log(`Session: ${r.session.name}`);
      console.log(`  Error: ${r.error}`);
    }
    if (i < results.length - 1) console.log("");
  }

  if (all && gone.length > 0) {
    if (results.length > 0) console.log("");
    const exited = gone.filter((s) => s.status === "exited");
    const vanished = gone.filter((s) => s.status === "vanished");
    if (exited.length > 0) {
      console.log("Exited sessions:");
      for (const s of exited) {
        const code = s.metadata?.exitCode ?? "?";
        const ago = s.metadata?.exitedAt ? timeAgo(new Date(s.metadata.exitedAt)) : "unknown";
        console.log(`  ${s.name} (exited with code ${code}, ${ago})`);
      }
    }
    if (vanished.length > 0) {
      if (exited.length > 0) console.log("");
      console.log("Vanished sessions (no exit record):");
      for (const s of vanished) {
        const ago = s.metadata?.createdAt ? timeAgo(new Date(s.metadata.createdAt)) : "unknown";
        console.log(`  \u26a0 ${s.name} (started ${ago})`);
      }
    }
  }
}

function printStats(stats: StatsResult, meta: SessionInfo["metadata"]): void {
  const cmd = meta
    ? meta.displayCommand
    : "unknown";
  const cwd = meta?.cwd ? shortPath(meta.cwd) : "unknown";

  console.log(`Session: ${stats.name}`);
  console.log(`  Command:    ${cmd}`);
  console.log(`  CWD:        ${cwd}`);
  console.log(`  Uptime:     ${formatUptime(stats.uptimeSeconds)}`);
  const pidSuffix = stats.process?.pid ? ` (pid ${stats.process.pid})` : "";
  console.log(`  Process:    ${stats.process.alive ? "running" : `exited (code ${stats.process.exitCode})`}${pidSuffix}`);
  if (stats.process?.resources) {
    console.log(`  CPU:        ${stats.process.resources.cpuPercent.toFixed(1)}%`);
    console.log(`  Memory:     ${formatMemory(stats.process.resources.rssKb)}`);
  }
  if (stats.daemon) {
    console.log(`  Daemon:     pid ${stats.daemon.pid}${stats.daemon.resources ? `, ${formatMemory(stats.daemon.resources.rssKb)}` : ""}`);
  }
  console.log(`  Terminal:   ${stats.terminal.cols}x${stats.terminal.rows}`);
  console.log(`  Cursor:     row ${stats.terminal.cursorY}, col ${stats.terminal.cursorX}`);
  console.log(`  Scrollback: ${stats.terminal.scrollbackUsed} / ${stats.terminal.scrollbackCapacity} lines`);
  console.log(`  Clients:    ${stats.clients.total} (${stats.clients.attached} attached, ${stats.clients.readOnly} readonly)`);

  const modes: string[] = [];
  if (stats.modes.sgrMouse) modes.push("SGR mouse");
  if (stats.modes.cursorHidden) modes.push("cursor hidden");
  if (stats.modes.kittyKeyboard) modes.push(`kitty keyboard (flags: ${stats.modes.kittyKeyboardFlags.join(",")})`);
  console.log(`  Modes:      ${modes.length > 0 ? modes.join(", ") : "none"}`);
}

function formatMemory(rssKb: number): string {
  if (rssKb < 1024) return `${rssKb} KB`;
  const mb = rssKb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

function formatUptime(seconds: number | null): string {
  if (seconds == null) return "unknown";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return `${h}h ${rm}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** How long the escalation gives a group to answer SIGTERM before it stops
 *  asking. A coding agent was measured ignoring SIGTERM for ten seconds, so
 *  this grace is a courtesy, not a plan. */
const ESCALATE_TERM_WAIT_MS = 2_000;
/** How long to wait after SIGKILL before reporting what is still there. */
const ESCALATE_KILL_WAIT_MS = 1_000;

/** TERM the groups, wait, KILL what is left, wait, then re-read the process
 *  table. Returns the pids still alive in those groups. */
async function escalateOverGroups(groups: number[]): Promise<number[]> {
  return sweepGroups(groups, ownProcessGroup(), ESCALATE_TERM_WAIT_MS, ESCALATE_KILL_WAIT_MS, {
    live: (targets) => membersOfGroups(targets, openSource()),
    signal: signalGroup,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
}

async function cmdKill(name: string): Promise<void> {
  const session = await getSession(name);

  if (!session) {
    console.error(`Session "${name}" not found.`);
    process.exit(1);
  }

  if (session.status !== "running" || !session.pid) {
    console.error(`Session "${name}" is not running. Use "pty rm ${name}" to remove it.`);
    process.exit(1);
  }

  // Strip the `strategy` tag so `pty gc` doesn't respawn the session on
  // its next tick. The `supervisor.status` tag is no longer a thing.
  const wasPermanent = session.metadata?.tags?.strategy === "permanent";
  if (wasPermanent) {
    try {
      updateTags(name, {}, ["strategy"]);
    } catch {}
  }

  // Take the tree BEFORE the signal. After the daemon exits its children are
  // reparented to init or a subreaper, so the parent links that identify them
  // as this session's processes are gone. This snapshot is the only chance to
  // learn which processes the word "killed" would be a claim about.
  const before = snapshotDescendantProcesses(session.pid);
  // Groups come from the raw listing, NOT from `before`. The snapshot drops a
  // descendant whose start token cannot be read, and that process is then never
  // signalled. A group needs no identity, so this reaches it anyway.
  const groups = groupsInTree(session.pid, openSource());

  try {
    process.kill(session.pid, "SIGTERM");
  } catch {
    console.error(`Failed to kill session "${name}".`);
    process.exitCode = 1;
    return;
  }

  // Wait for the daemon to fully exit before returning. Its shutdown re-flushes
  // exit metadata to disk (an atomic tmp-write + rename); if we returned while
  // that was still in flight, a caller that immediately `pty rm`s the session
  // could race the late write and leave a stray temp file behind. Bounded — the
  // SIGTERM shutdown path settles in ~2s. If it overruns, preserve the socket
  // evidence and return a loud failure. Returning success while the daemon is alive
  // makes the next start look broken and hides the process that blocked it.
  const exited = await waitForProcessExit(session.pid, 7000);
  if (!exited) {
    console.error(
      `Failed to kill session "${name}": daemon PID ${session.pid} is still running ` +
      `after 7s. Socket ${getSocketPath(name)} may still be owned.`,
    );
    process.exitCode = 1;
    return;
  }
  cleanupSocket(name);
  let after = aftermathOf(before, readProcessStartToken, hasProcessExitedForReap);
  let escalated: number[] | undefined;
  if (!allGone(after)) {
    escalated = await escalateOverGroups(groups);
    // Re-measure. The report must describe the machine now, not the signals
    // that were sent at it.
    const again = openSource();
    after = aftermathOf(
      before,
      (pid) => valueOf(again.identity(pid)),
      hasProcessExitedForReap,
    );
  }
  const outcome = killOutcomeLines(name, after, escalated);
  for (const line of outcome.out) console.log(line);
  for (const line of outcome.err) console.error(line);
  // Anything left is a failure, and the status says so.
  if (!verifiedEmpty(after, escalated)) process.exitCode = 1;

  if (wasPermanent && session.metadata?.tags?.ptyfile) {
    console.error(`Note: this session is managed by ${session.metadata.tags.ptyfile}`);
    console.error("The strategy tag will be restored on the next 'pty up'.");
  }
}

async function cmdRecover(name: string, snapshotPath: string): Promise<void> {
  validateName(name);
  const root = path.resolve(getSessionDir());
  const snapshot = readBoundedJson<SessionMetadata>(path.resolve(snapshotPath));
  const capability = snapshot.recovery;
  if (
    capability?.protocol !== RECOVERY_PROTOCOL ||
    typeof capability.secret !== "string" ||
    typeof capability.metadataRevision !== "string" ||
    capability.metadataRevision.length === 0 ||
    !snapshot.generation ||
    !snapshot.daemonPid
  ) {
    throw new Error("snapshot does not advertise supported recovery");
  }
  assertPrivateRecoveryPaths(root, capability);
  if (readProcessStartToken(snapshot.daemonPid) !== capability.processStartToken) {
    throw new Error("daemon PID/start identity no longer matches the snapshot");
  }
  const lockIdentity = recoveryLockIdentity({
    name,
    daemonPid: snapshot.daemonPid,
    processStartToken: capability.processStartToken,
    rootDevice: capability.rootDevice,
    rootInode: capability.rootInode,
    recoveryDirDevice: capability.recoveryDirDevice,
    recoveryDirInode: capability.recoveryDirInode,
  });
  const lockContents = recoveryLockContents(snapshot.daemonPid, lockIdentity);
  if (!acquireRecoveryLock(name, lockContents)) {
    throw new Error(`session "${name}" is being created by another process`);
  }

  const requestPath = recoveryRequestPath(root, name);
  const resultPath = recoveryResultPath(root, name);
  try {
    const targets = [
      getSocketPath(name),
      getPidPath(name),
      getMetadataPath(name),
    ];
    if (targets.some((target) => fs.existsSync(target))) {
      const current = readMetadata(name);
      if (
        !targets.every((target) => fs.existsSync(target)) ||
        !current ||
        current.daemonPid !== snapshot.daemonPid ||
        current.generation !== snapshot.generation ||
        current.recovery?.processStartToken !== capability.processStartToken ||
        current.recovery.launchIdentity !== capability.launchIdentity
      ) {
        throw new Error("recovery target is no longer empty");
      }
      const stats = await queryStats(name);
      if (stats.daemon.pid !== snapshot.daemonPid) {
        throw new Error("republished socket reached a different daemon");
      }
      console.log(`Session "${name}" registry recovered without restart.`);
      return;
    }
    assertPrivateRecoveryPaths(root, capability);
    try { fs.unlinkSync(resultPath); } catch {}
    const nonce = randomBytes(16).toString("hex");
    const request = signRecoveryRequest(capability.secret, {
      protocol: RECOVERY_PROTOCOL,
      name,
      daemonPid: snapshot.daemonPid,
      generation: snapshot.generation,
      processStartToken: capability.processStartToken,
      launchIdentity: capability.launchIdentity,
      rootDevice: capability.rootDevice,
      rootInode: capability.rootInode,
      lockIdentity,
      nonce,
      metadata: snapshot,
    });
    assertPrivateRecoveryPaths(root, capability);
    atomicWritePrivate(requestPath, request);

    const deadline = Date.now() + 7000;
    let nextNotify = Date.now() + 250;
    let result: RecoveryResult | null = null;
    while (Date.now() < deadline) {
      try {
        const candidate = readBoundedJson<RecoveryResult>(resultPath);
        if (candidate.nonce === nonce) {
          result = candidate;
          break;
        }
      } catch {}
      if (Date.now() >= nextNotify) {
        assertPrivateRecoveryPaths(root, capability);
        atomicWritePrivate(requestPath, request);
        nextNotify = Date.now() + 250;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!result) throw new Error("supporting daemon did not answer recovery request");
    if (!verifyRecoveryResult(capability.secret, result)) {
      throw new Error("daemon recovery response authentication failed");
    }
    if (!result.ok) throw new Error(result.error ?? "daemon refused recovery");
    if (
      result.daemonPid !== snapshot.daemonPid ||
      result.generation !== snapshot.generation ||
      result.processStartToken !== capability.processStartToken ||
      result.launchIdentity !== capability.launchIdentity
    ) {
      throw new Error("daemon recovery response changed identity");
    }

    const current = readMetadata(name);
    if (
      !current ||
      current.daemonPid !== snapshot.daemonPid ||
      current.generation !== snapshot.generation ||
      current.recovery?.processStartToken !== capability.processStartToken ||
      current.recovery.launchIdentity !== capability.launchIdentity
    ) {
      throw new Error("republished metadata changed identity");
    }
    const stats = await queryStats(name);
    if (stats.daemon.pid !== snapshot.daemonPid) {
      throw new Error("republished socket reached a different daemon");
    }
    console.log(`Session "${name}" registry recovered without restart.`);
  } finally {
    try {
      assertPrivateRecoveryPaths(root, capability);
      try { fs.unlinkSync(requestPath); } catch {}
      try { fs.unlinkSync(resultPath); } catch {}
    } catch {}
    releaseRecoveryLock(name, lockContents);
  }
}

function renameUsage(): void {
  // Single source of truth: the same text `pty rename --help` prints, to stderr
  // for the error paths.
  console.error(COMMAND_HELP.rename);
}

async function cmdMetadata(rawArgs: string[]): Promise<void> {
  if (rawArgs[0] === "patch" && (rawArgs[1] === "-h" || rawArgs[1] === "--help")) {
    printCommandHelp("metadata");
    return;
  }
  if (rawArgs[0] !== "patch") {
    console.error('pty metadata: expected subcommand "patch".');
    console.error("  Usage: pty metadata patch --id <stable-id>");
    process.exit(1);
  }

  let id: string | null = null;
  for (let i = 1; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--id") {
      const value = rawArgs[++i];
      if (!value) {
        console.error("pty metadata patch: --id requires a stable session id.");
        process.exit(1);
      }
      if (id !== null) {
        console.error("pty metadata patch: --id may only be provided once.");
        process.exit(1);
      }
      id = value;
    } else {
      console.error(`pty metadata patch: unexpected argument "${arg}".`);
      console.error("  Usage: pty metadata patch --id <stable-id>");
      process.exit(1);
    }
  }
  if (id === null) {
    console.error("pty metadata patch: missing required --id <stable-id>.");
    process.exit(1);
  }

  const input = fs.readFileSync(0, "utf-8").trim();
  if (input.length === 0) {
    console.error("pty metadata patch: expected one JSON patch object on stdin.");
    console.error('  Example: printf \'%s\' \'{"displayName":"Worker"}\' | pty metadata patch --id a1b2c3d4');
    process.exit(1);
  }

  let patch: unknown;
  try {
    patch = JSON.parse(input);
  } catch (e) {
    console.error(`pty metadata patch: invalid JSON on stdin: ${(e as Error).message}`);
    process.exit(1);
  }

  try {
    const result = await patchMetadataById(id, patch as any);
    console.log(JSON.stringify(result));
  } catch (e) {
    console.error(`pty metadata patch: ${(e as Error).message}`);
    process.exit(1);
  }
}

async function cmdEvidence(rawArgs: string[]): Promise<void> {
  const operation = rawArgs[0];
  if (operation !== "snapshot" && operation !== "remove") {
    console.error('pty evidence: expected subcommand "snapshot" or "remove".');
    console.error("  Usage: pty evidence snapshot --id <stable-id>");
    console.error("         pty evidence remove --id <stable-id> --expected-generation <opaque>");
    process.exit(1);
  }
  if (
    rawArgs.length === 2 &&
    (rawArgs[1] === "-h" || rawArgs[1] === "--help")
  ) {
    console.log(EVIDENCE_LEAF_HELP[operation]);
    return;
  }

  let id: string | null = null;
  let expectedGeneration: string | null = null;
  for (let i = 1; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--id") {
      const value = rawArgs[++i];
      if (!value) throw new Error("pty evidence: --id requires a stable session id.");
      if (id !== null) throw new Error("pty evidence: --id may only be provided once.");
      id = value;
    } else if (arg === "--expected-generation") {
      const value = rawArgs[++i];
      if (!value) throw new Error("pty evidence: --expected-generation requires an opaque generation.");
      if (expectedGeneration !== null) {
        throw new Error("pty evidence: --expected-generation may only be provided once.");
      }
      expectedGeneration = value;
    } else {
      throw new Error(`pty evidence: unexpected argument "${arg}".`);
    }
  }

  if (id === null) throw new Error("pty evidence: missing required --id <stable-id>.");
  if (operation === "snapshot") {
    if (expectedGeneration !== null) {
      throw new Error("pty evidence snapshot: --expected-generation is only valid for remove.");
    }
    fs.writeFileSync(1, `${JSON.stringify(await getSessionExitEvidence(id))}\n`);
    return;
  }
  if (expectedGeneration === null) {
    throw new Error("pty evidence remove: missing required --expected-generation <opaque>.");
  }
  fs.writeFileSync(1, `${JSON.stringify(await removeSessionGeneration(id, expectedGeneration))}\n`);
}

async function cmdRename(rawArgs: string[]): Promise<void> {
  const insideSession = !!process.env.PTY_SESSION;

  // Parse flags
  let show = false;
  let clear = false;
  const positional: string[] = [];
  for (const a of rawArgs) {
    if (a === "--show") show = true;
    else if (a === "--clear") clear = true;
    else if (a === "-h" || a === "--help") { renameUsage(); return; }
    else positional.push(a);
  }

  // --show <ref>
  if (show) {
    if (positional.length !== 1) {
      console.error("pty rename --show requires exactly one ref.");
      renameUsage();
      process.exit(1);
    }
    const session = await getSession(positional[0]);
    if (!session) {
      console.error(`Session "${positional[0]}" not found.`);
      process.exit(1);
    }
    const dn = session.metadata?.displayName;
    if (dn) {
      console.log(dn);
    } else {
      console.log(`(no displayName; session is referenced by its id: ${session.name})`);
    }
    return;
  }

  // --clear
  if (clear) {
    let targetName: string;
    if (positional.length === 0) {
      if (!insideSession) {
        console.error("pty rename --clear with no ref requires being inside a pty session (PTY_SESSION not set).");
        renameUsage();
        process.exit(1);
      }
      targetName = process.env.PTY_SESSION!;
    } else if (positional.length === 1) {
      const session = await getSession(positional[0]);
      if (!session) {
        console.error(`Session "${positional[0]}" not found.`);
        process.exit(1);
      }
      targetName = session.name;
    } else {
      console.error("pty rename --clear takes at most one ref.");
      renameUsage();
      process.exit(1);
    }
    try {
      setDisplayName(targetName, null);
      console.log(`Cleared displayName on "${targetName}".`);
    } catch (e: any) {
      console.error(e.message);
      process.exit(1);
    }
    return;
  }

  // Set form — resolve target and new display
  let targetName: string;
  let newDisplay: string;
  if (positional.length === 1) {
    if (!insideSession) {
      console.error("pty rename with a single arg is only allowed inside a pty session.");
      console.error("Outside, use: pty rename <ref> <new-display-name>");
      renameUsage();
      process.exit(1);
    }
    targetName = process.env.PTY_SESSION!;
    newDisplay = positional[0];
  } else if (positional.length === 2) {
    const session = await getSession(positional[0]);
    if (!session) {
      console.error(`Session "${positional[0]}" not found.`);
      process.exit(1);
    }
    targetName = session.name;
    newDisplay = positional[1];
  } else {
    renameUsage();
    process.exit(1);
  }

  // Display names are bounded, single-line presentation metadata. The on-disk
  // id (`name`) carries the strict charset and sock-path-length constraint.
  try {
    validateDisplayName(newDisplay);
  } catch (e: any) {
    console.error(`Invalid displayName: ${e.message}`);
    process.exit(1);
  }

  try {
    setDisplayName(targetName, newDisplay);
    console.log(`Set displayName on "${targetName}" → "${newDisplay}".`);
  } catch (e: any) {
    console.error(e.message);
    process.exit(1);
  }
}

async function cmdRm(name: string): Promise<void> {
  const session = await getSession(name);

  if (!session) {
    console.error(`Session "${name}" not found.`);
    process.exit(1);
  }

  if (session.status === "running") {
    console.error(`Session "${name}" is still running. Use "pty kill ${name}" first.`);
    process.exit(1);
  }

  // `exited` means the child is gone, not necessarily the daemon: the daemon
  // deliberately keeps its socket alive for 500ms so attached clients receive
  // the exit packet, then performs deferred cleanup. Returning success before
  // that process exits lets an immediate same-name `pty run` publish a new
  // socket/pid which the old daemon can unlink. Wait on the old generation's
  // recorded daemon PID; the 5s shutdown backstop makes 7s a real bound rather
  // than an arbitrary sleep. On timeout, do not claim removal succeeded.
  const generation = session.metadata?.generation;
  const daemonPid =
    session.pid ??
    session.metadata?.daemonPid ??
    readSessionPid(name);
  if (daemonPid !== null && daemonPid !== undefined) {
    const exited = await waitForProcessExit(daemonPid, 7000);
    if (!exited) {
      console.error(
        `Session "${name}" daemon did not exit within 7s; not removed. Try again.`,
      );
      process.exit(1);
    }
  }

  // Take the creation lock and re-check generation ownership in the same
  // critical section as the unlink. This closes both sides of the race: a
  // replacement already published is rejected, and a replacement cannot
  // publish between our check and cleanup. The empty generation / -1 PID
  // fallbacks keep pre-generation metadata removable while still refusing a
  // newly published generation.
  const removed = cleanupOwnedAll(name, {
    generation: generation ?? "",
    pid: daemonPid ?? -1,
  });
  if (!removed) {
    console.error(`Session "${name}" was replaced while waiting; new generation was not removed.`);
    process.exit(1);
  }

  console.log(`Session "${name}" removed.`);
}

async function cmdGc(opts: {
  dryRun: boolean;
  idleDays?: number;
  fastFailWindowSec?: number;
  fastFailLimit?: number;
  keepMaxAgeMs?: number;
}): Promise<void> {
  const { dryRun } = opts;
  const result = await gc(opts);
  const keepMaxAgeMs = opts.keepMaxAgeMs ?? DEFAULT_KEEP_MAX_AGE_MS;
  const prunedTags = await pruneOrphanLayoutTags({ dryRun });

  const killedVerb = dryRun ? "Would kill orphan child" : "Killed orphan child";
  const abandonVerb = dryRun ? "Would abandon" : "Abandoned";
  const respawnVerb = dryRun ? "Would respawn" : "Respawned";
  const flapVerb = dryRun ? "Would flap" : "Flapping";
  const removeVerb = dryRun ? "Would remove" : "Removed";
  const prunedVerb = dryRun ? "Would prune" : "Pruned";

  for (const k of result.killedOrphanChildren) {
    console.log(`${killedVerb}: ${k.name} (parent ${k.parent} ${k.reason})`);
  }
  for (const a of result.abandoned) {
    const detail = a.reason === "idle" && a.idleDays !== undefined
      ? `idle ${a.idleDays}d`
      : a.reason;
    console.log(`${abandonVerb}: ${a.name} (${detail})`);
  }
  for (const skipped of result.reapSkipped) {
    const phase = skipped.signalled ? "after signalling" : "before signalling";
    console.log(
      `Skipped ${skipped.operation} reap: ${skipped.name} (${skipped.reason}, ${phase})`,
    );
  }
  for (const r of result.respawned) {
    const note = r.ptyfileReread ? " (pty.toml re-read)" : "";
    console.log(`${respawnVerb}: ${r.name}${note}`);
  }
  for (const f of result.respawnFailed) {
    console.log(`Respawn failed: ${f.name} — ${f.error}`);
  }
  for (const fl of result.flapped) {
    console.log(
      `${flapVerb}: ${fl.name} (${fl.counter} fast-fails in ${fl.window}s, limit ${fl.limit})`,
    );
  }
  for (const name of result.flappingSkipped) {
    console.log(
      `Skipped (flapping): ${name} — remove strategy.status tag to retry`,
    );
  }
  for (const name of result.removed) {
    console.log(`${removeVerb}: ${name}`);
  }
  // Reported apart from the plain sweep above: an operator who tagged these
  // sessions asked for them to survive, so the reason they went away anyway
  // has to be visible rather than looking like the keep tag was ignored.
  for (const name of result.keepExpired) {
    console.log(
      `${removeVerb} (keep expired after ${formatDuration(keepMaxAgeMs)}): ${name}`,
    );
  }
  // Deliberately NOT counted as an action below: a kept session is a
  // no-op. It is printed anyway so "why is this dead session still
  // listed?" has a visible answer instead of looking like a gc bug.
  for (const name of result.kept) {
    console.log(
      `Kept (keep tag): ${name} — swept once dead for ${formatDuration(keepMaxAgeMs)}, or remove the keep tag to reap it now`,
    );
  }
  for (const { name, removedKeys } of prunedTags) {
    console.log(
      `${prunedVerb} orphan tags on ${name}: ${removedKeys.map((k) => `#${k}`).join(" ")}`,
    );
  }

  const totalTags = prunedTags.reduce((sum, r) => sum + r.removedKeys.length, 0);
  const totalActions =
    result.killedOrphanChildren.length +
    result.abandoned.length +
    result.reapSkipped.length +
    result.respawned.length +
    result.respawnFailed.length +
    result.flapped.length +
    result.flappingSkipped.length +
    result.removed.length +
    result.keepExpired.length +
    totalTags;

  if (totalActions === 0) {
    console.log(dryRun ? "Nothing would be cleaned up." : "Nothing to clean up.");
    return;
  }

  const parts: string[] = [];
  if (result.killedOrphanChildren.length > 0) {
    parts.push(`${result.killedOrphanChildren.length} orphan child${result.killedOrphanChildren.length === 1 ? "" : "ren"}`);
  }
  if (result.abandoned.length > 0) {
    parts.push(`${result.abandoned.length} abandoned`);
  }
  if (result.reapSkipped.length > 0) {
    parts.push(`${result.reapSkipped.length} reap skip${result.reapSkipped.length === 1 ? "" : "s"}`);
  }
  if (result.respawned.length > 0) {
    parts.push(`${result.respawned.length} respawn${result.respawned.length === 1 ? "" : "s"}`);
  }
  if (result.respawnFailed.length > 0) {
    parts.push(`${result.respawnFailed.length} respawn failure${result.respawnFailed.length === 1 ? "" : "s"}`);
  }
  if (result.flapped.length > 0) {
    parts.push(`${result.flapped.length} flapping`);
  }
  if (result.flappingSkipped.length > 0) {
    parts.push(`${result.flappingSkipped.length} skipped-flapping`);
  }
  if (result.removed.length > 0) {
    parts.push(`${result.removed.length} stale session${result.removed.length === 1 ? "" : "s"}`);
  }
  if (result.keepExpired.length > 0) {
    parts.push(`${result.keepExpired.length} keep-expired session${result.keepExpired.length === 1 ? "" : "s"}`);
  }
  if (totalTags > 0) {
    parts.push(`${totalTags} orphan tag${totalTags === 1 ? "" : "s"}`);
  }
  console.log(
    dryRun
      ? `Would clean up ${parts.join(", ")}. (Dry run — no changes made.)`
      : `Cleaned up ${parts.join(", ")}.`,
  );
}

/** Print a minimal launchd plist that runs `pty gc` every `interval`
 *  seconds. Pure stdout — the caller redirects to
 *  `~/Library/LaunchAgents/com.compoundingtech.pty.gc.plist` and `launchctl load`s
 *  it themselves. No FDA dance, no bundled binary; just node + the gc
 *  command, inheriting PATH and PTY_SESSION_DIR. If the SSD where node
 *  lives isn't mounted at boot, the invocation fails — the next tick
 *  tries again. That's the whole point. */
/** Launchd `Label` values are reverse-DNS strings; the docs require
 *  each service to have a unique label. When emitting per-network gc
 *  plists we suffix the label with the root's basename so N networks
 *  install N distinct services. Non-URL-safe characters (spaces,
 *  slashes, etc.) collapse to a single hyphen so a pathological root
 *  name can't produce a plist launchd rejects. */
function labelBasenameFromRoot(sessionDir: string): string {
  return path
    .basename(sessionDir)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function printLaunchdPlist(interval: number): void {
  const sessionDir = getSessionDir();
  const isDefault = sessionDir === DEFAULT_SESSION_DIR;
  // Default root keeps the pre-Phase-2 label untouched so existing
  // installs (`launchctl load ... com.compoundingtech.pty.gc.plist`) survive
  // an upgrade. Non-default roots get a suffixed label so two networks
  // can each install their own plist without a `Label` collision.
  const suffix = isDefault ? "" : `.${labelBasenameFromRoot(sessionDir)}`;
  const label = `com.compoundingtech.pty.gc${suffix}`;
  // Per-root log so a network's gc noise stays inside its own registry.
  const logPath = path.join(sessionDir, "gc.log");
  const ptyBin = process.argv[1];
  const envPath = process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin";
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // We point ProgramArguments at node + the invoked launcher or CLI script so
  // the plist doesn't depend on the `pty` shim staying on PATH at launchd's
  // (minimal) shell. EnvironmentVariables still carries PATH so the
  // spawned children (and any `which` inside pty itself) find the user's
  // tools. PTY_ROOT (canonical) pins the target registry.
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escape(process.execPath)}</string>
    <string>${escape(ptyBin)}</string>
    <string>gc</string>
  </array>
  <key>StartInterval</key>
  <integer>${interval}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escape(logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escape(envPath)}</string>
    <key>PTY_ROOT</key>
    <string>${escape(sessionDir)}</string>
  </dict>
</dict>
</plist>
`;
  process.stdout.write(plist);
}

// --- tag-multi: read/write tags across multiple sessions in one call ---
//
// Three selectors (mutually exclusive):
//   <name>...               explicit list (resolved up-front; any unresolvable
//                           name aborts before any write)
//   --filter-tag k=v ...    sessions whose tags match all listed pairs
//   --all                   every session
//
// No ops = read mode (per-session tag dump, text or --json). Any ops
// (`k=v` / `--rm k`) = write mode; --all + write mode requires --yes
// because it operates on every session in the dir.

interface TagMultiParsed {
  selector:
    | { kind: "names"; names: string[] }
    | { kind: "filter"; filterTags: Record<string, string> }
    | { kind: "all" };
  ops: { updates: Record<string, string>; removals: string[] };
  json: boolean;
  yes: boolean;
}

function parseTagMultiArgs(argv: string[]): TagMultiParsed {
  let all = false;
  const filterTags: Record<string, string> = {};
  const names: string[] = [];
  const updates: Record<string, string> = {};
  const removals: string[] = [];
  let json = false;
  let yes = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") { all = true; continue; }
    if (a === "--json") { json = true; continue; }
    if (a === "--yes" || a === "-y") { yes = true; continue; }
    if (a === "-h" || a === "--help") {
      printTagMultiHelp();
      process.exit(0);
    }
    if (a === "--filter-tag") {
      if (i + 1 >= argv.length) {
        console.error("pty tag-multi: --filter-tag requires k=v");
        process.exit(1);
      }
      const next = argv[++i];
      const eq = next.indexOf("=");
      if (eq === -1) {
        console.error(`pty tag-multi: --filter-tag value "${next}" must be k=v`);
        process.exit(1);
      }
      const k = next.slice(0, eq);
      if (k === "") {
        console.error("pty tag-multi: --filter-tag key must be non-empty");
        process.exit(1);
      }
      filterTags[k] = next.slice(eq + 1);
      continue;
    }
    if (a === "--rm") {
      if (i + 1 >= argv.length) {
        console.error("pty tag-multi: --rm requires a key (e.g. --rm role)");
        process.exit(1);
      }
      const k = argv[++i];
      if (k === "") {
        console.error("pty tag-multi: --rm requires a non-empty key");
        process.exit(1);
      }
      removals.push(k);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq !== -1) {
      const k = a.slice(0, eq);
      if (k === "") {
        console.error(`pty tag-multi: empty key in "${a}". Tag keys must be non-empty.`);
        process.exit(1);
      }
      updates[k] = a.slice(eq + 1);
      continue;
    }
    // Anything else is a positional session name. validateName will catch
    // illegal characters at resolution time.
    names.push(a);
  }

  // Selector mutex check.
  const selectorCount =
    (all ? 1 : 0) +
    (Object.keys(filterTags).length > 0 ? 1 : 0) +
    (names.length > 0 ? 1 : 0);
  if (selectorCount === 0) {
    console.error(
      "pty tag-multi: no selector — pass session names, --filter-tag k=v, or --all",
    );
    process.exit(1);
  }
  if (selectorCount > 1) {
    console.error(
      "pty tag-multi: selectors are mutually exclusive — pick one of <names>, --filter-tag, --all",
    );
    process.exit(1);
  }

  let selector: TagMultiParsed["selector"];
  if (all) selector = { kind: "all" };
  else if (Object.keys(filterTags).length > 0) selector = { kind: "filter", filterTags };
  else selector = { kind: "names", names };

  return { selector, ops: { updates, removals }, json, yes };
}

async function cmdTagMulti(argv: string[]): Promise<void> {
  const parsed = parseTagMultiArgs(argv);
  const isWrite =
    Object.keys(parsed.ops.updates).length > 0 || parsed.ops.removals.length > 0;

  // Resolve selector → list of stable session ids. Explicit names are
  // resolved up-front so an unresolvable name aborts before any writes.
  let targets: string[];
  if (parsed.selector.kind === "names") {
    targets = [];
    for (const ref of parsed.selector.names) {
      const sess = await getSession(ref);
      if (!sess) {
        console.error(`pty tag-multi: session "${ref}" not found.`);
        process.exit(1);
      }
      targets.push(sess.name);
    }
  } else if (parsed.selector.kind === "filter") {
    const all = await listSessions();
    targets = all
      .filter((s) => matchesAllTags(s.metadata?.tags, parsed.selector.kind === "filter" ? parsed.selector.filterTags : {}))
      .map((s) => s.name);
  } else {
    // --all
    if (isWrite && !parsed.yes) {
      const all = await listSessions();
      console.error(
        `pty tag-multi: --all writes are destructive across ${all.length} session(s). Re-run with --yes to apply.`,
      );
      process.exit(1);
    }
    const all = await listSessions();
    targets = all.map((s) => s.name);
  }

  // Read mode: collect per-session tags into an object.
  if (!isWrite) {
    const out: Record<string, Record<string, string>> = {};
    for (const name of targets) {
      const meta = readMetadata(name);
      out[name] = meta?.tags ?? {};
    }
    if (parsed.json) {
      console.log(JSON.stringify(out));
      return;
    }
    if (targets.length === 0) {
      console.log("0 sessions matched.");
      return;
    }
    for (const name of targets) {
      const tags = out[name];
      const keys = Object.keys(tags);
      if (keys.length === 0) {
        console.log(`${name}: (no tags)`);
        continue;
      }
      console.log(`${name}:`);
      for (const k of keys) console.log(`  ${k}=${tags[k]}`);
    }
    return;
  }

  // Write mode: apply per-session, continue on error, exit 1 if any failed.
  if (targets.length === 0) {
    if (parsed.json) {
      console.log(JSON.stringify({}));
    } else {
      console.log("0 sessions matched. No writes performed.");
    }
    return;
  }
  const results: Record<string, Record<string, string>> = {};
  const errors: { name: string; message: string }[] = [];
  for (const name of targets) {
    try {
      updateTags(name, parsed.ops.updates, parsed.ops.removals);
      const meta = readMetadata(name);
      results[name] = meta?.tags ?? {};
    } catch (e: any) {
      errors.push({ name, message: e.message ?? String(e) });
    }
  }
  if (parsed.json) {
    console.log(JSON.stringify(results));
  } else {
    const changed = Object.keys(results).length;
    console.log(`${changed} session(s) processed.`);
  }
  if (errors.length > 0) {
    for (const e of errors) {
      console.error(`pty tag-multi: ${e.name}: ${e.message}`);
    }
    process.exit(1);
  }
}

function printTagMultiHelp(): void {
  console.log(`Usage:
  pty tag-multi <selector> [--json] [--yes] [<ops>...]

Selectors (pick one):
  <name>...                explicit list of session names or displayNames
  --filter-tag k=v         sessions matching tag (repeatable for AND)
  --all                    every session

Operations (presence flips command into write mode):
  k=v                      set tag k to v
  --rm k                   remove tag k

Flags:
  --json                   structured output (object: name → tags)
  --yes / -y               required with --all when ops are present

Examples:
  pty tag-multi --all --json
  pty tag-multi --filter-tag role=web env=prod
  pty tag-multi sess-a sess-b --rm temp-flag
  pty tag-multi --all --yes audit=2026-04-25`);
}

// --- emit: publish a user.* event to a session's events log ---

async function cmdEmit(argv: string[]): Promise<void> {
  // pty emit <type> [--json <payload>] [--text <string>]
  // pty emit <ref> <type> [--json <payload>] [--text <string>]
  // Inside a session, $PTY_SESSION provides the default ref.
  let ref: string | null = null;
  let type: string | null = null;
  let jsonStr: string | null = null;
  let textStr: string | null = null;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json" && i + 1 < argv.length) { jsonStr = argv[++i]; continue; }
    if (a === "--text" && i + 1 < argv.length) { textStr = argv[++i]; continue; }
    if (a === "-h" || a === "--help") {
      printEmitHelp();
      return;
    }
    positional.push(a);
  }

  if (positional.length === 2) { ref = positional[0]; type = positional[1]; }
  else if (positional.length === 1) { ref = null; type = positional[0]; }
  else {
    printEmitHelp();
    process.exit(1);
  }

  // Default to $PTY_SESSION when no explicit ref given.
  if (ref == null) ref = process.env.PTY_SESSION ?? null;
  if (!ref) {
    console.error("pty emit: no session ref given and not running inside a pty session");
    console.error("  tip: run inside a pty session, or: pty emit <session-ref> <type>");
    process.exit(1);
  }

  const resolvedName = await resolveRef(ref);

  let data: unknown;
  if (jsonStr != null) {
    try { data = JSON.parse(jsonStr); }
    catch (e: any) {
      console.error(`pty emit: --json payload is not valid JSON: ${e.message}`);
      process.exit(1);
    }
  }

  try {
    const event = await emitUserEvent(resolvedName, type!, {
      ...(data !== undefined ? { data } : {}),
      ...(textStr != null ? { text: textStr } : {}),
    });
    // Silent by default; -v isn't implemented. Return the type so scripts
    // can chain `pty emit ... | ...` if they want.
    void event;
  } catch (e: any) {
    console.error(e.message);
    process.exit(1);
  }
}

function printEmitHelp(): void {
  // Single source of truth: same text as `pty emit --help`.
  console.log(COMMAND_HELP.emit);
}

// (state / wrap / unwrap removed in the lean-core pass — smalltalk's
//  folder + bus own agent state; wrap was orthogonal shim generation
//  that isn't part of the session-primitive contract.)


function hasPtyFile(dir: string): boolean {
  try {
    return fs.statSync(path.join(path.resolve(dir), "pty.toml")).isFile();
  } catch {
    return false;
  }
}

async function cmdUp(dir: string | undefined, names: string[]): Promise<void> {
  let ptyFile;
  try {
    ptyFile = readPtyFile(dir);
  } catch (e: any) {
    console.error(e.message);
    process.exit(1);
  }

  let sessions = ptyFile.sessions;
  if (names.length > 0) {
    const nameSet = new Set(names);
    const matchesName = (s: PtySessionDef) => nameSet.has(s.displayName) || nameSet.has(s.shortName);
    const unknown = names.filter((n) => !sessions.some((s) => s.displayName === n || s.shortName === n));
    if (unknown.length > 0) {
      console.error(`Unknown session${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);
      console.error(`Available: ${sessions.map((s) => s.shortName).join(", ")}`);
      process.exit(1);
    }
    sessions = sessions.filter(matchesName);
  }

  const tomlPath = path.join(ptyFile.dir, "pty.toml");
  const existing = await listSessions();
  /** Find an existing session that came from this same (ptyfile, ptyfile.session)
   *  pair. The toml-derived displayName is just a label; identity is the tag
   *  pair, so renaming a session or hitting a long-name collision doesn't lose
   *  the binding. */
  const findByTags = (shortName: string) => existing.find((s) =>
    s.metadata?.tags?.ptyfile === tomlPath &&
    s.metadata?.tags?.["ptyfile.session"] === shortName
  );
  const allNameSet = await allSessionNames();

  let started = 0;
  let skipped = 0;

  for (const sess of sessions) {
    const userTomlKeys = Object.keys(sess.tags ?? {}).sort();
    const ptyfileTagsValue = userTomlKeys.join(",");
    const tomlTags: Record<string, string> = {
      ...sess.tags,
      ptyfile: tomlPath,
      "ptyfile.session": sess.shortName,
      "ptyfile.tags": ptyfileTagsValue,
    };

    const bound = findByTags(sess.shortName);

    if (bound && bound.status === "running") {
      // Sync tags from toml to the running session (including ptyfile metadata).
      // Track which tag keys came from the toml via "ptyfile.tags" so that
      // removing a tag from the toml causes it to be removed here (but
      // manually-added tags — those not in "ptyfile.tags" — are preserved).
      const currentTags = bound.metadata?.tags ?? {};

      const updates: Record<string, string> = {};
      for (const [k, v] of Object.entries(tomlTags)) {
        if (currentTags[k] !== v) updates[k] = v;
      }

      const prevTomlKeys = (currentTags["ptyfile.tags"] ?? "")
        .split(",")
        .map((k) => k.trim())
        .filter((k) => k.length > 0);
      const newKeySet = new Set(userTomlKeys);
      const removals = prevTomlKeys.filter((k) => !newKeySet.has(k));

      // Manual `pty up` is an operator "reset" signal, same shape as
      // `pty restart` in cmdRestart above. Drop any `pty gc` flapping
      // bookkeeping the session may have accumulated so a re-`pty up`
      // gives the session a clean slate. These keys are gc-owned, never
      // toml-declared, so they aren't in `prevTomlKeys`.
      for (const k of [
        "strategy.status",
        "strategy.consecutive-fast-fails",
        "strategy.last-respawn-at",
        "strategy.command-hash",
      ]) {
        if (currentTags[k] !== undefined && !removals.includes(k)) removals.push(k);
      }

      const label = bound.metadata?.displayName ?? bound.name;
      if (Object.keys(updates).length > 0 || removals.length > 0) {
        try {
          updateTags(bound.name, updates, removals);
          const changedTagUpdates = Object.entries(updates)
            .filter(([k]) => k !== "ptyfile" && k !== "ptyfile.session" && k !== "ptyfile.tags")
            .map(([k, v]) => `${k}=${v}`);
          const changedRemovals = removals.map((k) => `-${k}`);
          const changed = [...changedTagUpdates, ...changedRemovals].join(", ");
          if (changed) {
            console.log(`  ● ${label} (already running, updated tags: ${changed})`);
          } else {
            console.log(`  ● ${label} (already running)`);
          }
        } catch {
          console.log(`  ● ${label} (already running)`);
        }
      } else {
        console.log(`  ● ${label} (already running)`);
      }
      skipped++;
      continue;
    }

    // Clean up an exited bound session so its slot can be reused.
    if (bound && isGone(bound.status)) {
      const label = bound.metadata?.displayName ?? bound.name;
      try {
        cleanupAll(bound.name);
      } catch (error) {
        console.error(`  ✗ ${label}: ${(error as Error).message}`);
        skipped++;
        continue;
      }
    }

    // Pick the on-disk id: honor the pty.toml's `id = "..."` if set,
    // otherwise generate a random one. Either way validate before spawn so
    // long pinned ids fail with a clear up-front error.
    let name: string;
    if (sess.id) {
      try {
        validateName(sess.id);
      } catch (e: any) {
        console.error(`  ✗ ${sess.displayName}: ${e.message}`);
        continue;
      }
      if (allNameSet.has(sess.id)) {
        console.error(`  ✗ ${sess.displayName}: id "${sess.id}" is already in use.`);
        continue;
      }
      name = sess.id;
      allNameSet.add(sess.id);
    } else {
      let candidate: string | null = null;
      for (let attempt = 0; attempt < 8; attempt++) {
        const c = randomSessionName();
        if (!allNameSet.has(c)) { candidate = c; allNameSet.add(c); break; }
      }
      if (!candidate) {
        console.error(`  ✗ ${sess.displayName}: could not generate a unique session id after 8 attempts.`);
        continue;
      }
      name = candidate;
    }

    // Validate the toml-derived displayName once. Default `<prefix>-<short>`
    // is always safe; an explicit `display_name` field could be anything.
    try {
      validateDisplayName(sess.displayName);
    } catch (e: any) {
      console.error(`  ✗ ${sess.displayName}: ${e.message}`);
      continue;
    }

    try {
      await spawnDaemon({
        name,
        command: "/bin/sh",
        args: ["-c", sess.command],
        displayCommand: sess.command,
        cwd: sess.cwd ?? ptyFile.dir,
        tags: tomlTags,
        displayName: sess.displayName,
        ...(sess.env && Object.keys(sess.env).length > 0 ? { extraEnv: sess.env } : {}),
      });
      console.log(`  ● ${sess.displayName} (started)`);
      started++;
    } catch (e: any) {
      console.error(`  ✗ ${sess.displayName}: ${e.message}`);
    }
  }

  if (started === 0 && skipped === sessions.length) {
    console.log("All sessions already running.");
  } else if (started > 0) {
    console.log(`Started ${started} session${started === 1 ? "" : "s"}.`);
  }
}

async function cmdDown(dir: string | undefined, names: string[]): Promise<void> {
  let ptyFile;
  try {
    ptyFile = readPtyFile(dir);
  } catch (e: any) {
    console.error(e.message);
    process.exit(1);
  }

  let sessions = ptyFile.sessions;
  if (names.length > 0) {
    const nameSet = new Set(names);
    sessions = sessions.filter((s) => nameSet.has(s.displayName) || nameSet.has(s.shortName));
  }

  const tomlPath = path.join(ptyFile.dir, "pty.toml");
  const existing = await listSessions();
  const findByTags = (shortName: string) => existing.find((s) =>
    s.metadata?.tags?.ptyfile === tomlPath &&
    s.metadata?.tags?.["ptyfile.session"] === shortName
  );
  let stopped = 0;

  for (const sess of sessions) {
    const existingSession = findByTags(sess.shortName);
    if (!existingSession) continue;

    const label = existingSession.metadata?.displayName ?? existingSession.name;

    // Strip the `strategy` tag so `pty gc` doesn't respawn the session
    // on its next tick. The `supervisor.status` tag is no longer a thing.
    const wasPermanent = existingSession.metadata?.tags?.strategy === "permanent";
    if (wasPermanent) {
      try {
        updateTags(existingSession.name, {}, ["strategy"]);
      } catch {}
    }

    if (existingSession.status === "running" && existingSession.pid) {
      try {
        process.kill(existingSession.pid, "SIGTERM");
        console.log(`  ○ ${label} (stopped${wasPermanent ? ", removed from supervision" : ""})`);
        stopped++;
      } catch {
        console.error(`  ✗ ${label}: failed to stop`);
      }
      cleanupSocket(existingSession.name);
    } else if (isGone(existingSession.status)) {
      try {
        cleanupAll(existingSession.name);
        console.log(`  ○ ${label} (cleaned up)`);
        stopped++;
      } catch (error) {
        console.error(`  ✗ ${label}: ${(error as Error).message}`);
      }
    }
  }

  if (stopped === 0) {
    console.log("No sessions to stop.");
  } else {
    console.log(`Stopped ${stopped} session${stopped === 1 ? "" : "s"}.`);
  }

  // Warn if any stopped sessions are toml-managed
  const anyTomlManaged = sessions.some((sess) => findByTags(sess.shortName)?.metadata?.tags?.ptyfile);
  if (anyTomlManaged && stopped > 0) {
    console.error("\nNote: strategy tags will be restored on the next 'pty up'.");
  }
}

/** Detect a session that should NOT be blindly `pty restart`ed: a stateful
 *  interactive agent. Two signals — a `role=agent` tag, or a `claude --resume`
 *  in the stored command. Returns a short human reason, or null. */
function statefulAgentReason(meta: SessionMetadata): string | null {
  if (meta.tags?.role === "agent") return "role=agent tag";
  const argv = [meta.command, ...(meta.args ?? []), meta.displayCommand].filter(Boolean).join(" ");
  if (/(^|\s|\/)claude(\s|$)/.test(argv) && /(^|\s)--resume(\s|=|$)/.test(argv)) {
    return "claude --resume command";
  }
  return null;
}

/** Bus-identity env vars stripped from an operator-initiated restart's re-exec.
 *  `pty restart` (and the dead-session "Restart? [Y/n]" path) re-run a stored
 *  command under the RESTARTER's shell env. If that shell belongs to a different
 *  convoy agent, its ST_AGENT/ST_ROOT leak into the re-exec'd session and it
 *  comes back under the wrong bus identity — the cos-restart incident, where
 *  restarting cos from smalltalk's shell brought cos back as smalltalk-claude
 *  (exit 129). Scrubbing them means a restarted session never inherits the
 *  restarter's identity; the blessed way to restart an agent with a correct
 *  identity is its supervisor (convoy). Fresh `pty run` is unaffected — a
 *  convoy-launched create legitimately inherits its own identity. */
const RESTART_SCRUBBED_ENV = ["ST_AGENT", "ST_ROOT"];

/** Recover the launch-time settings that are not part of the command/cwd/tag
 *  compatibility surface. Older metadata simply falls back to historical
 *  defaults because all fields are optional. */
function persistedLaunchOptions(meta: SessionMetadata) {
  return {
    ...(meta.rows !== undefined ? { rows: meta.rows } : {}),
    ...(meta.cols !== undefined ? { cols: meta.cols } : {}),
    ...(meta.ephemeral !== undefined ? { ephemeral: meta.ephemeral } : {}),
    ...(meta.isolateEnv ? { isolateEnv: true } : {}),
    ...(meta.extraEnv && Object.keys(meta.extraEnv).length > 0 ? { extraEnv: meta.extraEnv } : {}),
    ...(meta.unsetEnv && meta.unsetEnv.length > 0 ? { unsetEnv: meta.unsetEnv } : {}),
    ...(meta.env ? { env: meta.env } : {}),
  };
}

async function cmdRestart(
  name: string,
  yes = false,
  forceNested = false,
): Promise<void> {
  const session = await getSession(name);

  if (!session) {
    console.error(`Session "${name}" not found.`);
    process.exit(1);
  }

  const meta = session.metadata;
  if (!meta) {
    console.error(`Session "${name}" has no metadata — cannot restart.`);
    cleanupAll(name);
    process.exit(1);
  }

  // Guardrail: `pty restart` blindly re-runs the stored argv — fine for a
  // stateless daemon, a footgun for a stateful interactive agent. Restarting a
  // `claude --resume` agent kills its in-progress work AND can wedge the resume
  // (the re-exec races the old pts teardown; claude freezes on its exit screen
  // and the daemon orphans). Refuse for agent-shaped sessions unless --force —
  // the right way to cycle an agent is through its supervisor (e.g. convoy).
  const agentReason = statefulAgentReason(meta);
  if (agentReason && !forceNested) {
    console.error(`Session "${name}" looks like a stateful agent (${agentReason}).`);
    console.error(
      "`pty restart` kills its in-progress work and can wedge a `claude --resume`. " +
      "Cycle it through its supervisor (e.g. `convoy up`) instead — or pass --force to restart anyway."
    );
    process.exit(1);
  }

  if (session.status === "running" && session.pid) {
    if (!yes) {
      const answer = await ask(`Session "${name}" is running. Kill and restart? [Y/n] `);
      if (answer.toLowerCase() === "n") {
        process.exit(0);
      }
    }
    try {
      process.kill(session.pid, "SIGTERM");
    } catch {}
    cleanupSocket(name);
    // Wait briefly for the process to exit
    await new Promise((r) => setTimeout(r, 200));
  }

  cleanupAll(name);
  // Manual restart is an operator "please try again" signal — drop any
  // `strategy.status=flapping` mark and its bookkeeping so the fresh
  // spawn isn't skipped by `pty gc` on the next tick. Auto-reset on
  // command edit already clears these; this handles the operator-
  // intervenes-without-edit case that gc otherwise can't infer.
  const restartTags = clearFlappingBookkeeping(meta.tags);
  // Preserve the human-friendly displayName across the respawn — without it the
  // restarted session reads as its raw id (e.g. claude-203827) instead of its
  // name, which breaks naming + the TUI peek. Tags are carried above.
  await spawnDaemon({
    name, command: meta.command, args: meta.args, displayCommand: meta.displayCommand, cwd: meta.cwd, tags: restartTags,
    ...(meta.displayName ? { displayName: meta.displayName } : {}),
    ...persistedLaunchOptions(meta),
    scrubEnv: RESTART_SCRUBBED_ENV,
  });
  console.log(`Session "${name}" restarted.`);

  // Nesting guard: restart itself is fine, but attaching would nest a client
  // inside the current session. Print a note and bail unless --force.
  const nested = process.env.PTY_SESSION;
  if (nested && !forceNested) {
    console.log(`  (not attached: already inside pty session "${nested}". Pass --force to attach anyway.)`);
    return;
  }

  doAttach(name);
}

async function cmdEvents(
  name: string | null,
  opts: { all: boolean; recent: boolean; json: boolean; waitEventType: string | null; timeout: number }
): Promise<void> {
  if (opts.recent) {
    if (!name) {
      console.error("--recent requires a session name.");
      process.exit(1);
    }
    const events = readRecentEvents(name);
    if (events.length === 0) {
      console.log(`No recent events for "${name}".`);
      return;
    }
    for (const event of events) {
      console.log(opts.json ? JSON.stringify(event) : formatEvent(event));
    }
    return;
  }

  // Follow mode: verify session exists if a specific name was given
  if (name) {
    const session = await getSession(name);
    if (!session) {
      console.error(`Session "${name}" not found.`);
      process.exit(1);
    }
  }

  // Wait mode: block until a specific event type appears
  if (opts.waitEventType) {
    if (!name) {
      console.error("--wait requires a session name.");
      process.exit(1);
    }
    const timeoutMs = opts.timeout > 0 ? opts.timeout * 1000 : 0;
    const start = Date.now();

    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;

      const follower = new EventFollower({
        names: [name!],
        onEvent: (event) => {
          if (event.type === opts.waitEventType) {
            if (timer) clearTimeout(timer);
            console.log(opts.json ? JSON.stringify(event) : formatEvent(event));
            follower.stop();
            resolve();
          }
        },
      });

      follower.start();

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          follower.stop();
          console.error(`Timed out after ${opts.timeout}s waiting for "${opts.waitEventType}" event.`);
          process.exit(1);
        }, timeoutMs);
      }

      process.on("SIGINT", () => {
        follower.stop();
        process.exit(0);
      });
    });
  }

  const follower = new EventFollower({
    names: opts.all ? undefined : name ? [name] : undefined,
    onEvent: (event) => {
      console.log(opts.json ? JSON.stringify(event) : formatEvent(event));
    },
  });

  follower.start();

  process.on("SIGINT", () => {
    follower.stop();
    process.exit(0);
  });

  // Keep the process alive while watchers are active
  setInterval(() => {}, 60_000);
}

async function cmdTest(args: string[]): Promise<void> {
  const vitestBin = path.join(
    import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
    "..",
    "node_modules",
    ".bin",
    "vitest"
  );
  const vitestArgs = args.length === 0 ? ["run"] : args;
  const result = spawnSync(vitestBin, vitestArgs, {
    stdio: "inherit",
    env: process.env,
  });
  process.exit(result.status ?? 1);
}

function ask(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return rl.question(prompt).then((answer) => {
    rl.close();
    return answer;
  });
}

/** Strip `pty gc`'s flapping bookkeeping from a tag map before a manual
 *  restart / respawn. `strategy.status`, `strategy.consecutive-fast-fails`,
 *  `strategy.last-respawn-at`, and `strategy.command-hash` are all
 *  gc-owned — they exist to track auto-respawn state, and an operator
 *  action ("please try again") is a signal to reset them. Returns
 *  `undefined` when the input is missing/empty so downstream defaults
 *  (spawnDaemon skips the `tags` field entirely) apply. */
function clearFlappingBookkeeping(
  tags: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!tags || Object.keys(tags).length === 0) return tags;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) {
    if (k === "strategy.status") continue;
    if (k === "strategy.consecutive-fast-fails") continue;
    if (k === "strategy.last-respawn-at") continue;
    if (k === "strategy.command-hash") continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}


function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
