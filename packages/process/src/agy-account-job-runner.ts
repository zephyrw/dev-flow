import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import type { OwnedLoginJobPort } from "../../agy-accounts/src/ports.js";
import type { InteractiveLoginJobPort } from "../../agy-accounts/src/login.js";
import type { AgyAuxiliaryLease } from "../../contracts/src/agy-account.js";

const execute = promisify(execFile);

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

export class AgyAccountJobRunner implements OwnedLoginJobPort, InteractiveLoginJobPort {
  private activeJobs = new Map<string, { child: ChildProcess; cwd: string; jobId: string }>();

  constructor(
    private hostExecutable: string = "devflow-host",
    private agyExecutable: string = "agy",
  ) {}

  private async verifyJobStopped(jobId: string, timeoutMs: number = 5000): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{1,150}$/.test(jobId)) return false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const { stdout } = await execute(this.hostExecutable, ["job-status", jobId], {
          windowsHide: true,
          timeout: 2000,
        });
        const status = JSON.parse(stdout.trim());
        if (status.id === jobId && status.alive === false && (status.active_processes === 0 || status.active_processes === undefined)) {
          return true;
        }
      } catch {
        // 查询错误、权限拒绝或超时均返回未确认，绝不能当成零进程
        return false;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

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

    const spec = {
      id: jobId,
      executable: this.agyExecutable,
      args: ["login"],
      cwd: tempCwd,
      env: {},
      timeout_ms: options.timeoutMs ?? 900000,
    };

    let hostProcess: ChildProcess;
    if (process.platform === "win32") {
      // 通过 host 启动可见交互控制台
      hostProcess = spawn(this.hostExecutable, ["run"], {
        cwd: tempCwd,
        windowsHide: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } else {
      hostProcess = spawn(this.agyExecutable, ["login"], {
        cwd: tempCwd,
        stdio: "inherit",
      });
    }

    let cliExitCode: number | null = null;
    let receivedCliExit = false;
    if (process.platform === "win32" && hostProcess.stdout) {
      const rl = createInterface({ input: hostProcess.stdout });
      rl.on("line", (line) => {
        try {
          const msg = JSON.parse(line.trim());
          if (msg.type === "exit") {
            cliExitCode = msg.code ?? 0;
            receivedCliExit = true;
          }
        } catch {}
      });
    }

    if (hostProcess.stdin) {
      hostProcess.stdin.write(JSON.stringify(spec) + "\n");
    }

    this.activeJobs.set(jobId, { child: hostProcess, cwd: tempCwd, jobId });

    const cancel = async () => {
      if (!this.activeJobs.has(jobId)) return;
      try {
        if (hostProcess.stdin && !hostProcess.stdin.destroyed) {
          hostProcess.stdin.end();
        }
        if (hostProcess.pid) {
          if (process.platform === "win32") {
            try {
              await execute("taskkill", ["/F", "/T", "/PID", String(hostProcess.pid)], { windowsHide: true });
            } catch {}
          } else {
            hostProcess.kill("SIGTERM");
          }
        }
      } catch {}
      // 检查 Job 是否停止
      if (process.platform === "win32") {
        await this.verifyJobStopped(jobId, 3000);
      }
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

        hostProcess.on("exit", async (code) => {
          if (timer) clearTimeout(timer);
          if (options.signal) {
            options.signal.removeEventListener("abort", onAbort);
          }
          this.activeJobs.delete(jobId);
          try {
            await rm(tempCwd, { recursive: true, force: true });
          } catch {}
          // Q02: 消费结构化 CLI exit，Host 管道中断或缺少终态不能按成功处理
          const finalCode = process.platform === "win32"
            ? (receivedCliExit ? cliExitCode : (code === 0 ? -1 : code))
            : code;
          if (finalCode === 0) {
            resolve({ success: true });
          } else {
            resolve({ success: false, error: `Login exited with code ${finalCode}` });
          }
        });

        hostProcess.on("error", async (err) => {
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
    // 校验 lease
    if (!options.lease || !options.lease.lease_id || !options.lease.operation_id) {
      throw new Error("invalid_auxiliary_lease");
    }

    const tempCwd = await mkdtemp(join(tmpdir(), "devflow-agy-aux-"));
    const jobId = options.lease.job_id || `aux_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const timeoutMs = options.timeoutMs ?? 30000;

    const spec = {
      id: jobId,
      executable: options.executable,
      args: options.args,
      cwd: tempCwd,
      env: {},
      timeout_ms: timeoutMs,
    };

    try {
      return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        let child: ChildProcess;
        let stdout = "";
        let stderr = "";
        let resolved = false;
        let cliExitCode: number | null = null;
        let receivedCliExit = false;
        let timer: NodeJS.Timeout | undefined;

        const cleanupAndFinish = async (res: { code: number | null; stdout: string; stderr: string }) => {
          if (resolved) return;
          resolved = true;
          if (timer) clearTimeout(timer);
          if (options.signal) {
            options.signal.removeEventListener("abort", onAbort);
          }
          if (process.platform === "win32") {
            // 验证 Job 停止 (R06: 使用稳定类型 ProcessStopUnconfirmedError)
            const stopped = await this.verifyJobStopped(jobId, 2000);
            if (!stopped) {
              reject(new ProcessStopUnconfirmedError(jobId, `auxiliary_job_not_stopped: Job ${jobId} failed to confirm stopped`));
              return;
            }
          }
          resolve(res);
        };

        const onAbort = async () => {
          if (resolved) return;
          if (timer) clearTimeout(timer);
          try {
            if (child && child.pid) {
              if (process.platform === "win32") {
                await execute("taskkill", ["/F", "/T", "/PID", String(child.pid)], { windowsHide: true }).catch(() => {});
              } else {
                child.kill("SIGKILL");
              }
            }
          } catch {}
          await cleanupAndFinish({ code: -1, stdout, stderr: `${stderr}\nCancelled by signal` });
        };

        if (options.signal) {
          if (options.signal.aborted) {
            void onAbort();
            return;
          }
          options.signal.addEventListener("abort", onAbort, { once: true });
        }

        timer = setTimeout(async () => {
          if (resolved) return;
          try {
            if (child && child.pid) {
              if (process.platform === "win32") {
                await execute("taskkill", ["/F", "/T", "/PID", String(child.pid)], { windowsHide: true }).catch(() => {});
              } else {
                child.kill("SIGKILL");
              }
            }
          } catch {}
          await cleanupAndFinish({ code: -1, stdout, stderr: `${stderr}\nTimeout after ${timeoutMs}ms` });
        }, timeoutMs);

        if (process.platform === "win32") {
          child = spawn(this.hostExecutable, ["run"], {
            cwd: tempCwd,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
          });

          // 向 host 发送 spec
          child.stdin?.write(JSON.stringify(spec) + "\n");
          const rl = createInterface({ input: child.stdout! });
          rl.on("line", (line) => {
            try {
              const msg = JSON.parse(line.trim());
              if (msg.type === "stdout" && msg.data) {
                stdout += Buffer.from(msg.data, "base64").toString("utf8");
              } else if (msg.type === "stderr" && msg.data) {
                stderr += Buffer.from(msg.data, "base64").toString("utf8");
              } else if (msg.type === "exit") {
                cliExitCode = msg.code ?? 0;
                receivedCliExit = true;
              } else if (msg.type === "error") {
                stderr += (msg.message || "host error") + "\n";
              }
            } catch {
              stdout += line + "\n";
            }
          });

          // R09: 必须在 close 事件（管道流排空后）结算，不能拿 Host 退出码 0 替代 CLI 退出码
          child.on("close", (hostCode) => {
            const finalCode = receivedCliExit
              ? cliExitCode
              : (hostCode === 0 ? -1 : hostCode);
            void cleanupAndFinish({ code: finalCode, stdout, stderr });
          });

          child.on("error", (err) => {
            if (timer) clearTimeout(timer);
            if (options.signal) options.signal.removeEventListener("abort", onAbort);
            reject(err);
          });
        } else {
          child = spawn(options.executable, options.args, {
            cwd: tempCwd,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          });

          child.stdout?.on("data", (chunk) => {
            stdout += chunk.toString();
          });
          child.stderr?.on("data", (chunk) => {
            stderr += chunk.toString();
          });

          child.on("close", (code) => {
            void cleanupAndFinish({ code, stdout, stderr });
          });

          child.on("error", (err) => {
            if (timer) clearTimeout(timer);
            if (options.signal) options.signal.removeEventListener("abort", onAbort);
            reject(err);
          });
        }
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
    const jobId = `interactive_login_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    const spec = {
      id: jobId,
      executable: input.executable,
      args: [...input.args],
      cwd: tempCwd,
      env: {},
      interactive: true,
      timeout_ms: 900000,
    };

    try {
      return await new Promise((resolvePromise) => {
        let child: ChildProcess;
        let cliExitCode: number | null = null;
        let receivedCliExit = false;

        if (process.platform === "win32") {
          // 通过 host 运行
          child = spawn(this.hostExecutable, ["run"], {
            cwd: tempCwd,
            windowsHide: false,
            stdio: ["pipe", "pipe", "pipe"],
          });
          child.stdin?.write(JSON.stringify(spec) + "\n");
          if (child.stdout) {
            const rl = createInterface({ input: child.stdout });
            rl.on("line", (line) => {
              try {
                const msg = JSON.parse(line.trim());
                if (msg.type === "exit") {
                  cliExitCode = msg.code ?? 0;
                  receivedCliExit = true;
                }
              } catch {}
            });
          }
        } else {
          child = spawn(input.executable, [...input.args], {
            cwd: tempCwd,
            stdio: "inherit",
          });
        }

        let isStopped = false;
        const confirmAndFinish = async (hostCode: number | null) => {
          if (isStopped) return;
          isStopped = true;
          let fullyStopped = false;
          if (process.platform === "win32") {
            fullyStopped = await this.verifyJobStopped(jobId, 5000);
          } else {
            fullyStopped = true;
          }
          // Q02: 消费结构化 CLI exit，Host 管道中断或缺少终态不能按成功处理
          const finalCode = process.platform === "win32"
            ? (receivedCliExit ? cliExitCode : (hostCode === 0 ? -1 : hostCode))
            : hostCode;
          resolvePromise({
            exit_code: finalCode,
            fully_stopped: fullyStopped,
          });
        };

        const onAbort = async () => {
          try {
            if (child.pid) {
              if (process.platform === "win32") {
                await execute("taskkill", ["/F", "/T", "/PID", String(child.pid)], { windowsHide: true }).catch(() => {});
              } else {
                child.kill("SIGTERM");
              }
            }
          } catch {}
          await confirmAndFinish(-1);
        };

        input.signal?.addEventListener("abort", onAbort, { once: true });
        child.once("close", async (code) => {
          input.signal?.removeEventListener("abort", onAbort);
          await confirmAndFinish(code);
        });
        child.once("error", async () => {
          input.signal?.removeEventListener("abort", onAbort);
          await confirmAndFinish(-1);
        });
      });
    } finally {
      try {
        await rm(tempCwd, { recursive: true, force: true });
      } catch {}
    }
  }
}
