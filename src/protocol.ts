import { Buffer } from "node:buffer";

export const MessageType = {
  DATA: 0, // Terminal data (bidirectional)
  ATTACH: 1, // Client → Server: attaching with terminal size
  DETACH: 2, // Client → Server: detach; machine stream → caller: intentional detach outcome
  RESIZE: 3, // Client → Server: terminal resized
  EXIT: 4, // Server → Client: process exited
  SCREEN: 5, // Server → Client: screen buffer replay on attach
  PEEK: 6, // Client → Server: read-only attach (no input, no resize)
  STATUS: 7, // Client → Server: request stats; Server → Client: JSON stats response
  ACCEPTED_SOCKET_OWNERSHIP: 8, // Request/response: exact held TCP connection ancestry
  LIFECYCLE_CAS: 9, // Request/response: generation-fenced one-tag compare-and-set
  GEOMETRY: 10, // Server → Client: effective shared rows/cols
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];

export interface Packet {
  type: MessageType;
  payload: Buffer;
}

export interface TcpConnectionTuple {
  /** Address/port of the held probing socket. */
  localAddress: string;
  localPort: number;
  /** Address/port the held probing socket connected to. */
  remoteAddress: string;
  remotePort: number;
}

export interface AcceptedSocketOwnershipRequest {
  expectedGeneration: string;
  connection: TcpConnectionTuple;
}

export type AcceptedSocketOwnershipResult =
  | { _tag: "Owned"; pid: number }
  | { _tag: "NotOwned" }
  | { _tag: "Unavailable"; reason: string };

export interface LifecycleCompareAndSetRequest {
  expectedGeneration: string;
  tag: string;
  expectedValue: string;
  value: string;
}
export type LifecycleCompareAndSetResult =
  | { _tag: "Changed"; value: string }
  | { _tag: "Unchanged"; value: string }
  | { _tag: "ValueMismatch"; value?: string }
  | { _tag: "Missing" }
  | { _tag: "GenerationMismatch" }
  | { _tag: "Busy" }
  | { _tag: "DeadlineExpired"; value: string }
  | { _tag: "Terminal"; value: string }
  | { _tag: "InvalidRequest"; reason: string };

const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

export const decodeAcceptedSocketOwnershipRequest = (
  input: unknown,
): AcceptedSocketOwnershipRequest | undefined => {
  const value = recordValue(input);
  const connection = recordValue(value?.connection);
  if (
    typeof value?.expectedGeneration !== "string" ||
    value.expectedGeneration.length === 0 ||
    typeof connection?.localAddress !== "string" ||
    connection.localAddress.length === 0 ||
    typeof connection.localPort !== "number" ||
    !Number.isInteger(connection.localPort) ||
    connection.localPort < 1 ||
    connection.localPort > 65_535 ||
    typeof connection.remoteAddress !== "string" ||
    connection.remoteAddress.length === 0 ||
    typeof connection.remotePort !== "number" ||
    !Number.isInteger(connection.remotePort) ||
    connection.remotePort < 1 ||
    connection.remotePort > 65_535
  ) return undefined;
  return {
    expectedGeneration: value.expectedGeneration,
    connection: {
      localAddress: connection.localAddress,
      localPort: connection.localPort,
      remoteAddress: connection.remoteAddress,
      remotePort: connection.remotePort,
    },
  };
};

export const decodeLifecycleCompareAndSetRequest = (
  input: unknown,
): LifecycleCompareAndSetRequest | undefined => {
  const value = recordValue(input);
  if (
    typeof value?.expectedGeneration !== "string" ||
    value.expectedGeneration.length === 0 ||
    typeof value.tag !== "string" ||
    value.tag.length === 0 ||
    typeof value.expectedValue !== "string" ||
    typeof value.value !== "string"
  ) return undefined;
  return {
    expectedGeneration: value.expectedGeneration,
    tag: value.tag,
    expectedValue: value.expectedValue,
    value: value.value,
  };
};

// Packet wire format: [type: uint8][length: uint32BE][payload: N bytes]
const HEADER_SIZE = 5;

// BUG-3: cap legitimate packet size. SCREEN replays carry the serialized
// xterm buffer (rows × cols × attrs × scrollback). With the 10k-line default
// scrollback plus mode prefixes, 32 MiB is generously above any real payload
// while still small enough to bound a single malformed-length attack.
export const MAX_PACKET_LENGTH = 32 * 1024 * 1024;

/** Thrown when an inbound packet declares a length larger than
 *  `MAX_PACKET_LENGTH`. Socket handlers should destroy the connection. */
export class PacketTooLargeError extends Error {
  readonly declaredLength: number;
  constructor(declaredLength: number) {
    super(
      `Packet length ${declaredLength} exceeds maximum ${MAX_PACKET_LENGTH}`
    );
    this.name = "PacketTooLargeError";
    this.declaredLength = declaredLength;
  }
}

