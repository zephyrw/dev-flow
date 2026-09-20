import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { FlowError, requireCondition } from "../../contracts/src/index.js";
import { JsonLines } from "../../adapters/agy/src/protocol.js";
import { id } from "../../core/src/util.js";
export interface ProcessSpec {
  id: string;
  workflow_id?: string;
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeout_ms: number;
  deadline_at?: number;
  stdin?: string;
}

function feedChildStdin(
  child: ChildProcessWithoutNullStreams,
  payload: string | undefined,
  closeAfterWrite: boolean,
) {
  let sent = false;
  const send = () => {
    if (sent || !child.stdin) return;
    sent = true;
    child.stdin.on("error", () => {});
    if (!payload) {
      if (closeAfterWrite) child.stdin.end();
      return;
    }
    if (closeAfterWrite) child.stdin.end(payload);
    else child.stdin.write(payload);
  };
  child.once("spawn", send);
  if (child.pid) send();
}

export interface ManagedProcess extends EventEmitter {
  id: string;
  completion: Promise<{
    code: number | null;
    signal?: string;
    termination_reason?: "timeout" | "manual";
  }>;
  stop: () => Promise<void>;
  pauseOutput?: () => void;
  resumeOutput?: () => void;
  termination_reason?: "timeout" | "manual";
}
export class ProcessManager {
  private active = new Map<string, ManagedProcess>();
  constructor(
    private hostExecutable: string,
    private requireHost = true,
    private lifecycle?: (
      spec: ProcessSpec,
      event: Record<string, unknown>,
    ) => void,
  ) {}
  start(spec: ProcessSpec): ManagedProcess {
    const existing = this.active.get(spec.id);
    if (existing) return existing;
    const isWindows = process.platform === "win32";
    requireCondition(
      !this.requireHost || existsSync(this.hostExecutable),
      "HOST_REQUIRED",
      "Process Host 尚未安装，不能执行受管进程",
      503,
    );
    const useHost = existsSync(this.hostExecutable);
    this.lifecycle?.(spec, { status: "starting", job_id: spec.id });
    const events = new EventEmitter() as ManagedProcess;
    events.id = spec.id;
    let child: ChildProcessWithoutNullStreams;
    const inherited: Record<string, string> = {
      DOTNET_ROOT: process.env.DOTNET_ROOT ?? process.cwd() + "/.cache/dotnet",
    };
    for (const key of [
      "SystemRoot",
      "WINDIR",
      "PATH",
      "TEMP",
      "TMP",
      "USERPROFILE",
      "HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "CODEX_HOME",
      "APPDATA",
      "LOCALAPPDATA",
      // Windows shells need these to resolve and execute .cmd/.bat programs.
      // Keep an explicit runtime allowlist; do not inherit tokens or secrets.
      "ComSpec",
      "PATHEXT",
      "SystemDrive",
      "ProgramFiles",
      "ProgramFiles(x86)",
      "ProgramW6432",
      "ProgramData",
      "JAVA_HOME",
      "JDK_HOME",
      "MAVEN_HOME",
      "M2_HOME",
    ])
      if (process.env[key]) inherited[key] = process.env[key]!;
    if (useHost) {
      child = spawn(this.hostExecutable, ["run"], {
        windowsHide: true,
        stdio: "pipe",
        env: inherited,
      });
      feedChildStdin(
        child,
        JSON.stringify({
          ...spec,
          env: { ...inherited, ...spec.env },
        }) + "\n",
        false,
      );
    } else {
      child = spawn(spec.executable, spec.args, {
        cwd: spec.cwd,
        env: { ...inherited, ...spec.env },
        windowsHide: true,
        shell: false,
        stdio: "pipe",
      });
      feedChildStdin(child, spec.stdin, true);
    }
    events.pauseOutput = () => {
      child.stdout.pause();
    };
    events.resumeOutput = () => {
      child.stdout.resume();
    };
    let settled = false;
    let termination_reason: "timeout" | "manual" | undefined;
    let timer: NodeJS.Timeout | undefined;
    const done = new Promise<{
      code: number | null;
      signal?: string;
      termination_reason?: "timeout" | "manual";
    }>((resolve, reject) => {
      const settle = (code: number | null, signal?: string) => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        this.active.delete(spec.id);
        this.lifecycle?.(spec, {
          status: "exited",
          code,
          confirmed: useHost,
          ...(termination_reason ? { termination_reason } : {}),
        });
        resolve({
          code,
          ...(signal ? { signal } : {}),
          ...(termination_reason ? { termination_reason } : {}),
        });
      };
      child.on("error", (e) => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        this.active.delete(spec.id);
        settled = true;
        this.lifecycle?.(spec, { status: "failed", confirmed: false });
        reject(e);
      });
      if (useHost) {
        const lines = new JsonLines((e) => {
          if (e.type === "stdout" || e.type === "stderr")
            events.emit(e.type, Buffer.from(String(e.data), "base64"));
          else if (e.type === "exit") settle(Number(e.code));
          else if (e.type === "error") {
            events.emit("diagnostic", String(e.message));
            settle(-1);
          } else {
            this.lifecycle?.(spec, { ...e, status: "running" });
            events.emit("host", e);
          }
        });
        child.stdout.on("data", (b: Buffer) => {
          try {
            lines.push(b);
          } catch (err) {
            events.emit("diagnostic", String(err));
            child.kill();
          }
        });
        child.stderr.on("data", (b) => events.emit("stderr", b));
        child.on("close", (code, signal) => {
          try {
            lines.finish();
          } catch {}
          settle(code === 0 ? -1 : code, signal ?? undefined);
        });
      } else {
        child.stdout.on("data", (b) => events.emit("stdout", b));
        child.stderr.on("data", (b) => events.emit("stderr", b));
        child.on("close", (code, signal) => settle(code, signal ?? undefined));
      }
    });
    events.completion = done;
    events.stop = async () => {
      if (settled) return;
      if (!termination_reason) {
        termination_reason = "manual";
        events.termination_reason = "manual";
      }
      if (useHost) {
        try {
          if (child.stdin?.writable) {
            child.stdin.write(JSON.stringify({ action: "stop" }) + "\n");
          } else {
            child.kill();
          }
        } catch {
          child.kill();
        }
      } else child.kill();
      await done;
    };
    let timeoutDuration = spec.timeout_ms;
    if (spec.deadline_at !== undefined) {
      timeoutDuration = Math.max(0, spec.deadline_at - Date.now());
    }
    if (
      timeoutDuration >= 0 &&
      (spec.timeout_ms > 0 || spec.deadline_at !== undefined)
    ) {
      timer = setTimeout(() => {
        if (!settled && !termination_reason) {
          termination_reason = "timeout";
          events.termination_reason = "timeout";
        }
        void events.stop();
      }, timeoutDuration);
    }
    this.active.set(spec.id, events);
    return events;
  }
  get(key: string) {
    return this.active.get(key);
  }
  async stop(key: string) {
    const p = this.active.get(key);
    if (p) await p.stop();
  }
  list() {
    return [...this.active.keys()];
  }
  async close() {
    await Promise.all([...this.active.values()].map((p) => p.stop()));
  }
}
