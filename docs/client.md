# Client API Reference

Import from `@compoundingtech/pty/client`.

```typescript
import { SessionConnection, spawnDaemon, listSessions } from "@compoundingtech/pty/client";
import { PtyServer } from "@compoundingtech/pty/server";
import { resolveKey } from "@compoundingtech/pty/keys";
import { PacketReader, MessageType } from "@compoundingtech/pty/protocol";
```

## Session Management

### `listSessions(): Promise<SessionInfo[]>`

List all retained sessions without mutating the registry. Cleanup is owned by
explicit lifecycle operations such as `gc()` and `cleanupAll()`.

### `getSession(ref: string): Promise<SessionInfo | null>`

Resolve a stable session id or display name. An exact stable id always wins. A
display name resolves only when it has exactly one match; multiple matches throw
an error that lists the candidate stable ids. Returns `null` when no session
matches. Resolve once, then pass `session.name` to socket-oriented APIs.

### `getSessionExitEvidence(name: string): Promise<SessionExitEvidenceResult>`

Read the retained terminal evidence for one dead daemon generation. A snapshot
contains the stable session id, opaque generation, `exited` or `vanished`
status, nullable exit code, `stream: "combined"`, and the exact persisted
bounded `lastLines`. An absent persisted tail is tagged `unavailable`; it is
not reported as an empty tail.

The operation fails closed with a tagged `unavailable` result when the session
is missing, running, locked, lacks a generation, or has invalid metadata. The
evidence reader rejects malformed, oversized, symlink, non-regular, type-invalid,
and over-200-line metadata as `invalid-metadata`.

### `removeSessionGeneration(name: string, expectedGeneration: string): Promise<RemoveSessionGenerationResult>`

Remove all PTY artifacts only when the retained metadata still belongs to the
given opaque generation and its daemon is gone. Results distinguish `removed`,
`missing`, `generation-mismatch`, `not-terminal`, `invalid-metadata`, and
`busy`. A replacement generation is never removed. Cleanup errors other than
absence are thrown, and metadata is removed last so failed cleanup retains the
evidence for retry.

Rust and other non-TypeScript consumers can use the equivalent machine-only
CLI boundary. Both operations address only an immutable stable id, emit exactly
one tagged JSON document on stdout, and exit 0 for semantic outcomes:

```sh
pty evidence snapshot --id a1b2c3d4
pty evidence remove --id a1b2c3d4 --expected-generation 7f44b35e
```

Invalid arguments and operational failures exit nonzero with a diagnostic on
stderr. A reconciler should durably consume the snapshot before passing its
opaque generation to `remove`; a mismatch must leave the replacement intact.

### Accepted-socket ownership and lifecycle CAS

`queryAcceptedSocketOwnership(name, request)` asks the live PTY daemon to prove
that the accepted side of one exact held TCP connection belongs to the current
child process or one of its descendants:

```typescript
const ownership = await queryAcceptedSocketOwnership("dev.web", {
  expectedGeneration: generation,
  connection: {
    localAddress: socket.localAddress!,
    localPort: socket.localPort!,
    remoteAddress: socket.remoteAddress!,
    remotePort: socket.remotePort!,
  },
});
// { _tag: "Owned", pid } | { _tag: "NotOwned" } |
// { _tag: "Unavailable", reason }
```

The caller must keep that exact connection open while querying. PTY reverses
the client-observed 4-tuple to identify the server-side `ESTABLISHED` socket,
then binds it to the exact current child identity and descendant tree. Inspection
runs in a worker so procfs, `ps`, or `libproc` latency cannot stall the daemon's
startup deadline timer. Linux uses procfs. Published packages include PTY's
universal arm64/x86_64 Darwin helper; source installs may use a best-effort
local build, and helper absence never fails package installation. Unsupported
platforms, scoped IPv6 tuples, generation mismatch, process-tree or descriptor
churn, unreadable or partial descriptor/socket tables, and helper failure return
`Unavailable`; none are
treated as `NotOwned`.

`compareAndSetLifecycle(name, request)` compares and replaces one exact tag
value through the live daemon:

```typescript
const result = await compareAndSetLifecycle("dev.web", {
  expectedGeneration: generation,
  tag: "run.lifecycle",
  expectedValue: startingValue,
  value: JSON.stringify({ _tag: "ready", generation }),
});
```

