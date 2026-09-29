import { describe, it, expect } from "vitest";
import { buildAttachRemoteArgs, buildFilteredGroups, buildSpawnRemoteArgs, type ListItem, type RelayHost, type RemoteSession } from "../src/tui/interactive.ts";
import type { SessionInfo } from "../src/sessions.ts";

function makeSession(name: string, status: "running" | "exited" = "running", opts?: { command?: string; cwd?: string; tags?: Record<string, string> }): SessionInfo {
  return {
    name,
    socketPath: `/tmp/${name}.sock`,
    pid: status === "running" ? 12345 : null,
    status,
    metadata: {
      command: opts?.command ?? "cat",
      args: [],
      displayCommand: opts?.command ?? "cat",
      cwd: opts?.cwd ?? "/tmp",
      createdAt: new Date().toISOString(),
      ...(opts?.tags ? { tags: opts.tags } : {}),
    },
  };
}

function makeHost(label: string, sessions: { name: string; command?: string; cwd?: string }[], spawn_enabled = true): RelayHost {
  return {
    label,
    url: `https://${label}#token`,
    sessions: sessions.map(s => ({
      name: s.name,
      status: "running",
      command: s.command ?? "bash",
      cwd: s.cwd ?? "/home/example",
    })),
    spawn_enabled,
    error: null,
  };
}

function itemNames(groups: ReturnType<typeof buildFilteredGroups>): string[][] {
  return groups.map(g => g.items.map(i => {
    if (i.type === "create") return "[create]";
    if (i.type === "remote-create") return "[remote-create]";
    if (i.type === "remote") return i.remote!.session.name;
    return i.session!.name;
  }));
}

function groupTitles(groups: ReturnType<typeof buildFilteredGroups>): string[] {
  return groups.map(g => g.title);
}

describe("buildFilteredGroups", () => {
  describe("no filter", () => {
    it("shows all local sessions with create item", () => {
      const sessions = [makeSession("web"), makeSession("worker")];
      const groups = buildFilteredGroups("", sessions, []);

      expect(groupTitles(groups)).toEqual(["Local"]);
      expect(itemNames(groups)).toEqual([["web", "worker", "[create]"]]);
    });

    it("shows remote groups with create when spawn enabled", () => {
      const sessions = [makeSession("local-1")];
      const hosts = [makeHost("server-a", [{ name: "remote-1" }])];
      const groups = buildFilteredGroups("", sessions, hosts);

      expect(groupTitles(groups)).toEqual(["Local", "server-a"]);
      expect(itemNames(groups)[1]).toEqual(["remote-1", "[remote-create]"]);
    });

    it("hides remote create when spawn not enabled", () => {
      const sessions: SessionInfo[] = [];
      const hosts = [makeHost("server-a", [{ name: "r1" }], false)];
      const groups = buildFilteredGroups("", sessions, hosts);

      expect(itemNames(groups)[1]).toEqual(["r1"]);
    });
  });

  describe("session filter", () => {
    it("filters local sessions by name", () => {
      const sessions = [makeSession("web-server"), makeSession("worker"), makeSession("db")];
      const groups = buildFilteredGroups("web", sessions, []);

      const local = groups.find(g => g.title === "Local")!;
      expect(local.items.some(i => i.session?.name === "web-server")).toBe(true);
      expect(local.items.some(i => i.session?.name === "worker")).toBe(false);
    });

    it("filters remote sessions by name", () => {
      const hosts = [makeHost("server-a", [
        { name: "api" },
        { name: "web" },
        { name: "cron" },
      ])];
      const groups = buildFilteredGroups("api", [], hosts);

      const remote = groups.find(g => g.title === "server-a");
      expect(remote).toBeDefined();
      const names = remote!.items.filter(i => i.type === "remote").map(i => i.remote!.session.name);
      expect(names).toContain("api");
      expect(names).not.toContain("cron");
    });

    it("hides create items when filter does not match 'new'", () => {
      const sessions = [makeSession("web")];
      const groups = buildFilteredGroups("web", sessions, []);

      const local = groups.find(g => g.title === "Local")!;
      expect(local.items.some(i => i.type === "create")).toBe(false);
    });

    it("shows create items when filter is prefix of 'new'", () => {
      const sessions = [makeSession("newsletter")];

      for (const prefix of ["n", "ne", "new"]) {
        const groups = buildFilteredGroups(prefix, sessions, []);
        const local = groups.find(g => g.title === "Local")!;
        expect(local.items.some(i => i.type === "create")).toBe(true);
      }
    });

    it("hides create items when filter goes past 'new'", () => {
      const sessions = [makeSession("newsletter")];
      const groups = buildFilteredGroups("news", sessions, []);

      const local = groups.find(g => g.title === "Local")!;
      expect(local.items.some(i => i.type === "create")).toBe(false);
    });
  });

  describe("host/session filter syntax", () => {
    it("filters by host name before slash", () => {
      const sessions = [makeSession("local-web")];
      const hosts = [
        makeHost("prod-server", [{ name: "api" }, { name: "web" }]),
        makeHost("staging", [{ name: "api" }, { name: "web" }]),
      ];
      const groups = buildFilteredGroups("prod/", sessions, hosts);

      expect(groupTitles(groups)).toContain("prod-server");
      expect(groupTitles(groups)).not.toContain("staging");
    });

    it("filters by session name after slash", () => {
      const hosts = [makeHost("server", [
        { name: "api" },
        { name: "web" },
        { name: "cron" },
      ])];
      const groups = buildFilteredGroups("server/api", [], hosts);

      const remote = groups.find(g => g.title === "server")!;
      const names = remote.items.filter(i => i.type === "remote").map(i => i.remote!.session.name);
      expect(names).toContain("api");
      expect(names).not.toContain("web");
    });

    it("host filter hides local when it does not match 'local'", () => {
      const sessions = [makeSession("web")];
      const hosts = [makeHost("prod", [{ name: "api" }])];
      const groups = buildFilteredGroups("prod/", sessions, hosts);

      expect(groupTitles(groups)).not.toContain("Local");
    });

    it("host filter shows local when it matches 'local'", () => {
      const sessions = [makeSession("web")];
      const hosts = [makeHost("prod", [{ name: "api" }])];
      const groups = buildFilteredGroups("local/", sessions, hosts);

      expect(groupTitles(groups)).toContain("Local");
      expect(groupTitles(groups)).not.toContain("prod");
    });

    it("both host and session filter combined", () => {
      const hosts = [
        makeHost("prod", [{ name: "api" }, { name: "web" }]),
        makeHost("staging", [{ name: "api" }, { name: "web" }]),
      ];
      const groups = buildFilteredGroups("prod/web", [], hosts);

      expect(groupTitles(groups)).toEqual(["prod"]);
      const names = groups[0].items.filter(i => i.type === "remote").map(i => i.remote!.session.name);
      expect(names).toEqual(["web"]);
    });
  });

  describe("edge cases", () => {
    it("empty sessions and no relay", () => {
      const groups = buildFilteredGroups("", [], []);
      expect(groupTitles(groups)).toEqual(["Local"]);
      expect(itemNames(groups)).toEqual([["[create]"]]);
    });

    it("relay host with error is skipped", () => {
      const hosts: RelayHost[] = [{
        label: "broken",
        url: "https://broken#token",
        sessions: [],
        spawn_enabled: true,
        error: "connection refused",
      }];
      const groups = buildFilteredGroups("", [], hosts);
      expect(groupTitles(groups)).toEqual(["Local"]);
    });

    it("filter matches no sessions", () => {
      const sessions = [makeSession("web")];
      const groups = buildFilteredGroups("zzzzz", sessions, []);

      const local = groups.find(g => g.title === "Local")!;
      expect(local.items).toEqual([]);
    });

    it("running sessions rank above exited in filter results", () => {
      const sessions = [
        makeSession("api-server", "exited"),
        makeSession("api-worker", "running"),
      ];
      const groups = buildFilteredGroups("api", sessions, []);

      const local = groups.find(g => g.title === "Local")!;
      const sessionItems = local.items.filter(i => i.type === "session");
      expect(sessionItems[0].session!.name).toBe("api-worker");
      expect(sessionItems[1].session!.name).toBe("api-server");
    });
  });
});

