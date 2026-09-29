# pty

> **Beta** — the CLI and testing library are usable but the API may change before 1.0.

Persistent terminal sessions. Run a process, detach, reconnect later. From anywhere, locally and over SSH.

Uses [@xterm/headless](https://github.com/xtermjs/xterm.js/tree/master/headless) internally.

The durable system contract lives in
[docs/vrs](docs/vrs/spec.md).

## Install

```sh
npm install -g @compoundingtech/pty
```

Or install with Nix — see [nix.md](nix.md).

Requires Node.js. Works on macOS and Linux.

## Usage

Run `pty` with no arguments to launch the interactive session manager:

```
╭─ pty ────────────────────────────────────────────────────────────╮
│                                                                  │
│  Filter: (type to filter)                                        │
│                                                                  │
│  ● webserver      ~/projects/myapp          node server.js       │
│  ● worker         ~/projects/myapp          npm run worker       │
│  ● devlog         ~/projects/myapp          tail -f log/dev.log  │
│  ○ migrations     (exited 2h ago)           npm run migrate      │
│  + Create new session...                                         │
│                                                                  │
╰──────────────────────────────────────────────────────────────────╯
 ↑↓ select  ⏎ attach  q quit
```

Arrow keys to navigate, type to filter, Enter to attach, `q` to quit. When pty-relay is installed, remote sessions appear grouped by host. Use `host/session` syntax to filter by host (e.g., `prod/api`). Creating a new session walks through a directory picker and name/command prompt.

When you detach from a session entered via the interactive list (`Ctrl+\`), you return to the list. The session keeps running in the background.

### Commands

```sh
pty                                       # interactive session manager
pty --preselect-new                       # open the TUI with "Create new session..." selected
pty --filter-tag layout=work              # TUI filtered by tag; new sessions inherit the tag
pty run -- node server.js                          # random id + auto display label
pty run --id myserver -- node server.js            # pin an explicit on-disk id
pty run --name "My API Server" -- node server.js   # set an explicit display label (any length)
pty run --id api --name "My API" -- node server.js # pin both id and display label
pty run --no-display-name -- bash                  # random id, no friendly label
pty run -d -- node server.js                       # start in the background
pty run -a -- node server.js                       # create or attach if already running
pty run -e -- npm test                             # ephemeral: reap even on `pty kill` / permanent
pty run --tag owner=forge -- node srv.js           # tag a session with metadata
pty run --env PORT=3000 --env MODE=dev -- node srv.js # persisted child env overlay
pty run --unset-env NO_COLOR -- node srv.js           # persisted inherited-env removal
pty run --tag keep=true -- npm test                # keep it past a gc sweep for 7d after it dies
pty run --cwd /path -- node server.js              # run in a specific directory

pty rename my-label                       # inside a session: add/change its displayName
pty rename <ref> my-label                 # outside: set displayName on <ref>
pty rename --show <ref>                   # show current displayName
pty rename --clear [ref]                  # remove displayName
pty metadata patch --id myserver < patch.json # atomically patch displayName/tags by exact id

pty list                                  # show active sessions (tags shown by default)
pty list --tags                           # include internal bookkeeping tags (ptyfile*, strategy, etc.)
pty list --json                           # show as JSON
pty list --remote example-host            # list a fabric peer's sessions (over fabric)
pty list --remote                         # include remote sessions via pty-relay
pty list --filter-tag role=web            # show only sessions with matching tag (repeatable)

pty attach myserver                       # reconnect to a session
pty attach -r myserver                    # reconnect, auto-restart if exited
pty attach --no-restart myserver          # attach only; fail if not running
pty attach --attach-stream-fd-v1 3 myserver 3>events.bin  # framed machine stream
pty exec -- codex                         # replace this session's process (inside a session)
pty peek myserver                         # print current screen and exit
pty peek --plain myserver                 # print as plain text (no ANSI)
pty peek --full myserver                  # print full scrollback
pty peek --wait "Listening" myserver      # wait until text appears on screen
pty peek --wait "Ready" -t 10 myserver    # wait with timeout (seconds)
pty peek -f myserver                      # follow output read-only

pty send myserver "hello"                 # send text (no implicit newline)
pty send myserver $'hello\n'              # send text with newline (shell syntax)
pty send myserver --seq "git status" --seq key:return  # ordered sequence
pty send myserver --seq key:ctrl+c        # also: ctrl-c, ctrl_c, C-c
pty send myserver --paste "$(cat prompt.md)"           # wrap as bracketed paste

pty stats                                 # live metrics for all sessions
pty stats myserver                        # stats for a specific session
pty stats --json                          # effective geometry, anonymous clients, CPU/memory/PIDs

pty events myserver                       # follow events in real-time
pty events --all                          # follow events from all sessions
pty events --recent myserver              # show recent events and exit
pty events --json myserver                # output raw JSONL

pty emit user.deploy.started              # emit a user event (inside a session)
pty emit myserver user.build.finished --json '{"ok":true}'  # with JSON payload
pty emit myserver user.note --text "checkpoint reached"     # with a text payload

pty restart myserver                      # restart an exited session (must have been preserved)
pty kill myserver                         # terminate a running session and its descendants
pty --root /state/pty recover myserver --snapshot ./myserver.json  # rebind a live supporting daemon after external unlink
pty rm myserver                           # remove an exited session's metadata
pty gc                                    # reconcile: kill orphan children, respawn permanents, sweep vanished
pty gc --dry-run                          # preview what gc would do without changing anything
pty gc --print-launchd-plist > ~/Library/LaunchAgents/com.compoundingtech.pty.gc.plist   # install macOS auto-gc
pty tag myserver role=web env=prod        # set one or more tags on a session
pty tag myserver --rm role --rm env       # remove one or more tags
pty tag-multi --filter-tag role=web env=prod    # bulk write across matching sessions
pty tag-multi --all --json                # bulk read tags across every session
pty tag-multi --all --yes audit=today     # write to every session (--yes required)

pty up                                    # start all sessions from ./pty.toml
pty up ./backend                          # start sessions from ./backend/pty.toml
pty up claude dev                         # start specific sessions from ./pty.toml
pty down                                  # stop all sessions from ./pty.toml
pty down claude                           # stop specific sessions
```

Session ids are stable and unique. Display names are mutable presentation
labels and may be shared by multiple sessions. A command reference resolves an
exact stable id first, then a display name only when that label has one match.
Ambiguous display names fail without acting and print the candidate stable ids.
Use stable ids in scripts and automation.

For automation that must update presentation metadata without alias fallback,
`pty metadata patch --id <stable-id>` reads one merge-style JSON object from
stdin and returns `{ changed, metadata }` as JSON:

```sh
printf '%s' '{"displayName":"Worker","tags":{"role":"worker","old":null}}' \
  | pty metadata patch --id a1b2c3d4
```

`displayName` and individual tag values use strings to set and `null` to clear;
omitted fields and tag keys remain unchanged. The operation holds the session's
metadata lock across one read/merge/atomic-write cycle. It fails if the exact id
is absent, even when a display name has the same text.

### Remote over fabric

`pty list --remote <peer>` lists another machine's sessions over [fabric](https://github.com/compoundingtech/fabric), which hands consumers a plain local Unix socket — pty never touches iroh. The remote machine serves a small control protocol that fabric exposes under the `pty-remote` ALPN. The recommended form is **on-demand**: fabric spawns the handler per dial, pipes the connection to its stdin/stdout, and owns persistence + roaming (no persistent pty daemon):

```sh
# On the remote peer — fabric spawns `pty remote-serve --stdio` per dial:
fabric expose pty-remote --exec -- pty remote-serve --stdio
```

From any trusted peer, the ordinary session commands take `--remote <peer>` —
`<ref>` is a stable id or unambiguous display name **on the remote**:

```sh
pty list --remote <peer>                  # list the peer's sessions
pty peek --remote <peer> <ref>            # print its current screen (read-only; -f to follow)
pty send --remote <peer> <ref> --seq "ls" --seq key:return   # send input
pty attach --remote <peer> <ref>          # attach interactively (the resilient shell)
```

Under the hood, `remote-serve` routes each command's connection through to the target session's local socket, so the ordinary per-session protocol runs unchanged over the fabric hop. A pty session already persists on its daemon and replays its screen on attach — so `pty attach --remote` to a long-lived remote pty **is** a persistent remote shell.

`pty remote-serve --stdio` reads the ambient `PTY_ROOT`, so run it in the same environment the sessions use.

There is also a transitional **listening-daemon** form, `pty remote-serve --socket <path>` (`fabric expose pty-remote --socket <path>`), being retired in favor of `--stdio`. If you use it, give it a socket path **outside** `PTY_ROOT` (a control socket inside it would be mis-counted as a phantom session), and run it **wrapped** — under `sh -c`, systemd, launchd, or another supervisor — so the pty process is a *child* of the session leader (exec'd directly as the session leader with no controlling TTY, e.g. `setsid pty remote-serve --socket … </dev/null &`, it can exit on detach).

### Nesting Prevention

If you run `pty run` inside an existing pty session, pty detects the nesting via the `PTY_SESSION` environment variable and runs the command directly instead of creating a session-inside-a-session.

Use `pty run -d` to explicitly create a background session from inside another session.

### Session lifecycle and cleanup

What happens to a **non-`strategy=permanent`** session when its command finishes
is **configurable**, via the `PTY_REAP_ON_EXIT` environment variable — a
network/global knob (the daemon inherits it, so setting it once configures a
whole fleet):

- **`reap` (shipped default).** The daemon removes its own registry entry —
  metadata, events, socket, pid — as it shuts down, so a finished session does
  not linger in `pty ls`.
- **`preserve` (`PTY_REAP_ON_EXIT=false`).** The finished session is kept: its
  final screen and registry entry stay listed and `pty peek`-able until
  `pty gc`'s sweep reclaims it — so a crash you want to inspect is still there.

Two per-session flags override the configured default either way:

| Flag | Effect |
|---|---|
| tag `keep=true` | Force **preserve**, including past a `pty gc` sweep — metadata/`lastLines`/events last until `pty gc --keep-max-age` (default 7d) after the session died, or until you `pty rm` it. Wins over everything, including `--ephemeral`. |
| `pty run -e` (`--ephemeral`) | Force **reap**, on *any* shutdown incl. `pty kill` and `strategy=permanent`. `keep` still wins over it. |

`strategy=permanent` sessions are always preserved (their supervisor reconciles
against the dead metadata to respawn them). `pty kill` also preserves — it is
stop-and-keep, deliberately distinct from `pty rm`.

If an external cleanup unlinks a live session's socket, pid, and metadata
paths, do not rerun its launch command: that can create a second provider.
New daemons advertise a recovery capability in metadata when their selected
root is private to the daemon user. Capture that complete metadata before the
unlink, then use `pty recover <name> --snapshot <file>`
against the same `PTY_ROOT`. Recovery authenticates the original daemon and
rebinds its listener without signaling, restarting, or disconnecting existing
clients. Missing, legacy, stale, tampered, wrong-root, and occupied-path
snapshots fail closed.
Recovery also rejects a snapshot captured before any later metadata mutation,
and rechecks that both the root and its recovery directory are still private
before exchanging authenticated state. An interrupted recover command can be
resumed with the same valid snapshot; it never probes, signals, or relaunches
the supporting daemon.

```sh
pty run -d -- npm test                          # shipped default: reaped when it finishes
PTY_REAP_ON_EXIT=false pty run -d -- npm test   # preserved: peekable until gc sweeps it
pty run -d --tag keep=true -- npm test          # force-keep, past a gc sweep, for 7d after it dies
pty run -d -e -- npm test                       # ephemeral: reaps on any shutdown, leaves no trace
pty rm mybuild                                  # explicit removal beats keep
```

`pty gc`'s sweep reclaims preserved-and-finished (and `vanished`) non-permanent
sessions — see [Auto-running gc](#auto-running-gc). `pty list` is strictly
observational and never removes registry state. `strategy=permanent` sessions
are exempt from the sweep; `keep=true` is exempt for a bounded window.

**`keep` expires.** A `keep`-tagged session is exempt from the sweep until it
has been *dead* longer than `pty gc --keep-max-age <dur>` (default `7d`), then
it is swept like any other stale record and reported as
`Removed (keep expired after 7d): <name>`. Nobody ever comes back to untag a
session they pinned mid-debug, so an unbounded exemption turns the registry
into an append-only log. Running sessions are never swept, whatever their age.

```sh
pty gc --keep-max-age 30d      # a month of retention instead of a week
pty gc --keep-max-age 0        # the keep exemption is over: sweep the backlog now
pty gc -n --keep-max-age 0     # …preview that first; keep-expired sessions are counted separately
```

### Events

Sessions automatically log terminal events — bell, title changes, desktop notifications (OSC 9/99/777), focus requests, and cursor visibility transitions — plus metadata mutations: `display_name_change` on rename, `tags_change` on tag updates, and any `user.*` events published via `pty emit`. Everything goes into per-session JSONL files.

```sh
pty events myserver              # follow events live (like tail -f)
pty events --all                 # follow all sessions, interleaved
pty events --recent myserver     # dump recent events and exit
pty events --json myserver       # raw JSONL output
```

Event files auto-truncate at 1,000 lines and are removed with their session by
lifecycle cleanup (daemon self-reap, `pty gc`, or `pty rm`).

### On-disk format

Session metadata, events, and supporting files all live under `$PTY_ROOT` (default `~/.local/state/pty`). The full layout — file naming, JSON shape, atomic-write contract, event types, stability tiers — is documented in [docs/disk-layout.md](docs/disk-layout.md). Third parties can read these files directly to skip the Node CLI's startup cost; `git`-style command forwarding (`pty <subcommand>` resolves to a `pty-<subcommand>` binary on `$PATH`) lets you ship native fast-path readers as `pty` subcommands.

### Namespaces

`pty` is single-registry by default — every `list`, `gc`, `kill`, `tag`, and `attach` operates on the same directory tree. Two tools sharing a machine can compose two levels of isolation on top of that: **filter by tag** (soft: everyone still sees each other but scoped views are cheap) and **switch registry** (hard: the underlying state directory is different, sessions are invisible across).

**Soft isolation via tags** — any tool can stamp a namespace tag at spawn and filter on it:

```sh
pty run --tag app=payments -- ./bin/worker
pty list --filter-tag app=payments          # only payments sessions
pty list --filter-tag app=payments --filter-tag role=worker  # combine, ALL must match
```

The primitive is `--filter-tag k=v` (repeatable, matches ALL). Any tool layering on top — smalltalk uses `st.network=<root>` to distinguish agents in its network from an operator's ad-hoc pty use — reads and writes tags through the same primitive; no pty semantics for the outer tool's key.

**Hard isolation via `--root`** — pin the state registry per call, or per environment:

```sh
pty --root /var/lib/pty-eval list           # one-off scope for this invocation
PTY_ROOT=/var/lib/pty-eval pty list         # scope for a whole shell / process tree
```

Distinct roots share no sockets, no metadata, no events, no gc. A launchd cron (`pty gc --print-launchd-plist`) inherits the current `$PTY_ROOT` and bakes a per-root Label (`com.compoundingtech.pty.gc.<basename>`) plus per-root log path, so N isolated registries can each install their own gc plist without collision. On the default root the Label stays `com.compoundingtech.pty.gc` — existing installs survive an upgrade unchanged.

`PTY_SESSION_DIR` (the pre-Phase-2 name for the same env var) still works and emits a one-time deprecation notice. Set `PTY_ROOT_LEGACY_SILENT=1` to suppress the notice while migrating.

**`PTY_ROOT` is the isolation mechanism — use it, not `PTY_SESSION_DIR`.** When both are set, `PTY_ROOT` (canonical) wins and the deprecated `PTY_SESSION_DIR` is ignored — with a one-time warning so the masking is visible. So a scratch/test harness running inside an environment that already exports `PTY_ROOT` (e.g. a supervised session tree) must set `PTY_ROOT` to isolate; setting only `PTY_SESSION_DIR` would be silently overridden by the ambient `PTY_ROOT` and its sessions would land in the ambient registry.

### Project Files

A project can include a `pty.toml` to declare its sessions:

```toml
[sessions.claude]
command = "claude --dangerously-skip-permissions"
tags = { role = "agent" }

[sessions.dev]
command = "deno task dev"
tags = { role = "build" }

[sessions.serve]
command = "bin/serve"
tags = { role = "server" }
```

Run `pty up` in the project directory (or `pty up /path/to/project`) to start all sessions. Run `pty down` to stop them. You can also start specific sessions: `pty up dev serve`.

Each session also supports these optional fields:

```toml
[sessions.serve]
command = "bin/serve"
id = "srv"                       # pin the on-disk id (sock + json filename)
display_name = "My Web Server"   # override the default `<prefix>-<sessionKey>` label
cwd = "packages/web"             # working directory (default: the manifest's dir)
```

`id` is validated like a `pty run --id` value (charset, sock-path length, uniqueness); omitted → pty generates a short random id at spawn time. `display_name` must be nonempty, already trimmed, single-line, free of Unicode control characters, and at most 160 Unicode scalar values; `/` and `\` are allowed because the value is metadata, not a path. Omitted → defaults to `<prefix>-<sessionKey>` (or just `<sessionKey>` if no prefix). The two fields decouple the human label from the kernel-constrained filename — long prefixes that would have blown past `sockaddr_un.sun_path` (~104 bytes) now work because the actual sock filename is just the short id.

`cwd` sets the session's working directory. An absolute path is used as-is; a relative path resolves against the manifest's directory. Omitted → the session runs in the manifest's directory (the default). This decouples where a session runs from where its `pty.toml` lives — so a manifest kept in a subdirectory (e.g. `.convoy/pty.toml`, to keep a repo root pristine) can still run its sessions in the repo root with `cwd = ".."`. The declared `cwd` is honored on the initial `pty up` and preserved across manual and `strategy=permanent` respawns.

Sessions can also declare per-session environment variables:

```toml
[sessions.api]
command = "bin/api"

[sessions.api.env]
PORT = "8080"
LOG_LEVEL = "debug"
```

The values are overlaid on the session child's inherited environment before its `/bin/sh -c` command runs. The effective overlay is stored with the other launch settings, so `pty restart` preserves it exactly; `strategy=permanent` respawns re-read the manifest and pick up edits. The equivalent direct-launch flag is repeatable `pty run --env KEY=VALUE` (later entries for the same key win).

Direct launches can also persist removals from the inherited environment with repeatable `pty run --unset-env KEY`. Removals are applied before `--env` overlays, so an explicit assignment wins when both mention the same key, regardless of flag order. Both policies survive manual and permanent restart. Metadata created before `unsetEnv` was introduced retains the historical ambient-inheritance behavior.

Two child invariants are applied after that policy: `PTY_SESSION` is always set to the session's stable id, and an absent `TERM` receives the existing `xterm-256color` default. Consequently, `--unset-env PTY_SESSION` cannot remove the session marker, and `--unset-env TERM` selects the default rather than leaving `TERM` absent. An explicit `--env TERM=...` assignment is preserved.

### Permanent sessions

Tag a session with `strategy=permanent` and `pty gc` will respawn it whenever its daemon exits or vanishes:

```sh
pty tag myserver strategy=permanent

# After myserver exits — manually or by crash — the next `pty gc` run
# brings it back. No backoff, no retry budget; the cron interval below
# is the rate limit. Sessions managed by pty.toml re-read the toml on
# respawn so command/env edits take effect immediately.
pty gc
```

From `pty.toml`:

```toml
[sessions.serve]
command = "bin/serve"
tags = { strategy = "permanent" }
```

Restart is stateless — every `pty gc` invocation re-derives intent from on-disk metadata. There's no in-memory restart counter, no `[failed]` state, no persisted bookkeeping. If a session's binary isn't reachable (volume not mounted, broken symlink), `pty gc` reports `Respawn failed:` and the next tick tries again.

**Fast-fail cap** — a permanent session whose leaf exits within `strategy.fast-fail-window` seconds of its previous `pty gc` respawn counts as a fast fail. After `strategy.fast-fail-limit` consecutive fast fails, `pty gc` writes `strategy.status=flapping` on the session, emits a `session_flapping` event, and stops respawning it. Subsequent gc ticks print `Skipped (flapping): <name>` and take no action. Defaults: 60 s window, 3 consecutive fast fails.

A flagged session shows `[flapping]` (red) in `pty list` in place of `[permanent]` — the operator's expectation has changed, so the badge reflects that.

Reset a flagged session with one of:

- `pty restart <name>` or `pty up` — the manual respawn drops all fast-fail bookkeeping (`strategy.status`, `strategy.consecutive-fast-fails`, `strategy.last-respawn-at`, `strategy.command-hash`), treating restart as an operator "please try again" signal.
- `pty tag <name> --rm strategy.status` — surgical reset that clears only the mark, leaving the counter intact for observability.
- Edit the session's `pty.toml` command — the classifier notices the SHA-256 fingerprint change and auto-resets the counter and mark on the next gc tick.

Per-session overrides tune the cap without editing gc's globals:

```sh
pty tag myserver strategy.fast-fail-window=120  # allow 2min of runtime before "fast"
pty tag myserver strategy.fast-fail-limit=5     # tolerate 5 fast fails before flapping
```

CLI globals mirror the per-session tags (`--fast-fail-window=N`, `--fast-fail-limit=N`); the per-session tag wins when both are set.

### Parent-child sessions

Tag a session with `parent=<name>` and `pty gc` will SIGTERM it (and clean up its metadata) when the referenced parent's daemon is no longer alive — useful for sidecar workers that shouldn't outlive their primary:

```sh
pty run -d --name webserver -- bin/serve
pty run -d --name webserver-tail --tag parent=webserver -- tail -f log/web.log
# If `webserver` dies, the next `pty gc` SIGTERMs `webserver-tail`.
```

What triggers the kill: the parent's metadata file is gone OR the parent's pid file is gone OR the parent's process isn't alive. What doesn't: the parent's exit code, the parent's `exitedAt` timestamp. Combinator with `strategy=permanent` is well-defined — orphan-kill wins (the child is removed, not respawned).

Cycles (A→B, B→A) resolve deterministically by name-sorted iteration: whichever name sorts first dies first on the tick where both parents are gone; the loser dies the same tick because its parent (the just-killed winner) is also dead. No cycle detection needed.

### Auto-running gc

`pty gc` is a one-shot reconciliation pass. The intended deployment is to run it on a short interval so permanent sessions come back quickly and orphans get cleaned promptly. The CLI ships an install helper for macOS:

Whether finished sessions need the sweep depends on [`PTY_REAP_ON_EXIT`](#session-lifecycle-and-cleanup): under the shipped `reap` default they self-clean at exit, so the sweep's finished-session duty is mostly `vanished` sessions (daemon killed outright, so it never ran its own cleanup) plus anything left listed by `preserve` mode. `pty list` only observes this state; it never cleans it up. So the interval primarily buys you respawn latency for permanents and orphan-kill promptness — and, in `preserve` mode, `pty ls` hygiene. `strategy=permanent` sessions are exempt; `keep=true` sessions are exempt until they have been dead longer than `--keep-max-age` (default 7d), which an interval-driven gc then reclaims on its own.

```sh
pty gc --print-launchd-plist > ~/Library/LaunchAgents/com.compoundingtech.pty.gc.plist
launchctl load ~/Library/LaunchAgents/com.compoundingtech.pty.gc.plist
```

Default interval is 30 seconds; tune with `pty gc --print-launchd-plist --interval=15` etc. Output goes to `~/.local/state/pty/gc.log`.

> **Upgrading from an older `@myobie/pty` install?** The gc-plist Label changed from `com.myobie.pty.gc` to `com.compoundingtech.pty.gc`. Unload the old service once so it doesn't linger orphaned: `launchctl unload ~/Library/LaunchAgents/com.myobie.pty.gc.plist && rm ~/Library/LaunchAgents/com.myobie.pty.gc.plist`, then install the new one above.

Statelessness is the whole point of running it on a cron rather than as a long-lived daemon. At boot, if the volume containing the `pty` binary isn't mounted yet, the invocation fails — the next tick tries again. The historic long-running supervisor would burn through its 5-retry budget in the first 10 seconds of boot and never come back; this design just shrugs and reconciles on the next tick.

For other systems:

- Linux + cron: `* * * * * pty gc >> ~/.local/state/pty/gc.log 2>&1` (one-minute resolution; tune to taste).
- Linux + systemd-timer: `OnUnitActiveSec=30s` on a `pty.gc.service` that `ExecStart=pty gc`.
- runit: a `run` script that loops `pty gc` with a `sleep 30` between iterations.

The macOS `pty gc --print-launchd-plist` helper is the only one bundled today; the others are one-liners and easy enough to write yourself. File an issue if you'd like a built-in install command for systemd/runit.

### Plugins

Like `git`, `pty` supports extensions: if you run `pty foo` and there's a `pty-foo` executable in your `$PATH`, pty will run it with the remaining arguments. This lets you build your own subcommands without modifying pty.

## Client API

@compoundingtech/pty exposes a programmatic TypeScript API for building apps on top of pty sessions. Import from `@compoundingtech/pty/client`.

```typescript
import {
  spawnDaemon, listSessions, getSession,
  getSessionExitEvidence, removeSessionGeneration,
  SessionConnection, sendData, peekScreen, queryStats,
  EventFollower, readRecentEvents,
  extractFilterTags, matchesAllTags,
} from "@compoundingtech/pty/client";
import { PtyServer } from "@compoundingtech/pty/server";         // native addon (node-pty)
import { resolveKey } from "@compoundingtech/pty/keys";           // browser-safe
import { PacketReader, MessageType } from "@compoundingtech/pty/protocol"; // browser-safe
```

### Managing sessions

```typescript
// Create a session
await spawnDaemon({
  name: "myserver",
  command: "node",
  args: ["server.js"],
  displayCommand: "node server.js",
  cwd: "/path/to/project",
  rows: 24,
  cols: 80,
});

// List and query
const sessions = await listSessions();
const stats = await queryStats("myserver");
```

### Connecting to a session

`SessionConnection` provides a bidirectional, event-driven connection without taking over stdin/stdout — ideal for GUI apps, multiplexers, or web interfaces:

```typescript
const conn = new SessionConnection({ name: "myserver", rows: 24, cols: 80 });

conn.on("geometry", ({ rows, cols }) => myTerminalView.resize(cols, rows));
conn.on("data", (data) => myTerminalView.write(data));
conn.on("exit", (code) => console.log(`Exited: ${code}`));

const initialScreen = await conn.connect();
myTerminalView.resize(conn.effectiveCols, conn.effectiveRows);
myTerminalView.write(initialScreen);

conn.write("hello\r");
conn.press("ctrl+c");
conn.resize(30, 100);
conn.disconnect();
```

For simpler operations:

```typescript
await sendData({ name: "myserver", data: ["hello\r"] });
const screen = await peekScreen({ name: "myserver", plain: true });
```

### Following events

```typescript
const follower = new EventFollower({
  names: ["myserver"],
  onEvent: (event) => console.log(event.type, event.ts),
});
follower.start();
```

See **[docs/client.md](docs/client.md)** for the full API reference.

## Testing Library

@compoundingtech/pty includes a terminal testing library — like Playwright, but for the terminal. Spawn any process in a real PTY, send keystrokes, take screenshots, assert on visible output.

```typescript
import { Session } from "@compoundingtech/pty/testing";

const session = Session.spawn("node", ["--experimental-strip-types", "my-app.ts"]);
await session.waitForText("Ready");

session.press("down");
session.press("return");
await session.waitForText("Selected!");

const ss = session.screenshot();
expect(ss.text).toContain("Selected!");
expect(ss.lines[0]).toMatch(/My App/);

session.press("ctrl+c");
await session.waitForAbsent("My App");
await session.close();
```

Works with any process: CLI tools, interactive TUIs, shells, vim, even `top`. The test runs in a real PTY with a real xterm terminal emulator, so you test exactly what users see.

See **[docs/testing.md](docs/testing.md)** for the full API reference, key names, patterns, and tips.

## TUI Framework (alpha)

@compoundingtech/pty also includes an experimental declarative TUI framework for building terminal interfaces with reactive signals, layout, and efficient cell-buffer diffing. Import from `@compoundingtech/pty/tui`.

> **Alpha** — the TUI framework API is unstable and will change. Use it for experiments, not production.

The `demos/` directory has four working apps built with the framework:

- **file-browser** — two-pane directory tree + file preview with soft-wrap and markdown highlighting
- **reminders** — full CRUD backed by `.md` files, three views (list, board, calendar), overlays
- **agent-teams** — live dashboard of a simulated AI agent hierarchy with real-time updates
- **playground** — interactive catalog of every TUI widget — atoms, layout, inputs, lists, data, overlays, and composition patterns, each with a live example and source snippet. A reference for anyone building on the TUI framework.

Run them with `node --experimental-strip-types demos/{name}/main.ts` (or `./demos/run <name>`). Each demo includes unit tests and PTY integration tests that exercise the testing library.

## Skill Reference

For AI coding agents and automation, see **[SKILL.md](SKILL.md)** — a concise guide to running and managing background processes with pty, including session lifecycle, common patterns, and rules for well-behaved agents.

## Tab Completion

```sh
brew install bash-completion  # required for bash on macOS; zsh works out of the box
npm run install-completions
```

## Prior Art

pty focuses on session persistence only — no splits, no panes, no window management. On mobile we don't need or want splits, and on desktop we have kitty/ghostty/native terminal splits. Keep things simple.

- [abduco](https://github.com/martanne/abduco) — minimal session management for terminal programs, handling detach and reattach cleanly. A major inspiration for pty.
- [dtach](https://github.com/crigler/dtach) — emulates the detach feature of screen with minimal overhead.
- [GNU Screen](https://www.gnu.org/software/screen/) — the original terminal multiplexer that pioneered session persistence.
- [tmux](https://github.com/tmux/tmux) — modern terminal multiplexer with session, window, and pane management.

## License

MIT
