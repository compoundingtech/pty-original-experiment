import { parentPort, workerData } from "node:worker_threads";
import { inspectAcceptedSocketOwnership } from "./socket-ownership.ts";
import type { TcpConnectionTuple } from "./protocol.ts";

const input = workerData as { rootPid: number; tuple: TcpConnectionTuple };
const result = inspectAcceptedSocketOwnership(input.rootPid, input.tuple);
parentPort?.postMessage(result);