Results are tagged: `Changed`, `Unchanged`, `ValueMismatch`, `Missing`,
`GenerationMismatch`, `Busy`, `DeadlineExpired`, `Terminal`, or
`InvalidRequest`. A replacement generation cannot be changed by a stale
completion.

The shell boundary reads the same typed request as one JSON object on stdin and
emits exactly one tagged JSON result:

```sh
pty readiness ownership --id dev.web < ownership.json
pty readiness cas --id dev.web < transition.json
```

### `validateName(name: string): void`

Throws if the name is invalid. Names must match `[a-zA-Z0-9._-]`, cannot be
`.` or `..`, and are at most 255 characters.

### `patchMetadataById(id: string, patch: MetadataPatch): Promise<MetadataPatchResult>`

Atomically merge presentation metadata for one exact stable id. This API never
falls back to a matching display name. It holds the session metadata lock across
one read, merge, validation, and atomic write; unrelated tags are preserved and
a no-op returns `changed: false` without writing or emitting an event.

```typescript
const result = await patchMetadataById("a1b2c3d4", {
  displayName: "Worker",
  tags: { role: "worker", temporary: null },
});

interface MetadataPatch {
  displayName?: string | null;
  tags?: Record<string, string | null>;
}

interface MetadataPatchResult {
  changed: boolean;
  metadata: SessionMetadata;
}
```

Strings set values, `null` clears them, and omitted fields or tag keys remain
unchanged. A successful change emits one `metadata_change` event containing
only effective changes as `previous` and `value` snapshots. The existing
`setDisplayName` and `updateTags` APIs retain their specialized event types for
compatibility.

### `getSessionDir(): string`

Returns the session directory path — `$PTY_ROOT` if set (the legacy `$PTY_SESSION_DIR` name is still honored), otherwise `~/.local/state/pty`.

### `getSocketPath(name: string): string`

Returns the Unix socket path for a session.

### `gc(opts?: { dryRun?: boolean; idleDays?: number; fastFailWindowSec?: number; fastFailLimit?: number }): Promise<GcResult>`

Run one reconciliation pass: sweep dead non-permanent sessions, kill orphaned `parent=` children, reap abandoned permanents, and respawn (or flap-skip) `strategy=permanent` sessions. The sweep is a backstop — a non-permanent session removes itself when its command finishes, so in practice it catches `vanished` sessions (SIGKILLed daemon, no cleanup code ran). Sessions tagged `keep` are never swept and are reported in `kept`. Returns a `GcResult` describing everything the pass did. Pass `{ dryRun: true }` to compute the same plan without mutating anything — useful for preview UIs.

```typescript
const result = await gc();
console.log(`Removed ${result.removed.length}, respawned ${result.respawned.length}`);

const plan = await gc({ dryRun: true });
console.log(`Would remove: ${plan.removed.join(", ")}`);
```

```typescript
interface GcResult {
  removed: string[];                                                              // dead non-permanent sessions cleaned up (mostly vanished)
  kept: string[];                                                                 // dead non-permanent sessions left alone because they are tagged `keep`
  killedOrphanChildren: { name: string; parent: string; reason: "missing" | "dead" }[];
  abandoned: { name: string; reason: "cwd-gone" | "idle"; idleDays?: number }[];  // live permanents reaped as abandoned
  respawned: { name: string; ptyfileReread: boolean }[];
  respawnFailed: { name: string; error: string }[];
  flapped: { name: string; counter: number; limit: number; window: number }[];    // flipped to strategy.status=flapping this tick
  flappingSkipped: string[];                                                       // already-flapping, skipped this tick
}
```

### `isGone(status): boolean`

Semantic helper — returns `true` when `status` is `"exited"` or `"vanished"` (i.e. the session has metadata on disk but no live daemon). Use this in branches that mean "there's a record we might want to reuse" rather than the hand-rolled two-branch check.

### `pruneOrphanLayoutTags(opts?: { dryRun?: boolean }): Promise<PrunedTagResult[]>`

Walks running sessions and removes tag keys of the form `:l<pid>-<rand>` whose encoded PID is no longer alive. `pty gc` calls this after removing exited sessions. Pass `{ dryRun: true }` to preview without mutating metadata.

```typescript
interface PrunedTagResult {
  name: string;
  removedKeys: string[];
}
```

