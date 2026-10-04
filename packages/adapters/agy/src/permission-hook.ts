import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import koffi from "koffi";
import { atomicWrite, objectHash } from "../../../core/src/util.js";

function windowsCommandPath(path: string) {
  // AGY's cmd.exe invocation re-quotes embedded quoted arguments. Use the
  // filesystem's existing short path to preserve spaces without shell expansion.
  const buffer = Buffer.alloc(32768 * 2);
  const shortPath = koffi.load("kernel32.dll").func("GetShortPathNameW", "uint32", ["str16", "void *", "uint32"]);
  const length = shortPath(path, buffer, 32768);
  const value = length > 0 && length < 32768 ? buffer.subarray(0, length * 2).toString("utf16le") : path;
  if (/[\s"%!&|<>^]/.test(value))
    throw new Error("AGY permission hook requires a Windows path that the native command host can quote safely");
  // Node's extension classification is case-sensitive even on Windows.
  return value.replace(/\.mjs$/i, ".mjs");
}

/** A temporary hook for the tools the human approved, without changing native grants. */
export function installAgyPermissionHook(cwd: string, runRoot: string, grant: { calls: Array<{ name: string }> }) {
  const scriptPath = join(runRoot, "permission-hook.mjs");
  atomicWrite(scriptPath, `let raw = "";
try {
  let event;
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 1048576) throw new Error("Hook input too large");
    try { event = JSON.parse(raw); break; } catch { /* The native pipe may stay open after a complete JSON message. */ }
  }
  if (!event) throw new Error("Incomplete hook input");
  const response = await fetch(new URL("/api/worker/native-permission", process.env.DEVFLOW_BASE_URL), {
    method: "POST", headers: { Authorization: "Bearer " + process.env.DEVFLOW_RUN_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId: event.conversationId, toolCall: { name: event.toolCall?.name, args: event.toolCall?.args } }), signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("Permission host unavailable");
  const result = await response.json();
  if (!["allow", "ask"].includes(result.decision)) throw new Error("Invalid permission decision");
  process.stdout.write(JSON.stringify({ decision: result.decision, reason: result.reason, permissionOverrides: result.permissionOverrides }));
} catch {
  process.stdout.write(JSON.stringify({ decision: "deny", reason: "DEVFLOW_PERMISSION_CHECK_FAILED" }));
}
`);
  const command = process.platform === "win32"
    ? `${windowsCommandPath(process.execPath)} ${windowsCommandPath(scriptPath)}`
    : `'${process.execPath.replaceAll("'", "'\\''")}' '${scriptPath.replaceAll("'", "'\\''")}'`;
  const path = join(cwd, ".agents", "hooks.json");
  const original = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const config = original === undefined ? {} : JSON.parse(original);
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid AGY hooks configuration");
  // Reuse one bridge entry per workspace so a prior interrupted Run cannot
  // install a second consumer for the same one-use decision.
  const key = "devflow-permission-" + objectHash(cwd).slice(0, 16);
  const matcher = "^(?:" + [...new Set(grant.calls.map(call => call.name))]
    .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")$";
  const entry = { enabled: true, PreToolUse: [{ matcher, hooks: [{ type: "command", command, timeout: 20 }] }] };
  const previous = config[key];
  const installed = JSON.stringify({ ...config, [key]: entry }, null, 2);
  atomicWrite(path, installed);
  return () => {
    if (!existsSync(path)) return;
    const current = readFileSync(path, "utf8");
    if (current === installed) {
      if (original !== undefined) atomicWrite(path, original);
      else rmSync(path);
      return;
    }
    // Preserve concurrent edits and remove only the entry we still own.
    let changed;
    try { changed = JSON.parse(current); } catch { return; /* Keep concurrent incomplete edits intact. */ }
    if (!changed || typeof changed !== "object" || Array.isArray(changed)) return;
    if (objectHash(changed[key]) !== objectHash(entry)) return;
    if (previous === undefined) delete changed[key];
    else changed[key] = previous;
    atomicWrite(path, JSON.stringify(changed, null, 2));
  };
}
