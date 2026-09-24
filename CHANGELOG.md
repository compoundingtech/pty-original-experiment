# Changelog

## Unreleased

### Attach and follow trailers identify the session

- Detaching from `pty attach` or `pty peek -f` now prints the stable session id,
  its display name, cwd, command and visible tags, followed by an actionable
  reattach command. Session exits include the runtime and a restart hint only
  when the registry retains the session. Remote attach hints include the peer.
- When a daemon closes its socket without an exit packet (for example after
  `pty kill`), attach and follow-mode peek now say that the session ended,
  including the same summary but no restart hint. A client-rejected malformed
  frame remains a connection error, not a session-end announcement.
- Attach banners include the display name when available. Machine attach
  streams remain framed, with no new stderr output on detach or EXIT.

### `pty metadata patch` waits out the attach window

- An attached child starts while `pty run` still holds the per-session
  creation lock, so a `metadata patch` executed at child start used to fail
  deterministically with `metadata is busy`. The patch path now waits
  boundedly (8 s total) for the creation/attach window instead of failing at
  once. Stuck locks still fail closed with the same `busy` error — the wait
  is bounded, never indefinite — and unknown ids still fail fast with
  `not found`.
- The daemon publishes the owner sidecar (`<id>.pid`) before spawning the
  child, so ancestry checks running at child start already observe it.

### One reader for the process table

- Process facts now come from one module. On Linux it reads `/proc` and spawns
  nothing at all. On macOS `ps` remains, but it is read once per operation
  rather than once per process per poll — the difference between 240 spawns
  inside a 1500 ms deadline and 60.
- Every query separates three answers: the fact, "the table was read and this
  process is not in it", and "I could not find out". A `ps` that is slow,
  truncated or silent now produces the third rather than the second. There is
  no default and no conversion that turns silence into absence by accident.
- A listing that does not contain the process that read it is treated as
  truncated rather than as an empty machine. `ps` always lists at least itself.
- `recovery.processStartToken` is unchanged and still comes from
  `ps -o lstart=`. Its exact text, including the two spaces before a
  single-digit day, is a contract with the Rust tool through a shared registry.
  The in-memory identity used by the teardown is a separate branded type so the
  two cannot be compared by accident.
- Production `ps` call sites: six down to three, and none of them inside a
  per-process poll loop.

### `pty kill` finishes the job

- After the daemon has gone, `pty kill` re-reads the process table. If anything
  from its pre-kill snapshot is still alive, it signals the process groups the
  session left behind, waits, escalates to SIGKILL, reads the table again, and
  reports what is still there. The daemon tears the tree down on its way out, so
  its teardown races its own exit; the command outlives the daemon and can
  finish the work.
- The sweep targets process groups rather than PIDs, because a group signal
  needs no per-process identity. A descendant whose process-start token cannot
  be read is dropped from the snapshot and never signalled individually; its
  group is still swept. The sweep also costs one `ps` call in total, against one
  per descendant for tokens.
- The daemon's own process group is never signalled. The PTY child calls
  `setsid`, so the daemon is alone in its group. The group of the process
  running `pty kill` is never signalled either, so the command survives to
  report. Group id 1 and below are never signalled.
- A zombie no longer counts as a process-group member. `ps` lists it with its
  group, so counting it made the sweep report a group it had already emptied.

### `pty kill` reports what it verified

- `pty kill` prints `Session "X" killed.` only when the session's process tree
  is gone. It takes a snapshot of the tree before it signals the daemon, and
  re-checks that snapshot after the daemon exits. Before this, the command
  asked about the daemon and reported about the session, so the success line
  was a claim about processes it never looked at.
- When something outlives the kill, the command prints
  `Session "X" daemon stopped.` on standard output, which is the part it
  verified, and names the surviving PIDs on standard error. A PID is called a
  survivor only when its process-start token still matches. A PID that has not
  exited but whose token cannot be read is reported separately as undecided.
- A daemon that could not kill a descendant now appends
  `session_descendants_survived` to the session event log, and its standard
  error warning names the PIDs. The daemon's standard error has no reader, so
  the log line is the copy a person can find.
- `pty kill` sends no additional signals and waits no longer than before.
- **Compatibility break.** `pty kill` now exits non-zero when anything survived,
  and when a start token could not be read so the outcome is undecided. A script
  that checks the status of `pty kill` will fail where it used to pass, because
  it was passing on a false success. The fix for such a caller is to stop
  treating an unverified kill as a completed one. A verified empty tree still
  exits 0.
- On macOS, an empty `ps -o stat=` field no longer counts as a dead process.
  An empty field means the process is gone or `ps` did not answer, and under
  load `ps` is the thing that goes quiet, so the kernel is asked again.

### Bounded `keep` retention in gc

- **`keep=true` on a DEAD session now expires.** `pty gc`'s sweep skips a
  `keep`-tagged exited/vanished session only while it has been dead for less
  than `--keep-max-age` (default `7d`), then reclaims it. Exit-time retention
  is unchanged and still unconditional; running sessions are never swept
  whatever their age. Agents tag the session they are debugging right now and
  never come back to untag it, so the previous forever-exemption grew the
  registry without bound (740 of 911 sessions on one host).
- **New `pty gc --keep-max-age <dur>`** — `Ns`/`Nm`/`Nh`/`Nd`, or bare `0` to
  sweep every dead `keep` session on this pass. A unit-less non-zero value is
  rejected rather than guessed at. Age is anchored on `exitedAt`, falling back
  to `createdAt` for a `vanished` session that never wrote one — the same
  anchor precedence `pty list --older-than` uses. Records with neither
  timestamp never expire (except under `0`).
- **`GcResult` gains `keepExpired: string[]`** — dead sessions swept despite a
  `keep` tag, disjoint from `removed` so callers can report the two reasons
  apart. Public `@compoundingtech/pty/client` API surface change; the module
  also now exports `DEFAULT_KEEP_MAX_AGE_MS` and `isKeepExpired`.
- **CLI output** — `Removed (keep expired after 7d): <name>` (`Would remove …`
  under `--dry-run`), a `N keep-expired sessions` term in the summary bar, and
  the retained-session line now names the window it is counting down:
  `Kept (keep tag): <name> — swept once dead for 7d, or remove the keep tag to
  reap it now`.
- Tests in `tests/gc-keep-expiry.test.ts` (8 new) cover: young keep session
  retained, expired one swept and reported apart from the untagged sweep,
  custom windows in both flag spellings, `0` sweeping a just-exited session,
  `createdAt` anchoring for a session with no exit record, a running keep
  session surviving `--keep-max-age 0`, non-mutating dry runs, and flag
  validation.

### Complete session termination

- `pty kill` now stops the PTY child and its complete descendant tree. A
  background descendant that previously survived `pty kill` now stops.
- Descendants are captured before the PTY child exits. Each PID remains bound
  to its process-start identity before every exact signal, which prevents a
  reused PID from becoming a target. The shutdown never signals a process
  group. It sends TERM first and uses KILL only for an exact descendant that
  ignores the bounded grace period.
- `pty kill` now returns a nonzero error when its daemon remains alive after
  seven seconds. The error names the daemon PID and socket instead of reporting
  success before a blocked replacement start.
- The installed `pty-kill-releases-socket-test` command performs a real
  kill-then-restart cycle. It succeeds only when the replacement owns the same
  Unix socket without manual cleanup.

### Key input notation