### `isReservedTagKey(key: string): boolean`

Returns `true` for pty's internal bookkeeping keys (`ptyfile`, `ptyfile.session`, `ptyfile.tags`, `strategy`) and for any key starting with `:` (the tool-owned-tag convention). Downstream tools should hide reserved keys from user-facing listings by default but still allow writes — set and unset them as needed.

### `isKeepRequested(tags?: Record<string, string>): boolean`

Returns `true` when `tags` carries the `keep` exemption — i.e. the session's metadata, `lastLines`, and events file must survive its death until an explicit `pty rm`. Any value other than `false` / `0` / `no` / `off` counts as set, so an unrecognized value errs toward retaining. The tag key itself is exported as `KEEP_TAG`.

Read tags from the session's *current* metadata rather than from a spawn-time snapshot — `keep` is routinely applied to a session that is still running.

### `shouldReapAtExit(tags: Record<string, string> | undefined, ephemeral: boolean): boolean`

The policy the daemon applies to its own registry entry as it shuts down, exposed so supervisors can predict it. `keep` wins over everything; then `ephemeral`; then `strategy=permanent` is retained for its supervisor; everything else is reaped.

Note this does not model the two cases decided outside the tag map: an external `pty kill` retains the session, and a `vanished` session (SIGKILLed daemon) never reaches this code at all.

### `cleanupSocket(name: string): void`

Remove a session's `.sock` and `.pid` files.

### `cleanupAll(name: string): void`

Remove all files for a session (socket, pid, metadata, and events). Cleanup is
serialized by acquiring the event lock before the metadata/creation lock. It
throws when either lock has a live holder, changes no session files in that
case, and removes only locks acquired by the cleanup call. Dead holders' stale
locks are reclaimed.

### Types

```typescript
interface SessionInfo {
  name: string;
  socketPath: string;
  pid: number | null;
  // "running"  — daemon alive, socket reachable.
  // "exited"   — daemon wrote an exit record before shutting down.
  // "vanished" — daemon is gone with no exit record (SIGKILL / OOM / crash).
  status: "running" | "exited" | "vanished";
  metadata: SessionMetadata | null;
}

interface SessionMetadata {
  command: string;
  args: string[];
  displayCommand: string;
  cwd: string;
  createdAt: string;
  exitCode?: number;
  exitedAt?: string;
  lastLines?: string[];
  tags?: Record<string, string>;
  displayName?: string; // mutable, non-unique presentation label
  isolateEnv?: boolean;
  extraEnv?: Record<string, string>;
  unsetEnv?: string[];
  env?: Record<string, string>;
}
```

## Session Creation

### `spawnDaemon(options: SpawnDaemonOptions): Promise<void>`

Spawn a new session daemon. Resolves once the daemon is listening.

```typescript
interface SpawnDaemonOptions {
  name: string;
  command: string;
  args: string[];
  displayCommand: string;
  cwd?: string;                      // defaults to process.cwd()
  ephemeral?: boolean;               // reap on ANY shutdown, incl. `pty kill` and strategy=permanent
                                     // (non-permanent sessions already self-reap when their command ends;
                                     //  a `keep` tag overrides this)
  rows?: number;                     // defaults to process.stdout.rows ?? 24
  cols?: number;                     // defaults to process.stdout.columns ?? 80
  tags?: Record<string, string>;     // key-value metadata (e.g. { owner: "forge" })
  isolateEnv?: boolean;              // inherit only the safe allow-list
  extraEnv?: Record<string, string>; // explicit assignments applied last
  unsetEnv?: string[];               // inherited keys removed before assignments
  env?: Record<string, string>;      // exact child env; mutually exclusive with the above
  startupLease?: {
    timeoutMs: number;               // positive startup budget, converted once
    lifecycleTag: string;            // exact tag carrying lifecycle JSON
  };
}
```

`unsetEnv` removals run before `extraEnv` assignments. The server then forces
`PTY_SESSION` to the stable session id and fills an absent `TERM` with
`xterm-256color`; naming either key in `unsetEnv` does not suppress those
invariants. An explicit `extraEnv.TERM` value is preserved.

