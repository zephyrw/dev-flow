import { hasDualQuotaWindows } from "../../../agy-accounts/src/quota.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  AccountProbePort,
  AccountProbeResult,
} from "../../../agy-accounts/src/ports.js";
import { parseAgyUsageOutput, type ParsedQuotaResult } from "./quota-parser.js";
import { resolveAgyExecutable } from "./executable-resolver.js";

export interface VerifiedUsageAdapter {
  /** Installed by a code-reviewed official-output adapter, never supplied by HTTP. */
  executable_fingerprint: string;
  cli_version: string;
  parse(text: string): ParsedQuotaResult;
}

export function createVerifiedUsageAdapter(
  executableFingerprint: string,
  cliVersion: string = "1.2.7",
): VerifiedUsageAdapter {
  return {
    executable_fingerprint: executableFingerprint,
    cli_version: cliVersion,
    parse: (text: string) => parseAgyUsageOutput(text, { cliVersion }),
  };
}

export interface AuxiliaryProbeRunner {
  runAuxiliaryProbe(options: {
    executable: string;
    args: string[];
    lease: any;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<{ code: number | null; stdout: string; stderr: string }>;
}

export function parseModelAccessOutput(
  stdout: string,
  expected: { modelId: string; accountId?: string; cwd?: string },
): { success: boolean; reason?: string } {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { success: false, reason: "empty_output" };

  const events: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      return { success: false, reason: "malformed_json_event" };
    }
  }

  // 检查是否有错误事件
  const hasError = events.some(
    (event) =>
      event.event === "error" ||
      event.type === "error" ||
      (event.result as any)?.status === "ERROR" ||
      event.is_error === true,
  );
  if (hasError) return { success: false, reason: "error_event_present" };

  // 必须有本次匹配的初始化事件
  const initEvent = events.find(
    (e) =>
      e.event === "init" ||
      e.type === "init" ||
      e.event === "session_start" ||
      e.event === "session_init" ||
      e.type === "turn_start" ||
      (e.model && typeof e.model === "string") ||
      (e.session && typeof (e.session as any).model === "string"),
  );
  if (!initEvent) {
    return { success: false, reason: "missing_init_event" };
  }

  const eventModel = (initEvent.model as string) ?? (initEvent.session as any)?.model;
  if (!eventModel || typeof eventModel !== "string") {
    return { success: false, reason: "missing_model_evidence" };
  }
  const isMatch =
    eventModel === expected.modelId;
  if (!isMatch) {
    return { success: false, reason: "model_mismatch" };
  }

  // 必须有明确成功终态
  const hasSuccessResult = events.some(
    (event) =>
      (event.event === "result" && (event.result as any)?.status === "SUCCESS") ||
      (event.type === "result" && ((event as any).status === "success" || event.is_error === false)),
  );
  if (!hasSuccessResult) {
    return { success: false, reason: "missing_success_result" };
  }

  return { success: true };
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
  private activeAdapter?: VerifiedUsageAdapter;
  private runner?: AuxiliaryProbeRunner;

  constructor(
    private readonly cliPath?: string,
    adapter?: VerifiedUsageAdapter,
    runner?: AuxiliaryProbeRunner,
  ) {
    this.activeAdapter = adapter;
    this.runner = runner;
  }
  private async fingerprint(): Promise<string> {
    const res = resolveAgyExecutable(this.cliPath);
    if (res.fingerprint) return res.fingerprint;
    const executable = res.resolvedPath ?? this.cliPath ?? process.env.AGY_CLI_PATH;
    if (!executable) return "";
    try {
      return createHash("sha256")
        .update(await readFile(resolve(executable)))
        .digest("hex");
    } catch {
      return "";
    }
  }
  private getAdapter(fingerprint: string): VerifiedUsageAdapter | undefined {
    if (
      this.activeAdapter &&
      this.activeAdapter.executable_fingerprint === fingerprint
    ) {
      return this.activeAdapter;
    }
    return undefined;
  }
  private unknown(fingerprint: string): AccountProbeResult {
    return {
      cli_version: this.activeAdapter?.cli_version ?? "unknown",
      windows: parseAgyUsageOutput("").windows,
      pools: [],
      executable_fingerprint: fingerprint,
      capability_verified: false,
      raw_output: "",
    };
  }

