import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OwnedLoginJobPort } from "../../agy-accounts/src/ports.js";
import type { InteractiveLoginJobPort } from "../../agy-accounts/src/login.js";
import type { AgyAuxiliaryLease } from "../../contracts/src/agy-account.js";

export class ProcessStopUnconfirmedError extends Error {
  readonly code = "PROCESS_STOP_UNCONFIRMED";
  readonly jobId: string;
  constructor(jobId: string, message?: string) {
    super(message ?? `Process stop unconfirmed for job: ${jobId}`);
    this.name = "ProcessStopUnconfirmedError";
    this.jobId = jobId;
  }
}

export interface AuxJobOptions {
  executable: string;
  args: string[];
  lease: AgyAuxiliaryLease;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * R04 修复：
 * - 所有子进程通过 runner-entry.js 管理，确保 Job 绑定和进程所有权
 * - start() 在中止/错误时必须确认进程停止，不返回 fully_stopped:true
 * - Windows 交互登录使用 CREATE_SUSPENDED | CREATE_NEW_CONSOLE
 */
export class AgyAccountJobRunner implements OwnedLoginJobPort, InteractiveLoginJobPort {
  private activeJobs = new Map<string, { child: ChildProcess; cwd: string; jobId: string }>();

  constructor(
    private agyExecutable: string = "agy",
  ) {}