When `startupLease` is present, the daemon atomically publishes the lifecycle
tag as `{\"_tag\":\"starting\",\"generation\":\"…\",\"bootId\":\"…\",\"deadlineMonotonicNs\":\"…\"}`
before `spawnDaemon()` resolves. The deadline is absolute in the named host-boot
monotonic domain. Initiating caller exit cannot disarm or extend it. Only a
successful live-daemon CAS away from that exact starting value disarms the
timer. At expiry PTY first freezes and proves complete child containment. A
complete observation records terminal cause `deadline` and terminates the exact
child tree. An unavailable or partial observation instead records terminal
cause `teardown-unavailable`, then best-effort signals every exact identity it
did observe plus the root process group; it never claims exact teardown when
containment is unknown. Both outcomes retain normal exit evidence. Child exit
before readiness similarly records terminal cause `exit`. Startup-lease
generations bypass ordinary daemon exit reaping so their terminal
lifecycle and exit evidence survive child/daemon shutdown for generation-fenced
consumption. A terminal value written by a successful current-generation
CAS is retained through the resulting child and daemon shutdown rather than
replaced by `exit`.

### `resolveCommand(cmd: string): string`

Resolve a command name to an absolute path (like `which`). Throws if not found.

### `waitForSocket(name: string, timeoutMs: number, earlyCheck?: () => void): Promise<void>`

Wait for a session's Unix socket to appear on disk.

### `PtyServer` (from `@compoundingtech/pty/server`)

The server class itself, for embedding a pty server directly (without the daemon process).
This is a separate export because it requires `node-pty` (a native C++ addon):

```typescript
import { PtyServer } from "@compoundingtech/pty/server";

const server = new PtyServer({
  name: "embedded",
  command: "bash",
  args: [],
  displayCommand: "bash",
  cwd: process.cwd(),
  rows: 24,
  cols: 80,
  onExit: (code) => console.log(`Exited: ${code}`),
});

await server.ready;
// server is now listening on its Unix socket
```

## Session Interaction (Programmatic)

These functions do not use `process.stdin`, `process.stdout`, or call `process.exit()`. Safe for use in GUI apps, servers, and libraries.

### `SessionConnection`

Bidirectional, event-driven connection to a session.

```typescript
const conn = new SessionConnection({ name: "myserver", rows: 24, cols: 80 });

conn.on("geometry", ({ rows, cols }) => {
  // Resize your emulator before the following screen/data bytes are parsed.
  terminal.resize(cols, rows);
});
conn.on("data", (data: string) => { /* terminal output */ });
conn.on("exit", (code: number) => { /* process exited */ });
conn.on("close", () => { /* connection closed */ });
conn.on("error", (err: Error) => { /* connection error */ });

const initialScreen = await conn.connect();
// Initial GEOMETRY is stream-ordered before SCREEN. The effective getters are
// therefore authoritative before applying the returned replay.
terminal.resize(conn.effectiveCols, conn.effectiveRows);
terminal.write(initialScreen);

conn.write("hello\r");          // send raw data
conn.press("ctrl+c");           // send named key
conn.resize(30, 100);           // request a shared-grid size
conn.disconnect();               // close connection
```

**Properties:**
- `connected: boolean` — whether the connection is active
- `effectiveRows: number` / `effectiveCols: number` — current authoritative
  shared-grid dimensions. These can differ from the client's requested size
  when another writable client is smaller.

**Events:**
| Event | Payload | Description |
|---|---|---|
| `geometry` | `{ rows, cols }` | Effective shared geometry, ordered before affected `screen`/`data` |
| `data` | `string` | Terminal output from the session |
| `screen` | `string` | Initial screen replay on connect |
| `exit` | `number` | Session process exited with code |
| `close` | — | Connection closed |
| `error` | `Error` | Connection error |

### `sendData(options: SendDataOptions): Promise<void>`

Send data to a session without connecting interactively. Resolves on success, rejects on error.

```typescript
await sendData({ name: "myserver", data: ["hello\r"] });

// With delay between items
await sendData({ name: "myserver", data: ["git status\r", "git diff\r"], delayMs: 500 });
```

### `peekScreen(options: PeekScreenOptions): Promise<string>`

Get the current screen content as a string.

```typescript
const screen = await peekScreen({ name: "myserver" });         // ANSI output
const plain = await peekScreen({ name: "myserver", plain: true }); // plain text
```

### `queryStats(name: string, timeoutMs?: number): Promise<StatsResult>`

