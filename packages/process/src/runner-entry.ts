import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

const attempt = process.argv[2] ?? randomUUID();
if (!process.send || !/^[a-f0-9-]{36}$/.test(attempt)) process.exit(1);
let tool: ChildProcess | undefined;
let started = false,
  stopping = false,
  rootExited = false;
const send = (message: Record<string, unknown>) => {
  if (process.connected) process.send?.({ ...message, attempt_id: attempt });
};
const startup = setTimeout(() => process.exit(1), 30000);
function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(startup);
  if (process.platform === "win32") {
    // The controller owns the Job. IPC loss also closes its kill-on-close handle.
    try {
      tool?.kill();
    } catch {}
    // Wait for tool exit notification before exiting to ensure 'exited' is sent
    if (tool && !rootExited) {
      tool.once("exit", () => process.exit(1));
      setTimeout(() => process.exit(1), 5000);
    } else {
      process.exit(1);
    }
    return;
  }
  // The launcher itself is the detached group leader and stays alive until escalation.
  try {
    process.kill(-process.pid, "SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      process.kill(-process.pid, "SIGKILL");
    } finally {
      process.exit(1);
    }
  }, 5000);
}
process.on("message", (raw) => {
  const message = raw as Record<string, unknown>;
  if (!message || message.attempt_id !== attempt) return;
  if (message.type === "stop") {
    stop();
    return;
  }
  if (message.type !== "start" || started || stopping) return;
  if (
    typeof message.executable !== "string" ||
    typeof message.cwd !== "string" ||
    !Array.isArray(message.args) ||
    message.args.some((value) => typeof value !== "string") ||
    !message.env ||
    typeof message.env !== "object"
  ) {
    stop();
    return;
  }
  started = true;
  clearTimeout(startup);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(message.env)) {
    if (
      typeof value !== "string" ||
      /^NODE_(OPTIONS|PATH|DEBUG.*|REPL_EXTERNAL_MODULE|COMPILE_CACHE|TLS_REJECT_UNAUTHORIZED)$/i.test(
        key,
      )
    )
      continue;
    env[key] = value;
  }
  try {
    tool = spawn(message.executable, message.args as string[], {
      cwd: message.cwd,
      env,
      stdio: ["inherit", "inherit", "inherit"],
      windowsHide: true,
      shell: false,
      // Inherit the launcher's existing group/Job; do not create an unowned second group.
      detached: false,
    });
    tool.once("error", () => {
      if (!rootExited) {
        rootExited = true;
        send({ type: "exited", code: -1 });
      }
    });
    tool.once("spawn", () => send({ type: "started", pid: tool!.pid }));
    tool.once("exit", (code, signal) => {
      if (rootExited) return;
      rootExited = true;
      send({ type: "exited", code, ...(signal ? { signal } : {}) });
      // Remain owned until the parent confirms the entire Job/group has stopped.
    });
  } catch {
    rootExited = true;
    send({ type: "exited", code: -1 });
  }
});
process.on("disconnect", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
send({ type: "ready", version: "1.0.0", pid: process.pid });
