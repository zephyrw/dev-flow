import { homedir } from "node:os";
import { z } from "zod";
import type { ToolProfile } from "../../contracts/src/execution-spec.js";
import { CATALOG_READ_TIMEOUT_MS } from "../../contracts/src/model-catalog.js";
import type { CreditQuotaStatus, RunObservation } from "../../contracts/src/run-observation.js";
import { resolveAdapterExecutable } from "../../adapters/sdk/src/registry.js";
import { codeBuddyBillingRegion, codeBuddyScope, isCodeBuddyExternalModel } from "../../adapters/codebuddy/src/local-scope.js";
import { parseCodeBuddyCreditQuota } from "../../adapters/codebuddy/src/credit-quota.js";
import { queryCodeBuddyAcp } from "../../core/src/model-catalog-service.js";

type Reading = { status: CreditQuotaStatus; quota: NonNullable<RunObservation["quota"]> | null };
type QueryResult = Reading & { retryAfter?: string };
type CachedReading = {
  nextReadAt: number;
  rateLimitDelay: number;
  last?: Reading;
  pending?: Promise<Reading>;
};
const balanceEndpoint = "https://www.codebuddy.cn/billing/meter/get-user-resource-summary";
const accountResponse = z.object({
  result: z.object({
    userInfo: z.object({
      userId: z.string().min(1),
      accessToken: z.string().min(1),
      enterpriseId: z.union([z.string(), z.number()]).optional(),
    }).optional(),
  }),
});

function retryAt(header: string, now: number): number {
  if (!/^\d+$/.test(header)) return Date.parse(header);
  const delay = Number(header) * 1000;
  return Number.isSafeInteger(now + delay) ? now + delay : NaN;
}

class CodeBuddyQuotaReader {
  private scope?: string;
  private readonly cache = new Map<string, CachedReading>();

  async read(profile: ToolProfile, cwd: string): Promise<Reading> {
    if (isCodeBuddyExternalModel(cwd, profile.modelId)) return { status: "external", quota: null };
    const executable = resolveAdapterExecutable("codebuddy-code", profile.executableRef);
    if (!executable) return { status: "unsupported", quota: null };
    const scope = codeBuddyScope();
    if (this.scope !== scope) {
      this.scope = scope;
      this.cache.clear();
    }
    const prefixArgs = profile.options.prefixArgs ?? [];
    const key = JSON.stringify([executable, prefixArgs]);
    let entry = this.cache.get(key);
    if (!entry) {
      entry = { nextReadAt: 0, rateLimitDelay: 30_000 };
      this.cache.set(key, entry);
    }
    if (entry.pending) return entry.pending;
    if (entry.last && Date.now() < entry.nextReadAt) return entry.last;
    const previous = entry.last?.quota;
    const request = this.query(executable, prefixArgs)
      .catch((): QueryResult => ({ status: "unavailable", quota: null }))
      .then(({ status, quota, retryAfter }): Reading => {
        if (this.cache.get(key) !== entry || scope !== codeBuddyScope()) return { status: "unavailable", quota: null };
        const effective: Reading = status === "unavailable" && previous
          ? { status: "stale", quota: previous } : { status, quota };
        const now = Date.now();
        entry.last = effective;
        entry.nextReadAt = now + (status === "available" ? 60_000 : 30_000);
        if (retryAfter !== undefined) {
          const upstream = retryAt(retryAfter, now);
          entry.nextReadAt = Math.max(now + entry.rateLimitDelay, Number.isFinite(upstream) ? upstream : 0);
          entry.rateLimitDelay = Math.min(300_000, entry.rateLimitDelay * 2);
        } else {
          entry.rateLimitDelay = 30_000;
        }
        return effective;
      })
      .finally(() => { entry.pending = undefined; });
    entry.pending = request;
    return request;
  }

  private async query(executable: string, prefixArgs: string[]): Promise<QueryResult> {
    const reply = await queryCodeBuddyAcp({
      adapterId: "codebuddy-code", executable, cwd: homedir(),
      args: [...prefixArgs, "--acp", "--tools", "", "--strict-mcp-config", "--no-session-persistence",
        "--settings", '{"disableAllHooks":true}'],
      env: { CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: "1" },
      timeoutMs: CATALOG_READ_TIMEOUT_MS,
      outputLimit: 128 * 1024,
    }, "_codebuddy.ai/getUserInfo");
    if (!reply.stdout || reply.timedOut || reply.truncated) return { status: "unavailable", quota: null };
    const account = accountResponse.safeParse(JSON.parse(reply.stdout));
    if (!account.success) return { status: "unavailable", quota: null };
    const user = account.data.result.userInfo;
    if (!user) return { status: "auth-required", quota: null };
    if (!codeBuddyBillingRegion(user.userId) || (user.enterpriseId && String(user.enterpriseId) !== "0"))
      return { status: "unsupported", quota: null };
    const response = await fetch(balanceEndpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
      headers: {
        Authorization: "Bearer " + user.accessToken,
        "X-Account-Uid": user.userId,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    if (response.status === 401 || response.status === 403) return { status: "auth-required", quota: null };
    if (response.status === 429) return { status: "unavailable", quota: null, retryAfter: response.headers.get("Retry-After") ?? "" };
    if (!response.ok) return { status: "unavailable", quota: null };
    const credits = parseCodeBuddyCreditQuota(await response.json());
    if (!credits) return { status: "unavailable", quota: null };
    return { status: "available", quota: {
      source: "account_api", observed_at: new Date().toISOString(), buckets: [], credits,
    } };
  }
}

export const codeBuddyQuota = new CodeBuddyQuotaReader();