export function encodePacket(type: MessageType, payload: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

export function encodeData(data: string): Buffer {
  return encodePacket(MessageType.DATA, Buffer.from(data));
}

export function encodeAttach(rows: number, cols: number): Buffer {
  const payload = Buffer.alloc(4);
  payload.writeUInt16BE(rows, 0);
  payload.writeUInt16BE(cols, 2);
  return encodePacket(MessageType.ATTACH, payload);
}

export function encodeDetach(): Buffer {
  return encodePacket(MessageType.DETACH, Buffer.alloc(0));
}

export function encodeResize(rows: number, cols: number): Buffer {
  const payload = Buffer.alloc(4);
  payload.writeUInt16BE(rows, 0);
  payload.writeUInt16BE(cols, 2);
  return encodePacket(MessageType.RESIZE, payload);
}

export function encodeGeometry(rows: number, cols: number): Buffer {
  const payload = Buffer.alloc(4);
  payload.writeUInt16BE(rows, 0);
  payload.writeUInt16BE(cols, 2);
  return encodePacket(MessageType.GEOMETRY, payload);
}

export function encodeExit(code: number): Buffer {
  const payload = Buffer.alloc(4);
  payload.writeInt32BE(code, 0);
  return encodePacket(MessageType.EXIT, payload);
}

export function encodePeek(plain = false, full = false): Buffer {
  const payload = Buffer.alloc(1);
  // Bit 0: plain, Bit 1: full scrollback
  payload.writeUInt8((plain ? 1 : 0) | (full ? 2 : 0), 0);
  return encodePacket(MessageType.PEEK, payload);
}

export function encodeScreen(data: string): Buffer {
  return encodePacket(MessageType.SCREEN, Buffer.from(data));
}

export function encodeStatus(): Buffer {
  return encodePacket(MessageType.STATUS, Buffer.alloc(0));
}

export function encodeStatusResponse(json: string): Buffer {
  return encodePacket(MessageType.STATUS, Buffer.from(json));
}

export function encodeAcceptedSocketOwnershipRequest(
  request: AcceptedSocketOwnershipRequest,
): Buffer {
  return encodePacket(
    MessageType.ACCEPTED_SOCKET_OWNERSHIP,
    Buffer.from(JSON.stringify(request)),
  );
}

export function encodeAcceptedSocketOwnershipResponse(
  result: AcceptedSocketOwnershipResult,
): Buffer {
  return encodePacket(
    MessageType.ACCEPTED_SOCKET_OWNERSHIP,
    Buffer.from(JSON.stringify(result)),
  );
}

export function encodeLifecycleCompareAndSetRequest(
  request: LifecycleCompareAndSetRequest,
): Buffer {
  return encodePacket(MessageType.LIFECYCLE_CAS, Buffer.from(JSON.stringify(request)));
}

export function encodeLifecycleCompareAndSetResponse(
  result: LifecycleCompareAndSetResult,
): Buffer {
  return encodePacket(MessageType.LIFECYCLE_CAS, Buffer.from(JSON.stringify(result)));
}

export function decodeSize(payload: Buffer): { rows: number; cols: number } {
  if (payload.length < 4) {
    return { rows: 24, cols: 80 };
  }
  return {
    rows: payload.readUInt16BE(0),
    cols: payload.readUInt16BE(2),
  };
}

export function decodeGeometry(payload: Buffer): { rows: number; cols: number } {
  return decodeSize(payload);
}

export function decodeExit(payload: Buffer): number {
  if (payload.length < 4) {
    return -1;
  }
  return payload.readInt32BE(0);
}

/** Streaming packet parser that handles partial reads on a stream socket.
 *  Throws `PacketTooLargeError` if a peer declares a length exceeding
 *  `MAX_PACKET_LENGTH` — handlers should destroy the socket. */
export class PacketReader {
  private buffer = Buffer.alloc(0);

  feed(data: Buffer): Packet[] {
    this.buffer = Buffer.concat([this.buffer, data]);
    const packets: Packet[] = [];

    while (this.buffer.length >= HEADER_SIZE) {
      const type = this.buffer.readUInt8(0) as MessageType;
      const length = this.buffer.readUInt32BE(1);

      if (length > MAX_PACKET_LENGTH) {
        // Poison the buffer so subsequent feed() calls can't continue past
        // the bad header (even though the caller should drop the connection).
        this.buffer = Buffer.alloc(0);
        throw new PacketTooLargeError(length);
      }

      if (this.buffer.length < HEADER_SIZE + length) break;

      const payload = Buffer.from(
        this.buffer.subarray(HEADER_SIZE, HEADER_SIZE + length)
      );
      packets.push({ type, payload });
      this.buffer = this.buffer.subarray(HEADER_SIZE + length);
    }

    return packets;
  }
}
