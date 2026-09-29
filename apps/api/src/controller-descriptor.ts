import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { atomicWrite } from "../../../packages/core/src/util.js";
import { getNative } from "../../../packages/process/src/native/index.js";
export function recordController(storage: string, entry: string, mode: "full" | "accounts" = "full") {
  // Both controller entrypoints have acquiredControllerLock (and initialized native) first.
  const creation = getNative().getProcessCreationTime(process.pid);
  if (creation === null) throw new Error("CONTROLLER_IDENTITY_UNAVAILABLE");
  const started = process.platform === "win32" ? execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-Process -Id ([int]$env:DEVFLOW_DESCRIPTOR_PID)).StartTime.ToUniversalTime().ToString('o')",
    ],
    {
      env: { ...process.env, DEVFLOW_DESCRIPTOR_PID: String(process.pid) },
      windowsHide: true,
      encoding: "utf8",
      timeout: 30000,
    },
  ).trim() : String(creation);
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