- Named key input is case-insensitive and accepts `+`, `-`, or `_` modifier
  separators plus compact `C-` Control notation, so `ctrl+u`, `ctrl-u`,
  `ctrl_u`, and `C-u` are equivalent. Invalid or incomplete key specs now name
  the supported forms, modifiers, and keys while preserving up-front atomic
  validation. (closes #164)

### Storage format

- New event type `session_descendants_survived`, carrying `data: { pids }`.
  A daemon appends it when it signalled its child's process tree with TERM and
  then KILL and found processes still alive. It records what the daemon could
  not kill; a process that left the tree before the snapshot is not in it.


- Supporting live daemons now advertise a `recovery` capability in session
  metadata. `pty recover <name> --snapshot <file>` uses that captured
  capability to authenticate a signal-free listener/registry rebind after an
  external unlink. Recovery preserves the daemon, PTY child, existing clients,
  generation, and launch identity; stale, tampered, legacy, or foreign-path
  attempts fail closed without relaunching. A retained signed metadata revision
  prevents older snapshots from rolling back later tags, display names, attach
  state, or lifecycle metadata. Recovery locks are resumable only by the same
  authenticated daemon identity after an interrupted CLI, and both the root and
  `.recovery` directory are identity/permission checked immediately before
  authenticated request exchange. Metadata mutations advance their signed
  recovery revision before publishing the new metadata, so an unlink during
  publication can deny recovery but cannot authorize an older snapshot.

### Restart-durable environment removals

- `pty run --unset-env KEY` and programmatic `unsetEnv` persist inherited
  environment removals across manual and permanent restart. Explicit `--env`
  assignments are applied afterward and therefore win independent of flag
  order.
- Storage format: session metadata may include an optional `unsetEnv` string
  array. Older records omit it and retain the historical ambient-inheritance
  behavior; exact `env` remains mutually exclusive with inherited-environment
  policy options.

### Ordered initial attach snapshots

- Every `ATTACH` and `PEEK` synchronization now sends the effective
  `GEOMETRY`, then one `SCREEN` baseline, before any following `DATA` or
  `EXIT`. Output already accepted by xterm at the snapshot cut is represented
  by `SCREEN`; later output is queued and released in order after it, with a
  single process exit following any final data.
- A new `ATTACH` or `PEEK` on the same socket supersedes an unfinished
  synchronization, so a re-attach or writable-to-readonly mode switch cannot
  emit the previous mode's stale screen or queued output. Reconnects establish
  the same fresh `GEOMETRY` → `SCREEN` → `DATA`/`EXIT` baseline.
- Valid `ATTACH` and `PEEK` messages now explicitly replace the socket's client
  role. In particular, attaching after a read-only peek restores input, resize,
  and shared-grid geometry participation; malformed attaches preserve the
  existing role and synchronization generation.

### Atomic exact-id metadata patching

- `pty metadata patch --id <stable-id>` reads one merge-style JSON object from
  stdin and atomically updates `displayName` and tags under one metadata lock.
  It never falls back to display-name lookup, preserves unrelated tags, returns
  `{ changed, metadata }`, and suppresses no-op writes and events.
- `patchMetadataById(id, patch)` exposes the same exact-id operation from
  `@compoundingtech/pty/client`. Existing rename/tag APIs share the merge engine
  while retaining their documented specialized events for compatibility.
- Metadata publication acquires the event lock before the metadata lock, so a
  busy event log fails before either file changes. Event appends and retention
  rewrites are serialized without a per-record byte-size assumption.
- `pty exec` now carries an opaque generation owner token in session children
  and refuses stale same-id replacements. Sessions started by an older build
  must be restarted once before they can use `pty exec`.
- The current display-name contract supersedes the permissive limits described
  in earlier release notes: values must be nonempty, already trimmed,
  single-line, free of Unicode control characters, and at most 160 Unicode
  scalar values. Slash and backslash remain valid metadata characters.

### Storage format

Effective atomic patches append one `metadata_change` event whose `previous`
and `value` objects contain only changed `displayName` and tag keys. No-op
patches append no event. Lock contention cannot publish only one side of an
effective patch. Metadata remains the authoritative state: a process crash or
underlying I/O failure between its write and event append can omit the
notification because pty does not journal a cross-file transaction.

### Non-unique display names with unambiguous session resolution

- Display names are presentation metadata and no longer need to be unique.
  Creating or renaming a session may reuse another session's display name or a
  stable id; stable session ids remain unique and immutable.
- Every local CLI session reference resolves with the same rule: an exact stable
  id wins, one display-name match resolves, and multiple display-name matches
  fail closed while listing the candidate stable ids. Fabric remote routing uses
  the same rule on the target host.

### Framed machine attach stream

- `pty attach --attach-stream-fd-v1 <fd> <ref>` keeps stdin/stdout as the
  controlling terminal while writing ordered, existing-protocol `GEOMETRY`,
  `SCREEN`, and `DATA` packets plus a terminal `EXIT` or `DETACH` outcome to a
  dedicated inherited descriptor. Intentional local detach is framed and
  flushed even when it occurs before the initial daemon baseline, so consumers
  can distinguish it from a truncated stream.
  The descriptor remains caller-owned and must be closed by the caller for
  consumers to observe EOF. Invalid descriptors, write failures, and daemons
  that do not provide the v1 geometry-first contract fail clearly on stderr.
- Ordinary interactive attach rendering and resize behavior are unchanged.

### Stream-ordered effective geometry for embedded clients

- Writable clients still select the shared PTY grid by independent row/column
  minima, and zero viewers still preserve the last size. The daemon now sends
  a framed `GEOMETRY` packet to writable and read-only output streams before
  every affected `SCREEN`/`DATA`, including peer attach, resize, and
  disconnect changes.
- `SessionConnection` exposes `effectiveRows`/`effectiveCols` and a `geometry`
  event. `attachPty()` and server-mode testing sessions resize their local
  xterm grid from the same stream event before parsing later output. Older
  clients safely ignore the bounded unknown packet and retain raw-byte
  behavior.

### Connected-client geometry introspection

- `pty stats --json` and `queryStats()` retain their existing effective
  terminal geometry and aggregate client counts, and now add anonymous
  `clients.connections` details. Writable entries report their requested
  rows/columns, last request sequence, and which min-wins axes they currently
  constrain; readonly entries carry no geometry. This is point-in-time
  observability and does not change attach/resize min-wins or DATA ordering
  semantics. An attached client that switches to readonly via `PEEK` now
  relinquishes its requested geometry, re-negotiating the effective size when
  necessary.
### Read-only session listing

- `listSessions()` and `pty list` are now strictly observational: they no
  longer create an absent registry, unlink stale socket/pid files, remove
  malformed metadata, or reap old dead sessions. A dead daemon with a stale
  socket is reported as exited/vanished in the first listing instead of
  requiring a mutating priming pass.
- Read-only APIs no longer perform lifecycle cleanup. Stale registry cleanup
  belongs to explicit operations such as `pty gc` and `pty rm`; normal daemon
  self-reaping is unchanged. In particular, `pty gc --dry-run` now performs no
  registry writes or removals. `pty gc` inventories dead socket/pid debris even
  when metadata is missing or malformed, and revalidates it while holding the
  per-name creation lock before removal.

### Generation-guarded gc cleanup and respawn

- Residual sweep and permanent respawn now compare the generation observed by
  gc with the current metadata while holding the per-name creation lock.
  Cleanup is skipped when another process replaced or edited the record after
  gc's snapshot, preventing a stale pass from unlinking or respawning over the
  replacement. Legacy generation-less records use exact metadata equality as a
  conservative fallback. Bundled CLI respawns inherit the already-held
  creation lock until the replacement publishes its socket.

### Attach-only CLI policy

- `pty attach --no-restart <ref>` attaches only to a currently running
  session. Missing, exited, or vanished sessions fail without prompting or
  executing retained launch metadata. Existing interactive prompting and
  `--auto-restart` behavior are unchanged.

### Generation-safe removal and immediate same-name reuse

- `pty rm` now returns success only after the removed session's daemon has
  completed its bounded deferred shutdown. An immediate same-name `pty run`
  can no longer have its socket or pidfile unlinked by cleanup from the old
  daemon generation.
- Daemon exit-metadata writes and cleanup are generation-owned and serialized
  with session creation. Stale cleanup skips files published by a replacement
  generation.

### Storage format

`<name>.json` gains optional `generation` and `daemonPid` lifecycle fields.
The generation is an opaque cleanup-ownership token; the daemon PID lets
`pty rm` wait for deferred shutdown after the child has exited.

### Restartable launch parity and bounded fleet listing

- `pty run --env KEY=VALUE` adds a repeatable child-environment overlay (last
  duplicate wins). It covers the remaining `pty.toml` launch field on the
  direct CLI and is included in generated fish/bash/zsh completions and help.
- Session metadata now persists the complete restart-relevant launch settings:
  terminal rows/columns, ephemeral mode, isolation mode, explicit environment
  overlay, and programmatic exact environment. Manual restart and permanent
  respawn reapply them instead of inheriting the restarter's launch shape.
  Existing metadata remains compatible and uses historical defaults.
- On POSIX, `kill(pid, 0)` returning `EPERM` now proves that the process is
  present. Necessary socket fallbacks run concurrently under one shared
  fleet-wide budget, and `listSessions()` returns deterministic name order.

### Storage format

`<name>.json` gains optional `rows`, `cols`, `ephemeral`, `isolateEnv`,
`extraEnv`, and `env` fields recording restart-relevant launch settings.

### Configurable exit-time cleanup for finished sessions

Whether a finished non-permanent session reaps itself at exit, or is preserved
(kept listed + `pty peek`-able until `pty gc` sweeps it), is now configurable via
the **`PTY_REAP_ON_EXIT`** environment variable — a network/global knob the
daemon inherits, so it can be set fleet-wide. `false`/`0`/`no`/`off` → preserve;
unset or anything else → **reap** (the shipped default). Two per-session flags
override the configured default either way:

- **New `keep` tag.** `keep=true` forces **preserve** regardless of the
  configured default, and exempts the session from `pty gc`'s sweep too, so its
  metadata/`lastLines`/events survive until an explicit `pty rm`. Any value
  other than `false`/`0`/`no`/`off` counts as set. Settable at spawn
  (`--tag keep=true`) or on a running session (`pty tag <ref> keep=true`) — the
  exit path and gc both re-read tags from disk. Wins over `--ephemeral`.
- **`--ephemeral` forces reap** regardless of the configured default, on *any*
  shutdown including `pty kill` and including `strategy=permanent`. `keep` wins
  over it. (Behavior change for existing `-e` callers: a `pty kill`'d ephemeral
  session is now reaped rather than kept.)
- **`pty gc` reports kept sessions.** `GcResult` gains `kept: string[]`, and
  `pty gc` prints `Kept (keep tag): <name>` so a retained dead session does not
  look like a gc bug. gc remains the owner of finished-session cleanup — it
  sweeps preserved/`vanished` non-permanent sessions; its other duties
  (orphan-kill, abandoned-reap, permanent respawn) are unchanged.

## 0.12.0

### Attach no longer nudges a child that is already at the right size

- The attach-time redraw nudge (resize to `cols - 1` and back, to paper over serialize-replay artifacts) now fires only when the attaching client's geometry differs from the session's. Attaching at the size the session already has leaves the child alone, so connecting a viewer no longer delivers `SIGWINCH` to an idle process.

### Package renamed: `@myobie/pty` → `@compoundingtech/pty`

- The npm scope + GitHub org moved from `@myobie`/`myobie` to `@compoundingtech`/`compoundingtech`. The package is now **`@compoundingtech/pty`**; all subpaths (`/tui`, `/client`, `/server`, `/testing`, `/protocol`, `/keys`) and the CLI command (`pty`) are unchanged in shape. Update imports and any `@myobie/pty*` dependency specifiers.
- The gc-plist launchd Label changed `com.myobie.pty.gc` → `com.compoundingtech.pty.gc`. **On upgrade**, unload the old service once so it doesn't linger: `launchctl unload ~/Library/LaunchAgents/com.myobie.pty.gc.plist && rm ~/Library/LaunchAgents/com.myobie.pty.gc.plist`, then reinstall via `pty gc --print-launchd-plist` (see README).
- The package is `private` (unpublished) pending a coordinated `@compoundingtech` publish; consumers use a `file:` dependency in the meantime.

### `@compoundingtech/pty/tui` — semantic design-token layer (`tokens.ts`)

- New `tokens` module is the single source of truth for semantic-color resolution: `SEMANTIC_SLOTS` (the one `SemanticColor`→theme-slot map), `resolveSemantic(color, theme)` (the canonical resolution `renderer.resolveColor` now delegates to — no behavior change), `semanticColorNames()`, and `themeTokens(theme)` — a serializer that emits a theme's tokens as a framework-neutral name→RGB map (e.g. for CSS custom properties), the foundation for driving the same palette on web as in the terminal. It's a leaf module (no dependency on the ANSI/render code), so the token vocabulary can be resolved and serialized without pulling in terminal rendering.

### `@compoundingtech/pty/tui` — `select` SRCL-style dropdown

- `renderSelect(options, selectedIndex, state, opts)` + `handleSelectKey(state, len, key)` + `createSelectState()` — a state-first dropdown (SRCL's `Select`): a caret + value button that opens an option list; Up/Down move the highlight, Enter commits, Escape closes. Caller owns the open/highlight state and the chosen index; renders with existing nodes (no renderer surgery). ComboBox (search + filter + pick) remains served by the existing `command-palette` widget.

### `@compoundingtech/pty/tui` — `codeBlock` / `message` SRCL-style components

- `codeBlock(code, opts)` — a numbered code/log block (SRCL's `CodeBlock`): one row per line with a right-aligned line-number gutter, an optional per-line `highlight` callback for syntax coloring, and `startLine` / `showLineNumbers` / `gutterColor`. Returns a `ColumnNode`. For logs, diffs, agent output.
- `message(content, opts)` — a chat/bus message bubble (SRCL's `Message` + `MessageViewer`): a padded bubble on a direction-colored fill — incoming (muted, left) or `outgoing` (accent, right, = MessageViewer) — with an optional `from` label. Maps to the bus/inbox view. Returns a `ColumnNode`.
- Both pure builders, semantic tokens only.

### `@compoundingtech/pty/tui` — `accordion` / `actionListItem` SRCL-style components

- `accordion(title, expanded, children, opts)` — a collapsible disclosure section (SRCL's `Accordion`): a `▸`/`▾` header that shows indented content when expanded. State-first (the caller owns `expanded`), returns a `ColumnNode`.
- `actionListItem(label, opts)` — a selectable action row (SRCL's `ActionListItem`): a 3-cell icon chip (accent-highlighted when `focused`) + label, with optional right-aligned text. Drops into a `selectable`/`virtual-list` for the agent/session roster. Returns a `RowNode`.
- Both are pure builders styled with semantic tokens only.

### `@compoundingtech/pty/tui` — `barProgress` / `barLoader` SRCL-style progress bars

- New `barProgress(percent, opts)` (a light `░` texture fill on a subtle track, SRCL's `BarProgress`) and `barLoader(percent, opts)` (a solid `█` fill, SRCL's `BarLoader`). `width`, fill `color`, and track `background` are configurable; percent clamps to 0–100. Each returns a `TextNode` (fill glyphs + spaces for the track) — distinct from, and leaving untouched, the framework's existing node-based `progressBar()`.

### `@compoundingtech/pty/tui` — `breadCrumbs` SRCL-style breadcrumb trail

- New `breadCrumbs(items, opts)` widget renders a breadcrumb trail (mirroring SRCL's `BreadCrumbs`): item labels joined by a ` ❯ ` separator. Accepts bare strings or `{ label }` items. The last (current) crumb is emphasized with the accent color + bold (`emphasizeLast`, default true); an optional `chips` mode puts each crumb on a muted fill like SRCL; the `separator` is configurable. Returns a `RowNode` of semantic-token-styled `TextNode`s. Maps to the network → host → agent drill-path.

### `@compoundingtech/pty/tui` — `ptyPane` first-class live-session widget

- New `renderPtyPane(buf, rect, handle, opts)` widget renders a live pty session into a `CellBuffer` region: border/title chrome with a focus color, scrollback (`scrollOffset`), a palette-index-preserving cell blit (unlike the base `ptyView` node, which flattens indexed colors to RGB and loses the outer terminal's theme), selection highlighting, cursor-with-scroll reporting (returns the on-screen 1-based cursor position, or `null` when the pane is unfocused or the cursor is scrolled off-screen), and a per-handle cell cache. Helpers `ptyPaneInnerRect`, `ptyPaneCursorRow`, `isSelectedInPane`, and `clearPtyPaneCache` are exported alongside it.
- Generalizes the single-pane render path pty-layout grew into a reusable widget the framework owns; multi-pane tiling stays the host's job.

### `@compoundingtech/pty/tui` — `badge` SRCL-style status chip

- New `badge(label, opts)` widget renders a small SRCL-style chip: an uppercase, padded label on a muted fill (mirroring SRCL's `Badge` — `text-transform: uppercase`, `padding: 0 1ch`, filled background). Status `variant`s (`neutral | ok | warn | error | accent | info`) color the label, or fill the chip when `solid: true`. `uppercase` and `bold` are configurable. Returns a `TextNode` styled with semantic color tokens only (no terminal-only escapes), so the same call can render under a non-terminal backend.

### `pty.toml` — per-session `cwd` field

- Sessions in a `pty.toml` accept an optional `cwd = "..."` setting the working directory. An absolute path is used as-is; a relative path resolves against the manifest's directory. Omitted → the session runs in the manifest's directory (the unchanged default).
- Decouples where a session runs from where its `pty.toml` lives: a manifest kept in a subdirectory (e.g. `.convoy/pty.toml`, to keep a repo root pristine) can run its sessions in the repo root via `cwd = ".."`. Honored on the initial `pty up` and preserved across `strategy=permanent` respawns (`respawnPermanent` no longer forces `cwd` to the manifest's directory when the session declares one).
- `PtySessionDef` on `@compoundingtech/pty/client` gains an optional `cwd?: string` (resolved absolute).

## 0.11.0

### `@compoundingtech/pty/tui` — `text()` accepts an object form `{ fg, bold, ... }`

- `text()` gains a second calling shape: `text(str, { fg: someColor, bold: true, italic: true, ... })`. The `fg` key maps to the `color` slot; the rest are the existing `TextOpts`. The original positional shape `text(str, color?, opts?)` continues to work — dispatch is by second-arg TYPE (string / array → positional Color, plain object → opts-with-fg), not arity.
- Motivation: consumers of the `@compoundingtech/pty/tui` barrel that lay out `{ fg: ..., bold: ... }` maps ran headlong into a compile error (`'fg' does not exist`) when the object reached the positional-`color` slot. Both shapes now compose cleanly.

### Lean-core: `pty state` and `pty wrap` REMOVED (BREAKING)

Two subcommands and their public API surface are removed with no back-compat shim. Both were auxiliary to the session primitive contract and better served elsewhere.

- **Removed `pty state` (subcommand + programmatic API + events + metadata field).** Redundant with smalltalk's folder-and-bus persistence.
  - CLI: `pty state {get, set, delete, keys}` gone.
  - Public API on `@compoundingtech/pty/client`: `getState`, `getStateKey`, `setState`, `deleteState`, `listStateKeys` gone. Removing these is a breaking export change.
  - Event types `state.set` and `state.delete` gone; their interfaces (`StateSetEvent`, `StateDeleteEvent`) removed from `EventRecord`.
  - `SessionMetadata.state?` field gone — this is a **PUBLIC FORMAT / Storage format** change. Existing on-disk metadata files with a populated `state` object will silently drop that field on the next daemon-side rewrite.
  - Tests: `tests/state.test.ts` (485 LOC) deleted; `tests/atomic-writes.test.ts` and `tests/events.test.ts` shed their state-specific cases.

- **Removed `pty wrap` / `pty unwrap` / `pty wrap --list`.** Orthogonal shim generation; not part of the session-primitive contract.
  - The `PTY_BIN_PATH` env var no longer has a consumer; treat as removed.
  - `~/.local/pty/bin/` (default wrap dir) is no longer created; existing shims can be `rm -rf`'d by hand.

- Usage-check swept the pty repo + `eval-sandbox/st-evals` + `convoy` + `~/bin/pty-claude-launcher.sh` + `cos` + `pty-relay` + `pty-layout` before the delete: no external consumers of state helpers or the wrap surface anywhere.

### `pty` — `--help` and shell completions rewritten (accuracy pass)

- New `usage()` groups commands logically (Create / Attach & interact / Observe / Modify / Lifecycle / Multi / Global), lists every flag every subcommand actually accepts (`--id`, `--name`, `--no-display-name`, `--isolate-env`, `--filter-tag`, `--remote`, `--force`, `--paste`, `--idle-days`, `--fast-fail-window`, `--fast-fail-limit`, `--print-launchd-plist`, and all the `tag-multi` selectors), and documents `<ref>` semantics + the four env vars (`PTY_ROOT`, `PTY_SESSION_DIR`, `PTY_ROOT_LEGACY_SILENT`, `PTY_SESSION`).
- Completion scripts (`completions/pty.{fish,bash,zsh}`) rewritten against the same surface — every current subcommand + every accepted flag covered; `state`, `wrap`, `unwrap` removed. Fish, bash and zsh all consistent.

### Follow-ups to #56 (fast-fail cap) + PTY_ROOT length backstop

- **`pty restart` and `pty up` now clear the `pty gc` flapping bookkeeping.** Manual restart is an operator "please try again" signal — dropping `strategy.status`, `strategy.consecutive-fast-fails`, `strategy.last-respawn-at`, and `strategy.command-hash` on the restarted session gives it a clean slate, so the next `pty gc` tick isn't a no-op (silent skip against a stale flapping flag). Auto-reset on command-hash divergence already handled the toml-edit case; this handles the operator-intervenes-without-edit case that gc otherwise can't infer. Applies to both `pty restart` and `pty up`'s "already running, tag-sync" path.
- **`pty list` renders `[flapping]`** in place of `[permanent]` when a session carries `strategy.status=flapping`. Red instead of yellow — the flag stands out from ordinary permanent sessions because the operator's expectation has changed (`pty gc` has stopped respawning it on purpose).
- **Startup-time PTY_ROOT length backstop.** When the resolved root's byte length + a default-shape `/<8-char-id>.sock` suffix (14 bytes) would exceed the `sockaddr_un.sun_path` 104-byte kernel limit, `pty` errors before any subcommand runs. The error names the root and points the finger at the root, not the session name — the previous fallthrough error at spawn time read as if a random-id name were the problem. Backstop respects `--root <shorter>` overrides.
- Tests in `tests/gc-flap-clear-badge-root-len.test.ts` (7 new) cover: restart-clears-bookkeeping, list shows [flapping] and hides [permanent] when both would apply, list still shows [permanent] otherwise, backstop errors on `pty list` with too-deep root, backstop fires before subcommand parsing, root at the usable threshold succeeds, `--root <shorter>` overrides a too-long env.

### `pty gc` fast-fail respawn cap (fixes #54)

- **New:** `pty gc` STEP-2 now detects a crash-looping permanent session and stops respawning it before it churns forever. A respawn whose leaf exits within `strategy.fast-fail-window` seconds (default 60) of the previous respawn counts as a fast fail; after `strategy.fast-fail-limit` consecutive fast fails (default 3) the session gets `strategy.status=flapping` written to its tags and a `session_flapping` event, and subsequent gc ticks silently skip it. This is the crash-loop-with-live-cwd case that the earlier `cwd-gone`/`idle` reap (#47, #50) didn't cover.
- **New event `session_flapping`.** Payload `{ session, type: "session_flapping", ts, counter, limit, window }`. `counter` is the fast-fail streak at the moment of flip (>= `limit`); `window` is the resolved window in seconds. Documented in `docs/disk-layout.md`.
- **New bookkeeping tags on permanent sessions.** Written by `pty gc` on every respawn: `strategy.last-respawn-at` (ISO timestamp), `strategy.consecutive-fast-fails` (running counter), `strategy.command-hash` (16-char SHA-256 prefix of the respawn command line — used to auto-reset the counter and clear a stale flapping mark when the operator edits the stored command). At the flip: `strategy.status=flapping` is added.
- **Manual reset:** `pty tag <name> --rm strategy.status` (or `pty tag ... --rm strategy.consecutive-fast-fails --rm strategy.last-respawn-at` for a full clean-slate). The next gc tick retries.
- **Auto-reset on command change:** the classifier compares the new command's fingerprint against `strategy.command-hash`. If they differ, the counter resets to zero and `strategy.status=flapping` clears — the operator has already reshaped the problem, no manual step needed.
- **Per-session overrides** — `strategy.fast-fail-window=<sec>` and `strategy.fast-fail-limit=<int>` tags override the defaults for one session; higher precedence than the CLI globals.
- **New CLI globals** — `pty gc --fast-fail-window=<sec>` and `pty gc --fast-fail-limit=<int>` mirror the per-session tags for anyone who wants to override the defaults for a whole gc run.
- **`GcResult` gains two fields.** `flapped: { name, counter, limit, window }[]` — sessions the classifier flipped this tick. `flappingSkipped: string[]` — sessions the classifier silently skipped because they were already flagged. Both are surfaced in `cmdGc` output. Additive; existing consumers keep working.
- **CLI output** — new lines: `Flapping: <name> (<N> fast-fails in <W>s, limit <L>)` on the flip tick and `Skipped (flapping): <name> — remove strategy.status tag to retry` on subsequent ticks. Summary bar adds `N flapping` / `N skipped-flapping` when non-empty. `--dry-run` mirrors with `Would flap: ...`.
- Tests in `tests/gc-flapping.test.ts` (10 new) cover: dry-run previews, at-limit persistence + event emission, already-flapping silent skip, slow-fail counter reset, command-hash auto-reset (clears flapping mark), per-session and CLI-global window/limit overrides, and the first-respawn (no prior last-respawn-at) case.

### Per-namespace isolation — `PTY_ROOT` + `pty --root <path>`

- **New canonical env var `PTY_ROOT`** for the state registry directory (default `~/.local/state/pty`). The pre-existing `PTY_SESSION_DIR` still works and continues to point at the same registry; when only the legacy name is set, `pty` emits a one-time deprecation notice to stderr per process. Precedence: `PTY_ROOT > PTY_SESSION_DIR > default`.
- **New env var `PTY_ROOT_LEGACY_SILENT=1`** — suppresses the `PTY_SESSION_DIR` deprecation notice for callers (test suites, long-lived legacy scripts) that are on a migration schedule.
- **New global flag `pty --root <path>`** — pins the state registry for a single invocation. Parsed before subcommand dispatch, so every subcommand (`list`, `gc`, `kill`, `tag`, `attach`, `up`, `run`, …) transparently scopes. Equivalent to `PTY_ROOT=<path> pty <cmd>`.
- **`pty gc --print-launchd-plist` per-root parametrization.** On the default root the emitted plist retains its Label `com.compoundingtech.pty.gc` (backwards-compatible with existing installs) and its previous log path. On a non-default root the Label becomes `com.compoundingtech.pty.gc.<basename-of-root>` — reverse-DNS-safe (non-`[A-Za-z0-9._-]` runs collapse to a single hyphen) — and the log path is `<PTY_ROOT>/gc.log`. Two networks can each install their own gc plist without a launchd-Label collision, and each network's gc noise stays inside its own registry.
- **`PTY_ROOT` added to the isolate-env allow-list** (`src/server.ts:ISOLATED_ENV_ALLOWLIST`) alongside `PTY_SESSION_DIR`, so `pty run --isolate-env` children still see the pinned registry.
- **Emitted plist now uses `PTY_ROOT`** in its `EnvironmentVariables` block — the deprecation notice fires anew every launchd tick if you re-use the legacy env, so a mid-migration installer gets loud, actionable feedback in `gc.log` instead of silent drift.
- **README** — new "Namespaces" section under "On-disk format" documenting soft (tag-filter) and hard (`--root`/`PTY_ROOT`) namespacing, with the smalltalk `st.network=<value>` tag called out as a specific application of the soft primitive.
- **`docs/disk-layout.md`** — directory table now references `$PTY_ROOT`; legacy env name called out with the migration hint.
- Tests in `tests/pty-root.test.ts` cover: env-var precedence, deprecation notice fires exactly once and is silenced by `PTY_ROOT_LEGACY_SILENT`, `--root` overrides both env vars, `--root` without a value errors clearly, default-root plist retains legacy Label, non-default root gets a suffixed Label + per-root logPath, and a pathological basename (spaces) sanitizes into a launchd-safe suffix.

### Fixes
- **`@compoundingtech/pty/tui` `CellBuffer` — wide-char (2-cell) glyph rendering fixed.** Two root causes, both in `src/tui/buffer.ts`:
  1. `writeAnsi` iterated the input string by UTF-16 code unit, splitting astral-plane codepoints (emoji like `📬`, `📭`, `📫` — U+1F4XX) into two lone surrogate halves stored as separate width-1 cells. Downstream `diff()` and `fullRender()` emitted the halves independently; a modern host terminal (kitty, iTerm2, Ghostty) recombined them as one wide glyph, but the CellBuffer's cell-index → terminal-column mapping was off by one on every emoji. Fixed by detecting surrogate pairs and combining them into one Cell whose `char` holds the full 2-code-unit string.
  2. `diff()`'s `lastCol = c + 1` cursor-position tracker didn't account for the wide char's 2-column advance. After a wide-char emit the terminal cursor lands at `c+2`, but `lastCol` said `c+1`, mispredicting adjacency for the next emit. Fixed by `lastCol = c + charWidth(nc.char)`.
  - Fixes the tui-sup `📬📬2 99` fossilization observed on the agent-viz cards grid when navigation shifted an emoji to a different column.
  - Regression coverage in `tests/buffer-wide-char-diff.test.ts` — 10 cases using xterm-headless + `@xterm/addon-unicode11` as the strong oracle (real-terminal semantics for astral-plane codepoints), verifying that `fullRender(prev) + diff(prev, next)` produces a terminal state equivalent to `fullRender(next)` across shift/replace/toggle/mixed-content scenarios.

### `pty gc` — abandoned-reap for permanent sessions
- **New `pty gc` step 1.5: abandoned-reap.** Runs between orphan-kill (step 1) and permanent-respawn (step 2). Reaps live `strategy=permanent` sessions detected as abandoned — SIGTERM the daemon (if alive), append a `session_abandoned` event, then `cleanupAll`. Two shapes today:
  - **cwd-gone (on-by-default)** — the session's recorded `cwd` no longer resolves on disk (`fs.statSync` throws `ENOENT`). Strong low-false-positive signal. Escape hatch: `strategy.abandon-if-cwd-gone=false` tag opts a session out.
  - **idle (opt-in)** — the session's `lastAttachAt` is older than a configured threshold. Enabled via `pty gc --idle-days N` (global) OR a per-session `strategy.idle-days=N` tag (which takes precedence over the global flag). Sessions with no `lastAttachAt` (never attached) are excluded — a session that was just spawned but hasn't been used yet isn't "idle."
  - Precedence: `cwd-gone` wins over `idle` when both conditions hold — the session is abandoned regardless of attach recency once the cwd is gone.
  - Fixes #47. Together with the process.title patch in #48 (schickling), stops orphaned `pty-daemon` processes from accumulating on long-lived hosts.
- **New event `session_abandoned`.** `{ session, type: "session_abandoned", ts, reason: "cwd-gone" | "idle", idleDays? }`. Appended to `<name>.events.jsonl` before `cleanupAll` unlinks the file, so `pty events` watchers still see the reap even though the session file is gone by the time gc returns.
- **New tag `strategy.abandon-if-cwd-gone=false`** — opts a permanent session out of the on-by-default cwd-gone reap. Only meaningful with `strategy=permanent`.
- **New tag `strategy.idle-days=<N>`** — opts a permanent session into idle-reap even without a CLI flag. Value is a positive integer number of days. Overrides `--idle-days N` when both are set.
- **New session-metadata field `lastAttachAt: string`** (ISO 8601). Written by the daemon on every non-readonly `ATTACH` message. Best-effort — a torn read during a concurrent `pty tag`/`pty rename` mutation doesn't crash the daemon, just loses one attach stamp until the next reconnect.
- **New `pty gc --idle-days N`** — sets the global idle threshold for the run. Positive integer required; zero and negative values are rejected. Combines with per-session `strategy.idle-days` tag (per-session wins).
- **New `pty gc` output row: `Abandoned: <name> (<reason>)`.** `--dry-run` mirrors with `Would abandon:`. Summary line adds "N abandoned" when the bucket is non-empty.
- **`GcResult` gains a fifth field: `abandoned: { name; reason: "cwd-gone" | "idle"; idleDays? }[]`.** Public `@compoundingtech/pty/client` API surface change.

### Breaking changes — supervisor replaced by `pty gc`
- **Removed the long-running `pty supervisor` command and the launchd FDA wrapper.** All `pty supervisor *` subcommands are gone (`start`, `stop`, `status`, `forget`, `reset`, `launchd install/uninstall`, `systemd install/uninstall`, `runit install/uninstall`). The bundled `src/supervisor.ts`, `src/supervisor-entry.ts`, and `scripts/supervisor-wrapper.c` are deleted. So are the three supervisor test files (`tests/supervisor.test.ts`, `tests/supervisor-hardening.test.ts`, `tests/supervisor-service-install.test.ts`). Net: about 600 lines of code and a separate long-lived process removed.
- **`pty gc` now does the supervisor's work**, statelessly, as a one-shot reconciliation pass. Every invocation re-derives intent from on-disk metadata; there's no in-memory restart counter, no persisted bookkeeping, no backoff state, no `[failed]` mark. Three steps run in order on each call: (1) walk sessions with a `parent=<name>` tag and SIGTERM + clean up any whose parent is gone; (2) respawn every `strategy=permanent` session that's exited or vanished (re-reading `pty.toml` when the session is toml-managed); (3) sweep exited/vanished non-permanent sessions (the historic `pty gc` behavior). The intended deployment is to run it on a short cron (default 30 s); failures (binary not on PATH, volume not mounted at boot) are non-events because the next tick tries again. This fixes the boot-time mount race where a supervised session under `/Volumes/SSD` would exhaust its 5-retry budget within 10 s of launchd firing before the volume even mounted.
- **New tag `parent=<name>`** — user-facing, not reserved. When `pty gc` notices the parent's daemon is gone (metadata removed OR pid file gone OR process dead), it SIGTERMs the child and `cleanupAll`s it. Combinator with `strategy=permanent` is well-defined: orphan-kill wins (the child is removed, not respawned). Cycles (A→B, B→A) resolve deterministically by name-sorted iteration.
- **New event `session_respawn`.** Emitted to a session's `<name>.events.jsonl` whenever `pty gc` respawns it. No payload beyond the envelope — the restart is stateless. Replaces the old `session_restart` (which carried `restartCount` / `backoffMs`).
- **Removed event types**: `session_restart`, `session_failed`, `supervisor_start`, `supervisor_stop`. Their corresponding TypeScript types (`SessionRestartEvent`, `SessionFailedEvent`, `SupervisorStartEvent`, `SupervisorStopEvent`) are no longer exported from `@compoundingtech/pty/client`.
- **Removed reserved tag `supervisor.status`.** It was only used to mark a session `[failed]` after exhausting retries — that concept doesn't exist anymore. `isReservedTagKey("supervisor.status")` now returns `false`.
- **Removed `strategy=temporary`.** It was a no-op identical to the default sweep path. Sessions previously tagged that way will fall through `pty gc`'s exited-sweep on the next tick.
- **New `pty gc --print-launchd-plist [--interval=N]`** — emits a macOS launchd plist to stdout that runs `pty gc` every N seconds (default 30). Pure stdout; no FDA wrapper, no compiled binary, no bundling. Install it yourself: `pty gc --print-launchd-plist > ~/Library/LaunchAgents/com.compoundingtech.pty.gc.plist && launchctl load ~/Library/LaunchAgents/com.compoundingtech.pty.gc.plist`. Other systems use one-liners documented in the README (cron, systemd-timer, runit) — no equivalent helper flags for those in v1.
- **New `pty gc --dry-run` output buckets.** The CLI now prints up to four sections per pass: `Killed orphan child:`, `Respawned:`, `Respawn failed:`, `Removed:`, plus the existing `Pruned orphan tags on … :` line. `--dry-run` mirrors with `Would kill orphan child:`, `Would respawn:`, `Would remove:`.
- **`gc()` client API** now returns `GcResult` (`{ removed, killedOrphanChildren, respawned, respawnFailed }`) instead of `string[]`. `pruneOrphanLayoutTags` is unchanged. New `GcResult` type exported from `@compoundingtech/pty/client`.
- **Migration** — if you installed via `pty supervisor launchd install`:
  ```sh
  launchctl unload ~/Library/LaunchAgents/com.compoundingtech.pty.supervisor.plist
  rm ~/Library/LaunchAgents/com.compoundingtech.pty.supervisor.plist
  rm -rf ~/.local/pty/launchd ~/.local/state/pty/supervisor
  pty gc --print-launchd-plist > ~/Library/LaunchAgents/com.compoundingtech.pty.gc.plist
  launchctl load ~/Library/LaunchAgents/com.compoundingtech.pty.gc.plist
  ```
  systemd users: `systemctl --user disable --now pty-supervisor.service && rm ~/.config/systemd/user/pty-supervisor.service && systemctl --user daemon-reload`, then install a cron / timer that runs `pty gc`. runit users: remove the symlink under `~/.config/runit/service` and the service dir under `~/.config/runit/sv`, then add a `run` script that loops `pty gc` with `sleep 30`.

### Breaking: on-disk name decoupled from display label
- **The session `name` (sock + json filename) is now always a short identifier, separate from the user-visible display label.** Before: `pty run --name X -- cmd` made `X` the on-disk identifier (sock file = `X.sock`); pty.toml sessions used `<prefix>-<sessionKey>` as the on-disk name. The result: long pretty labels hit macOS's 104-byte `sockaddr_un.sun_path` limit (~68 chars of usable name with the default session dir), so Nathan's friend trying to give sessions long descriptive names ran straight into `EINVAL`/`ENAMETOOLONG` in spawn. Now: the on-disk name is always a short Crockford-base32 id (8 chars) unless explicitly pinned, and the display label is a separate `displayName` field with permissive validation (≤ 500 chars, any printable text except `/ \ \0 \n \r \t` and control bytes).
- **`pty run` flag rename: `--name <X>` now sets the displayName; the on-disk id is set by `--id <X>`.** Old `pty run --name long-pretty-label -- cmd` silently broke on long values; new `pty run --name "My Long Pretty Label" -- cmd` works. To pin an explicit on-disk id (for deterministic scripting / reproducible automation), use `pty run --id <id>`. Both omitted → random id + auto-generated displayName. Both can be combined: `pty run --id svc --name "My Service" -- cmd`. The id is validated up front (charset, sock-path length, uniqueness) so automation fails loudly rather than producing a cryptic `EINVAL` deep in spawn. `--no-display-name` still works for "id only, no label."
- **`pty up` (pty.toml sessions) gives every session a random short id.** The previous behavior of using `<prefix>-<sessionKey>` as the on-disk name is gone; that string is now the `displayName`. Long `prefix` values that used to hit the kernel limit (`prefix = "my-very-long-project-name"`, `[sessions.frontend-dev-server]` → 41-char name + path overhead) now succeed because the sock filename is just the 8-char id.
- **`pty up` re-run detection: matches existing sessions by the `(ptyfile, ptyfile.session)` tag pair, not by name.** Same external behavior — `pty up` on a running toml session prints `(already running)` — but the matching key changed underneath. Manual `pty rename`s on a toml session no longer confuse `pty up`.
- **pty.toml gets two optional fields per session table:**
  - `id = "..."` — pin the on-disk identifier (validated like `--id`).
  - `display_name = "..."` — override the default `<prefix>-<sessionKey>` label.
  Both omitted → random id + default label. Existing tomls keep working with no edits.
- **`pty rename` now validates the new display name with `validateDisplayName`** (permissive: ≤ 500 chars, no slashes / backslashes / null / newlines / control bytes) instead of the strict `validateName` (sock-filename charset, sock-path length). The strict path is reserved for ids.
- **`SessionMetadata.displayName` is now preserved through exit.** Previously `saveExitMetadata` rebuilt the metadata blob from `this.options` and didn't carry `displayName` forward, so a session that exited dropped its display label. Now it's read from existing metadata and re-stamped.
- **Internal: `PtySessionDef.name` is gone — replaced by `displayName` + optional `id`.** Consumers of `readPtyFile()` need to update field references. `shortName` (the raw toml key) is unchanged. **External CLI/API surface unchanged for sessions resolved by reference** — `pty kill`, `pty peek`, `pty send`, `pty attach`, etc. already resolved by either name or displayName via `resolveRef → getSession`, and continue to.
- **Migration**: existing sessions created under the old name model keep working as-is; their files don't move. New sessions created by `pty run` or `pty up` after the upgrade use the new shape. If you have shell aliases or scripts that hand-glob `~/.local/state/pty/<name>.sock` by a known long name, they will stop finding new sessions — query via `pty list --json` and resolve by `displayName`.

### Spawn lifecycle
- **`spawnDaemon({ bindToSpawnerLifetime: true })` ties the daemon's lifetime to the spawner.** Off by default, so existing callers see no change. When enabled, `spawn.ts` sets `PTY_SPAWNER_PID=<spawner pid>` in the daemon's env; `server.ts` polls that PID every 5 s and calls `cleanShutdown(0)` once it's gone (and exits immediately if the spawner is already dead at startup). Fixes the orphan-daemon class of bug where a short-lived spawner (script, test harness, scoped Effect resource) exits without calling `disconnect()` / `kill()` and leaves the daemon reparented to init forever — observed in the wild as hundreds of `@compoundingtech/pty/dist/server.js` processes accumulating multi-GiB RSS over days. Long-lived supervisors that want the daemon to outlive them simply omit the option. Implemented via env var rather than a runtime API so the daemon (a separate process) needs no IPC. See [overengineeringstudio/effect-utils#677](https://github.com/overengineeringstudio/effect-utils/issues/677) for the full write-up.

### Interactive TUI
- **Home list auto-refreshes when sessions change underneath it** (closes #26). Previously the overview was a snapshot taken on screen entry — new sessions, exits, tag changes, and rename events didn't appear until the user navigated away and back. Now the home screen polls `listSessions()` once per second while it's the active view, pushing the result through the `sessions` signal so the framework's reactive render picks it up. Polling pauses while the user is attached / spawning a new session and resumes on return; the interval is `unref()`-ed so it never holds the event loop alive on its own (the TUI exits cleanly when the user quits or stdin closes). Polling was chosen over `fs.watch` / `EventFollower` because cross-process file-watching through the node-pty child layer is unreliable on macOS — polling is simpler, platform-independent, and cheap (one `readdir` + per-file `stat` per second).
- **Filter and selection persist across attach/detach** (closes #27). Previously, the overview's filter input and selection were cleared every time the user attached to a session and came back — `doAttach` (and the remote-spawn / remote-attach paths) explicitly reset `filterField` to empty on `onDetach` / `onExit`. That made jumping in and out of sessions feel disorienting. Now the four return paths preserve both. The selection still clamps when the underlying list shrinks (a session that exited and got reaped while the user was attached), so it never points off the end. The clear-filter-on-spawn behavior was the same code path; it's also gone, which means `+ Create new session...` followed by detach lands you back on your filtered view too.

### Tags
- **`pty tag-multi` — multi-session tag operations.** New sibling command for read and write across many sessions in one CLI invocation. Three mutually-exclusive selectors:
  - `<name>...` — explicit list (resolved up-front; if any name is unresolvable the command aborts before any write so partial application doesn't happen)
  - `--filter-tag k=v` — sessions matching tag(s); repeatable for AND
  - `--all` — every session
  No ops = read mode (per-session tag dump, text or `--json` returning `{ name → tags }`). Any ops (`k=v` / `--rm k`) flips to write mode. `--all` writes are destructive across the whole session dir, so they require `--yes` / `-y`; without it the command exits non-zero with the matched count and no writes. Empty match (filter or `--all` over an empty dir) is exit 0 with `0 sessions matched.`. Each successful write is individually atomic and emits its own `tags_change` event; per-session no-ops (effective tags unchanged) emit nothing. The single-session `pty tag` command is unchanged — `pty tag-multi` is a separate entry point so a fingerslip can't accidentally rewrite the wrong scope. Examples: `pty tag-multi --all --json`, `pty tag-multi --filter-tag role=web env=prod`, `pty tag-multi sess-a sess-b --rm temp-flag`, `pty tag-multi --all --yes audit=2026-04-25`.
- **`pty tag` now has a defined contract for bulk operations.** Multiple `key=value` and `--rm <key>` may appear in any order in a single invocation; updates apply before removals (so `pty tag X k=v --rm k` ends with `k` removed, by design — last-step-wins). All tag mutations fan into one atomic `writeMetadata` and one `tags_change` event with full before/after snapshots; effective no-ops (setting current values, removing missing keys, set+rm of a key that never existed) emit nothing. Same-key duplicates: last positional wins for sets, idempotent for `--rm`. New error surface: empty keys (`=value`, `--rm ""`) and `--rm` at end-without-arg are rejected with clear messages. Bulk pattern is the recommended shape for hooks that stamp several tags at once — pays Node startup once instead of N times. The single-key form (`pty tag X role=web`) is unchanged.

### Storage format
- **Documented the on-disk layout** in [docs/disk-layout.md](docs/disk-layout.md). Covers `PTY_SESSION_DIR`, the full directory contents (`<name>.json`, `.events.jsonl`, `.sock`, `.pid`, `.lock`, `theme`, `supervisor/`), the metadata JSON shape field-by-field, the events JSONL line format and every built-in event type, the atomic-write tmp-file convention (`<target>.tmp.<pid>.<rand>` — third-party readers must ignore these), and stability tiers (tier 1 = "we'll try not to break this," tier 2 = "may move freely"). Aimed at non-Node consumers who want to skip the CLI's startup cost — read the JSON directly or ship a fast-path reader as a `pty-<subcommand>` binary on `$PATH`. Pre-1.0 caveat: schema may change in any release; pin to a pty version. The README's Events section now points at the doc.
- **Drift-guard test** (`tests/disk-layout-docs.test.ts`) asserts every `SessionMetadata` field name, every concrete event-type literal, and every file extension we write under `PTY_SESSION_DIR` is mentioned in the doc. Adding a field or event type without documenting it fails CI. The corresponding interfaces in `src/sessions.ts` and `src/events.ts` carry `// PUBLIC FORMAT` comments pointing at the doc.

### Interactive TUI
- **Readline-style editing shortcuts in the interactive filter input** (closes #24). The `pty` / `pty i` / `pty interactive` picker's filter input was append-only (backspace + printable chars) — no cursor, no word motion, no kill-line. It now carries a real cursor and routes every keystroke through `applyTextKey`, which means: `ctrl+a` / `ctrl+e` / `home` / `end` to jump, `left` / `right` / `alt+←/→` / `alt+b` / `alt+f` to walk and word-motion, `ctrl+u` to clear, `ctrl+w` to delete the previous word (new), `ctrl+k` to kill to end of line (new), and printable characters insert at the cursor. The filter line renders with `renderFieldNodes` so the cursor paints on top of the character under it (inverse-video) without shoving neighbors sideways.
- **`applyTextKey` (in `@compoundingtech/pty/tui`) gained `ctrl+w` and `ctrl+k`.** Every text-field consumer — the interactive filter, the form widget, the command palette, the prompt bar — inherits the shortcuts for free.

### Fixes
- **Concurrent writers can no longer corrupt the session metadata file.** Reported against `pty tag` but the flaw spanned four write sites: `writeMetadata` (sessions.ts), supervisor state save, `pty supervisor reset`, and the event-log retention/truncation path. All four shared the same bug — `target + ".tmp"` is a single fixed path per target, so two concurrent writers truncate-and-overwrite each other's tmp file, and whichever `rename` runs second (or first, depending on timing) can land a half-written JSON blob into the target. Fix: new `atomicWriteFileSync` / `atomicWriteFile` helpers in `sessions.ts` that use a unique tmp path per writer (`<target>.tmp.<pid>.<rand>`), `writeFileSync` into that, then `rename` into place. POSIX same-filesystem `rename` is atomic; readers always see either the old file or the new one, never an intermediate. All four call sites now route through the helper. Event-log truncation (previously `writeFile` in place over a 1000-line rollover) also goes through tmp+rename, so `pty events` readers never see a mid-rewrite file. Contract: last-write-wins under concurrent writers — lost updates are possible, corruption is not. Large (> 4KB) `user.*` / `state.set` event payloads can still interleave at the POSIX `O_APPEND` level; the module documents this and recommends keeping large blobs in state rather than events.

## 0.10.0 (2026-04-24)

### Nesting prevention (client-inside-a-client refusal)
- **`pty attach`, `pty a`, and `pty attach -r`** now refuse to run when `$PTY_SESSION` is set. Attaching inside an existing client nested two clients and sent detach keybindings to the outer one, leaving users tangled. The guard fires before ref resolution, so even a mistyped name yields the nesting hint instead of "Session not found." Error text points at `Ctrl+\\` to detach and at pty-layout's `^]n` for users inside a tiled layout. `--force` restores the old behavior.
- **`pty restart <ref>`** still restarts the session when nested (that operation is independent of attach), but skips the trailing `doAttach` and prints `(not attached: already inside pty session "X")`. `--force` restores the old restart-then-attach behavior. `-y` / `--yes` (which skips the kill-confirm prompt) is unchanged and independent.
- **`pty` / `pty i` / `pty interactive`** refuse to open the TUI picker when nested — the picker rendering inside a session with broken detach was a worse footgun than any other vector. `--force` opens it anyway (useful for debugging the TUI itself).
- **`pty run -a`** narrows the existing "already inside pty session, running directly" behavior: if `-a` was given and the target session is already running, refuse rather than silently dropping `-a` and running the command in-place. The target-not-running case keeps the run-directly behavior (there's no session to attach to). `--force` skips the new check.
- **Shared helper `ensureNotNested(cmd, { force?, hint? })`** in `src/cli.ts` — early exit with a consistent message and per-command hint text.
- **`Session.spawn` (the `@compoundingtech/pty/testing` harness) now scrubs `PTY_SESSION` from the child env** in addition to the existing `PTY_SERVER_CONFIG` scrubbing, so tests running inside a pty session don't leak that context into the CLI they're exercising. Without this, every interactive-TUI test would trip the new guard.

### Events & state
- **`pty emit` — publish user events.** `pty emit <type> [--json <payload>] [--text <string>]` appends an event of type `user.<name>` to a session's `.events.jsonl` file. `<type>` must start with `user.` (the `user.*` namespace is reserved for arbitrary app events and will never collide with built-in types). Inside a pty session the ref is omitted — `$PTY_SESSION` resolves it — so scripts inside a session can just run `pty emit user.deploy.started --json '{"commit":"abc123"}'`. Consumers tail via the existing `EventFollower` API. Programmatic access: `emitUserEvent(sessionName, type, { data?, text? })` on `@compoundingtech/pty/client`.
- **`pty state` — per-session JSON key/value bag.** Each session's metadata file now carries an optional `state: Record<string, unknown>` field with four CLI subcommands:
  - `pty state set [ref] <key> [value]` — value parsed as JSON; if omitted, read from stdin (for piping big payloads).
  - `pty state get [ref] [key]` — prints a single key's value (JSON), or the whole bag pretty-printed when `key` is omitted. Missing key exits non-zero with no stdout.
  - `pty state delete [ref] <key>` — removes a key (drops the whole `state` field if the last key is removed).
  - `pty state keys [ref]` — one key per line.
  All four support the inside-session shorthand where `ref` is omitted and `$PTY_SESSION` resolves it. `pty state set` takes the JSON value as exactly one positional or as stdin — three or more positionals are rejected with a clear hint to quote the value (previously trailing args were silently joined with spaces and fed to `JSON.parse`, which produced confusing errors). Writes go through `writeMetadata`'s atomic rename, so readers never see a torn file, and in-process `Promise.all` over many `setState` calls lands every update (Node is single-threaded and `setState` is synchronous). Cross-process concurrent writers can still race on the read-modify-write window; keep multi-writer fan-outs serialized if it matters. Mutations automatically emit `state.set` / `state.delete` events (carrying `key` and `value`), so downstream watchers get a full history without extra wiring. `pty state delete` on a missing key is a quiet no-op — no ghost event fires. Programmatic access: `getState`, `getStateKey`, `setState`, `deleteState`, `listStateKeys` on `@compoundingtech/pty/client`. `deleteState` now returns a `boolean` indicating whether a key was actually removed (was `void`).
- **New event types exported from `@compoundingtech/pty/client`:** `UserEvent`, `StateSetEvent`, `StateDeleteEvent`, `DisplayNameChangeEvent`, `TagsChangeEvent`, plus helpers `emitUserEvent`, `appendEvent`, `isUserEvent`, `validateUserEventType`. `EventBase.type` widened from the `EventType` enum to `string` so subtypes carry their own literals (`user.${string}` / `"state.set"` / `"state.delete"` / `"display_name_change"` / `"tags_change"`); existing consumers that switch on the enum values are unaffected.
- **`display_name_change` event on rename.** `setDisplayName` (and therefore `pty rename`) now emits `{ session, type: "display_name_change", ts, previous, value }` whenever the stored display name actually changes. `previous` and `value` are `string | null`. No-op writes (renaming to the same value, clearing when already null) emit nothing. Requested by pty-layout so live TUIs can refresh cached pane titles in response to a rename instead of polling metadata or waiting for re-attach.
- **`tags_change` event on tag mutation.** `updateTags` (and therefore `pty tag`, `pty run --tag`, supervisor status stamping, etc.) now emits `{ session, type: "tags_change", ts, previous, value }` with full snapshots of the previous and new tag maps. Consumers diff the two maps; no need to reason about `updates` vs. `removals`. Skipped on no-op updates (setting the same value, removing a key that isn't present).
- **Event emission moved down into the helpers.** Previously `state.set` / `state.delete` were emitted by the `pty state` CLI wrapper — calling `setState`/`deleteState` directly from `@compoundingtech/pty/client` wrote metadata but no event, so programmatic consumers (pty-layout, dashboards) never saw the change. `setState` now emits on every successful write; `deleteState` emits when it actually removed a key. Same pattern for `setDisplayName` and `updateTags`. The CLI no longer needs to emit separately. Downstream callers pick this up automatically — if you were relying on the CLI being the emission point, you no longer need to guard against double-emission because the CLI path was removed.

### Supervisor
- Add `pty supervisor systemd install|uninstall` for Linux user services. The installer writes a unit to `~/.config/systemd/user/`, sets `PATH`, `TERM`, `COLORTERM`, and `PTY_SESSION_DIR`, runs `systemctl --user daemon-reload`, and enables/starts the service immediately. If linger is disabled, the command now prints a hint explaining that the service will only stay up while the user session exists and how to enable boot-time startup with `loginctl enable-linger`.
- Add `pty supervisor runit install|uninstall`. The installer writes a `run` script plus symlink-ready service directory (defaulting to `~/.config/runit/{sv,service}`), exporting the same environment variables before execing the supervisor entry point. This is aimed at runit-based systems like Void Linux, while still being easy to test from a private `runsvdir`.
- Add integration coverage for both installers: a real `systemctl --user` install/uninstall test and a runit install test that boots the generated service under a private `runsvdir`.

### TUI framework
- **Palette index preserved end-to-end through the CellBuffer pipeline.** Second half of the palette-preservation work (first half was on `PtyHandle.readCells`). The buffer-side `Cell` interface in `src/tui/types.ts` gained `fgIndex: number | null` and `bgIndex: number | null` (required, to match the strictness of `fg`/`bg` and keep all internal constructors honest). `writeAnsi` now captures the index on SGR 30-37 / 90-97 / 38;5;N / 48;5;N (and nulls it on truecolor 38;2 or resets 0/39/49). `diff` and `fullRender` emit the indexed SGR when `fgIndex` / `bgIndex` is non-null and fall back to 38;2 truecolor otherwise, so round-trips like `writeAnsi("\x1b[34mhi")` → `fullRender` produce `\x1b[34m` and not `\x1b[38;2;0;0;204m`. `cellsEqual` compares the indices, so the diff layer correctly re-emits when only the index changed. Same change propagated through `emptyCell`, `makeCell`, and the few inline cell literals. The ptyView rendering path now forwards `cell.fgIndex`/`bgIndex` into the buffer, so embedded PTY panes re-emitted by consumers like pty-layout keep the outer terminal's theme for indexed colors while still supporting truecolor for programs that emit it.
- **`PtyHandle.readCells` now preserves palette indices (`fgIndex` / `bgIndex`).** Cells returned from `readCells()` gained two optional fields: `fgIndex: number | null` and `bgIndex: number | null`, populated with the raw 0-255 palette index whenever the source used SGR 30-37 / 90-97 / 38;5;N / 48;5;N. Previously palette cells were flattened to hardcoded VGA RGB via `paletteToRgb()` (blue became `[0,0,204]`, etc.), which was correct for `ptyView()` rendering but wrong for consumers like pty-layout that reconstruct the cell grid into SGR bytes aimed at a real terminal — the outer terminal's theme was lost. The existing `fg` / `bg` RGB fields are unchanged and still filled with the flattened approximation, so nothing breaks; re-emitters just check `fgIndex` first. Named `PtyCell` type (new) exported from `@compoundingtech/pty/tui` for consumers that want the shape without a `ReturnType<...>` dance. `underlineColor` deliberately skipped — the existing `Cell` shape only tracks `underline: boolean`, so palette-aware underline colors would be a bigger addition than a nullable-index twin of an existing field.
- **Automatic re-render on embedded PTY data arrival.** `PtyHandle` now carries a reactive `rev` signal that bumps on every data/exit/resize/theme event, and `ptyView()`'s render path reads it — so the framework's `effect()` re-renders automatically whenever the embedded terminal content changes. Previously the consumer had to wire `handle.onActivity` to a signal bump manually; forgetting to meant output appeared to "buffer" until some unrelated signal read triggered a render (e.g., a keystroke forcing a cursor-position update). `onActivity` remains as an escape hatch for non-render side effects (stats, notifications) but is no longer required for the common case. Non-breaking.
- **Focus manager.** `createFocusManager()` + `ctx.focus` on every `ScreenContext`. Stack-based: `push(scope)` returns a disposer, `dispatchKey` / `dispatchMouse` walk innermost → outermost with bubbling (return `false` to let the parent scope try). Scopes can be conditionally active via an `active: () => boolean` predicate — useful for keeping sibling scopes alive (like one per pane) and switching which one dispatches without pushing/popping. Solves the "nested panes / modals / overlays" routing problem that every app was re-implementing by hand. The playground now uses it: global pane-switch chords via `AppConfig.onKey` (they intercept before any scope so modals can't swallow them); pane scopes in the focus stack with `active: () => pane.get() === ...`. Modal overlays just push a scope on top and dispose it when closed. `FocusManager`, `FocusScope` exported from `@compoundingtech/pty/tui`.
- **Mouse support.** Set `AppConfig.mouse: true` to enable SGR mouse reporting. Screens get an optional `handleMouse(event, ctx)` alongside `handleKey`. `MouseEvent` carries `action` (`press` / `release` / `drag` / `move` / `scrollUp` / `scrollDown`), `button` (left/middle/right/none), 0-based `x`/`y`, and modifier flags. `hitTest(roots, x, y)` walks the rendered tree by `_rect` to find the deepest node under a point; `findInPath` locates a typed ancestor. Widgets that benefit from mouse — `virtual-list` (click + scroll), `stream-view` (scroll), `tabs` (click to select) — gained `handleVirtualMouse` / `handleStreamMouse` / `handleTabsMouse` helpers. `parseInput(buf)` returns the unified `InputEvent` stream; the legacy `parseKey(buf)` filters it to keyboard-only so existing consumers are unaffected.
- **Cursor rendering via `inverse`.** `text()` gained optional `inverse` and `background` style flags. Text widgets (`renderFieldText` / `renderTextArea`) render the cursor by painting the character under it with fg/bg swapped instead of inserting a block glyph that shifts neighbors sideways. New `renderFieldNodes(text, cursor, active, opts)` returns the three text nodes (before / inverse / after) for composing custom fields.
- **Multi-line prompt bar.** `promptBar({ kind: "multi", state })` now renders each line of the `TextAreaState` as its own row within its column, so newlines actually show. Prompt glyph appears only on the first line; continuation rows are indented.
- **Word motion in text fields.** `applyTextKey` / `applyTextAreaKey` respect `alt+left`/`alt+right` and `alt+b`/`alt+f` for word-boundary navigation. The input parser learned modified-arrow sequences (`ESC[1;mods<letter>`) so `option+arrow` on macOS terminals routes correctly.
- **Separator bg preserved inside panels.** `hSepBuf` used to zero-out the cell bg, showing the terminal default through as a grey band when separators sat inside a panel. Now it preserves the underlying cell bg.
- **Breaking: `handleKey` return value no longer quits the app.** Screens that want to quit now call `ctx.quit()` explicitly (`ScreenContext.quit`). The old "return `false` from `handleKey` → app exits" behavior was a footgun: any screen that forgot to return `true` on an unhandled key would accidentally terminate. The return value is now a hint for nested routing only; the framework ignores it. Also: `app()` now has a default ctrl+c handler that calls quit unless `AppConfig.onKey` intercepts the key first — most consumers duplicated this themselves and no longer need to. The interactive pty TUI and the playground demo have been migrated to the new pattern.
- **New widgets tier.** `src/tui/widgets/` exposes higher-level building blocks on top of the core primitives: tree view (`tree.ts`), date picker (`date-picker.ts`), multi-field form with focus ring (`form.ts`), markdown renderer (`markdown.ts`), multi-line text composer (`text-area.ts`), virtualized list for large datasets (`virtual-list.ts`), sticky-bottom stream view for chat/logs (`stream-view.ts`), horizontal tabs (`tabs.ts`), confirm modal (`confirm.ts`), toast queue (`toast.ts`), fuzzy command palette (`command-palette.ts`), sortable table (`table.ts`), a help-overlay helper (`help-overlay.ts`), Claude-Code-style prompt bar (`prompt-bar.ts`), toolbar (`toolbar.ts`), sparkline (`sparkline.ts`), and bar chart (`bar-chart.ts`). All state-first: the consumer owns the signals, widgets are pure key-dispatch + pure render. Re-exported from `@compoundingtech/pty/tui`; existing primitives (text, row, column, panel, selectable, etc.) are unchanged. Full tests per widget.
- **Signal-backed command registry** (`command-registry.ts`): `registerGlobalCommand` for app-lifetime commands and `useCommandScope(scopeId, commands)` for screen/focus-scoped commands. The existing `command-palette.ts` widget takes a `Command[]` — pass `allCommands.get()` to get the aggregated live view. Scopes compose (global + screen + focus), replace in one call (useful for contextual focused-item commands), and auto-unregister via returned disposers. Enables the "command palette represents every action across the app" pattern without every call site knowing about every command.
- **Panel footer caption.** `panel(title, children, { footerTitle: "x" })` renders an optional caption on the bottom border with the same chrome as the top title. Mirrors mactop's "4/17 layout (skyblue) · -/+ 1000ms" strip. Back-compat: the third arg can still be a plain `BoxStyle` string.
- **Shift+Tab (backtab) now fires as a proper key event.** The raw-stdin parser in `src/tui/input.ts` previously dropped the legacy `ESC[Z` encoding as "unknown CSI" and ignored the shift modifier in the kitty keyboard protocol for code 9 (tab). Both paths now produce `{ name: "backtab", shift: true, ctrl: false, alt: false }`, so form widgets across apps can bind shift-tab for backward field navigation. Added `shift: boolean` to `KeyEvent` as a required field — existing consumers that only read ctrl/alt are unaffected. Surfaced while building the `reminders` app where the form widget needed backtab to move between fields.

### Demos
- Add `demos/playground/` — an interactive catalog of every widget the TUI framework ships, grouped by category (atoms, layout, inputs, lists, data, overlays, patterns, kitchen-sink). Each demo has its own state, live interaction, and a source snippet. Run via `./demos/run playground`. Intended as reference docs + a shareable "here's what the framework does."

### Fixes
- **Shift+Enter / kitty keyboard protocol inside supervised (launchd-started) sessions.** Children of a daemon started from a minimal env (launchd, systemd, sparse CI runners) previously had no `TERM` at all, which caused modern TUIs — Claude Code, vim, nvim — to fall back to legacy key encoding where Shift+Enter is indistinguishable from Enter. Two related fixes:
  - `buildChildEnv` in `server.ts` now defaults `TERM=xterm-256color` in the child's env whenever it would otherwise be absent. Never overrides an explicit value. Covers all three env paths (legacy inheritance, `isolateEnv` allow-list, verbatim `env:`).
  - Removed the hardcoded `name: "xterm-256color"` from `pty.spawn()`. node-pty's `name` parameter unconditionally clobbers `env.TERM`, which meant a user running under `TERM=xterm-kitty` in their outer terminal never had that reach the inner child — the inner pty was always forced to `xterm-256color`. Now an inherited `TERM` (kitty, wezterm, iterm2) flows through naturally, letting TUIs negotiate the richer capabilities those terminals offer.
  - Supervisor also sets `TERM` / `COLORTERM` on its own `process.env` at startup as belt-and-suspenders, so any subprocess spawned outside the `spawnDaemon` path also sees a usable terminal type.

### List & GC ergonomics
- Add `"vanished"` as a third session status alongside `"running"` and `"exited"`. A session becomes `vanished` when its daemon process is gone but no exit record was written (no `exitCode`, no `exitedAt`) — the shape caused by SIGKILL, OOM, or power-loss where the daemon had no chance to finalise metadata. `pty list` groups vanished sessions into their own warning-styled bucket (yellow header, `⚠` marker) so operators don't confuse them with clean exits, and `pty list --json` emits the literal string `"vanished"` in the `status` field. Same reapability as `exited` — `pty gc` cleans both up in one pass. The 24h `DEAD_SESSION_TTL` now also applies to vanished sessions (anchored on `createdAt` when `exitedAt` is absent), so they don't accumulate indefinitely on machines that regularly hard-crash. (part of #21)
- Add `pty list --summary` (and `--json --summary`). Replaces the per-session table with compact counts plus oldest/newest pointers, e.g. `7 sessions — 4 running, 2 exited, 1 vanished\noldest: claude-main (running, 2h12m)\nnewest: build-worker-3 (exited, 3m)`. Respects any filters in play (`--status`, `--older-than`, `--newer-than`, `--filter-tag`), so questions like "how many stale web workers do I have?" are one command. (part of #21)
- Add `pty list --status <running|exited|vanished>` to narrow output to a single status. (part of #21)
- Add `pty list --older-than <dur>` / `--newer-than <dur>` age filters. Grammar: compact single-unit durations `Ns | Nm | Nh | Nd` (no compound forms like `1h30m`). Age is anchored on `exitedAt` when present, else `createdAt`. Composes with `--status` and `--filter-tag`. (part of #21)
- Add `pty gc --dry-run` (`-n`). Walks the same set `gc` would clean up — exited sessions **plus** vanished sessions **plus** orphan `:l<pid>-<rand>` layout tags — and prints `Would remove:` / `Would prune:` lines without mutating anything. Ends with `Would clean up N stale sessions. (Dry run — no changes made.)`. (part of #21)
- `gc()` client API now accepts an options object: `gc({ dryRun?: boolean }): Promise<string[]>`. Same for `pruneOrphanLayoutTags({ dryRun })`. Default behaviour unchanged. (part of #21)
- Export `isGone(status)` helper from `@compoundingtech/pty/client` — returns `true` for both `"exited"` and `"vanished"`. Use this in callers that mean "has metadata but no live daemon" (e.g. "reuse the cwd/tags for a respawn") rather than hand-rolling the two-branch check. (part of #21)
- Export `parseDuration` and `formatDuration` from `@compoundingtech/pty/client`. Downstream tools (pty-relay, pty-layout) can accept the same `Ns|Nm|Nh|Nd` grammar as `--older-than/--newer-than` without duplicating a parser.

### Send
- Add `pty send --paste` (and `paste: true` on `SendOptions` / `SendDataOptions`) to wrap the entire payload in bracketed-paste markers (CSI 200 ~ … CSI 201 ~). The receiving TUI treats everything between the markers as one paste event rather than a sequence of keystrokes — intended for injecting multi-line prompts into agent sessions (claude, aider, etc.) without premature submission when the payload contains newlines. Works with positional text, `--seq` sequences, and composes with `--with-delay`. Flag position-independent.
- **Behaviour change:** `pty send` now errors on unknown trailing flags after positional text instead of silently dropping them. Previously `pty send <name> "text" --enter` exited 0 and sent only `"text"` — the `--enter` was swallowed and the text never executed because no Enter was appended. Now: exits non-zero with `Unexpected argument: --enter`. The common typos `--enter` / `--newline` / `--return` / `--cr` additionally print a hint pointing at the real syntax `--seq "<text>" --seq key:return`. Mirrors the strictness of the `--seq` parsing branch. (closes #20 — thanks @schickling-assistant)

### Client API
- Add `env?: Record<string, string>` to `SpawnDaemonOptions` and `ServerOptions` — use this to spawn a session child with a verbatim environment (no inheritance from the daemon's `process.env`, no allow-list). `PTY_SESSION` is always injected on top so nesting detection and `pty exec` keep working. Mutually exclusive with `isolateEnv` / `extraEnv` (throws at daemon startup if both are passed). Requested by the pty-layout dev to spawn a launcher shell with a shim `tmux` on `PATH`, a custom `TMUX` marker, and a filter-tag env var.
- Add `PtyHandle.readWrappedFlags(scrollOffset?): boolean[]` — per-row flags aligned with `readCells`, where `true` means the row continues the previous row because xterm wrapped a long line (not because the child emitted `\n`). Intended for consumers reconstructing logical lines from a visually-multi-row text selection (e.g., copying a wrapped URL to the clipboard without a spurious newline). Passes through xterm.js's `IBufferLine.isWrapped`; works for both `createPty` embedded terminals and `attachPty` remote sessions since the serialize/replay path preserves wrap state.
- Add `isReservedTagKey(key)` to `@compoundingtech/pty/client`. Returns `true` for pty's internal bookkeeping keys (`ptyfile`, `ptyfile.session`, `ptyfile.tags`, `supervisor.status`, `strategy`) **and** for any key starting with `:`. The `:` prefix is a new convention for **tool-owned tags** — downstream tools (pty-relay, pty-layout) can set and read tags like `:l<pid>-<rand>` or `:layout=grid` and have them hidden from `pty list` and the interactive TUI by default, while still being visible under `pty list --tags`. Replaces five copies of a hand-maintained deny-list across `cli.ts`, `interactive.ts`, and downstream consumers.
- Add `pruneOrphanLayoutTags(): Promise<PrunedTagResult[]>` and wire it into `pty gc`. Walks **running** sessions, matches tag keys against `/^:l(\d+)-[a-z0-9]+$/`, and removes any whose encoded PID is no longer alive (ESRCH from `kill(pid, 0)`). Use case: pty-layout stamps `:l<pid>-<rand>` on each session it owns a view of, and if the layout process crashes the tag persists. `pty gc` now cleans these up alongside exited sessions in one pass.

## 0.9.0

### Session naming
- **Breaking (default behaviour):** `pty run` without `--name` now assigns a short random id (Crockford-ish base32, 8 chars) to the session's `name` field, and stores the old human-friendly cwd+command label in a new optional `displayName` field. `PTY_SESSION`, events, `ptyfile.session`, and anything else that references a session by its stable id will see the random id for sessions created after this release. Sessions created before this release continue to work unchanged (their `name` stays what it was).
- Add `pty run --no-display-name` — generates the random id but skips the `displayName` auto-gen. Useful for throwaway shells you might promote later.
- Add `pty rename`:
  - `pty rename <new>` inside a session — sets `displayName` on the current session (uses `PTY_SESSION`)
  - `pty rename <ref> <new>` outside — sets `displayName` on `<ref>`
  - `pty rename --show <ref>` — prints the current `displayName`
  - `pty rename --clear [ref]` — removes the `displayName`
  - `name` is immutable; rename only ever writes `displayName`.
- Lookup-by-ref (`pty attach`, `peek`, `send`, `stats`, `kill`, `rm`, `tag`, `restart`, `events`) now accepts either the stable `name` or the mutable `displayName`. Collisions between a name and a displayName across live sessions are rejected at create/rename time.
- `pty list` and the interactive TUI now render `displayName` as the primary label when set, with the stable `name` shown in parens for disambiguation; when no `displayName` is set, just the `name`.
- New workflow this enables: `pty run --no-display-name -- bash` → work in the shell → `pty rename my-claude` → `pty exec -- claude` (promote an anonymous shell into a named, long-lived agent session without exiting).

### Security
- BUG-1: `validateName` now rejects session names whose Unix-socket path would exceed the 104-byte `sun_path` limit; previously the daemon's `listen()` failed silently inside an error handler and the `ready` Promise never resolved, hanging every caller. `server.ready` also now rejects on listen errors.
- BUG-2: `acquireLock` is now built on `open(O_CREAT|O_EXCL)` (`openSync(path, "wx")`); two processes racing to steal a stale lock can no longer both win.
- BUG-3: `PacketReader` enforces a 32 MiB `MAX_PACKET_LENGTH` cap and throws `PacketTooLargeError` on oversize length headers; socket handlers catch and destroy the peer. Previously a crafted `length=0xFFFFFFFF` frame would cause unbounded buffer growth.
- BUG-4: Add `pty run --isolate-env` (and `isolateEnv: true` / `extraEnv` on `SpawnDaemonOptions` / `ServerOptions`) to spawn session children with a scrubbed env limited to an allow-list (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `COLORTERM`, `LANG`, `TZ`, `PWD`, `TMPDIR`, `LC_*`, `PTY_SESSION_DIR`, `PTY_SESSION`). Intended for pty-relay to apply when spawning daemons for remote clients — prevents operator secrets (cloud tokens, OAuth, `PTY_RELAY_PASSPHRASE`, etc.) from leaking into a session reachable by a remote user. Default behaviour is unchanged.
- BUG-5: The Unix-socket file is now created under `umask 0o077`, closing the microsecond window where the inode was group/world-readable before `chmod 0o600`.

### Fixes
- Fix fire-and-forget sends hanging in Linux namespace containers. Both the library-side `sendData` (Promise API in `@compoundingtech/pty/client`) and the CLI-side `send` (used by `pty send`) were resolving on the socket's `'close'` event, which requires both sides to half-close; some container network stacks (e.g. Namespace.so runners) don't reliably trigger the server's auto-half-close, so callers hung forever. Both now resolve on `'finish'` — the writable side has been flushed to the kernel, which is exactly the guarantee a fire-and-forget send needs. (closes #18, #19 — thanks @schickling-assistant)
- Fix `pty list --remote` not rendering tags or displayName on remote sessions. Remote sessions now go through the same render path as local — displayName in parens, strategy marker, user-facing tags as `#key=value` — whenever the relay includes them in its `ls --json` output.
- Fix mouse tracking modes (1000/1002/1003) not being replayed when a client reattaches to a session with mouse tracking already enabled — the server previously only replayed the SGR encoding (1006), cursor visibility, and kitty keyboard flags. Clients (e.g., pty-layout) checking tracking mode to decide whether to forward mouse events will now see the correct state.
- Fix `EventFollower` starting at EOF when its directory watcher detected a brand-new `.events.jsonl` — `session_start` was already on disk by the time the dir event fired, so followers were skipping it. New-file detections now start at offset 0 while existing-file watches still start at EOF.
- Fix `session_exit` sometimes missing from the events log when the daemon was killed via SIGTERM (`pty kill` and similar). The event was queued on the `EventWriter` chain but the daemon exited before the append flushed. `close()` now waits for the child process's `onExit` (bounded at 2s) and then drains the writer before resolving.
- Fix garbage characters in `less`/`git log`: respond to terminal queries (OSC 10/11/4, DA2, DSR, XTVERSION) and strip them from client broadcast so the client's terminal doesn't respond with duplicate input

### Interactive TUI
- **"Create new session..." is now a one-keystroke action.** Pressing Enter spawns `$SHELL` (fallback `bash`) in `$HOME` with a random id and no `displayName`. No wizard, no directory picker, no name/command prompts. Use `pty rename` and `pty exec` from inside the new session to promote it into something specific. Remote "Create new session..." mirrors the same one-shot flow via `pty-relay connect <url> --spawn <random-id>` (the relay is responsible for the remote-side shell/cwd defaults).
- Add `--preselect-new` flag: `pty --preselect-new` opens the interactive TUI with "Create new session..." pre-selected (useful for pty-layout panes that should land on the create prompt)
- Add `--filter-tag key=value` flag (repeatable): filters the TUI to sessions matching all given tags AND auto-applies those tags to any session created from this TUI instance — so new sessions (local and remote) stay in the filtered view (e.g., pty-layout layouts)
- Remote session spawns forward filter tags to pty-relay as `--tag key=value` so remote sessions created from a filtered TUI are tagged on the remote side and stay in the filtered view
- Tag filter is shown in the Filter line; remote groups are filtered by their `tags` field when a tag filter is active
- Session rows in the interactive list now show user-facing tags inline (`#key=value`) alongside cwd and command (matches `pty list` output)
- Interactive TUI shows "Create new session..." for spawn-enabled remote hosts
- Interactive filter hides "Create new session..." items when filter doesn't match "new"
- `host/session` filter syntax: type `prod/api` to filter by host then session
- Extracted `buildFilteredGroups` as a pure function for unit testing

### Listing
- `pty list` now shows tags by default (hashtag format, e.g., `#role=web`) — internal bookkeeping keys (`ptyfile*`, `strategy`, `supervisor.status`) are hidden
- `pty list --tags` now means "show all tags including internal bookkeeping" (previously required to show any tags)
- Add `pty list --filter-tag key=value` (repeatable): show only sessions matching all given tags

### Client API
- Export `extractFilterTags` and `matchesAllTags` from `@compoundingtech/pty/client` so third-party tools (e.g., pty-relay) can accept and apply the same `--filter-tag key=value` syntax
- Add optional `tags?: Record<string, string>` on remote session entries so pty-relay can surface tags in `ls --json` and have the interactive TUI filter remote sessions by them
- Add `launcher?: { command: string; args?: string[] }` to `SpawnDaemonOptions` so non-Node callers (Bun, Deno) can route the detached daemon launch through a Node binary — the daemon needs Node to load the `node-pty` native addon (closes #17)
- Add `PtyHandle.alternateScreen: boolean` and `PtyHandle.kittyKeyboardFlags: number[]` so hosts like pty-layout can proxy alternate-screen state and kitty keyboard protocol enable/disable to the outer terminal (for Shift+Enter and friends in the focused pane)
- Export `setDisplayName(name, displayName | null)` from `@compoundingtech/pty/client` for programmatic renames
- Add `displayName?: string` to `SessionMetadata`, `ServerOptions`, and `SpawnDaemonOptions` — set at spawn time or later via `setDisplayName` / `pty rename`

### Project files
- `pty up` now removes tags that were removed from `pty.toml` — toml-managed tag keys are tracked in a `ptyfile.tags` meta tag so manually-added tags (set via `pty tag`) are preserved

### pty exec
- Add `pty exec -- <command> [args...]` to replace the current session's command from inside the session
- Updates session metadata so the supervisor restarts the new command, not the original
- Errors if not inside a pty session (`PTY_SESSION` not set) or if the session is managed by a pty.toml
- Preserves existing tags and other metadata
- Emits `session_exec` event with previous and new command

## 0.8.0

### Relay integration
- Interactive TUI (`pty` with no args) discovers [pty-relay](https://github.com/compoundingtech/pty-relay) on PATH and shows remote sessions alongside local ones, grouped by host
- Remote sessions are fetched asynchronously — local sessions render immediately, remote groups appear when the relay responds
- Enter on a remote session spawns `pty-relay connect` with pause/resume
- Add `pty list --remote` to include remote hosts in the text and JSON output
- Graceful degradation: if pty-relay is not installed, nothing changes

### Events
- Add `session_start` event — emitted when a session is created, includes tags for filtering
- Add `session_exit` event — emitted when a session's child process exits, includes exit code

### TUI framework
- Export `SelectableGroup<T>` interface from `@compoundingtech/pty/tui`
- `groupedSelectable` `renderHeader` callback now receives the full group object instead of `(title, count)`
- Empty groups are now rendered (header shown) instead of being silently skipped

## 0.7.2

### launchd
- `pty supervisor launchd install` now compiles a small C wrapper binary (`pty-supervisor`) that validates Full Disk Access before exec'ing node — grant FDA to this binary, not to node itself
- Install flow checks FDA via a one-shot launchd job (no false positives from terminal's FDA)
- Interactive prompt guides user through granting FDA, opens Finder to the binary, verifies after confirmation
- Wrapper bakes in PATH at compile time so child processes can find deno, claude, etc.
- `--path` flag to override the baked-in PATH: `pty supervisor launchd install --path "$PATH"`
- Wrapper runs `--check` for diagnostics: validates node, bundle, and FDA

### Fixes
- Fix `spawnDaemon` leaking orphaned daemon processes on failure — child is now killed if `waitForSocket` times out
- Fix `events --wait` timeout not being cancelled when event is found (caused exit code 1 even on match)
- Fix `displayCommand` duplication in `pty list` for toml-spawned sessions
- `displayCommand` now includes full command + args for `pty run` sessions
- Supervisor logs every skip reason in `doRestart` for debugging
- Supervisor state directory moved to `~/.local/state/pty/supervisor/` (no longer pollutes session dir)

## 0.7.1

### Fixes
- `pty peek` now works on exited sessions by reading saved output from metadata
- `pty peek --wait` handles exited sessions: checks saved output, shows last lines and exit code if pattern not found
- `--wait` accepts multiple patterns (`--wait "passed" --wait "failed"`) — matches on any
- Increase saved output from 20 to 200 lines (`lastLines` in exit metadata)
- Exit metadata saved twice: immediately in `onExit` (for status display) and again in `close()` (for complete output after all PTY data has flushed)
- Fix TUI race where session showed as "running" after exit (delay list refresh 200ms to let metadata flush)
- Fix SKILL.md examples to use multiple `--wait` flags instead of regex syntax

## 0.7.0

### Supervisor
- Add session supervisor: `pty supervisor start` runs a foreground process that watches for sessions with `strategy=permanent` tag and restarts them on exit with exponential backoff (1s→16s, max 5 restarts per 60s)
- `pty supervisor start/stop/status/forget/reset` commands
- `pty supervisor launchd install/uninstall` for macOS auto-start — bundles the supervisor into a portable JS file via esbuild, uses absolute paths to node (no PATH dependency), `KeepAlive=true`
- Supervision is configured entirely through tags (`strategy=permanent` or `strategy=temporary`)
- `strategy=permanent`: restart on exit with backoff. `strategy=temporary`: clean up on exit
- Supervisor detects dead processes via PID liveness check (handles external kills where `exitedAt` is never set)
- Supervisor state persisted in `~/.local/state/pty/supervisor/` (restart counts survive supervisor restarts)
- `pty supervisor reset <name>` clears failed status for retry
- New event types: `session_restart`, `session_failed`, `supervisor_start`, `supervisor_stop`
- 10s periodic scan as safety net for missed `fs.watch` events

### Project files
- Add `pty up` / `pty down` commands to start and stop sessions defined in a `pty.toml` project file
- `pty.toml` supports named sessions with commands, tags, and an optional `prefix` for session naming
- `pty up` accepts a directory argument (`pty up ./backend`) and session name filtering (`pty up dev serve`)
- `pty up` syncs tags from the toml to already-running sessions (without removing manually-added tags)
- `pty up` stores `ptyfile` and `ptyfile.session` tags so the supervisor re-reads the toml on restart
- `pty down` removes strategy tags and stops sessions (including supervised ones), warns about toml-managed sessions

### Mutable tags
- Add `pty tag <name> key=value` / `pty tag <name> --rm key` to set and remove tags on running or exited sessions
- `pty tag <name>` with no args shows current tags
- Warns when modifying tags on toml-managed sessions (changes will be overwritten by `pty up`)
- Atomic metadata writes (write-to-temp + rename) to prevent partial reads

### Peek and wait
- Add `pty peek --wait "text"` to block until text appears on screen, with optional `-t` timeout (seconds)
- Add `pty peek --full` to show full scrollback (not just viewport)
- Add `pty events --wait <type>` to block until a specific event type occurs, with optional `-t` timeout

### CLI improvements
- Add `--cwd` flag to `pty run` to start a session in a specific directory
- Add `--tags` flag to `pty list` to display tags as `#key=value` hashtags
- Colorize `pty list` output: bold cyan session names, dimmed commands
- Interactive TUI list shows `[permanent]`/`[temporary]`/`[failed]` markers with color
- `pty kill` on supervised sessions removes the strategy tag (supervisor won't restart it)
- `pty kill` and `pty down` warn when stopping toml-managed sessions

### Fixes
- Defensive `meta.args` fallback to `[]` in all display code (prevents crashes on old metadata)
- Shell integration tests isolated from real session directory
- Fix flaky TUI filter test (wait for list to re-render, not just input to appear)

## 0.6.0

### Breaking changes
- **`PtyServer` moved from `@compoundingtech/pty/client` to `@compoundingtech/pty/server`** — this keeps `./client` free of native addon dependencies (`node-pty`). Update imports: `import { PtyServer } from "@compoundingtech/pty/server"`
- **`resolveKey` and `parseSeqValue` are still in `@compoundingtech/pty/client`** but also available standalone via the new `@compoundingtech/pty/keys` export (browser-safe, zero dependencies)

### Features
- Add session tags: `pty run --tag owner=forge --tag env=dev -- command` sets key-value metadata on sessions, visible in `pty list --json` and persisted across exits and restarts. Tags are available in `SpawnDaemonOptions`, `ServerOptions`, and `SessionMetadata` for programmatic use (#12)

### Exports
- Add `@compoundingtech/pty/server` subpath export for `PtyServer` and `ServerOptions` (requires `node-pty` native addon)
- Add `@compoundingtech/pty/keys` subpath export for browser-safe key resolution (`resolveKey`, `parseSeqValue` — zero dependencies)
- Add `@compoundingtech/pty/protocol` subpath export for browser-safe wire protocol types (`PacketReader`, `MessageType`, encode/decode helpers) (#11, thanks @schickling)

### Fixes
- Fix `resolveKey` silently dropping shift modifier for non-letter keys: `shift+return` now correctly produces CSI u encoding (`\x1b[13;2u`), `shift+up` produces `\x1b[1;2A`, etc. All modifier combinations (ctrl+shift, alt+shift, ctrl+alt+shift) now work for arrows, navigation keys, and control chars (#13, #14, thanks @schickling)
- Validate session `cwd` before spawning and surface explicit errors (`Working directory does not exist`, `Working directory is not a directory`, `Working directory is not searchable`) instead of failing silently with exit code 1 or misleading `posix_spawnp failed` messages (#9, #10, thanks @schickling)
- Lazy-load the interactive TUI module so non-interactive CLI commands like `pty list` don't crash with `uv_cwd` when launched from a deleted directory (#9, #10)
- Clarify the `posix_spawnp` error message to mention the actual PTY shell and cwd context instead of blaming the wrapped command

## 0.5.0

### Client API (`@compoundingtech/pty/client`)
- New `@compoundingtech/pty/client` entry point for programmatic session management — no TUI framework dependency required
- `SessionConnection` class for bidirectional session connections without taking over stdin/stdout
- `sendData()` — Promise-based alternative to CLI send (no `process.exit()`)
- `peekScreen()` — Promise-based screen capture (no stdout writes)
- Export `queryStats`, `attach`, `peek`, `send` from client API
- Export `PtyServer` and `ServerOptions` for embedding
- Export events system: `EventType`, `EventRecord`, `EventFollower`, `readRecentEvents`, `formatEvent`, and all event subtypes
- Export key resolution: `resolveKey`, `parseSeqValue`
- Export session helpers: `gc`, `validateName`, `cleanupAll`, `cleanupSocket`, `getSocketPath`
- Export protocol types: `PacketReader`, `MessageType`, `Packet`
- `spawnDaemon` now takes an options object with optional `rows`/`cols` (breaking change from positional args)

### CLI improvements
- Add `pty gc` command to remove all exited sessions at once
- Git-style plugin support: `pty <anything>` looks for `pty-<anything>` in PATH and runs it, forwarding remaining args
- Prevent accidental session nesting: `pty run` inside an existing session execs the command directly instead of creating a nested session (`-d` bypasses the check)
- Set `PTY_SESSION` env var in child processes so they can detect they're inside a pty session
- Add CPU and memory usage to `pty stats` (child process and daemon, via `ps`)
- Add process PIDs to `pty stats` output
- Gracefully handle older daemons that don't report resource usage
- Exit messages now include the session name (`[myserver exited with code 0]`)

### Events
- Add terminal event logging — sessions capture bell, title changes, desktop notifications (OSC 9/99/777), focus requests, and cursor visibility transitions to a per-session JSONL file
- Add `pty events <name>` command to follow events in real-time (like `tail -f`)
- Add `pty events --all` to follow events from all sessions, interleaved
- Add `pty events --recent <name>` to show recent events and exit
- Add `pty events --json` for machine-readable JSONL output
- Deduplicate consecutive identical title change events
- Event files auto-truncate at 1,000 lines (keeping most recent 500)
- Event file I/O is fully async (non-blocking write queue)
- Event files are cleaned up with the existing 24-hour dead session TTL

### Fixes
- Respond to DA1 (Primary Device Attribute) queries so fish shell 4.x starts in under 50ms instead of blocking 10s at startup (#5)
- Fix postinstall `spawn-helper` chmod to work under pnpm's global virtual store layout, replacing the broken relative-path `chmod` with a proper Node.js script that uses `createRequire` to find node-pty regardless of layout (#8, thanks @schickling)

### Tests
- Add shell integration tests covering bash, zsh, and fish startup

## 0.4.1

- Add `pty stats` command for live session metrics (terminal size, scrollback, clients, modes, uptime)
- Add `pty stats --json` for machine-readable output
- Add `pty rm` command to remove exited session metadata
- Add `--ephemeral` / `-e` flag to `pty run` for auto-cleanup on exit
- `pty kill` now only kills running sessions (use `pty rm` for exited ones)
- Increase default scrollback from 1,000 to 10,000 lines (matching Ghostty)
- Exited sessions now show cwd in `pty ls` and interactive list
- Exited sessions show command in `pty ls`
- Running sessions always rank above exited in interactive search
- Selecting an exited session in interactive UI restarts it
- New STATUS protocol message (type 7) for querying live session metrics
- Export `spawnDaemon`, `listSessions`, `getSession` from `@compoundingtech/pty/tui`
- Add `cursorRow`, `cursorCol`, `mouseMode`, `scrollback`, `bufferLength`, `baseY` to `PtyHandle`
- Fix build bug: dynamic `require()` paths used `.ts` extension in dist

## 0.3.0

- Add `pty wrap` / `pty unwrap` to auto-wrap commands in pty sessions
- Improve attach fidelity for ratatui/crossterm TUI apps (ECH/CUF serialize fixes, SIGWINCH nudge)

## 0.2.2

- Restrict session directory and socket permissions (0o700 / 0o600)
- Allow following a peek in plain mode (`pty peek -f --plain`)
- Fix lifecycle hooks, command parsing, and peek flag handling

## 0.2.1

- Add fuzzy filter to interactive session list
- Add light themes, terminal theme detection, Ctrl+G theme cycling
- Persist theme preference

## 0.2.0

- Auto-name sessions from command + directory
- Rebuild interactive list with the TUI framework
- Weight session name higher in search results
- Fix global install spawn failure (#4)

## 0.1.3

- Fix doubled keystrokes after session exits in interactive list

## 0.1.2

- Fix CLI for npm global install (build src/ to dist/ with tsc)

## 0.1.1

- Bundle CLI for npm global install compatibility (#3)

## 0.1.0

- Initial release
- Persistent terminal sessions with detach/attach
- Multi-client support
- Interactive session manager
- Playwright-style terminal testing library (`@compoundingtech/pty/testing`)
- Declarative TUI framework (`@compoundingtech/pty/tui`)
