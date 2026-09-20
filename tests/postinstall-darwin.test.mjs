import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { installDarwinSocketOwner } from "../scripts/postinstall.js";
import { buildDarwinSocketOwner } from "../scripts/build-darwin-socket-owner.js";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const makeRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pty-darwin-helper-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "bin"));
  return root;
};

describe("Darwin helper installation", () => {
  it("uses a packaged helper without invoking a compiler", () => {
    const root = makeRoot();
    fs.writeFileSync(
      path.join(root, "bin", "pty-socket-owner-darwin"),
      "fixture",
    );
    let compiled = false;
    expect(installDarwinSocketOwner({
      platform: "darwin",
      root,
      run: () => { compiled = true; },
    })).toBe("available");
    expect(compiled).toBe(false);
  });

  it("produces one packaged universal helper for both Darwin architectures", () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, "native"));
    fs.writeFileSync(path.join(root, "native", "pty-socket-owner-darwin.c"), "fixture");
    let invocation;
    const output = buildDarwinSocketOwner({
      platform: "darwin",
      root,
      run: (file, args) => {
        invocation = { file, args };
        fs.writeFileSync(args.at(-1), "universal fixture");
        return { status: 0, stderr: "" };
      },
    });
    expect(output).toBe(path.join(root, "bin", "pty-socket-owner-darwin"));
    expect(fs.readFileSync(output, "utf8")).toBe("universal fixture");
    expect(invocation).toMatchObject({
      file: "cc",
      args: expect.arrayContaining(["-arch", "arm64", "x86_64"]),
    });
  });

  it("refuses package production that would omit the Darwin helper", () => {
    expect(() => buildDarwinSocketOwner({
      platform: "linux",
      root: makeRoot(),
    })).toThrow("must be produced on Darwin");
  });

  it("keeps installation successful when no compiler is available", () => {
    const root = makeRoot();
    const warnings = [];
    expect(() => installDarwinSocketOwner({
      platform: "darwin",
      root,
      run: () => ({ error: new Error("cc missing"), status: null, stderr: "" }),
      warn: (message) => warnings.push(message),
    })).not.toThrow();
    expect(warnings).toEqual([
      "[@compoundingtech/pty] Darwin socket-ownership helper unavailable: cc missing",
    ]);
  });
});
