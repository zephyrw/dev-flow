import type {
  AgyAccount,
  AgyQuotaSnapshot,
  AgyDomainWait,
  WindowKind,
} from "../../contracts/src/agy-account.js";

export interface AccountBlockDetails {
  account_id: string;
  blocked_reason: string;
  reset_timestamps: number[];
  has_unknown_block: boolean;
}

export interface DomainWaitEvaluation {
  should_wait: boolean;
  blocked_window?: WindowKind | "unknown";
  next_eligible_at: string | null;
  reason: string;
  blocked_accounts: AccountBlockDetails[];
}

function parseTimeMs(isoOrStr: string | null | undefined): number | null {
  if (!isoOrStr) return null;
  const t = Date.parse(isoOrStr);
  return Number.isNaN(t) ? null : t;
}

import { evaluateAccountForDemand } from "./selector.js";

export function computeDomainWait(
  accounts: AgyAccount[],
  snapshots: AgyQuotaSnapshot[],
  requiredPoolIds: string[],
  now: number,
  options: {
    clockSkewSeconds?: number;
    realmId?: string;
    sourceEpoch?: number;
    allowedAccountIds?: string[] | Set<string> | null;
    requiredModelIds?: string[];
    nightPool?: "normal" | "strict";
    isNight?: boolean;
    nightEndAt?: number;
    refreshVerifiedMaxAgeHours?: number;
  } = {},
): DomainWaitEvaluation {
  const allowedList = options.allowedAccountIds
    ? options.allowedAccountIds instanceof Set
      ? Array.from(options.allowedAccountIds)
      : options.allowedAccountIds
    : null;

  const blockedAccounts: AccountBlockDetails[] = [];
  const candidateAvailableTimestamps: number[] = [];

  for (const acc of accounts) {
    if (allowedList && !allowedList.includes(acc.id)) {
      continue;
    }

    const evalRes = evaluateAccountForDemand({
      account: acc,
      snapshots,
      policy: {
        required_pool_ids: requiredPoolIds,
        required_model_ids: options.requiredModelIds,
        allowed_account_ids: allowedList,
        night_pool: options.nightPool,
        is_night: options.isNight,
        night_end_at: options.nightEndAt,
        refresh_verified_max_age_hours: options.refreshVerifiedMaxAgeHours,
        reset_clock_skew_seconds: options.clockSkewSeconds,
      },
      evaluationTime: now,
    });

    const hasUnknownBlock = evalRes.excluded_reasons.some((r) =>
      [
        "account_disabled",
        "account_incompatible",
        "reauth_required",
        "pending_quota_initialization",
        "missing_required_quota_pools",
        "model_not_supported_in_pool",
        "quota_exhausted_unknown_window",
        "quota_window_unobserved",
        "five_hour_exhausted_unknown_reset",
        "weekly_exhausted_unknown_reset",
        "night_pool_strict_unverified_refresh",
      ].includes(r),
    );

    blockedAccounts.push({
      account_id: acc.id,
      blocked_reason: evalRes.excluded_reasons[0] ?? "quota_exhausted",
      reset_timestamps: evalRes.earliest_wake_time ? [evalRes.earliest_wake_time] : [],
      has_unknown_block: hasUnknownBlock,
    });

    // 仅无未知/永久阻塞且有可信时间的账号参与跨账号 min
    if (!hasUnknownBlock && evalRes.earliest_wake_time && evalRes.earliest_wake_time > now) {
      candidateAvailableTimestamps.push(evalRes.earliest_wake_time);
    }
  }

  if (candidateAvailableTimestamps.length === 0) {
    return {
      should_wait: true,
      blocked_window: "unknown",
      next_eligible_at: null,
      reason: "all_accounts_exhausted_or_blocked_without_known_reset",
      blocked_accounts: blockedAccounts,
    };
  }

  const minEligible = Math.min(...candidateAvailableTimestamps);
  return {
    should_wait: true,
    blocked_window: "weekly",
    next_eligible_at: new Date(minEligible).toISOString(),
    reason: "waiting_for_quota_window_reset",
    blocked_accounts: blockedAccounts,
  };
}
