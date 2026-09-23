import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ProcessManager, type ManagedProcess } from "./manager.js";
import type { OwnedLoginJobPort } from "../../agy-accounts/src/ports.js";
import type { InteractiveLoginJobPort } from "../../agy-accounts/src/login.js";
import type { AgyAuxiliaryLease } from "../../contracts/src/agy-account.js";

export class ProcessStopUnconfirmedError extends Error {
  readonly code = "PROCESS_STOP_UNCONFIRMED";
  constructor(readonly jobId: string) {
    super(`Process stop unconfirmed: ${jobId}`);
    this.name = "ProcessStopUnconfirmedError";
  }
}
export interface AuxJobOptions {
  executable: string;
  args: string[];
  lease: AgyAuxiliaryLease;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export class AgyAccountJobRunner
  implements OwnedLoginJobPort, InteractiveLoginJobPort
{
  constructor(
    private agyExecutable = "agy",
    private processes = new ProcessManager(),
  ) {}
  private async create(
    executable: string,
    args: string[],
    interactive: boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const cwd = await mkdtemp(
      join(tmpdir(), interactive ? "devflow-agy-login-" : "devflow-agy-aux-"),
    );
    let process: ManagedProcess;
    try {
      signal?.throwIfAborted();
      process = this.processes.start({
        id: `agy_${randomUUID()}`,
        executable,
        args,
        cwd,
        env: {},
        timeout_ms: timeoutMs,
        interactive,
      });
    } catch (error) {
      await rm(cwd, { recursive: true, force: true });
      throw error;
    }
    const abort = () => {
      void process.stop().catch(() => {});
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const completion = process.completion.finally(async () => {
      signal?.removeEventListener("abort", abort);
      if (
        (await this.processes.observe(process.id)).state === "confirmed_exited"
      )
        await rm(cwd, { recursive: true, force: true });
    });
    void completion.catch(() => {});
    return { process, completion };
  }
  async startLoginJob(options: {
    realmId: string;
    operationId: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }) {
    const { process, completion } = await this.create(
      this.agyExecutable,
      ["login"],
      true,
      options.timeoutMs ?? 900000,
      options.signal,
    );
    const result = completion.then((value) => ({
      success:
        value.code === 0 &&
        !value.termination_reason &&
        !options.signal?.aborted,
      ...(value.code !== 0 ||
      value.termination_reason ||
      options.signal?.aborted
        ? { error: value.termination_reason ?? "login_failed" }
        : {}),
    }));
    void result.catch(() => {});
    return {
      jobId: process.id,
      waitForCompletion: () => result,
      cancel: async () => {
        const stopped = await this.processes.stop(process.id);
        if (
          stopped.status !== "confirmed_exited" &&
          stopped.status !== "confirmed_not_started"
        )
          throw new ProcessStopUnconfirmedError(process.id);
      },
    };
  }
  async runAuxiliaryProbe(
    options: AuxJobOptions,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    if (!options.lease?.lease_id || !options.lease.operation_id)
      throw new Error("invalid_auxiliary_lease");
    const { process, completion } = await this.create(
      options.executable,
      options.args,
      false,
      options.timeoutMs ?? 30000,
      options.signal,
    );
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let size = 0,
      overflow = false;
    const collect = (chunks: Buffer[]) => (value: Buffer) => {
      size += value.length;
      if (size > 1024 * 1024) {
        overflow = true;
        void process.stop().catch(() => {});
        return;
      }
      chunks.push(value);
    };
    process.on("stdout", collect(stdout));
    process.on("stderr", collect(stderr));
    const result = await completion;
    if (overflow) throw new Error("AGY_PROBE_OUTPUT_LIMIT");
    return {
      code:
        options.signal?.aborted || result.termination_reason ? -1 : result.code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    };
  }
  async start(input: {
    executable: string;
    args: readonly string[];
    signal: AbortSignal;
  }): Promise<{ exit_code: number | null; fully_stopped: boolean }> {
    const { process, completion } = await this.create(
      input.executable,
      [...input.args],
      true,
      900000,
      input.signal,
    );
    try {
      const result = await completion;
      return {
        exit_code:
          input.signal.aborted || result.termination_reason ? -1 : result.code,
        fully_stopped: true,
      };
    } catch {
      return {
        exit_code: -1,
        fully_stopped:
          (await this.processes.observe(process.id)).state ===
          "confirmed_exited",
      };
    }
  }
  close() {
    return this.processes.close();
  }
}
