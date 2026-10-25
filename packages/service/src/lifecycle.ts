import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { redact } from "../../core/src/util.js";

export function lifecycleLogger(mode: "full" | "accounts") {
  let build: unknown = "unknown";
  try { build = JSON.parse(readFileSync(fileURLToPath(new URL("../../../build-info.json", import.meta.url)), "utf8")).build_revision; } catch { /* source run */ }
  const log = (event: string, details: Record<string, unknown> = {}) => console.error(JSON.stringify({
    time: new Date().toISOString(), component: "controller", event, pid: process.pid, ppid: process.ppid, mode, build, ...details,
  }));
  log("starting");
  process.on("uncaughtExceptionMonitor", error => log("uncaught_exception", { error: redact(error.stack ?? error.message) }));
  process.on("unhandledRejection", error => log("unhandled_rejection", { error: redact(error instanceof Error ? error.stack ?? error.message : String(error)) }));
  process.on("exit", code => log("exit", { code }));
  return log;
}
