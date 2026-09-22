import {
  spawn,
  execFileSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { EventEmitter } from "node:events";
import { FlowError, requireCondition } from "../../contracts/src/index.js";

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
  agy_account?: {
    realm_id: string;
    account_id: string;
    auth_epoch: number;
    permit_id: string;
  };
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

export type ProcessStopReason = "timeout" | "manual" | "account_switch";
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
    termination_reason?: ProcessStopReason;
  }>;
  stop: (reason?: ProcessStopReason) => Promise<void>;
  pauseOutput?: () => void;
  resumeOutput?: () => void;
  termination_reason?: ProcessStopReason;
}
export class ProcessManager {
  private active = new Map<string, ManagedProcess>();
  private admission?: (spec: ProcessSpec) => void;
  setAdmissionGuard(guard?: (spec: ProcessSpec) => void) {
    this.admission = guard;
  }
  private stopHistory = new Map<string, ProcessStopResult>();
  private closing = false;
  constructor(
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
    this.admission?.(spec);
    this.lifecycle?.(spec, { status: "starting", job_id: spec.id });
    const events = new EventEmitter() as ManagedProcess;
    events.id = spec.id;
    const inherited: Record<string, string> = {};
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
    const child = spawn(spec.executable, spec.args, {
      cwd: spec.cwd,
      env: { ...inherited, ...spec.env },
      windowsHide: true,
      shell: false,
      stdio: "pipe",
    });
    feedChildStdin(child, spec.stdin, true);
    events.pid = child.pid;
    events.pauseOutput = () => {
      child.stdout.pause();
    };
    events.resumeOutput = () => {
      child.stdout.resume();
    };
    let settled = false;
    let termination_reason: ProcessStopReason | undefined;
    let timer: NodeJS.Timeout | undefined;
    const done = new Promise<{
      code: number | null;
      signal?: string;
      termination_reason?: ProcessStopReason;
    }>((resolve, reject) => {
      const settle = (
        code: number | null,
        signal?: string,
      ) => {
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
        this.lifecycle?.(spec, { status: "failed" });
        reject(e);
      });
      child.stdout.on("data", (b) => events.emit("stdout", b));
      child.stderr.on("data", (b) => events.emit("stderr", b));
      child.on("close", (code, signal) => settle(code, signal ?? undefined));
    });
    events.completion = done;
    events.stop = async (reason = "manual") => {
      if (settled) return;
      if (!termination_reason || reason === "manual") {
        termination_reason = reason;
        events.termination_reason = reason;
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
        void events.stop("timeout");
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
    reasonOrOptions: ProcessStopReason | ProcessStopOptions = "manual",
  ): Promise<ProcessStopResult> {
    const reason = typeof reasonOrOptions === "string" ? reasonOrOptions : "manual";
    const options = typeof reasonOrOptions === "string" ? undefined : reasonOrOptions;
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
    await p.stop(reason);
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
