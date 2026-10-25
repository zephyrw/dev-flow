import type { AgyAccount, AgyQuotaSnapshot } from "../../contracts/src/agy-account.js";
import { evaluateAccountForDemand, type SelectionPolicy } from "./selector.js";
import { quotaPoolCoversModel, hasRequiredQuotaWindows } from "./quota.js";
import { compareQuotaRanks } from "./quota-ranking.js";

/** Rank the best usable model pool, without changing a workflow's chosen model. */
export function rankModelFallbackAccounts(accounts: AgyAccount[], snapshots: AgyQuotaSnapshot[], now: number, policy: SelectionPolicy) {
  return accounts.flatMap(account => {
    if (["disabled", "incompatible", "reauth_required"].includes(account.state) ||
        policy.allowed_account_ids && !policy.allowed_account_ids.includes(account.id)) return [];
    const base = evaluateAccountForDemand({ account, snapshots: [], evaluationTime: now,
      policy: { ...policy, required_pool_ids: ["pending"], required_model_ids: [], active_category: undefined } });
    if (base.excluded_reasons.some(reason => reason !== "missing_required_quota_pools")) return [];
    const latest = new Map<string, AgyQuotaSnapshot>();
    for (const snap of snapshots.filter(s => s.account_id === account.id).sort((a, b) => b.observed_at.localeCompare(a.observed_at)))
      if (!latest.has(snap.pool_id)) latest.set(snap.pool_id, snap);
    const scores = [...latest.values()].flatMap(pool => {
      const model = account.models?.native_ids.find(id => quotaPoolCoversModel(pool, id));
      if (account.models && !model) return [];
      const result = evaluateAccountForDemand({ account, snapshots: [...latest.values()], evaluationTime: now,
        policy: { ...policy, quota_trigger: undefined, required_pool_ids: [pool.pool_id], required_model_ids: model ? [model] : [], active_category: undefined } });
      const hard = result.excluded_reasons.filter(reason => !["quota_exhausted_not_reset", "quota_exhausted_unknown_window",
        "five_hour_exhausted_unknown_reset", "weekly_exhausted_unknown_reset", "missing_required_quota_pools"].includes(reason));
      if (hard.length) return [];
      const usable = result.eligible_for_candidate || result.eligible_for_permit;
      return [{ account_id: account.id, weekly: usable ? result.projected_weekly : 0,
        five_hour: result.min_five_hour ?? (hasRequiredQuotaWindows(pool.pool_id, pool.windows) ? 1 : 0),
        has_observation: pool.capability_verified !== false && hasRequiredQuotaWindows(pool.pool_id, pool.windows) }];
    }).sort(compareQuotaRanks);
    const best = scores[0];
    if (!best && account.models?.native_ids.length === 0) return [];
    return [{ account_id: account.id, weekly: best?.weekly ?? 0, five_hour: best?.five_hour ?? 0,
      has_observation: best?.has_observation ?? false, last_used_at: account.last_used_at, enrolled_at: account.enrolled_at }];
  }).sort((a, b) => compareQuotaRanks(a, b));
}
