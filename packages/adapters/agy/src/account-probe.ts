import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import type {
  AccountProbePort,
  AccountProbeResult,
} from "../../../agy-accounts/src/ports.js";
import { parseAgyUsageOutput, type ParsedQuotaResult } from "./quota-parser.js";

export interface VerifiedUsageAdapter {
  /** Installed by a code-reviewed official-output adapter, never supplied by HTTP. */
  executable_fingerprint: string;
  cli_version: string;
  parse(text: string): ParsedQuotaResult;
}
type ProbeOptions = {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  account_id?: string;
  credential_revision?: number;
  model_id?: string;
};
export class AgyAccountProbe implements AccountProbePort {
  private inFlight?: { key: string; promise: Promise<AccountProbeResult> };
  private modelAccessCache = new Map<string, number>();
  constructor(
    private readonly cliPath?: string,
    private readonly adapter?: VerifiedUsageAdapter,
  ) {}
  private async fingerprint(): Promise<string> {
    const executable = this.cliPath ?? process.env.AGY_CLI_PATH;
    if (!executable) return "";
    try {
      return createHash("sha256")
        .update(await readFile(resolve(executable)))
        .digest("hex");
    } catch {
      return "";
    }
  }
  private unknown(fingerprint: string): AccountProbeResult {
    return {
      cli_version: this.adapter?.cli_version ?? "unknown",
      windows: parseAgyUsageOutput("").windows,
      pools: [],
      executable_fingerprint: fingerprint,
      capability_verified: false,
      raw_output: "",
    };
  }
  async probeUsage(options: ProbeOptions = {}): Promise<AccountProbeResult> {
    options.signal?.throwIfAborted();
    const fingerprint = await this.fingerprint();
    if (
      !fingerprint ||
      !this.adapter ||
      this.adapter.executable_fingerprint !== fingerprint
    )
      return this.unknown(fingerprint);
    const key = JSON.stringify([
      options.account_id,
      options.credential_revision,
      fingerprint,
    ]);
    // Different identity requests must not share a result or run concurrently.
    if (this.inFlight) {
      if (this.inFlight.key !== key) throw new Error("probe_identity_busy");
      if (options.signal?.aborted) options.signal.throwIfAborted();
      return this.inFlight.promise;
    }
    const promise = this.execute(
      ["-p", "/usage", "--output-format", "text", "--print-timeout", "30s"],
      options,
    )
      .then((result) => {
        if (result.code !== 0) throw new Error("official_usage_probe_failed");
        const parsed = this.adapter!.parse(result.stdout);
        const pools = parsed.pools.map((pool) => ({
          pool_id: pool.pool_id,
          model_ids: pool.models,
          windows: pool.windows,
        }));
        const valid =
          !!parsed.email &&
          pools.length > 0 &&
          pools.every(
            (pool) =>
              pool.model_ids.length > 0 &&
              ["weekly", "five_hour"].every((kind) => {
                const windows = pool.windows.filter(
                  (window) => window.kind === kind,
                );
                const window = windows[0];
                return (
                  windows.length === 1 &&
                  window?.status === "observed" &&
                  typeof window.remaining_fraction === "number" &&
                  window.remaining_fraction >= 0 &&
                  window.remaining_fraction <= 1 &&
                  !!window.reset_at &&
                  Number.isFinite(Date.parse(window.reset_at))
                );
              }),
          );
        return {
          email: parsed.email,
          plan_tier: parsed.plan_tier,
          cli_version: this.adapter!.cli_version,
          windows: parsed.windows,
          pools,
          executable_fingerprint: fingerprint,
          capability_verified: valid,
          raw_output: "",
        };
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    this.inFlight = { key, promise };
    return promise;
  }
  async probeModelAccess(
    modelId: string,
    options: ProbeOptions = {},
  ): Promise<boolean> {
    const fingerprint = await this.fingerprint();
    if (
      !this.adapter ||
      this.adapter.executable_fingerprint !== fingerprint ||
      !options.account_id ||
      options.credential_revision === undefined ||
      !modelId
    )
      return false;
    options.signal?.throwIfAborted();
    const key = JSON.stringify([
      options.account_id,
      options.credential_revision,
      modelId,
      fingerprint,
    ]);
    if (Date.now() - (this.modelAccessCache.get(key) ?? 0) < 86400000)
      return true;
    if (this.inFlight) throw new Error("probe_identity_busy");
    const result = await this.execute(
      [
        "--model",
        modelId,
        "--output-format",
        "stream-json",
        "--print-timeout",
        "10s",
        "-p",
        "Reply only OK.",
      ],
      { ...options, timeoutMs: options.timeoutMs ?? 15000 },
    );
    if (result.code !== 0) return false;
    const events = result.stdout.split(/\r?\n/).flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
    const success =
      events.some(
        (event) => event.type === "result" && event.is_error === false,
      ) &&
      !events.some(
        (event) => event.type === "error" || event.is_error === true,
      );
    if (success) this.modelAccessCache.set(key, Date.now());
    return success;
  }
  private async execute(
    args: string[],
    options: ProbeOptions,
  ): Promise<{ code: number | null; stdout: string }> {
    const executable = this.cliPath ?? process.env.AGY_CLI_PATH;
    if (!executable) throw new Error("agy_cli_not_configured");
    const cwd = await mkdtemp(join(tmpdir(), "devflow-agy-probe-"));
    try {
      options.signal?.throwIfAborted();
      return await new Promise((resolvePromise, reject) => {
        const child = spawn(resolve(executable), args, {
          cwd,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const decoder = new StringDecoder("utf8");
        let stdout = "";
        let failure: Error | undefined;
        const stop = (reason: string) => {
          failure ??= new Error(reason);
          child.kill();
        };
        const abort = () => stop("probe_cancelled");
        const timer = setTimeout(
          () => stop("probe_timeout"),
          options.timeoutMs ?? 35000,
        );
        options.signal?.addEventListener("abort", abort, { once: true });
        child.stdout.on("data", (data: Buffer) => {
          stdout += decoder.write(data);
          if (stdout.length > 1024 * 1024) stop("probe_output_limit");
        });
        child.stderr.resume();
        child.once("error", () => {
          failure ??= new Error("probe_spawn_failed");
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", abort);
          if (failure) reject(failure);
          else resolvePromise({ code, stdout: stdout + decoder.end() });
        });
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
}
