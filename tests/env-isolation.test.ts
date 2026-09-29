import { describe, it, expect } from "vitest";
import { buildSpawnEnv } from "../src/testing/session.ts";

// Regression coverage for the test-isolation gap: when the harness itself runs
// inside a pty session, ambient PTY_ROOT (which getSessionDir() prefers over
// PTY_SESSION_DIR) leaked into spawned `pty`s and made them read the real live
// session dir instead of the per-test tmpdir.

describe("buildSpawnEnv (Session.spawn env isolation)", () => {
  it("always scrubs PTY_SESSION and PTY_SERVER_CONFIG", () => {
    const env = buildSpawnEnv({ PTY_SESSION: "example.pty", PTY_SERVER_CONFIG: "{}", HOME: "/h" });
    expect(env.PTY_SESSION).toBeUndefined();
    expect(env.PTY_SERVER_CONFIG).toBeUndefined();
    expect(env.HOME).toBe("/h"); // unrelated vars pass through
  });

  it("scrubs ambient PTY_ROOT / PTY_SESSION_DIR when the caller didn't set them", () => {
    const env = buildSpawnEnv({ PTY_ROOT: "/real/root", PTY_SESSION_DIR: "/real/dir" });
    expect(env.PTY_ROOT).toBeUndefined();
    expect(env.PTY_SESSION_DIR).toBeUndefined();
  });

  it("does NOT let ambient PTY_ROOT override an explicit per-call PTY_SESSION_DIR", () => {
    // The core failure mode: caller isolates via PTY_SESSION_DIR, harness has an
    // ambient PTY_ROOT. The child must see PTY_SESSION_DIR and no PTY_ROOT, so
    // getSessionDir() resolves to the caller's dir.
    const env = buildSpawnEnv(
      { PTY_ROOT: "/real/root", HOME: "/h" },
      { PTY_SESSION_DIR: "/tmp/isolated" },
    );
    expect(env.PTY_ROOT).toBeUndefined();
    expect(env.PTY_SESSION_DIR).toBe("/tmp/isolated");
  });

  it("keeps a PTY_ROOT the caller set explicitly (deliberate override wins)", () => {
    const env = buildSpawnEnv(
      { PTY_ROOT: "/ambient/root" },
      { PTY_ROOT: "/wanted/root" },
    );
    expect(env.PTY_ROOT).toBe("/wanted/root");
  });

  it("keeps a PTY_SESSION_DIR the caller set explicitly", () => {
    const env = buildSpawnEnv({}, { PTY_SESSION_DIR: "/wanted/dir" });
    expect(env.PTY_SESSION_DIR).toBe("/wanted/dir");
  });
});

describe("isolation hard guard (tests/setup/isolate-env.ts)", () => {
  it("has scrubbed ambient PTY_ROOT / PTY_SESSION / PTY_SESSION_DIR from the worker", () => {
    // The setupFile runs once per worker before any test module. If this fails,
    // the suite is running with a leaked ambient pty context and any test that
    // spawns `pty` may read the developer's real live session dir.
    expect(process.env.PTY_ROOT).toBeUndefined();
    expect(process.env.PTY_SESSION).toBeUndefined();
    expect(process.env.PTY_SESSION_DIR).toBeUndefined();
  });
});
