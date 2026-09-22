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

    // Direct spawn - no host executable
    const child = spawn(this.agyExecutable, ["login"], {
      cwd: tempCwd,
      windowsHide: false, // Interactive login needs visible window
      stdio: "inherit",
    });

    this.activeJobs.set(jobId, { child, cwd: tempCwd, jobId });

    const cancel = async () => {
      if (!this.activeJobs.has(jobId)) return;
      try {
        if (child.pid) {
          if (process.platform === "win32") {
            try {
              child.kill();
            } catch {}
          } else {
            child.kill("SIGTERM");
          }
        }
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
            if (child && child.pid) {
              child.kill("SIGKILL");
            }
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

        // Direct spawn - no host executable
        const child = spawn(options.executable, options.args, {
          cwd: tempCwd,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        timer = setTimeout(() => {
          if (resolved) return;
          try {
            if (child && child.pid) {
              child.kill("SIGKILL");
            }
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
      return await new Promise((resolvePromise) => {
        // Direct spawn - no host executable
        const child = spawn(input.executable, [...input.args], {
          cwd: tempCwd,
          windowsHide: false, // Interactive needs visible window
          stdio: "inherit",
        });

        let isStopped = false;
        const confirmAndFinish = (code: number | null) => {
          if (isStopped) return;
          isStopped = true;
          resolvePromise({
            exit_code: code,
            fully_stopped: true,
          });
        };

        const onAbort = () => {
          try {
            if (child.pid) {
              child.kill("SIGTERM");
            }
          } catch {}
          confirmAndFinish(-1);
        };

        input.signal?.addEventListener("abort", onAbort, { once: true });
        child.once("close", (code) => {
          input.signal?.removeEventListener("abort", onAbort);
          confirmAndFinish(code);
        });
        child.once("error", () => {
          input.signal?.removeEventListener("abort", onAbort);
          confirmAndFinish(-1);
        });
      });
    } finally {
      try {
        await rm(tempCwd, { recursive: true, force: true });
      } catch {}
    }
  }
}
