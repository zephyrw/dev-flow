import { join } from "node:path";
import { atomicWrite } from "../../../packages/core/src/util.js";
import { getNative } from "../../../packages/process/src/native/index.js";
export function recordController(storage: string, entry: string, mode: "full" | "accounts" = "full") {
  // Both controller entrypoints have acquiredControllerLock (and initialized native) first.
  const creation = getNative().getProcessCreationTime(process.pid);
  if (creation === null) throw new Error("CONTROLLER_IDENTITY_UNAVAILABLE");
  let started = String(creation);
  if (process.platform === "win32") {
    // Preserve all FILETIME ticks for stop-devflow.ps1 without starting a shell.
    const ticks = BigInt(creation) - 116444736000000000n;
    const seconds = new Date(Number(ticks / 10000000n) * 1000).toISOString();
    started = seconds.replace(".000Z", `.${String(ticks % 10000000n).padStart(7, "0")}Z`);
  }
  atomicWrite(
    join(storage, "controller-process.json"),
    JSON.stringify({
      pid: process.pid,
      started,
      creation_time: String(creation),
      executable: process.execPath,
      entry,
      mode,
    }),
  );
}
