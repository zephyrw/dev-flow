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

export function computeDomainWait(
  accounts: AgyAccount[],
  snapshots: AgyQuotaSnapshot[],
  requiredPoolIds: string[],
  now: number,
  options: {
    clockSkewSeconds?: number;
    realmId?: string;
    sourceEpoch?: number;
  } = {},
): DomainWaitEvaluation {
  const clockSkewMs = (options.clockSkewSeconds ?? 60) * 1000;
  const snapMap = new Map<string, Map<string, AgyQuotaSnapshot>>();
  for (const s of snapshots) {
    if (!snapMap.has(s.account_id)) {
      snapMap.set(s.account_id, new Map());
    }
    snapMap.get(s.account_id)!.set(s.pool_id, s);
  }

  const blockedAccounts: AccountBlockDetails[] = [];
  const candidateAvailableTimestamps: number[] = [];

  for (const acc of accounts) {
    if (acc.state === "disabled" || acc.state === "incompatible") {
      blockedAccounts.push({
        account_id: acc.id,
        blocked_reason: acc.state,
        reset_timestamps: [],
        has_unknown_block: true,
      });
      continue;
    }

    if (acc.state === "reauth_required") {
      blockedAccounts.push({
        account_id: acc.id,
        blocked_reason: "reauth_required",
        reset_timestamps: [],
        has_unknown_block: true,
      });
      continue;
    }

    if (acc.state === "pending_quota") {
      blockedAccounts.push({
        account_id: acc.id,
        blocked_reason: "pending_quota",
        reset_timestamps: [],
        has_unknown_block: true,
      });
      continue;
    }

    const poolSnaps = snapMap.get(acc.id);
    let accHasUnknownBlock = false;
    const accResetTimes: number[] = [];

    for (const poolId of requiredPoolIds) {
      const snap = poolSnaps?.get(poolId);
      if (!snap) {
        accHasUnknownBlock = true;
        break;
      }

      if (snap.exhausted && snap.exhausted.window === "unknown") {
        accHasUnknownBlock = true;
        break;
      }

      if (
        !["weekly", "five_hour"].every((kind) =>
          snap.windows.some(
            (w) =>
              w.kind === kind &&
              w.status === "observed" &&
              w.remaining_fraction !== null,
          ),
        )
      ) {
        accHasUnknownBlock = true;
        break;
      }
      for (const win of snap.windows) {
        if (win.remaining_fraction !== null && win.remaining_fraction <= 0) {
          const resetMs = parseTimeMs(win.reset_at);
          if (!resetMs) {
            accHasUnknownBlock = true;
          } else {
            accResetTimes.push(resetMs + clockSkewMs);
          }
        }
      }
    }

    blockedAccounts.push({
      account_id: acc.id,
      blocked_reason: "quota_exhausted",
      reset_timestamps: accResetTimes,
      has_unknown_block: accHasUnknownBlock,
    });

    if (!accHasUnknownBlock && accResetTimes.length > 0) {
      const accEarliest = Math.max(...accResetTimes);
      if (accEarliest > now) {
        candidateAvailableTimestamps.push(accEarliest);
      }
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
