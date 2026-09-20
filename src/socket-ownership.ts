import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { openSource, type LiveIdentity, type ProcessSource, type Row } from "./proc-table.ts";
import type {
  AcceptedSocketOwnershipResult,
  TcpConnectionTuple,
} from "./protocol.ts";

export interface SocketOwnershipDeps {
  platform?: NodeJS.Platform;
  processSource?: () => ProcessSource;
  linuxProcRoot?: string;
  darwinHelperPath?: string;
  execHelper?: (file: string, args: string[]) => string;
  endianness?: "BE" | "LE";
}

type BackendResult =
  | { _tag: "Owned"; pid: number }
  | { _tag: "NotOwned" }
  | { _tag: "Unavailable"; reason: string };

interface TreeIdentity {
  pid: number;
  identity: LiveIdentity;
}

/**
 * Prove that the server side of one exact held TCP connection belongs to the
 * current PTY child or one of its descendants. Both the process tree and every
 * inspected socket table are complete-or-unavailable; missing facts never turn
 * into NotOwned.
 */
export const inspectAcceptedSocketOwnership = (
  rootPid: number,
  tuple: TcpConnectionTuple,
  deps: SocketOwnershipDeps = {},
): AcceptedSocketOwnershipResult => {
  const tupleError = validateTuple(tuple);
  if (tupleError !== undefined) return { _tag: "Unavailable", reason: tupleError };

  const sourceFactory = deps.processSource ?? openSource;
  const before = exactTree(rootPid, sourceFactory());
  if (before._tag === "Unavailable") return before;

  const pids = before.identities.map(({ pid }) => pid);
  const observed = inspectBackend(pids, tuple, deps);
  if (observed._tag === "Unavailable") return observed;

  const middle = exactTree(rootPid, sourceFactory());
  if (middle._tag === "Unavailable") return middle;
  if (!sameTree(before.identities, middle.identities)) {
    return { _tag: "Unavailable", reason: "process-tree-changed" };
  }
  if (observed._tag === "NotOwned") return observed;
  if (!before.identities.some(({ pid }) => pid === observed.pid)) {
    return { _tag: "Unavailable", reason: "backend-returned-non-descendant" };
  }

  const confirmed = inspectBackend(pids, tuple, deps);
  if (confirmed._tag !== "Owned" || confirmed.pid !== observed.pid) {
    return { _tag: "Unavailable", reason: "socket-ownership-changed" };
  }
  const after = exactTree(rootPid, sourceFactory());
  if (after._tag === "Unavailable") return after;
  return sameTree(middle.identities, after.identities)
    ? confirmed
    : { _tag: "Unavailable", reason: "process-tree-changed" };
};

const inspectBackend = (
  pids: number[],
  tuple: TcpConnectionTuple,
  deps: SocketOwnershipDeps,
): BackendResult => {
  const platform = deps.platform ?? process.platform;
  return platform === "linux"
    ? inspectLinux(pids, tuple, deps.linuxProcRoot ?? "/proc", deps.endianness ?? os.endianness())
    : platform === "darwin"
      ? inspectDarwin(pids, tuple, deps)
      : { _tag: "Unavailable", reason: `unsupported-platform:${platform}` };
};

const exactTree = (
  rootPid: number,
  source: ProcessSource,
): { _tag: "Available"; identities: TreeIdentity[] } | { _tag: "Unavailable"; reason: string } => {
  const answer = source.rows();
  if (answer.kind !== "known") {
    return { _tag: "Unavailable", reason: `process-table-${answer.kind}` };
  }
  const byPid = new Map(answer.value.map((row) => [row.pid, row]));
  const root = byPid.get(rootPid);
  if (!root || root.state.startsWith("Z") || root.identity === null) {
    return { _tag: "Unavailable", reason: "child-identity-unavailable" };
  }

  const children = new Map<number, Row[]>();
  for (const row of answer.value) {
    const list = children.get(row.ppid) ?? [];
    list.push(row);
    children.set(row.ppid, list);
  }
  const identities: TreeIdentity[] = [];
  const queue = [root];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const row = queue.shift()!;
    if (seen.has(row.pid)) continue;
    seen.add(row.pid);
    if (row.state.startsWith("Z") || row.identity === null) {
      return { _tag: "Unavailable", reason: `process-identity-unavailable:${row.pid}` };
    }
    identities.push({ pid: row.pid, identity: row.identity });
    queue.push(...(children.get(row.pid) ?? []));
  }
  identities.sort((a, b) => a.pid - b.pid);
  return { _tag: "Available", identities };
};

const sameTree = (left: TreeIdentity[], right: TreeIdentity[]): boolean =>
  left.length === right.length && left.every((entry, index) =>
    entry.pid === right[index]?.pid && entry.identity === right[index]?.identity
  );

