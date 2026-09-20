// Ensure node-pty's prebuilt `spawn-helper` is executable. Necessary because
// node-pty's published tarball ships the file with mode 0644 and its own
// post-install never chmods it. The previous workaround used a relative path
// (`node_modules/node-pty/prebuilds/*/spawn-helper`) which silently no-ops
// under pnpm with `enableGlobalVirtualStore`, where node-pty lives in a
// sibling content-addressed link rather than nested under @compoundingtech/pty.
//
// The root-cause fix belongs in microsoft/node-pty; once that ships, this
// script can be removed entirely.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

if (process.platform === "win32") process.exit(0);

// Resolve from this package's root (package.json sibling), not from the
// script file, so that node-pty is discoverable regardless of whether
// node_modules is nested (npm/yarn/bun) or a sibling link (pnpm GVS).
const pkgDir = path.dirname(fileURLToPath(import.meta.url));
const requireFromPkg = createRequire(
  pathToFileURL(path.join(pkgDir, "..", "package.json")),
);

let nodePtyDir;
try {
  nodePtyDir = path.dirname(requireFromPkg.resolve("node-pty/package.json"));
} catch {
  console.warn("[@compoundingtech/pty] node-pty not found; skipping spawn-helper chmod");
}

if (nodePtyDir) {
  const helper = path.join(
    nodePtyDir,
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper",
  );
  try {
    fs.chmodSync(helper, 0o755);
  } catch {
    // Acceptable when there's no prebuild for this arch and node-pty was
    // built from source — node-gyp produces the binary executable already.
  }
}

export function installDarwinSocketOwner({
  platform = process.platform,
  root = path.resolve(pkgDir, ".."),
  run = spawnSync,
  warn = console.warn,
} = {}) {
  if (platform !== "darwin") return "not-applicable";
  const source = path.join(root, "native", "pty-socket-owner-darwin.c");
  const output = path.join(root, "bin", `pty-socket-owner-darwin-${process.arch}`);
  const packaged = [
    output,
    path.join(root, "bin", "pty-socket-owner-darwin"),
  ].find((candidate) => fs.existsSync(candidate));
  if (packaged) {
    try {
      fs.chmodSync(packaged, 0o755);
      return "available";
    } catch (error) {
      warn(`[@compoundingtech/pty] Darwin socket-ownership helper unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`);
      return "unavailable";
    }
  }
  const temporary = `${output}.tmp-${process.pid}`;
  const result = run("cc", ["-O2", "-Wall", "-Wextra", source, "-o", temporary], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!result.error && result.status === 0) {
    try {
      fs.renameSync(temporary, output);
      fs.chmodSync(output, 0o755);
      return "available";
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch {}
      warn(`[@compoundingtech/pty] Darwin socket-ownership helper unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`);
      return "unavailable";
    }
  }
  try { fs.rmSync(temporary, { force: true }); } catch {}
  const detail = result.error?.message ?? result.stderr?.trim() ?? "unknown compiler failure";
  warn(`[@compoundingtech/pty] Darwin socket-ownership helper unavailable: ${detail}`);
  return "unavailable";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installDarwinSocketOwner();
}