describe("buildSpawnRemoteArgs", () => {
  it("builds the base argv with no tags", () => {
    expect(buildSpawnRemoteArgs("https://host#tok", "myses", {})).toEqual([
      "connect", "https://host#tok", "--spawn", "myses",
    ]);
  });

  it("forwards tags as --tag key=value pairs", () => {
    expect(buildSpawnRemoteArgs("https://host", "myses", { role: "web" })).toEqual([
      "connect", "https://host", "--spawn", "myses", "--tag", "role=web",
    ]);
  });

  it("forwards multiple tags in a stable order", () => {
    const tags = { role: "web", env: "prod" };
    const argv = buildSpawnRemoteArgs("https://h", "s", tags);
    expect(argv).toEqual([
      "connect", "https://h", "--spawn", "s",
      "--tag", "role=web",
      "--tag", "env=prod",
    ]);
  });

  it("preserves = in values", () => {
    expect(buildSpawnRemoteArgs("u", "n", { note: "k=v" })).toEqual([
      "connect", "u", "--spawn", "n", "--tag", "note=k=v",
    ]);
  });
});

describe("buildAttachRemoteArgs", () => {
  const sess = (name: string): RemoteSession => ({ name, status: "running" });
  const host = (label: string, url: string): RelayHost => ({
    label, url, sessions: [], spawn_enabled: true, error: null,
  });

  it("appends session name to token URL path (no fragment)", () => {
    expect(buildAttachRemoteArgs(host("h", "https://x.example"), sess("s1"))).toEqual([
      "connect", "https://x.example/s1",
    ]);
  });

  it("appends session name before the URL fragment (with token hash)", () => {
    expect(buildAttachRemoteArgs(host("h", "https://x.example#tok"), sess("s2"))).toEqual([
      "connect", "https://x.example/s2#tok",
    ]);
  });

  it("uses label + --session for ssh:// peers, ignoring URL-path convention", () => {
    expect(buildAttachRemoteArgs(host("home", "ssh://me@home"), sess("chat"))).toEqual([
      "connect", "home", "--session", "chat",
    ]);
  });

  it("ssh peers with port keep label routing", () => {
    expect(buildAttachRemoteArgs(host("box", "ssh://user@box:2222"), sess("s"))).toEqual([
      "connect", "box", "--session", "s",
    ]);
  });
});
