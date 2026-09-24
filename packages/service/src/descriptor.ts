import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { atomicWrite } from "../../core/src/util.js";

export function recordController(
  storage: string,
  entry: string,
  mode: "full" | "accounts" = "full",
) {
  let started = new Date(
    Date.now() - Math.floor(process.uptime() * 1000),
  ).toISOString();

  if (process.platform === "win32") {
    try {
      const psStarted = execFileSync(
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
          timeout: 5000,
        },
      ).trim();
      if (psStarted) started = psStarted;
    } catch {
      /* fallback to process.uptime timestamp */
    }
  }

  atomicWrite(
    join(storage, "controller-process.json"),
    JSON.stringify(
      {
        pid: process.pid,
        started,
        executable: process.execPath,
        entry,
        mode,
        protocol: "node-v1",
      },
      null,
      2,
    ),
  );
}
