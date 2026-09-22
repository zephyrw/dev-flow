import {
  spawn,
  execFileSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { FlowError, requireCondition } from "../../contracts/src/index.js";
import { JsonLines } from "../../adapters/agy/src/protocol.js";
import { id } from "../../core/src/util.js";

function killProcessTree(pid?: number) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
        windowsHide: true,
        stdio: "ignore",
      });
      return;
    }
    process.kill(pid, "SIGTERM");
  } catch {}
}

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
export interface ProcessStopOptions {
  expectedPid?: number;
  checkNotStarted?: boolean;
}

export interface ProcessStopResult {
  status:
    | "confirmed_exited"
    | "confirmed_not_started"
    | "requested"
    | "unknown"
    | "not_owned";
  pid?: number;
}

export interface ManagedProcess extends EventEmitter {
  id: string;
  pid?: number;
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
  private stopHistory = new Map<string, ProcessStopResult>();
  private closing = false;
  constructor(
    private hostExecutable: string,
    private requireHost = true,
    private lifecycle?: (
      spec: ProcessSpec,
      event: Record<string, unknown>,
    ) => void,
  ) {}
  start(spec: ProcessSpec): ManagedProcess {
    if (this.closing) {
      throw new FlowError(
        "PROCESS_MANAGER_CLOSING",
        "进程管理器正在关闭，拒绝启动新进程",
        503,
      );
    }
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
      child.stdin.on("error", () => {});
      // All children use the current Windows user and its existing login profile.
      child.stdin.write(
        JSON.stringify({
          ...spec,
          env: { ...inherited, ...spec.env },
        }) + "\n",
      );
    } else {
      child = spawn(spec.executable, spec.args, {
        cwd: spec.cwd,
        env: { ...inherited, ...spec.env },
        windowsHide: true,
        shell: false,
        stdio: "pipe",
      });
      child.stdin.on("error", () => {});
      if (spec.stdin) child.stdin.end(spec.stdin);
      else child.stdin.end();
    }
    events.pid = child.pid;
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
        this.stopHistory.set(spec.id, {
          status: "confirmed_exited",
          pid: events.pid,
        });
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
        this.stopHistory.set(spec.id, {
          status: "confirmed_exited",
          pid: events.pid,
        });
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
          }
        } catch {}
      }
      killProcessTree(child.pid);
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
  async stop(
    key: string,
    options?: ProcessStopOptions,
  ): Promise<ProcessStopResult> {
    const history = this.stopHistory.get(key);
    if (
      history &&
      (history.status === "confirmed_exited" ||
        history.status === "confirmed_not_started")
    ) {
      return history;
    }
    const p = this.active.get(key);
    if (!p) {
      if (options?.checkNotStarted) {
        const res: ProcessStopResult = { status: "confirmed_not_started" };
        this.stopHistory.set(key, res);
        return res;
      }
      return { status: "unknown" };
    }
    if (options?.expectedPid && p.pid && p.pid !== options.expectedPid) {
      return { status: "not_owned", pid: p.pid };
    }
    const pid = p.pid;
    await p.stop();
    const result: ProcessStopResult = { status: "confirmed_exited", pid };
    this.stopHistory.set(key, result);
    return result;
  }
  list() {
    return [...this.active.keys()];
  }
  async close() {
    this.closing = true;
    await Promise.all([...this.active.values()].map((p) => p.stop()));
  }
}
