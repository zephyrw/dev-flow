import type { AgyQuotaTrigger, QuotaWindow, WindowKind } from "../../contracts/src/agy-account.js";

export const AGY_MODEL_POOL_IDS = ["Gemini Models", "Claude and GPT models", "Gemini 4 Argon"];

export interface QuotaRank {
  account_id: string;
  weekly: number;
  five_hour?: number;
  last_used_at?: string;
  enrolled_at?: string;
}

/** The other pool is an admission constraint, never part of this score. */
export function quotaRankingWindows(
  pools: Array<{ pool_id: string; model_ids?: string[]; windows: QuotaWindow[] }>,
  trigger?: Pick<AgyQuotaTrigger, "pool_id">,
): { weekly: number; five_hour: number } {
  const exact = trigger && pools.find(pool => pool.pool_id === trigger.pool_id);
  const selected = trigger ? exact ? [exact] : pools.filter(pool =>
    pool.pool_id.toLowerCase() === "global" && pool.model_ids?.includes("*")) : pools;
  const fraction = (kind: WindowKind) => selected.length ? Math.min(...selected.map(pool =>
    pool.windows.find(window => window.kind === kind)?.remaining_fraction ??
      (pool.pool_id === "Gemini 4 Argon" && kind === "five_hour" ? 1 : 0))) : 0;
  return { weekly: fraction("weekly"), five_hour: fraction("five_hour") };
}

export function compareQuotaRanks(a: QuotaRank, b: QuotaRank, window: WindowKind = "weekly"): number {
  const first = window === "five_hour" ? (b.five_hour ?? 0) - (a.five_hour ?? 0) : b.weekly - a.weekly;
  const second = window === "five_hour" ? b.weekly - a.weekly : (b.five_hour ?? 0) - (a.five_hour ?? 0);
  const time = (value?: string) => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
  return first || second || time(a.last_used_at) - time(b.last_used_at) ||
    time(a.enrolled_at) - time(b.enrolled_at) || a.account_id.localeCompare(b.account_id);
}
