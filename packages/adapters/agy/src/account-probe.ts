import { hasDualQuotaWindows, hasRequiredQuotaWindows } from "../../../agy-accounts/src/quota.js";
import { resolve } from "node:path";
import type {
  AccountProbePort,
  AccountProbeResult,
} from "../../../agy-accounts/src/ports.js";
import { parseAgyUsageOutput, type ParsedQuotaResult } from "./quota-parser.js";
import { resolveFingerprintedAgyExecutable, assertAgyExecutableUnchanged, type AgyExecutableResolution } from "./executable-resolver.js";
import { parseAgyModelCatalog } from "./model-configuration.js";
import { hasAgyPrintTimeout, hasConflictingAgyFailureDiagnostic, isAgyIndividualQuotaError } from "./failure-fact.js";

export interface VerifiedUsageAdapter {
  /** Installed by a code-reviewed official-output adapter, never supplied by HTTP. */
  executable_fingerprint: string;
  cli_version: string;
  parse(text: string): ParsedQuotaResult;
}

export function createVerifiedUsageAdapter(
  executableFingerprint: string,
  cliVersion: string = "unknown",
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
  }): Promise<{ code: number | null; stdout: string; stderr: string; termination_reason?: string }>;
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

  const eventModel = (initEvent.init as any)?.model ??
    (initEvent.model as string) ?? (initEvent.session as any)?.model;
  if (!eventModel || typeof eventModel !== "string") {
    return { success: false, reason: "missing_model_evidence" };
  }
  const isMatch =
    eventModel === expected.modelId;
  if (!isMatch) {
    return { success: false, reason: "model_mismatch" };
  }

  // This probe creates a fresh invocation, never resumes a conversation. Keep
  // the provider's explicit quota cause after checking the requested model.
  const last = events.at(-1);
  if ((last?.event === "result" || last?.type === "result") &&
      (last?.result as any)?.status === "ERROR" &&
      typeof (last.result as any)?.error === "string" &&
      /\b(?:timeout|timed out|deadline exceeded)\b/i.test((last.result as any).error))
    return { success: false, reason: "agy_model_probe_timeout" };
  if ((last?.event === "result" || last?.type === "result") &&
      (last?.result as any)?.status === "ERROR" &&
      isAgyIndividualQuotaError((last?.result as any)?.error) &&
      !((last?.result as any)?.denied_actions?.length))
    return { success: false, reason: "agy_model_quota_exhausted" };
  const hasError = events.some(event => event.event === "error" || event.type === "error" ||
    (event.result as any)?.status === "ERROR" || event.is_error === true ||
    (event.result as any)?.denied_actions?.length || (event as any).denied_actions?.length);
  if (hasError) return { success: false, reason: "error_event_present" };

  // 必须有明确成功终态
  const hasSuccessResult = last && (
    (last.event === "result" && (last.result as any)?.status === "SUCCESS") ||
    (last.type === "result" && ((last as any).status === "success" || last.is_error === false))
  );
  if (!last || !hasSuccessResult) {
    return { success: false, reason: "missing_success_result" };
  }
  const response = (last.result as any)?.response ?? last.response;
  if (typeof response !== "string" || !response.trim())
    return { success: false, reason: "agy_model_probe_timeout" };

  return { success: true };
}

type ProbeOptions = {
  force?: boolean;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  account_id?: string;
  credential_revision?: number;
  model_id?: string;
};
type ModelAccessFlight = {
  key: string;
  controller: AbortController;
  promise: Promise<boolean>;
  waiters: number;
  settled: boolean;
};
export class AgyAccountProbe implements AccountProbePort {
  private inFlight?: { key: string; promise: Promise<AccountProbeResult> };
  private identityInFlight = false;
  private modelAccessFlight?: ModelAccessFlight;
  private modelAccessCache = new Map<string, number>();
  private activeAdapter?: VerifiedUsageAdapter;
  private adapterRefresh?: Promise<void>;
  private runner?: AuxiliaryProbeRunner;