  async probeIdentity(options: ProbeOptions = {}): Promise<{
    email: string;
    subject?: string;
    cli_version: string;
    raw_output: string;
  }> {
    options.signal?.throwIfAborted();
    const fingerprint = await this.fingerprint();
    const adapter = this.getAdapter(fingerprint);
    if (!fingerprint || !adapter) {
      throw new Error("identity_unverified: cli_adapter_or_fingerprint_unverified");
    }
    const result = await this.execute(
      ["-p", "/usage", "--output-format", "text", "--print-timeout", "15s"],
      options,
    );
    if (result.code !== 0) {
      throw new Error(`identity_unverified: official cli exited with code ${result.code}`);
    }
    const parsed = adapter.parse(result.stdout);
    const email = parsed.email;
    if (!email) {
      throw new Error("identity_unverified: unable to extract email from official cli output");
    }
    return {
      email,
      cli_version: parsed.cli_version,
      raw_output: result.stdout,
    };
  }

  async probeUsage(options: ProbeOptions = {}): Promise<AccountProbeResult> {
    options.signal?.throwIfAborted();
    const fingerprint = await this.fingerprint();
    const adapter = this.getAdapter(fingerprint);
    if (!fingerprint || !adapter) return this.unknown(fingerprint);
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
    const timeoutMs = Math.max(options.timeoutMs ?? 0, 35000);
    const promise = this.execute(
      ["-p", "/usage", "--output-format", "text", "--print-timeout", "30s"],
      { ...options, timeoutMs },
    )
      .then((result) => {
        if (result.code !== 0) throw new Error("official_usage_probe_failed");
        const parsed = adapter.parse(result.stdout);
        const pools = parsed.pools.length > 0
          ? parsed.pools.map((pool) => ({
              pool_id: pool.pool_id,
              model_ids: pool.models,
              windows: pool.windows,
            }))
          : [
              {
                pool_id: "global",
                model_ids: ["*"],
                windows: parsed.windows,
              },
            ];
        const valid = pools.length > 0 && pools.every((pool) =>
          pool.model_ids.length > 0 && hasDualQuotaWindows(pool.windows));
        return {
          email: parsed.email,
          plan_tier: parsed.plan_tier,
          cli_version: adapter.cli_version,
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
    const adapter = this.getAdapter(fingerprint);
    if (
      !adapter ||
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
    const parsed = parseModelAccessOutput(result.stdout, {
      modelId,
      accountId: options.account_id,
      cwd: options.cwd,
    });
    return parsed.success;
  }
  private async execute(
    args: string[],
    options: ProbeOptions,
  ): Promise<{ code: number | null; stdout: string }> {
    const resPath = resolveAgyExecutable(this.cliPath);
    const executable = resPath.resolvedPath ?? this.cliPath ?? process.env.AGY_CLI_PATH;
    if (!executable) throw new Error("agy_cli_not_configured");

    if (!this.runner) {
      throw new Error("auxiliary_runner_required: all auxiliary probe executions must be managed by Process Host runner");
    }

    let cliTimeoutMs = 0;
    const printTimeoutIdx = args.indexOf("--print-timeout");
    if (printTimeoutIdx >= 0 && args[printTimeoutIdx + 1]) {
      const match = /^(\d+)(s|m)?$/i.exec(args[printTimeoutIdx + 1]!);
      if (match) {
        const num = Number(match[1]);
        const unit = match[2]?.toLowerCase();
        cliTimeoutMs = unit === "m" ? num * 60000 : num * 1000;
      }
    }
    const hostTimeoutMs = Math.max(
      options.timeoutMs ?? (cliTimeoutMs > 0 ? cliTimeoutMs + 5000 : 35000),
      cliTimeoutMs > 0 ? cliTimeoutMs + 5000 : 35000,
    );

    const lease = {
      lease_id: `aux_${Date.now()}`,
      operation_id: `probe_${Date.now()}`,
      realm_id: "default-agy-realm",
      job_id: `probe_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      created_at: Date.now(),
      expires_at: Date.now() + hostTimeoutMs,
    };
    const res = await this.runner.runAuxiliaryProbe({
      executable: resolve(executable),
      args,
      lease,
      timeoutMs: hostTimeoutMs,
      signal: options.signal,
    });
    return { code: res.code, stdout: res.stdout };
  }
}