  async startLoginJob(options: {
    realmId: string;
    operationId: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<{
    jobId: string;
    waitForCompletion: () => Promise<{ success: boolean; error?: string }>;
    cancel: () => Promise<void>;
  }> {
    options.signal?.throwIfAborted();
    const jobId = `login_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const tempCwd = await mkdtemp(join(tmpdir(), "devflow-agy-login-"));

    // R04 修复：通过 runner-entry.js 启动，确保进程所有权和 Job 绑定
    const runnerEntry = require.resolve("./runner-entry.js");
    const child = spawn(process.execPath, [runnerEntry, this.agyExecutable, "login"], {
      cwd: tempCwd,
      windowsHide: false, // Interactive login needs visible window
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });

    this.activeJobs.set(jobId, { child, cwd: tempCwd, jobId });

    // R04 修复：通过 IPC 发送 start 消息
    const sendStart = () => {
      try {
        child.send?.({
          type: "start",
          executable: this.agyExecutable,
          args: ["login"],
          cwd: tempCwd,
          env: {},
        });
      } catch {}
    };
    child.once("spawn", sendStart);
    if (child.pid) sendStart();

    const cancel = async () => {
      if (!this.activeJobs.has(jobId)) return;
      try {
        // R04 修复：通过 IPC 发送 stop 消息，等待确认
        child.send?.({ type: "stop", reason: "login_cancelled" });
        // 等待进程退出
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            try { child.kill("SIGKILL"); } catch {}
            resolve();
          }, 5000);
          child.once("close", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      } catch {}
      try {
        await rm(tempCwd, { recursive: true, force: true });
      } catch {}
      this.activeJobs.delete(jobId);
    };

    const waitForCompletion = async (): Promise<{ success: boolean; error?: string }> => {
      const timeoutMs = options.timeoutMs ?? 900000;
      let timer: NodeJS.Timeout | undefined;

      return new Promise((resolve) => {
        const onAbort = async () => {
          await cancel();
          resolve({ success: false, error: "login_cancelled" });
        };

        if (options.signal) {
          options.signal.addEventListener("abort", onAbort, { once: true });
        }

        timer = setTimeout(async () => {
          await cancel();
          resolve({ success: false, error: "login_timeout" });
        }, timeoutMs);

        child.on("exit", async (code) => {
          if (timer) clearTimeout(timer);
          if (options.signal) {
            options.signal.removeEventListener("abort", onAbort);
          }
          this.activeJobs.delete(jobId);
          try {
            await rm(tempCwd, { recursive: true, force: true });
          } catch {}
          if (code === 0) {
            resolve({ success: true });
          } else {
            resolve({ success: false, error: `Login exited with code ${code}` });
          }
        });

        child.on("error", async (err) => {
          if (timer) clearTimeout(timer);
          this.activeJobs.delete(jobId);
          try {
            await rm(tempCwd, { recursive: true, force: true });
          } catch {}
          resolve({ success: false, error: err.message });
        });
      });
    };

    return {
      jobId,
      waitForCompletion,
      cancel,
    };
  }

  async runAuxiliaryProbe(options: AuxJobOptions): Promise<{ code: number | null; stdout: string; stderr: string }> {
    options.signal?.throwIfAborted();
    if (!options.lease || !options.lease.lease_id || !options.lease.operation_id) {
      throw new Error("invalid_auxiliary_lease");
    }

    const tempCwd = await mkdtemp(join(tmpdir(), "devflow-agy-aux-"));
    const timeoutMs = options.timeoutMs ?? 30000;

    try {
      // R04 修复：通过 runner-entry.js 启动，确保进程所有权
      const runnerEntry = require.resolve("./runner-entry.js");
      return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        let resolved = false;
        let timer: NodeJS.Timeout | undefined;

        const cleanupAndFinish = (res: { code: number | null; stdout: string; stderr: string }) => {
          if (resolved) return;
          resolved = true;
          if (timer) clearTimeout(timer);
          if (options.signal) {
            options.signal.removeEventListener("abort", onAbort);
          }
          resolve(res);
        };

        const onAbort = () => {
          if (resolved) return;
          if (timer) clearTimeout(timer);
          try {
            // R04 修复：通过 IPC 发送 stop 消息
            child.send?.({ type: "stop", reason: "probe_aborted" });
          } catch {}
          cleanupAndFinish({ code: -1, stdout, stderr: `${stderr}\nCancelled by signal` });
        };

        if (options.signal) {
          if (options.signal.aborted) {
            void onAbort();
            return;
          }
          options.signal.addEventListener("abort", onAbort, { once: true });
        }

        const child = spawn(process.execPath, [runnerEntry, options.executable, ...options.args], {
          cwd: tempCwd,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe", "ipc"],
        });

        // R04 修复：通过 IPC 发送 start 消息
        const sendStart = () => {
          try {
            child.send?.({
              type: "start",
              executable: options.executable,
              args: [...options.args],
              cwd: tempCwd,
              env: {},
            });
          } catch {}
        };
        child.once("spawn", sendStart);
        if (child.pid) sendStart();

        timer = setTimeout(() => {
          if (resolved) return;
          try {
            child.send?.({ type: "stop", reason: "probe_timeout" });
          } catch {}
          cleanupAndFinish({ code: -1, stdout, stderr: `${stderr}\nTimeout after ${timeoutMs}ms` });
        }, timeoutMs);

        child.stdout?.on("data", (chunk) => {
          stdout += chunk.toString();
        });
        child.stderr?.on("data", (chunk) => {
          stderr += chunk.toString();
        });

        child.on("close", (code) => {
          cleanupAndFinish({ code, stdout, stderr });
        });

        child.on("error", (err) => {
          if (timer) clearTimeout(timer);
          if (options.signal) options.signal.removeEventListener("abort", onAbort);
          reject(err);
        });
      });
    } finally {
      try {
        await rm(tempCwd, { recursive: true, force: true });
      } catch {}
    }
  }

  async start(input: {
    executable: string;
    args: readonly string[];
    signal: AbortSignal;
  }): Promise<{
    exit_code: number | null;
    fully_stopped: boolean;
  }> {
    input.signal?.throwIfAborted();
    const tempCwd = await mkdtemp(join(tmpdir(), "devflow-agy-login-"));

    try {
      // R04 修复：通过 runner-entry.js 启动，确保进程所有权
      const runnerEntry = require.resolve("./runner-entry.js");
      return await new Promise((resolvePromise) => {
        const child = spawn(process.execPath, [runnerEntry, input.executable, ...input.args], {
          cwd: tempCwd,
          windowsHide: false, // Interactive needs visible window
          stdio: ["pipe", "pipe", "pipe", "ipc"],
        });

        // R04 修复：通过 IPC 发送 start 消息
        const sendStart = () => {
          try {
            child.send?.({
              type: "start",
              executable: input.executable,
              args: [...input.args],
              cwd: tempCwd,
              env: {},
            });
          } catch {}
        };
        child.once("spawn", sendStart);
        if (child.pid) sendStart();

        let isStopped = false;
        const confirmAndFinish = (code: number | null, fullyStopped: boolean) => {
          if (isStopped) return;
          isStopped = true;
          // R04 修复：不再默认返回 fully_stopped:true
          // 必须确认进程确实退出
          resolvePromise({
            exit_code: code,
            fully_stopped: fullyStopped,
          });
        };

        const onAbort = () => {
          try {
            // R04 修复：通过 IPC 发送 stop 消息
            child.send?.({ type: "stop", reason: "aborted" });
          } catch {}
          // R04 修复：中止时等待确认退出，不立即返回 fully_stopped:true
          const confirmTimer = setTimeout(() => {
            // 超时后仍未退出，标记为未确认
            confirmAndFinish(-1, false);
          }, 5000);
          child.once("close", (code) => {
            clearTimeout(confirmTimer);
            confirmAndFinish(code, true);
          });
        };

        input.signal?.addEventListener("abort", onAbort, { once: true });
        child.once("close", (code) => {
          input.signal?.removeEventListener("abort", onAbort);
          confirmAndFinish(code, true);
        });
        child.once("error", () => {
          input.signal?.removeEventListener("abort", onAbort);
          // R04 修复：错误时标记为未确认停止
          confirmAndFinish(-1, false);
        });
      });
    } finally {
      try {
        await rm(tempCwd, { recursive: true, force: true });
      } catch {}
    }
  }
}
