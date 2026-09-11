import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { atomicWrite } from "../../core/src/util.js";
export function recordController(storage: string, entry: string) {
  if (process.platform !== "win32") return;
  const started = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "(Get-Process -Id ([int]$env:DEVFLOW_DESCRIPTOR_PID)).StartTime.ToUniversalTime().ToString('o')"], {
    env: { ...process.env, DEVFLOW_DESCRIPTOR_PID: String(process.pid) },
    windowsHide: true, encoding: "utf8", timeout: 10000,
  }).trim();
  atomicWrite(join(storage, "controller-process.json"), JSON.stringify({
    pid: process.pid, started, executable: process.execPath, entry,
  }));
}
