// Public API for programmatic session management.
// Import from "@compoundingtech/pty/client".

// Session management
export {
  listSessions, getSession, gc, pruneOrphanLayoutTags, isGone,
  validateName, updateTags, setDisplayName, patchMetadataById,
  getSessionExitEvidence, removeSessionGeneration,
  getSessionDir, getSocketPath,
  cleanupSocket, cleanupAll,
  // Exposed for the same reason as `isReservedTagKey`: downstream tools
  // (relay, layout, supervisors) need to answer "is this session exempt
  // from reaping?" without re-deriving which tag values count as set —
  // including how long the `keep` exemption lasts against `pty gc`.
  KEEP_TAG, isKeepRequested, shouldReapAtExit,
  DEFAULT_KEEP_MAX_AGE_MS, isKeepExpired,
  type SessionInfo, type SessionMetadata, type MetadataPatch, type MetadataPatchResult,
  type SessionExitEvidence, type SessionExitEvidenceTail,
  type SessionExitEvidenceResult, type RemoveSessionGenerationResult,
  type PrunedTagResult, type GcResult,
} from "./sessions.ts";

// Session creation
export { spawnDaemon, resolveCommand, waitForSocket, setServerModulePath, type SpawnDaemonOptions } from "./spawn.ts";

// Session interaction (programmatic — no process.exit, no stdin/stdout)
export {
  SessionConnection, sendData, peekScreen,
  type SessionConnectionOptions, type SendDataOptions, type PeekScreenOptions,
} from "./connection.ts";

// Session interaction (CLI-oriented — uses process.stdin/stdout, may call process.exit)
export {
  attach, peek, send, queryStats,
  queryAcceptedSocketOwnership, compareAndSetLifecycle,
  TERMINAL_SANITIZE,
  type AttachOptions, type PeekOptions, type SendOptions,
  type StatsResult, type ProcessResources,
} from "./client.ts";

// Events
export {
  EventType,
  EventFollower, readRecentEvents, formatEvent,
  emitUserEvent, appendEvent, isUserEvent, validateUserEventType,
  type EventRecord, type EventBase,
  type BellEvent, type TitleChangeEvent, type NotificationEvent,
  type FocusRequestEvent, type CursorVisibleEvent,
  type SessionStartEvent, type SessionExitEvent, type SessionExecEvent,
  type SessionRespawnEvent,
  type UserEvent,
  type DisplayNameChangeEvent, type TagsChangeEvent, type MetadataChangeEvent,
  type FollowerOptions,
} from "./events.ts";

// Project files
export { readPtyFile, type PtyFile, type PtySessionDef } from "./ptyfile.ts";

// Tag filter helpers (used by --filter-tag; shared with pty-relay)
export { extractFilterTags, matchesAllTags, isReservedTagKey } from "./tags.ts";

// Duration parse/format — used by `pty list --older-than/--newer-than`,
// available here so downstream tools can accept the same grammar.
export { parseDuration, formatDuration } from "./duration.ts";

// Keys
export { resolveKey, parseSeqValue } from "./keys.ts";

// Protocol (advanced)
export {
  PacketReader, MessageType,
  type Packet, type TcpConnectionTuple,
  type AcceptedSocketOwnershipRequest, type AcceptedSocketOwnershipResult,
  type LifecycleCompareAndSetRequest, type LifecycleCompareAndSetResult,
} from "./protocol.ts";
export { type StartupLeaseOptions } from "./startup-lease.ts";