Query live metrics from a running session without attaching. The matching
`pty stats --json` command uses the same non-attaching STATUS request.
`terminal.rows` and `terminal.cols` are the current effective shared geometry;
`clients` includes aggregate counts plus anonymous connection details showing
each writable client's requested size and which min-wins axes it constrains.

```typescript
interface StatsResult {
  name: string;
  terminal: {
    cols: number; rows: number;
    cursorX: number; cursorY: number;
    scrollbackUsed: number; scrollbackCapacity: number;
  };
  process: {
    alive: boolean; exitCode: number | null;
    pid: number | null;
    resources: ProcessResources | null;
  };
  daemon: {
    pid: number;
    resources: ProcessResources | null;
  };
  clients: {
    total: number; attached: number; readOnly: number;
    connections?: Array<
      | {
          role: "writable";
          rows: number; cols: number;
          lastRequestSequence: number;
          constrains: { rows: boolean; cols: boolean };
        }
      | {
          role: "readonly";
          constrains: { rows: false; cols: false };
        }
    >;
  };
  modes: {
    sgrMouse: boolean; cursorHidden: boolean;
    kittyKeyboard: boolean; kittyKeyboardFlags: number[];
  };
  uptimeSeconds: number | null;
  createdAt: string | null;
}

interface ProcessResources {
  rssKb: number;
  cpuPercent: number;
}
```

Connection details are anonymous and their order is unspecified. They are a
point-in-time explanation of the current min-wins result, not an event stream;
polling stats cannot order geometry changes relative to attached-session DATA.
`lastRequestSequence` is a daemon-local counter for the writable connection's
most recent attach or resize request, not a connection identity or timestamp.
Older daemons omit `connections`; the aggregate counts remain authoritative and
must not be reconstructed as an empty connection list. The daemon does not
retain a durable client identity; socket and packet-parser state are transport
internals and are not exposed.

## Session Interaction (CLI-oriented)

These functions use `process.stdin`/`process.stdout` directly and may call `process.exit()`. They are re-exported for tools that want CLI-like behavior.

### `attach(options: AttachOptions): void`

Interactive attach with bidirectional I/O. Takes over stdin/stdout. Ctrl+\ to detach (double-tap to send through).

Set `attachStreamFdV1` to a writable inherited descriptor (3 or greater) for
machine mode. stdin and stdout remain the controlling terminal for input and
resize events, but terminal output is written only to that descriptor using the
existing protocol framing. Version 1 emits ordered `GEOMETRY`, `SCREEN`, and
`DATA` packets followed by one terminal outcome: `EXIT` when the session process
ends or `DETACH` when the local user intentionally detaches. `DETACH` may be the
first packet when the user detaches before the daemon supplies its initial
baseline. Each initial attach or reconnect otherwise starts with `GEOMETRY`; a
daemon that sends terminal data first is rejected as unsupported.

The descriptor remains caller-owned. `attach()` flushes its writer but does not
close the descriptor, so a consumer sees EOF only when the caller closes its
copy (or the process exits). A clean EOF follows a framed `EXIT` or `DETACH`;
EOF without either outcome is a truncated stream. Descriptor errors fail the
attach and are reported on stderr; stderr text is never written into the framed
stream.

### `peek(options: PeekOptions): void`

Read-only view. Writes directly to stdout.

### `send(options: SendOptions): void`

Send data to a session. Calls `process.exit(0)` on success, `process.exit(1)` on error.

## Events

### `EventFollower`

Follow events from one or more sessions in real-time.

```typescript
const follower = new EventFollower({
  names: ["myserver"],           // or omit for all sessions
  onEvent: (event) => {
    console.log(event.type, event.ts);
  },
});
follower.start();
// later:
follower.stop();
```

### `readRecentEvents(name: string, count?: number): EventRecord[]`

Read the last N events (default 50) for a session.

### `formatEvent(event: EventRecord): string`

Format an event for console output with timestamp.

### `EventType`

```typescript
const EventType = {
  BELL: "bell",
  TITLE_CHANGE: "title_change",
  NOTIFICATION: "notification",
  FOCUS_REQUEST: "focus_request",
  CURSOR_VISIBLE: "cursor_visible",
};
```

### Event types

```typescript
type EventRecord =
  | BellEvent
  | TitleChangeEvent
  | NotificationEvent
  | FocusRequestEvent
  | CursorVisibleEvent;
```