const validateTuple = (tuple: TcpConnectionTuple): string | undefined => {
  if (tuple.localAddress.includes("%") || tuple.remoteAddress.includes("%")) {
    return "scoped-ipv6-unavailable";
  }
  if (net.isIP(tuple.localAddress) === 0) return "invalid-local-address";
  if (net.isIP(tuple.remoteAddress) === 0) return "invalid-remote-address";
  if (net.isIP(tuple.localAddress) !== net.isIP(tuple.remoteAddress)) {
    return "address-family-mismatch";
  }
  if (!isPort(tuple.localPort)) return "invalid-local-port";
  if (!isPort(tuple.remotePort)) return "invalid-remote-port";
  return undefined;
};

const isPort = (value: number): boolean => Number.isSafeInteger(value) && value > 0 && value <= 65535;
const stripZone = (address: string): string => address.split("%", 1)[0];

const inspectLinux = (
  pids: number[],
  tuple: TcpConnectionTuple,
  procRoot: string,
  endianness: "BE" | "LE",
): BackendResult => {
  const family = net.isIP(stripZone(tuple.localAddress));
  const expectedLocal = encodeLinuxProcAddress(stripZone(tuple.remoteAddress), endianness);
  const expectedRemote = encodeLinuxProcAddress(stripZone(tuple.localAddress), endianness);
  if (expectedLocal === undefined || expectedRemote === undefined) {
    return { _tag: "Unavailable", reason: "address-encoding-failed" };
  }
  const tableName = family === 4 ? "tcp" : "tcp6";
  const localPort = tuple.remotePort.toString(16).padStart(4, "0").toUpperCase();
  const remotePort = tuple.localPort.toString(16).padStart(4, "0").toUpperCase();

  for (const pid of pids) {
    let table: string;
    let fds: string[];
    try {
      table = fs.readFileSync(path.join(procRoot, String(pid), "net", tableName), "utf8");
      fds = fs.readdirSync(path.join(procRoot, String(pid), "fd"));
    } catch {
      return { _tag: "Unavailable", reason: `procfs-unreadable:${pid}` };
    }
    const parsed = parseLinuxTcpTable(table);
    if (parsed === undefined) {
      return { _tag: "Unavailable", reason: `socket-table-invalid:${pid}` };
    }
    const inodes = new Set(parsed.filter((row) =>
      row.state === "01" &&
      row.localAddress === expectedLocal &&
      row.localPort === localPort &&
      row.remoteAddress === expectedRemote &&
      row.remotePort === remotePort
    ).map((row) => row.inode));
    if (inodes.size === 0) continue;

    for (const fd of fds) {
      let target: string;
      try {
        target = fs.readlinkSync(path.join(procRoot, String(pid), "fd", fd));
      } catch {
        return { _tag: "Unavailable", reason: `fd-table-unreadable:${pid}` };
      }
      const match = /^socket:\[(\d+)]$/.exec(target);
      if (match && inodes.has(match[1])) return { _tag: "Owned", pid };
    }
  }
  return { _tag: "NotOwned" };
};

interface LinuxTcpRow {
  localAddress: string;
  localPort: string;
  remoteAddress: string;
  remotePort: string;
  state: string;
  inode: string;
}

/** Parse a complete procfs tcp/tcp6 table. Any malformed data invalidates it. */
export const parseLinuxTcpTable = (input: string): LinuxTcpRow[] | undefined => {
  const lines = input.trimEnd().split("\n");
  if (lines.length === 0 || !lines[0]?.includes("local_address")) return undefined;
  const rows: LinuxTcpRow[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === "") continue;
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) return undefined;
    const local = /^([0-9A-Fa-f]+):([0-9A-Fa-f]{4})$/.exec(fields[1]);
    const remote = /^([0-9A-Fa-f]+):([0-9A-Fa-f]{4})$/.exec(fields[2]);
    if (!local || !remote || !/^[0-9A-Fa-f]{2}$/.test(fields[3]) || !/^\d+$/.test(fields[9])) {
      return undefined;
    }
    rows.push({
      localAddress: local[1].toUpperCase(),
      localPort: local[2].toUpperCase(),
      remoteAddress: remote[1].toUpperCase(),
      remotePort: remote[2].toUpperCase(),
      state: fields[3].toUpperCase(),
      inode: fields[9],
    });
  }
  return rows;
};

export const encodeLinuxProcAddress = (
  address: string,
  endianness: "BE" | "LE" = os.endianness(),
): string | undefined => {
  const bytes = ipBytes(address);
  if (bytes === undefined) return undefined;
  if (endianness === "BE") return Buffer.from(bytes).toString("hex").toUpperCase();
  const out: number[] = [];
  for (let offset = 0; offset < bytes.length; offset += 4) {
    out.push(bytes[offset + 3], bytes[offset + 2], bytes[offset + 1], bytes[offset]);
  }
  return Buffer.from(out).toString("hex").toUpperCase();
};

