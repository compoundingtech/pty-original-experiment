import { parentPort } from "node:worker_threads";

const until = Date.now() + 100;
while (Date.now() < until) {}
parentPort.postMessage({ _tag: "NotOwned" });
