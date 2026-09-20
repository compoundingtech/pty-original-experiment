import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { sourceFromShape, type ProcessSource } from "../src/proc-table.ts";
import {
  encodeLinuxProcAddress,
  inspectAcceptedSocketOwnership,
  inspectAcceptedSocketOwnershipAsync,
  parseLinuxTcpTable,
} from "../src/socket-ownership.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const tuple = {
  localAddress: "127.0.0.1",
  localPort: 51_000,
  remoteAddress: "127.0.0.1",
  remotePort: 3_000,
};

const table = (inode?: number, address = "0100007F"): string => [
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
  ...(inode === undefined ? [] : [
    `   0: ${address}:0BB8 ${address}:C738 01 00000000:00000000 00:00000000 00000000 1000 0 ${inode}`,
  ]),
  "",
].join("\n");

const addProcess = (root: string, pid: number, inode?: number): void => {
  const base = path.join(root, String(pid));
  fs.mkdirSync(path.join(base, "net"), { recursive: true });
  fs.mkdirSync(path.join(base, "fd"));
  fs.writeFileSync(path.join(base, "net", "tcp"), table(inode));
  if (inode !== undefined) fs.symlinkSync(`socket:[${inode}]`, path.join(base, "fd", "7"));
};

const fixture = (): { root: string; source: ProcessSource } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pty-socket-owner-"));
  roots.push(root);
  return {
    root,
    source: sourceFromShape("100 1 100 S root\n101 100 100 S child"),
  };
};

describe("Linux accepted socket ownership", () => {
  it("binds the exact reverse 4-tuple to a descendant fd", () => {
    const { root, source } = fixture();
    addProcess(root, 100);
    addProcess(root, 101, 42);
    expect(inspectAcceptedSocketOwnership(100, tuple, {
      platform: "linux",
      linuxProcRoot: root,
      processSource: () => source,
    })).toEqual({ _tag: "Owned", pid: 101 });
  });

  it("does not accept a matching decoy outside the child tree", () => {
    const { root, source } = fixture();
    addProcess(root, 100);
    addProcess(root, 101);
    addProcess(root, 999, 42);
    expect(inspectAcceptedSocketOwnership(100, tuple, {
      platform: "linux",
      linuxProcRoot: root,
      processSource: () => source,
    })).toEqual({ _tag: "NotOwned" });
  });

  it("fails closed when any descendant socket table is unavailable", () => {
    const { root, source } = fixture();
    addProcess(root, 100);
    expect(inspectAcceptedSocketOwnership(100, tuple, {
      platform: "linux",
      linuxProcRoot: root,
      processSource: () => source,
    })).toEqual({ _tag: "Unavailable", reason: "procfs-unreadable:101" });
  });

  it("rejects a partial procfs table rather than reading it as empty", () => {
    expect(parseLinuxTcpTable("sl local_address\n0: broken")).toBeUndefined();
  });

  it("encodes procfs address words for the host byte order", () => {
    expect(encodeLinuxProcAddress("127.0.0.1", "LE")).toBe("0100007F");
    expect(encodeLinuxProcAddress("127.0.0.1", "BE")).toBe("7F000001");
    expect(encodeLinuxProcAddress("2001:db8::1", "LE")).toBe(
      "B80D0120000000000000000001000000",
    );
    expect(encodeLinuxProcAddress("2001:db8::1", "BE")).toBe(
      "20010DB8000000000000000000000001",
    );
  });


  it("matches a big-endian procfs tuple end to end", () => {
    const { root, source } = fixture();
    addProcess(root, 100);
    addProcess(root, 101, 42);
    fs.writeFileSync(path.join(root, "101", "net", "tcp"), table(42, "7F000001"));
    expect(inspectAcceptedSocketOwnership(100, tuple, {
      platform: "linux",
      linuxProcRoot: root,
      processSource: () => source,
      endianness: "BE",
    })).toEqual({ _tag: "Owned", pid: 101 });
  });
  it("fails closed for scoped IPv6 tuples", () => {
    expect(inspectAcceptedSocketOwnership(100, {
      localAddress: "fe80::1%eth0",
      localPort: 51_000,
      remoteAddress: "fe80::2%eth0",
      remotePort: 3_000,
    })).toEqual({ _tag: "Unavailable", reason: "scoped-ipv6-unavailable" });
  });
});

describe("Darwin libproc backend", () => {
  it("keeps helper failure distinct from NotOwned", () => {
    const source = sourceFromShape("100 1 100 S root");
    expect(inspectAcceptedSocketOwnership(100, tuple, {
      platform: "darwin",
      processSource: () => source,
      execHelper: () => "unavailable\n",
    })).toEqual({ _tag: "Unavailable", reason: "darwin-table-unavailable" });
  });

  it("rechecks a positive descriptor observation before returning Owned", () => {
    const source = sourceFromShape("100 1 100 S root");
    let observations = 0;
    expect(inspectAcceptedSocketOwnership(100, tuple, {
      platform: "darwin",
      processSource: () => source,
      execHelper: () => ++observations === 1 ? "owned 100\n" : "not-owned\n",
    })).toEqual({ _tag: "Unavailable", reason: "socket-ownership-changed" });
  });

  it.runIf(process.platform === "darwin")(
    "proves a real accepted loopback socket through libproc",
    async () => {
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("TCP listener address unavailable");
      const accepted = new Promise<net.Socket>((resolve) => server.once("connection", resolve));
      const client = net.createConnection(address.port, "127.0.0.1");
      await new Promise<void>((resolve) => client.once("connect", resolve));
      const serverSocket = await accepted;
      try {
        expect(inspectAcceptedSocketOwnership(process.pid, {
          localAddress: client.localAddress!,
          localPort: client.localPort!,
          remoteAddress: client.remoteAddress!,
          remotePort: client.remotePort!,
        })).toEqual({ _tag: "Owned", pid: process.pid });
      } finally {
        client.destroy();
        serverSocket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});

describe("ownership worker isolation", () => {
  it("does not block daemon timers while inspection is running", async () => {
    // This is deliberately a real timer: the guarantee is that CPU-blocking
    // inspection in another thread cannot stall the daemon event loop.
    let timerFired = false;
    setTimeout(() => { timerFired = true; }, 10);
    const result = await inspectAcceptedSocketOwnershipAsync(100, tuple, {
      workerUrl: new URL("./fixtures/socket-ownership-worker.mjs", import.meta.url),
      timeoutMs: 1_000,
    });
    expect(result).toEqual({ _tag: "NotOwned" });
    expect(timerFired).toBe(true);
  });
});