const ipBytes = (address: string): number[] | undefined => {
  if (net.isIPv4(address)) {
    const bytes = address.split(".").map(Number);
    return bytes.length === 4 && bytes.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
      ? bytes
      : undefined;
  }
  if (!net.isIPv6(address)) return undefined;
  const halves = address.toLowerCase().split("::");
  if (halves.length > 2) return undefined;
  const expand = (part: string): number[] | undefined => {
    if (part === "") return [];
    const words: number[] = [];
    for (const token of part.split(":")) {
      if (token.includes(".")) {
        const v4 = ipBytes(token);
        if (v4 === undefined) return undefined;
        words.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else if (/^[0-9a-f]{1,4}$/.test(token)) {
        words.push(Number.parseInt(token, 16));
      } else {
        return undefined;
      }
    }
    return words;
  };
  const left = expand(halves[0] ?? "");
  const right = expand(halves[1] ?? "");
  if (left === undefined || right === undefined) return undefined;
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 0 || (halves.length === 1 && left.length !== 8)) return undefined;
  const words = [...left, ...Array.from({ length: missing }, () => 0), ...right];
  if (words.length !== 8) return undefined;
  return words.flatMap((word) => [word >>> 8, word & 0xff]);
};

const inspectDarwin = (
  pids: number[],
  tuple: TcpConnectionTuple,
  deps: SocketOwnershipDeps,
): BackendResult => {
  const bin = path.resolve(
    import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "bin",
  );
  const architectureHelper = path.join(bin, `pty-socket-owner-darwin-${process.arch}`);
  const helper = deps.darwinHelperPath ?? (
    fs.existsSync(architectureHelper)
      ? architectureHelper
      : path.join(bin, "pty-socket-owner-darwin")
  );
  const execute = deps.execHelper ?? ((file: string, args: string[]) => execFileSync(file, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2_000,
  }));
  let output: string;
  try {
    output = execute(helper, [
      stripZone(tuple.remoteAddress),
      String(tuple.remotePort),
      stripZone(tuple.localAddress),
      String(tuple.localPort),
      ...pids.map(String),
    ]).trim();
  } catch {
    return { _tag: "Unavailable", reason: "darwin-helper-failed" };
  }
  if (output === "not-owned") return { _tag: "NotOwned" };
  if (output === "unavailable") return { _tag: "Unavailable", reason: "darwin-table-unavailable" };
  const match = /^owned (\d+)$/.exec(output);
  if (!match) return { _tag: "Unavailable", reason: "darwin-helper-invalid-output" };
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pids.includes(pid)
    ? { _tag: "Owned", pid }
    : { _tag: "Unavailable", reason: "darwin-helper-returned-non-descendant" };
};

export interface AsyncSocketOwnershipDeps {
  workerUrl?: URL;
  timeoutMs?: number;
}

/** Run synchronous procfs/libproc inspection in an isolated worker so a slow
 * readiness query cannot delay the daemon-owned startup deadline timer. */
export const inspectAcceptedSocketOwnershipAsync = (
  rootPid: number,
  tuple: TcpConnectionTuple,
  deps: AsyncSocketOwnershipDeps = {},
): Promise<AcceptedSocketOwnershipResult> => new Promise((resolve) => {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  let worker: Worker;
  try {
    worker = new Worker(
      deps.workerUrl ?? new URL(`./socket-ownership-worker.${extension}`, import.meta.url),
      { workerData: { rootPid, tuple } },
    );
  } catch {
    resolve({ _tag: "Unavailable", reason: "ownership-worker-failed" });
    return;
  }
  let settled = false;
  const finish = (result: AcceptedSocketOwnershipResult): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    void worker.terminate();
    resolve(result);
  };
  const timer = setTimeout(
    () => finish({ _tag: "Unavailable", reason: "ownership-worker-timeout" }),
    deps.timeoutMs ?? 10_000,
  );
  worker.once("message", (value: unknown) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      finish({ _tag: "Unavailable", reason: "ownership-worker-invalid-result" });
      return;
    }
    const result = value as Record<string, unknown>;
    if (result._tag === "Owned" && Number.isSafeInteger(result.pid) && (result.pid as number) > 0) {
      finish({ _tag: "Owned", pid: result.pid as number });
    } else if (result._tag === "NotOwned") {
      finish({ _tag: "NotOwned" });
    } else if (result._tag === "Unavailable" && typeof result.reason === "string") {
      finish({ _tag: "Unavailable", reason: result.reason });
    } else {
      finish({ _tag: "Unavailable", reason: "ownership-worker-invalid-result" });
    }
  });
  worker.once("error", () => {
    finish({ _tag: "Unavailable", reason: "ownership-worker-failed" });
  });
  worker.once("exit", (code) => {
    if (code !== 0) finish({ _tag: "Unavailable", reason: "ownership-worker-failed" });
  });
});