  constructor(
    private readonly cliPath?: string,
    adapter?: VerifiedUsageAdapter,
    runner?: AuxiliaryProbeRunner,
  ) {
    this.activeAdapter = adapter;
    this.runner = runner;
  }
  private async getAdapter(fingerprint: string, executable: AgyExecutableResolution): Promise<VerifiedUsageAdapter | undefined> {
    if (!fingerprint || !this.activeAdapter) return undefined;
    if (this.activeAdapter.executable_fingerprint === fingerprint) return this.activeAdapter;
    // A CLI update invalidates cached evidence, not permission to query the CLI.
    // Share metadata refresh; actual identity, quota and model checks still run.
    if (this.adapterRefresh) {
      await this.adapterRefresh;
      return this.getAdapter(fingerprint, executable);
    }
    const refresh = (async () => {
      let cliVersion = "unknown";
      try {
        const result = await this.execute(["--version"], { timeoutMs: 3000 }, executable);
        if (result.code === 0) cliVersion = /\b(\d+\.\d+\.\d+)\b/.exec(result.stdout)?.[1] ?? "unknown";
      } catch (error) {
        if ((error as { code?: string })?.code === "PROCESS_STOP_UNCONFIRMED") throw error;
        // Version metadata is optional; let the real probe report availability.
      }
      this.modelAccessCache.clear();
      this.activeAdapter = createVerifiedUsageAdapter(fingerprint, cliVersion);
    })();
    this.adapterRefresh = refresh;
    try {
      await refresh;
      return this.activeAdapter;
    } finally {
      if (this.adapterRefresh === refresh) this.adapterRefresh = undefined;
    }
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
    const executable = await resolveFingerprintedAgyExecutable(this.cliPath);
    const fingerprint = executable.fingerprint ?? "";
    const adapter = await this.getAdapter(fingerprint, executable);
    if (!fingerprint || !adapter) {
      throw new Error("identity_unverified: cli_adapter_or_fingerprint_unverified");
    }
    if (this.identityInFlight || this.inFlight || this.modelAccessFlight)
      throw new Error("probe_identity_busy");
    this.identityInFlight = true;
    try {
      const result = await this.execute(
        ["-p", "/usage", "--output-format", "text", "--print-timeout", "15s"],
        options,
        executable,
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
    } finally {
      this.identityInFlight = false;
    }
  }

  async probeUsage(options: ProbeOptions = {}): Promise<AccountProbeResult> {
    options.signal?.throwIfAborted();
    const started = Date.now();
    const executable = await resolveFingerprintedAgyExecutable(this.cliPath);
    const fingerprint = executable.fingerprint ?? "";
    const adapter = await this.getAdapter(fingerprint, executable);
    if (!fingerprint || !adapter) return this.unknown(fingerprint);
    if (this.identityInFlight || this.modelAccessFlight)
      throw new Error("probe_identity_busy");
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
    const budget = Math.max(1000, options.timeoutMs ?? 35000);
    const timeoutMs = Math.min(budget, budget + 5000 - (Date.now() - started));
    if (timeoutMs < 1000) throw Object.assign(new Error("agy_usage_prepare_timeout"), { code: "agy_usage_prepare_timeout" });
    const prepared = Date.now();
    const promise = this.execute(
      ["-p", "/usage", "--output-format", "text", "--print-timeout", `${Math.max(1, Math.floor((timeoutMs - 1000) / 1000))}s`],
      { ...options, timeoutMs },
      executable,
    )
      .then((result) => {
        const received = Date.now();
        if (result.code !== 0) throw new Error("official_usage_probe_failed");
        const parsed = adapter.parse(result.stdout);
        const pools = parsed.pools.length > 0
          ? parsed.pools.map((pool) => {
              const poolValid = pool.models.length > 0 && hasRequiredQuotaWindows(pool.pool_id, pool.windows);
              return {
                pool_id: pool.pool_id,
                model_ids: pool.models,
                windows: pool.windows,
                capability_verified: poolValid,
              };
            })
          : [
              {
                pool_id: "global",
                model_ids: ["*"],
                windows: parsed.windows,
                capability_verified: hasDualQuotaWindows(parsed.windows),
              },
            ];
        const valid = pools.length > 0 && pools.some((pool) => pool.capability_verified);
        return {
          email: parsed.email,
          plan_tier: parsed.plan_tier,
          cli_version: adapter.cli_version,
          windows: parsed.windows,
          pools,
          executable_fingerprint: fingerprint,
          capability_verified: valid,
          raw_output: "",
          timings: { prepare_ms: prepared - started, cli_ms: received - prepared, parse_ms: Date.now() - received },
        };
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    this.inFlight = { key, promise };
    return promise;
  }
  async probeModels(options: ProbeOptions = {}) {
    options.signal?.throwIfAborted();
    const executable = await resolveFingerprintedAgyExecutable(this.cliPath);
    const fingerprint = executable.fingerprint ?? "";
    const adapter = await this.getAdapter(fingerprint, executable);
    if (!fingerprint || !adapter) throw new Error("model_catalog_unverified");
    const result = await this.execute(["models"], { ...options, timeoutMs: options.timeoutMs ?? 15000 }, executable);
    if (result.code !== 0) throw new Error("model_catalog_unavailable");
    const catalog = parseAgyModelCatalog({ stdout: result.stdout, cliVersion: adapter.cli_version });
    if (catalog.status !== "fresh" || !catalog.entries.length) throw new Error("model_catalog_unavailable");
    return { native_ids: catalog.entries.filter(entry => entry.availability === "listed" && !entry.hidden).map(entry => entry.nativeId),
      observed_at: new Date().toISOString(), executable_fingerprint: fingerprint, cli_version: adapter.cli_version };
  }
  async probeModelAccess(
    modelId: string,
    options: ProbeOptions = {},
  ): Promise<boolean> {
    options.signal?.throwIfAborted();
    const executable = await resolveFingerprintedAgyExecutable(this.cliPath);
    const fingerprint = executable.fingerprint ?? "";
    const adapter = await this.getAdapter(fingerprint, executable);
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
    if (options.force) this.modelAccessCache.delete(key);
    const lastSuccess = this.modelAccessCache.get(key);
    if (!options.force && lastSuccess !== undefined && Date.now() - lastSuccess < 86400000)
      return true;
    if (this.inFlight || this.identityInFlight) throw new Error("probe_identity_busy");
    if (this.modelAccessFlight) {
      if (this.modelAccessFlight.key !== key || this.modelAccessFlight.controller.signal.aborted)
        throw new Error("probe_identity_busy");
      return this.waitForModelAccess(this.modelAccessFlight, options.signal);
    }
    const flight: ModelAccessFlight = {
      key,
      controller: new AbortController(),
      promise: Promise.resolve(false),
      waiters: 0,
      settled: false,
    };
    this.modelAccessFlight = flight;
    flight.promise = Promise.resolve().then(async () => {
      flight.controller.signal.throwIfAborted();
      const result = await this.execute(
        [
          "--model",
          modelId,
          "--output-format",
          "stream-json",
          "--print-timeout",
          "120s",
          "-p",
          "Reply only OK.",
        ],
        // The native print timeout starts after CLI initialization. Account/model
        // discovery and the first inference can both be slow after a restart.
        { ...options, timeoutMs: Math.max(options.timeoutMs ?? 0, 180000), signal: flight.controller.signal },
        executable,
      );
      flight.controller.signal.throwIfAborted();
      if (result.termination_reason === "timeout" || hasAgyPrintTimeout(result.stderr))
        throw Object.assign(new Error("agy_model_probe_timeout"), { code: "agy_model_probe_timeout" });
      const parsed = parseModelAccessOutput(result.stdout, {
        modelId,
        accountId: options.account_id,
        cwd: options.cwd,
      });
      if (parsed.reason === "agy_model_probe_timeout")
        throw Object.assign(new Error("agy_model_probe_timeout"), { code: "agy_model_probe_timeout" });
      if (result.code === 3 && parsed.reason === "agy_model_quota_exhausted" &&
          !hasConflictingAgyFailureDiagnostic(result.stderr))
        throw Object.assign(new Error("agy_model_quota_exhausted"), {
          code: "agy_model_quota_exhausted", account_id: options.account_id, model_id: modelId,
        });
      if (result.code !== 0) return false;
      if (parsed.success) this.modelAccessCache.set(key, Date.now());
      return parsed.success;
    }).finally(() => {
      flight.settled = true;
      if (this.modelAccessFlight === flight) this.modelAccessFlight = undefined;
    });
    return this.waitForModelAccess(flight, options.signal);
  }

  private waitForModelAccess(flight: ModelAccessFlight, signal?: AbortSignal): Promise<boolean> {
    // Each caller owns its wait; stop the shared process only after all callers leave.
    flight.waiters++;
    return new Promise<boolean>((resolve, reject) => {
      let finished = false;
      const release = () => {
        if (finished) return false;
        finished = true;
        signal?.removeEventListener("abort", abort);
        flight.waiters--;
        return true;
      };
      const abort = () => {
        if (!release()) return;
        reject(signal?.reason ?? new DOMException("Probe cancelled", "AbortError"));
        if (flight.waiters === 0 && !flight.settled) flight.controller.abort();
      };
      flight.promise.then(
        (value) => { if (release()) resolve(value); },
        (error) => { if (release()) reject(error); },
      );
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  private async execute(
    args: string[],
    options: ProbeOptions,
    executable: AgyExecutableResolution,
  ): Promise<{ code: number | null; stdout: string; stderr: string; termination_reason?: string }> {
    options.signal?.throwIfAborted();
    await assertAgyExecutableUnchanged(executable);
    options.signal?.throwIfAborted();

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
    const hostTimeoutMs = Math.max(1000, options.timeoutMs ?? (cliTimeoutMs > 0 ? cliTimeoutMs + 5000 : 35000));

    const lease = {
      lease_id: `aux_${Date.now()}`,
      operation_id: `probe_${Date.now()}`,
      realm_id: "default-agy-realm",
      job_id: `probe_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      created_at: Date.now(),
      expires_at: Date.now() + hostTimeoutMs,
    };
    const res = await this.runner.runAuxiliaryProbe({
      executable: resolve(executable.resolvedPath!),
      args,
      lease,
      timeoutMs: hostTimeoutMs,
      signal: options.signal,
    });
    return { code: res.code, stdout: res.stdout, stderr: res.stderr,
      ...(res.termination_reason ? { termination_reason: res.termination_reason } : {}) };
  }
}
