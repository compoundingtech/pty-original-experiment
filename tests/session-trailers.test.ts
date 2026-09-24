import { describe, expect, it, vi } from "vitest";
import { TERMINAL_SANITIZE, exitHeader, trailer } from "../src/client.ts";
import * as net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { encodeScreen } from "../src/protocol.ts";

const SAN = TERMINAL_SANITIZE + "\x1b[999;1H";
const clientUrl = new URL("../dist/client.js", import.meta.url).href;

const runCleanClose = async (command: "attach" | "peek", plain = false, malformed = false): Promise<{ stdout: string; stderr: string; code: number | null }> => {
  const server = net.createServer((socket) => {
    socket.once("data", () => socket.end(malformed
      ? Buffer.from([5, 0xff, 0xff, 0xff, 0xff])
      : encodeScreen("ready")));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP listener");
  const script = `
    import net from "node:net";
    import { attach, peek } from ${JSON.stringify(clientUrl)};
    const socket = net.createConnection({ host: "127.0.0.1", port: ${address.port} });
    socket.once("connect", () => ${command}({
      name: "gone", socket, peer: "box", follow: true, plain: ${plain},
      row: { name: "gone", status: "running", displayName: "My Worker",
        cwd: "/opt/proj", command: "sh" },
      onExit: (code) => process.exit(code),
    }));
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end();
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const [code] = await once(child, "close") as [number | null];
  server.close();
  return { code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
};
describe("session trailer bytes", () => {
  it("names a remote detach, displays the dial-time row and includes the peer", () => {
    const actual = trailer({ name: "web-3f2a", peer: "box", row: {
      name: "web-3f2a", status: "running", displayName: "My Web Server",
      cwd: "/opt/proj", command: "node app.js", tags: { role: "web" },
    } }, "[detached from web-3f2a]", "reattach: pty attach --remote box web-3f2a");
    expect(actual).toBe(SAN + "\r\n[detached from web-3f2a]\r\n" +
      "  \x1b[1mMy Web Server\x1b[0m \x1b[2m(web-3f2a)\x1b[0m #role=web — /opt/proj — \x1b[2mnode app.js\x1b[0m\r\n" +
      "  reattach: pty attach --remote box web-3f2a\r\n");
  });

  it("prints exit duration and the kept local session's restart hint", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-24T12:14:00.000Z"));
      const metadata = {
        command: "node", args: ["app.js"], displayCommand: "node app.js",
        cwd: "/opt/proj", createdAt: "2026-09-24T10:00:00.000Z",
        displayName: "My Web Server", tags: { keep: "true" },
      };
      const actual = trailer({ name: "web-3f2a", metadata },
        exitHeader("web-3f2a", 1, { name: "web-3f2a", createdAt: metadata.createdAt }),
        "restart: pty attach web-3f2a");
      expect(actual).toBe(SAN + "\r\n[web-3f2a exited with code 1 after 2h14m]\r\n" +
        "  \x1b[1mMy Web Server\x1b[0m \x1b[2m(web-3f2a)\x1b[0m #keep=true — /opt/proj — \x1b[2mnode app.js\x1b[0m\r\n" +
        "  restart: pty attach web-3f2a\r\n");
    } finally {
      vi.useRealTimers();
    }
  });

  it("omits the summary if a remote row was unavailable", () => {
    expect(trailer({ name: "gone", peer: "box" }, "[gone session ended]")).toBe(
      SAN + "\r\n[gone session ended]\r\n");
  });
  it("prints the close trailer on a clean attach socket EOF without an EXIT", async () => {
    const result = await runCleanClose("attach");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("\x1b[2J\x1b[Hready" + SAN +
      "\r\n[gone session ended]\r\n" +
      "  \x1b[1mMy Worker\x1b[0m \x1b[2m(gone)\x1b[0m — /opt/proj — \x1b[2msh\x1b[0m\r\n");
  });

  it("prints the close trailer on a clean follow socket EOF, plain and styled", async () => {
    const styled = await runCleanClose("peek");
    expect(styled.code).toBe(0);
    expect(styled.stderr).toBe("");
    expect(styled.stdout).toBe("ready" + SAN + "\r\n[gone session ended]\r\n" +
      "  \x1b[1mMy Worker\x1b[0m \x1b[2m(gone)\x1b[0m — /opt/proj — \x1b[2msh\x1b[0m\r\n");
    const plain = await runCleanClose("peek", true);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toBe("ready\r\n[gone session ended]\r\n" +
      "  My Worker (gone) — /opt/proj — sh\r\n");
  });

  it("does not mistake a client-rejected frame for a daemon-ended session", async () => {
    for (const command of ["attach", "peek"] as const) {
      const result = await runCleanClose(command, false, true);
      expect(result.code).toBe(0);
      expect(result.stderr).toContain("pty client: dropping connection — Packet length");
      expect(result.stdout).toBe("");
    }
  });

});
