import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { FlowError } from "../../contracts/src/index.js";
import {
  getNativeAsync,
  type NativeModule,
  type WindowsNative,
} from "./native/index.js";
import { observeProcessRecord } from "./process-protocol.js";
import type { ProcessIdentity, StopObservation } from "./process-protocol.js";

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
  interactive?: boolean;
  keep_stdin_open?: boolean;
  agy_account?: {
    realm_id: string;
    account_id: string;
    auth_epoch: number;
    permit_id: string;
  };
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
type Completion = {
  code: number | null;
  signal?: string;
  termination_reason?: ProcessStopReason;
};
export interface ManagedProcess extends EventEmitter {
  id: string;
  pid?: number;
  identity?: ProcessIdentity;
  ready: Promise<void>;
  completion: Promise<Completion>;
  stop: (reason?: ProcessStopReason) => Promise<void>;
  pauseOutput?: () => void;
  resumeOutput?: () => void;
  termination_reason?: ProcessStopReason;
  writeStdin: (value: string) => void;
  endStdin: () => void;
}

export function cleanProcessEnvironment(
  extra: Record<string, string> = {},
): Record<string, string> {
  const allowed = new Set([
    "SYSTEMROOT",
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
    "COMSPEC",
    "PATHEXT",
    "SYSTEMDRIVE",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "PROGRAMDATA",
    "JAVA_HOME",
    "JDK_HOME",
    "MAVEN_HOME",
    "M2_HOME",
    "LANG",
    "LC_ALL",
  ]);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && allowed.has(key.toUpperCase()))
      result[key] = value;
  for (const [key, value] of Object.entries(extra)) {
    if (
      /^NODE_(OPTIONS|PATH|DEBUG.*|REPL_EXTERNAL_MODULE|COMPILE_CACHE|TLS_REJECT_UNAUTHORIZED)$/i.test(
        key,
      )
    )
      continue;
    if (key.includes("=") || key.includes("\0") || value.includes("\0"))
      throw new Error("INVALID_PROCESS_ENV");
    if (process.platform === "win32")
      for (const existing of Object.keys(result))
        if (existing.toUpperCase() === key.toUpperCase())
          delete result[existing];
    result[key] = value;
  }
  return result;
}

