/**
 * Minimal Node launcher entry for managed tool processes.
 *
 * Spawned by the controller with `process.execPath`, `execArgv: []`, and a
 * dedicated IPC channel plus independent stdin/stdout/stderr pipes.
 * Loads only Node built-ins — no business modules, no koffi.
 *
 * Protocol (JSON over IPC):
 *   out: { type: "ready", version, attempt_id, pid }
 *   in:  { type: "start", executable, args, cwd, env }
 *   in:  { type: "stop", reason?, stop_seconds? }
 *   out: { type: "started", pid }
 *   out: { type: "exited", code, signal? }
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

const PROTOCOL_VERSION = "1.0.0";
const START_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_GRACE_MS = 5_000;

type StartMessage = {
  type: "start";
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
};

type StopMessage = {
  type: "stop";
  reason?: string;
  stop_seconds?: number;
};

type IncomingMessage = StartMessage | StopMessage;

type OutgoingMessage =
  | { type: "ready"; version: string; attempt_id: string; pid: number }
  | { type: "started"; pid: number }
  | { type: "exited"; code: number | null; signal?: string };

/** Env keys that must never reach the tool (debug / preload / module search). */
const STRIP_ENV_KEYS = new Set([
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_DEBUG",
  "NODE_DEBUG_NATIVE",
  "NODE_DEBUG_MODULE",
  "NODE_DEBUG_NET",
  "NODE_DEBUG_HTTP",
  "NODE_REPL_EXTERNAL_MODULE",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_PENDING_DEPRECATION",
  "NODE_COMPILE_CACHE",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStrippedEnvKey(key: string): boolean {
  return (
    STRIP_ENV_KEYS.has(key) ||
    key.startsWith("NODE_DEBUG") ||
    key.startsWith("NODE_OPTIONS")
  );
}

function sanitizeEnv(
  source: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (typeof value !== "string") continue;
    if (isStrippedEnvKey(key)) continue;
    out[key] = value;
  }
  return out;
}

function parseIncoming(raw: unknown): IncomingMessage | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.type === "start") {
    const executable = raw.executable;
    const args = raw.args;
    const cwd = raw.cwd;
    const env = raw.env;
    if (typeof executable !== "string" || executable.length === 0) return undefined;
    if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
      return undefined;
    }
    if (typeof cwd !== "string" || cwd.length === 0) return undefined;
    if (!isRecord(env)) return undefined;
    return {
      type: "start",
      executable,
      args: args as string[],
      cwd,
      env: sanitizeEnv(env),
    };
  }
  if (raw.type === "stop") {
    const reason = typeof raw.reason === "string" ? raw.reason : undefined;
    const stopSeconds =
      typeof raw.stop_seconds === "number" &&
      Number.isFinite(raw.stop_seconds) &&
      raw.stop_seconds >= 0
        ? raw.stop_seconds
        : undefined;
    const msg: StopMessage = { type: "stop" };
    if (reason !== undefined) msg.reason = reason;
    if (stopSeconds !== undefined) msg.stop_seconds = stopSeconds;
    return msg;
  }
  return undefined;
}

function send(message: OutgoingMessage): void {
  try {
    process.send?.(message);
  } catch {
    // Channel already closed — exit path will run.
  }
}

// Strip inherited debug/preload configuration before any child is spawned.
delete process.env.NODE_OPTIONS;
delete process.env.NODE_PATH;
delete process.env.NODE_DEBUG;
delete process.env.NODE_REPL_EXTERNAL_MODULE;

const attempt_id = randomUUID();
let tool: ChildProcess | undefined;
let started = false;
let stopping = false;
let finished = false;
let startTimer: NodeJS.Timeout | undefined;
let stopTimer: NodeJS.Timeout | undefined;

function finish(code: number | null, signal?: string): void {
  if (finished) return;
  finished = true;
  if (startTimer) {
    clearTimeout(startTimer);
    startTimer = undefined;
  }
  if (stopTimer) {
    clearTimeout(stopTimer);
    stopTimer = undefined;
  }
  send({
    type: "exited",
    code,
    ...(signal !== undefined ? { signal } : {}),
  });
  const exitCode = code === null ? (signal !== undefined ? 1 : 0) : code;
  // Flush the exited message, then leave with the tool's exit code.
  setTimeout(() => {
    process.exit(exitCode);
  }, 0);
}

/**
 * Terminate the tool.
 * POSIX: SIGTERM to the dedicated process group, SIGKILL after grace.
 * Windows: full-tree TerminateJobObject is coordinated by the parent
 * controller (this runner never loads koffi / Win32). Best-effort kill of
 * the direct child only when the parent is gone (IPC disconnect).
 */
function stopTool(graceMs: number, fromDisconnect: boolean): void {
  if (!tool || stopping) return;
  stopping = true;
  const pid = tool.pid;
  if (process.platform === "win32") {
    // On Windows, the parent controller uses TerminateJobObject for full-tree
    // cleanup. But we also kill the direct child here so the runner exits
    // cleanly when receiving an explicit stop message (not just disconnect).
    try {
      tool.kill();
    } catch {
      // Already gone.
    }
    return;
  }
  if (pid !== undefined) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        tool.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    }
    stopTimer = setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          tool?.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }, graceMs);
  } else {
    try {
      tool.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

function handleStart(msg: StartMessage): void {
  if (started || finished) return;
  started = true;
  if (startTimer) {
    clearTimeout(startTimer);
    startTimer = undefined;
  }
  try {
    tool = spawn(msg.executable, msg.args, {
      cwd: msg.cwd,
      env: msg.env,
      shell: false,
      // Direct byte-forwarding of the three data pipes — no JSON/base64.
      stdio: ["inherit", "inherit", "inherit"],
      // POSIX: dedicated process group so stop can signal the whole tree.
      // Windows: Job membership is inherited from this runner automatically.
      detached: process.platform !== "win32",
      windowsHide: true,
    });
  } catch {
    finish(1);
    return;
  }
  const toolPid = tool.pid;
  if (toolPid !== undefined) {
    send({ type: "started", pid: toolPid });
  } else {
    // Spawn reported no pid — treat as failed start.
    finish(1);
    return;
  }
  tool.once("error", () => {
    finish(1);
  });
  tool.once("close", (code, signal) => {
    finish(code, signal ?? undefined);
  });
}

function handleStop(msg: StopMessage): void {
  const graceMs =
    msg.stop_seconds !== undefined
      ? Math.max(0, msg.stop_seconds * 1000)
      : DEFAULT_STOP_GRACE_MS;
  stopTool(graceMs, false);
}

if (typeof process.send !== "function") {
  // Must be spawned with an IPC channel.
  process.exit(1);
}

startTimer = setTimeout(() => {
  if (!started) finish(1);
}, START_TIMEOUT_MS);

process.on("message", (raw: unknown) => {
  const msg = parseIncoming(raw);
  if (!msg) return;
  if (msg.type === "start") handleStart(msg);
  else handleStop(msg);
});

process.on("disconnect", () => {
  stopTool(DEFAULT_STOP_GRACE_MS, true);
  // If the tool is already gone, exit now; otherwise close handler finishes.
  if (!tool || finished) finish(1);
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    stopTool(DEFAULT_STOP_GRACE_MS, true);
    if (!tool || finished) finish(1);
  });
}

send({
  type: "ready",
  version: PROTOCOL_VERSION,
  attempt_id,
  pid: process.pid,
});
