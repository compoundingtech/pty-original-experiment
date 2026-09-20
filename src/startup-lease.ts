import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

export interface StartupLeaseOptions {
  /** Positive startup budget. PTY converts this once into an absolute deadline. */
  timeoutMs: number;
  /** The one metadata tag whose value carries the generation-fenced lifecycle. */
  lifecycleTag: string;
}

export interface ArmedStartupLease {
  generation: string;
  lifecycleTag: string;
  bootId: string;
  deadlineMonotonicNs: string;
  startingValue: string;
}

export type StartupLeaseTerminalCause = "exit" | "deadline" | "teardown-unavailable";

export interface MonotonicClock {
  bootId(): string | undefined;
  nowNs(): bigint;
}

export const systemMonotonicClock: MonotonicClock = {
  bootId: () => readBootIdentity(),
  nowNs: () => process.hrtime.bigint(),
};

export const armStartupLease = (
  options: StartupLeaseOptions,
  generation: string,
  clock: MonotonicClock = systemMonotonicClock,
): ArmedStartupLease => {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("startup lease timeoutMs must be a positive safe integer");
  }
  if (options.lifecycleTag.length === 0) {
    throw new Error("startup lease lifecycleTag must not be empty");
  }
  const bootId = clock.bootId();
  if (bootId === undefined || bootId.length === 0) {
    throw new Error("startup lease boot identity is unavailable");
  }
  const deadline = clock.nowNs() + BigInt(options.timeoutMs) * 1_000_000n;
  const deadlineMonotonicNs = deadline.toString();
  return {
    generation,
    lifecycleTag: options.lifecycleTag,
    bootId,
    deadlineMonotonicNs,
    startingValue: JSON.stringify({
      _tag: "starting",
      generation,
      bootId,
      deadlineMonotonicNs,
    }),
  };
};

export const terminalStartupLeaseValue = (
  generation: string,
  cause: StartupLeaseTerminalCause,
): string => JSON.stringify({ _tag: "terminal", generation, cause });

/** A deadline is only claimed when PTY proved complete process containment.
 * Unknown or partial observations remain terminal, but explicitly report that
 * the ensuing exact-identity/group signals are best-effort containment. */
export const startupLeaseDeadlineCause = (
  containmentComplete: boolean,
): StartupLeaseTerminalCause => containmentComplete
  ? "deadline"
  : "teardown-unavailable";

export const remainingLeaseDelayMs = (deadlineMonotonicNs: string, nowNs: bigint): number => {
  let deadline: bigint;
  try {
    deadline = BigInt(deadlineMonotonicNs);
  } catch {
    return 0;
  }
  if (nowNs >= deadline) return 0;
  const remaining = (deadline - nowNs + 999_999n) / 1_000_000n;
  return Number(remaining > 2_147_483_647n ? 2_147_483_647n : remaining);
};

export const readBootIdentity = (): string | undefined => {
  if (process.platform === "linux") {
    try {
      const value = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      return value.length > 0 ? `linux:${value}` : undefined;
    } catch {
      return undefined;
    }
  }
  if (process.platform === "darwin") {
    try {
      const value = execFileSync("sysctl", ["-n", "kern.boottime"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2_000,
      }).trim();
      return value.length > 0 ? `darwin:${value}` : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
};
