import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

/** Build the universal helper that is included by npm pack. Package production
 * fails closed off Darwin or when either architecture cannot be compiled; an
 * install never needs a compiler to use the resulting package. */
export function buildDarwinSocketOwner({
  platform = process.platform,
  root = path.resolve(scriptDir, ".."),
  run = spawnSync,
} = {}) {
  if (platform !== "darwin") {
    throw new Error("Darwin socket-ownership packages must be produced on Darwin");
  }
  const source = path.join(root, "native", "pty-socket-owner-darwin.c");
  const output = path.join(root, "bin", "pty-socket-owner-darwin");
  const temporary = `${output}.tmp-${process.pid}`;
  const result = run("cc", [
    "-O2",
    "-Wall",
    "-Wextra",
    "-arch",
    "arm64",
    "-arch",
    "x86_64",
    source,
    "-o",
    temporary,
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0 || !fs.existsSync(temporary)) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    const detail = result.error?.message ?? result.stderr?.trim() ?? `cc exited ${result.status}`;
    throw new Error(`Failed to build universal Darwin socket-ownership helper: ${detail}`);
  }
  fs.renameSync(temporary, output);
  fs.chmodSync(output, 0o755);
  return output;
}

export function cleanDarwinSocketOwner(root = path.resolve(scriptDir, "..")) {
  fs.rmSync(path.join(root, "bin", "pty-socket-owner-darwin"), { force: true });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--clean")) cleanDarwinSocketOwner();
  else buildDarwinSocketOwner();
}