export class ProcessManager {
  private active = new Map<string, ManagedProcess>();
  private stopHistory = new Map<string, ProcessStopResult>();
  private admission?: (spec: ProcessSpec) => void;
  private closing = false;
  constructor(
    private lifecycle?: (
      spec: ProcessSpec,
      event: Record<string, unknown>,
    ) => void,
  ) {}
  setAdmissionGuard(guard?: (spec: ProcessSpec) => void) {
    this.admission = guard;
  }
  start(spec: ProcessSpec): ManagedProcess {
    if (this.closing)
      throw new FlowError("PROCESS_MANAGER_CLOSING", "进程管理器正在关闭", 503);
    const existing = this.active.get(spec.id);
    if (existing) return existing;
    this.admission?.(spec);
    const env = cleanProcessEnvironment(spec.env);
    const identity: ProcessIdentity = {
      backend: "node-v1",
      id: spec.id,
      attempt_id: randomUUID(),
    };
    const events = new EventEmitter() as ManagedProcess;
    events.id = spec.id;
    events.identity = identity;
    let child: ChildProcess | undefined;
    let native: NativeModule | undefined;
    let job: bigint | undefined;
    let interactive: ReturnType<WindowsNative["spawnInteractive"]> | undefined;
    let timer: NodeJS.Timeout | undefined,
      startupTimer: NodeJS.Timeout | undefined,
      poll: NodeJS.Timeout | undefined;
    let launchIssued = false;
    let started = false,
      finished = false,
      stopRequested = false,
      bound = false,
      pipesClosed = false;
    let finishing: Promise<void> | undefined;
    let resolveDone!: (value: Completion) => void,
      rejectDone!: (error: Error) => void;
    let resolveReady!: () => void, rejectReady!: (error: Error) => void;
    events.completion = new Promise((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    events.ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    void events.completion.catch(() => {});
    void events.ready.catch(() => {});
    const notify = (event: Record<string, unknown>) =>
      this.lifecycle?.(spec, {
        ...event,
        pid: identity.pid,
        identity: { ...identity },
        attempt_id: identity.attempt_id,
      });
    const clearTimers = () => {
      clearTimeout(timer);
      clearTimeout(startupTimer);
      if (poll) clearInterval(poll);
    };
    const send = (message: Record<string, unknown>) => {
      if (!child?.connected) throw new Error("PROCESS_CHANNEL_CLOSED");
      child.send({ ...message, attempt_id: identity.attempt_id }, (error) => {
        if (error) void finish(-1, undefined, error);
      });
    };
    const finish = (
      code: number | null,
      signal?: string,
      failure?: Error,
    ): Promise<void> => {
      if (finished) return Promise.resolve();
      if (finishing) return finishing;
      finishing = (async () => {
        clearTimers();
        let confirmed = false;
        try {
          if (child?.pid && !bound) {
            child.kill();
            const deadline = Date.now() + 5000;
            while (
              child.exitCode === null &&
              child.signalCode === null &&
              Date.now() < deadline
            )
              await new Promise((resolve) => setTimeout(resolve, 25));
            if (child.exitCode === null && child.signalCode === null)
              throw new Error("RUNNER_STOP_UNCONFIRMED");
          }
          if (native && "createJob" in native && job) {
            if (!native.terminateJob(job, code ?? 1))
              throw new Error("JOB_TERMINATE_FAILED");
            const deadline = Date.now() + 10000;
            while (Date.now() < deadline) {
              const count = native.queryJobActiveCount(job);
              if (count < 0) throw new Error("JOB_QUERY_FAILED");
              if (count === 0) {
                confirmed = true;
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
          } else if (native && "killProcessGroup" in native && identity.pgid) {
            const current = native.getProcessCreationTime(identity.pgid);
            if (
              current &&
              identity.launcher_creation_time &&
              current !== identity.launcher_creation_time
            )
              throw new Error("PROCESS_NOT_OWNED");
            const result = native.killProcessGroup(
              identity.pgid,
              stopRequested ? "SIGTERM" : "SIGKILL",
            );
            if (!result.success) throw new Error(result.error);
            const deadline = Date.now() + 10000,
              escalate = Date.now() + (stopRequested ? 5000 : 0);
            let killed = !stopRequested;
            while (Date.now() < deadline) {
              if (!native.isProcessGroupAlive(identity.pgid)) {
                confirmed = true;
                break;
              }
              if (!killed && Date.now() >= escalate) {
                const result = native.killProcessGroup(
                  identity.pgid,
                  "SIGKILL",
                );
                if (!result.success) throw new Error(result.error);
                killed = true;
              }
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
          } else if (child?.pid) {
            // No start has been sent: this launcher cannot have created a tool.
            child.kill();
            const deadline = Date.now() + 5000;
            while (
              child.exitCode === null &&
              child.signalCode === null &&
              Date.now() < deadline
            )
              await new Promise((resolve) => setTimeout(resolve, 25));
            confirmed = child.exitCode !== null || child.signalCode !== null;
          } else confirmed = true;
          if (confirmed && child?.pid) {
            const deadline = Date.now() + 5000;
            while (!pipesClosed && Date.now() < deadline)
              await new Promise((resolve) => setTimeout(resolve, 10));
            if (!pipesClosed) throw new Error("PROCESS_PIPES_STILL_OPEN");
          }
        } catch {
          confirmed = false;
        }
        if (!confirmed) {
          this.stopHistory.set(spec.id, { status: "unknown", pid: events.pid });
          try {
            notify({ status: "failed", confirmed: false });
          } catch {}
          const error = new FlowError(
            "PROCESS_STOP_UNCONFIRMED",
            "无法确认受管进程树已完全退出",
            409,
          );
          rejectReady(error);
          rejectDone(error);
          throw error;
        }
        finished = true;
        interactive?.close();
        if (native && "createJob" in native && job) {
          native.closeHandle(job);
          job = undefined;
        }
        this.active.delete(spec.id);
        this.stopHistory.set(spec.id, {
          status: launchIssued ? "confirmed_exited" : "confirmed_not_started",
          pid: events.pid,
        });
        const result = {
          code,
          ...(signal ? { signal } : {}),
          ...(events.termination_reason
            ? { termination_reason: events.termination_reason }
            : {}),
        };
        try {
          notify({
            status: failure ? "failed" : "exited",
            confirmed: true,
            ...result,
          });
        } catch (error) {
          failure = error as Error;
        }
        if (!started) rejectReady(failure ?? new Error("PROCESS_NOT_STARTED"));
        if (failure) rejectDone(failure);
        else resolveDone(result);
      })().finally(() => {
        finishing = undefined;
      });
      void finishing.catch(() => {});
      return finishing;
    };
    events.stop = async (reason = "manual") => {
      if (finished) return;
      stopRequested = true;
      if (!events.termination_reason || reason === "manual")
        events.termination_reason = reason;
      // Initialization must observe cancellation before creating any OS resources.
      if (!native) {
        await events.completion.catch(() => {});
        return;
      }
      await finish(-1);
    };
    events.pauseOutput = () => child?.stdout?.pause();
    events.resumeOutput = () => child?.stdout?.resume();
    events.writeStdin = (value) => {
      if (!started || !child?.stdin?.writable)
        throw new Error("PROCESS_STDIN_CLOSED");
      child.stdin.write(value);
    };
    events.endStdin = () => child?.stdin?.end();
    this.stopHistory.delete(spec.id);
    this.active.set(spec.id, events);
    try {
      notify({ status: "starting", confirmed: false });
    } catch (error) {
      this.active.delete(spec.id);
      rejectReady(error as Error);
      rejectDone(error as Error);
      return events;
    }
    const timeout =
      spec.deadline_at !== undefined
        ? Math.max(0, spec.deadline_at - Date.now())
        : spec.timeout_ms;
    if (spec.deadline_at !== undefined || timeout > 0)
      timer = setTimeout(() => {
        void events.stop("timeout").catch(() => {});
      }, timeout);
    void (async () => {
      try {
        native = await getNativeAsync();
        if (stopRequested) {
          await finish(-1);
          return;
        }
        if ("createJob" in native) {
          identity.job_name = `Local\\DevFlow.${identity.attempt_id}`;
          job = native.createJob(identity.job_name) ?? undefined;
          if (!job) throw new Error("JOB_CREATE_FAILED");
          if (spec.interactive) {
            interactive = native.spawnInteractive(
              spec.executable,
              spec.args,
              spec.cwd,
              env,
              job,
            );
            bound = true;
            identity.pid = events.pid = interactive.pid;
            identity.creation_time = native
              .getProcessCreationTime(interactive.pid)
              ?.toString();
            if (!identity.creation_time)
              throw new Error("PROCESS_IDENTITY_UNKNOWN");
            notify({ status: "running", confirmed: false });
            launchIssued = true;
            interactive.resume();
            started = true;
            resolveReady();
            const win = native;
            poll = setInterval(() => {
              try {
                if (interactive && !win.isProcessRunning(interactive.handle))
                  void finish(interactive.exitCode());
              } catch (error) {
                void finish(-1, undefined, error as Error);
              }
            }, 50);
            return;
          }
        } else if (spec.interactive)
          throw new Error("INTERACTIVE_LOGIN_UNSUPPORTED");
        const runner = fileURLToPath(
          new URL("./runner-entry.js", import.meta.url),
        );
        // Development also uses the single compiled artifact, never a second handwritten JS copy.
        const entry = existsSync(runner)
          ? runner
          : fileURLToPath(
              new URL(
                "../../../dist/packages/process/src/runner-entry.js",
                import.meta.url,
              ),
            );
        if (!existsSync(entry)) throw new Error("RUNNER_BUILD_REQUIRED");
        child = spawn(process.execPath, [entry, identity.attempt_id], {
          cwd: spec.cwd,
          env: cleanProcessEnvironment(),
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe", "ipc"],
          detached: process.platform !== "win32",
        });
        const pipeError = (error: Error) => {
          events.emit("channel_error");
          void finish(-1, undefined, error);
        };
        child.stdin?.on("error", pipeError);
        child.stdout?.on("error", pipeError);
        child.stderr?.on("error", pipeError);
        child.stdout?.on("data", (value) => events.emit("stdout", value));
        child.stderr?.on("data", (value) => events.emit("stderr", value));
        child.once("error", (error) => {
          void finish(-1, undefined, error);
        });
        child.once("close", (code, signal) => {
          pipesClosed = true;
          void finish(
            code,
            signal ?? undefined,
            finished || finishing
              ? undefined
              : new Error("RUNNER_DISCONNECTED"),
          );
        });
        startupTimer = setTimeout(() => {
          void finish(-1, undefined, new Error("RUNNER_START_TIMEOUT"));
        }, 30000);
        let armed = false;
        child.on("message", (value) => {
          if (finished || finishing) return;
          try {
            const message = value as Record<string, unknown>;
            if (!message || message.attempt_id !== identity.attempt_id) return;
            if (message.type === "ready") {
              if (
                armed ||
                message.version !== "1.0.0" ||
                message.pid !== child?.pid
              )
                throw new Error("RUNNER_PROTOCOL_INVALID");
              identity.launcher_pid = child!.pid;
              identity.launcher_creation_time = native!
                .getProcessCreationTime(child!.pid!)
                ?.toString();
              if (!identity.launcher_creation_time)
                throw new Error("RUNNER_IDENTITY_UNKNOWN");
              if (native && "createJob" in native) {
                if (!job || !native.assignProcessToJob(job, child!.pid!))
                  throw new Error("JOB_ASSIGN_FAILED");
              } else identity.pgid = child!.pid;
              bound = true;
              notify({ status: "starting", confirmed: false });
              armed = true;
              if (stopRequested) {
                void finish(-1);
                return;
              }
              launchIssued = true;
              send({
                type: "start",
                executable: spec.executable,
                args: spec.args,
                cwd: spec.cwd,
                env,
              });
            } else if (message.type === "started") {
              if (
                !armed ||
                started ||
                !Number.isSafeInteger(message.pid) ||
                Number(message.pid) <= 0
              )
                throw new Error("RUNNER_PROTOCOL_INVALID");
              identity.pid = events.pid = Number(message.pid);
              identity.creation_time = native!
                .getProcessCreationTime(identity.pid)
                ?.toString();
              notify({ status: "running", confirmed: false });
              started = true;
              clearTimeout(startupTimer);
              resolveReady();
              if (spec.stdin) child!.stdin!.write(spec.stdin);
              if (!spec.keep_stdin_open) child!.stdin!.end();
              events.emit("host", {
                type: "started",
                pid: events.pid,
                attempt_id: identity.attempt_id,
              });
            } else if (message.type === "exited") {
              if (message.code !== null && !Number.isInteger(message.code))
                throw new Error("RUNNER_PROTOCOL_INVALID");
              void finish(
                message.code as number | null,
                typeof message.signal === "string" ? message.signal : undefined,
              );
            } else throw new Error("RUNNER_PROTOCOL_INVALID");
          } catch (error) {
            void finish(-1, undefined, error as Error);
          }
        });
      } catch (error) {
        await finish(-1, undefined, error as Error);
      }
    })().catch(() => {});
    return events;
  }
  get(key: string) {
    return this.active.get(key);
  }
  async observe(key: string): Promise<StopObservation> {
    const active = this.active.get(key);
    if (active) return observeProcessRecord({ identity: active.identity });
    const result = this.stopHistory.get(key);
    return {
      state:
        result?.status === "confirmed_exited" ||
        result?.status === "confirmed_not_started"
          ? "confirmed_exited"
          : "unknown",
    };
  }
  async stop(
    key: string,
    reasonOrOptions: ProcessStopReason | ProcessStopOptions = "manual",
  ): Promise<ProcessStopResult> {
    const options =
      typeof reasonOrOptions === "string" ? undefined : reasonOrOptions;
    const process = this.active.get(key);
    if (process) {
      if (options?.expectedPid && process.pid !== options.expectedPid)
        return { status: "not_owned", pid: process.pid };
      try {
        await process.stop(
          typeof reasonOrOptions === "string" ? reasonOrOptions : "manual",
        );
      } catch {
        return { status: "unknown", pid: process.pid };
      }
    }
    const history = this.stopHistory.get(key);
    if (history && options?.expectedPid && history.pid !== options.expectedPid)
      return { status: "not_owned" };
    // A missing record is not evidence that an earlier attempt never started.
    return history ?? { status: "unknown" };
  }
  list() {
    return [...this.active.keys()];
  }
  async close() {
    this.closing = true;
    const results = await Promise.allSettled(
      [...this.active.values()].map((process) => process.stop()),
    );
    if (results.some((result) => result.status === "rejected"))
      throw new Error("PROCESS_STOP_UNCONFIRMED");
  }
}