Each extends `EventBase { session: string; type: EventType; ts: string }`.

`NotificationEvent` adds `title?`, `body?`, `source?: "osc9" | "osc99" | "osc777"`.
`TitleChangeEvent` adds `value: string`.

`MetadataChangeEvent` has type `"metadata_change"` and carries `previous` and
`value` objects. Only the changed `displayName` field and changed tag keys are
present; `null` represents an absent or cleared value.

## Keys (also available via `@compoundingtech/pty/keys`)

These functions are also available as a standalone browser-safe import via `@compoundingtech/pty/keys` (zero dependencies).

### `resolveKey(spec: string): string`

Resolve a key name to its byte sequence. Supports:

- Named keys: `return`, `tab`, `escape`, `space`, `backspace`, `delete`
- Arrows: `up`, `down`, `left`, `right`
- Navigation: `home`, `end`, `pageup`, `pagedown`
- Modifiers: `ctrl+c`, `ctrl-c`, `ctrl_c`, `C-c`, `alt+x`, `shift+a`

Key names and modifiers are case-insensitive. Modifier chords accept `+`, `-`,
or `_` separators; compact `C-` is accepted for Control. Invalid key specs
report the accepted notation, modifiers, and named keys.

### `parseSeqValue(value: string): string`

If value starts with `key:`, resolves the key name. Otherwise returns the literal string.

## Protocol (Advanced)

Low-level protocol types for building custom clients. Also available as a standalone browser-safe import via `@compoundingtech/pty/protocol` (no Node-only dependencies).

### `PacketReader`

Streaming packet parser. Feed raw socket data, get parsed packets.

```typescript
const reader = new PacketReader();
socket.on("data", (raw) => {
  const packets = reader.feed(raw);
  for (const packet of packets) {
    // packet.type: MessageType, packet.payload: Buffer
  }
});
```

### `MessageType`

```typescript
const MessageType = {
  DATA: 0,     // Terminal output / input
  ATTACH: 1,   // Client attach with size
  DETACH: 2,   // Client → server request; machine stream → caller outcome
  RESIZE: 3,   // Terminal resize
  EXIT: 4,     // Process exited
  SCREEN: 5,   // Screen replay
  PEEK: 6,     // Read-only peek request
  STATUS: 7,   // Stats query/response
  GEOMETRY: 10, // Effective shared rows/cols (server → client)
};
```

`DETACH` always has an empty payload. On the session socket it requests that
the client connection detach. On `--attach-stream-fd-v1`, it is the terminal
outcome for an intentional local detach and is flushed before clean completion.
Clean EOF follows either `DETACH` or `EXIT`; EOF without either outcome is a
truncated stream.

Packet types are length-delimited. Clients predating `GEOMETRY` ignore the
unknown bounded packet and continue with following `SCREEN`/`DATA`, preserving
their historical raw-byte behavior. Embedders that reconstruct a terminal grid
must handle `GEOMETRY`.

For each `ATTACH` or `PEEK`, the server establishes a new synchronization
generation with this public stream order:

```text
GEOMETRY -> SCREEN -> DATA / EXIT
```

`GEOMETRY` is sent immediately. The server then takes an ordered xterm parser
cut: output before that cut is represented by `SCREEN`, while later `DATA` and
`EXIT` packets are queued and released after the screen baseline. If the child
exits before the cut, the server emits one `EXIT` after any final queued data.
A later `ATTACH` or `PEEK` on the same socket cancels the unfinished generation,
including writable-to-readonly mode changes, so stale screen or queued output
from the previous mode is not emitted. A reconnect starts the same ordering
contract again with a fresh `GEOMETRY` and `SCREEN`.

Each valid `ATTACH` or `PEEK` also replaces the socket's current role rather
than accumulating state. `ATTACH` makes the socket writable, installs its
requested geometry, and restores `DATA`/`RESIZE` handling and shared-grid
participation. `PEEK` makes it read-only and removes its geometry constraint.
A malformed `ATTACH` payload leaves the prior role and synchronization
generation unchanged.

### `TERMINAL_SANITIZE: string`

ANSI sequence that resets all terminal modes (mouse tracking, cursor visibility, alternate screen, etc.). Useful after disconnecting from a session.
