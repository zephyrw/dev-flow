import type {
  AgyAccount,
  AgyQuotaSnapshot,
  QuotaWindow,
} from "../../contracts/src/agy-account.js";

export interface CandidateEvaluation {
  account_id: string;
  alias: string;
  projected_weekly: number;
  is_projected_reset: boolean;
  min_five_hour: number | null;
  last_used_at?: string;
  enrolled_at: string;
}

export interface ExcludedAccountReason {
  account_id: string;
  alias: string;
  reason: string;
  details?: Record<string, unknown>;
}

export interface SelectionPolicy {
  allowed_account_ids?: string[] | null;
  reset_clock_skew_seconds?: number;
  night_pool?: "normal" | "strict";
  is_night?: boolean;
  current_active_account_id?: string | null;
  sticky_active?: boolean;
  refresh_verified_max_age_hours?: number;
  night_end_at?: number;
}

export interface SelectionResult {
  ranked_candidates: CandidateEvaluation[];
  excluded_accounts: ExcludedAccountReason[];
  next_eligible_at: string | null;
}

export function nightWindow(
  config: { timezone: string; night_start: string; night_end: string },
  now: number,
): { is_night: boolean; night_end_at: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: config.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  const current =
    Number(parts.find((p) => p.type === "hour")!.value) * 60 +
    Number(parts.find((p) => p.type === "minute")!.value);
  const minute = (text: string) => {
    const [h, m] = text.split(":").map(Number);
    return h! * 60 + m!;
  };
  const start = minute(config.night_start),
    end = minute(config.night_end);
  return {
    is_night:
      start <= end
        ? current >= start && current < end
        : current >= start || current < end,
    night_end_at: now + ((end - current + 1440) % 1440 || 1440) * 60_000,
  };
}

function parseTimeMs(isoOrStr: string | null | undefined): number | null {
  if (!isoOrStr) return null;
  const t = Date.parse(isoOrStr);
  return Number.isNaN(t) ? null : t;
}

export function selectCandidates(
  accounts: AgyAccount[],
  snapshots: AgyQuotaSnapshot[],
  requiredPoolIds: string[],
  now: number,
  policy: SelectionPolicy = {},
): SelectionResult {
  const clockSkewMs = (policy.reset_clock_skew_seconds ?? 60) * 1000;
  const allowedSet = policy.allowed_account_ids
    ? new Set(policy.allowed_account_ids)
    : null;

  const ranked: CandidateEvaluation[] = [];
  const excluded: ExcludedAccountReason[] = [];
  const eligibleTimestamps: number[] = [];

  // 构建 snapshot 索引: account_id -> pool_id -> AgyQuotaSnapshot
  const snapMap = new Map<string, Map<string, AgyQuotaSnapshot>>();
  for (const s of snapshots) {
    if (!snapMap.has(s.account_id)) {
      snapMap.set(s.account_id, new Map());
    }
    snapMap.get(s.account_id)!.set(s.pool_id, s);
  }

  for (const acc of accounts) {
    // 1. 基础状态过滤
    if (acc.state === "disabled") {
      excluded.push({
        account_id: acc.id,
        alias: acc.alias,
        reason: "account_disabled",
      });
      continue;
    }
    if (acc.state === "incompatible") {
      excluded.push({
        account_id: acc.id,
        alias: acc.alias,
        reason: "account_incompatible",
      });
      continue;
    }
    if (acc.state === "reauth_required") {
      excluded.push({
        account_id: acc.id,
        alias: acc.alias,
        reason: "reauth_required",
      });
      continue;
    }
    if (acc.state === "pending_quota") {
      excluded.push({
        account_id: acc.id,
        alias: acc.alias,
        reason: "pending_quota_initialization",
      });
      continue;
    }
    if (allowedSet && !allowedSet.has(acc.id)) {
      excluded.push({
        account_id: acc.id,
        alias: acc.alias,
        reason: "not_in_allowed_policy",
      });
      continue;
    }

    // 夜间策略过滤
    if (policy.is_night) {
      if (policy.night_pool === "strict") {
        const verified = parseTimeMs(acc.auth.last_refresh_verified_at);
        if (
          !verified ||
          verified > now ||
          now - verified >
            (policy.refresh_verified_max_age_hours ?? 24) * 3600_000
        ) {
          excluded.push({
            account_id: acc.id,
            alias: acc.alias,
            reason: "night_pool_strict_unverified_refresh",
          });
          continue;
        }
      }
      if (acc.auth.refresh_expires_at) {
        const refreshExp = parseTimeMs(acc.auth.refresh_expires_at);
        if (
          refreshExp &&
          refreshExp <= (policy.night_end_at ?? now + 12 * 3600 * 1000)
        ) {
          excluded.push({
            account_id: acc.id,
            alias: acc.alias,
            reason: "refresh_token_expiring_soon",
          });
          continue;
        }
      }
    }

    // 2. 检查所需配额池
    const poolSnaps = snapMap.get(acc.id);
    let missingPool = false;
    let poolExhausted = false;
    let minWeeklyFraction = 1;
    let isProjectedResetAny = false;
    let minFiveHourFraction: number | null = 1;

    for (const poolId of requiredPoolIds) {
      const snap = poolSnaps?.get(poolId);
      if (!snap) {
        missingPool = true;
        break;
      }

      // 检查确证耗尽且无法确定窗口
      if (snap.exhausted && snap.exhausted.window === "unknown") {
        poolExhausted = true;
        break;
      }

      const weeklyWindow = snap.windows.find((w) => w.kind === "weekly");
      const fiveHourWindow = snap.windows.find((w) => w.kind === "five_hour");

      // 必须有双窗口数据
      if (
        !weeklyWindow ||
        weeklyWindow.status !== "observed" ||
        weeklyWindow.remaining_fraction === null ||
        !fiveHourWindow ||
        fiveHourWindow.status !== "observed" ||
        fiveHourWindow.remaining_fraction === null
      ) {
        missingPool = true;
        break;
      }

      // 检查 5 小时窗口
      const fhRemain = fiveHourWindow.remaining_fraction;
      if (fhRemain !== null && fhRemain <= 0) {
        const fhReset = parseTimeMs(fiveHourWindow.reset_at);
        if (!fhReset) {
          poolExhausted = true;
          break;
        }
        if (now < fhReset + clockSkewMs) {
          poolExhausted = true;
          eligibleTimestamps.push(fhReset + clockSkewMs);
          break;
        }
      }
      if (fhRemain !== null) {
        minFiveHourFraction = Math.min(minFiveHourFraction ?? 1, fhRemain);
      }

      // 检查周窗口
      const wkRemain = weeklyWindow.remaining_fraction;
      let effectiveWk = wkRemain ?? 0;
      const weeklyReset = parseTimeMs(weeklyWindow.reset_at);
      if (weeklyReset !== null && now >= weeklyReset + clockSkewMs) {
        effectiveWk = 1;
        isProjectedResetAny = true;
      }
      if (wkRemain !== null && wkRemain <= 0) {
        const wkReset = parseTimeMs(weeklyWindow.reset_at);
        if (!wkReset) {
          poolExhausted = true;
          break;
        }
        if (now < wkReset + clockSkewMs) {
          poolExhausted = true;
          eligibleTimestamps.push(wkReset + clockSkewMs);
          break;
        } else {
          // 到期投影重置为 1
          effectiveWk = 1;
          isProjectedResetAny = true;
        }
      }
      minWeeklyFraction = Math.min(minWeeklyFraction, effectiveWk);
    }

    if (missingPool) {
      excluded.push({
        account_id: acc.id,
        alias: acc.alias,
        reason: "missing_required_quota_pools",
      });
      continue;
    }
    if (poolExhausted) {
      excluded.push({
        account_id: acc.id,
        alias: acc.alias,
        reason: "quota_exhausted_not_reset",
      });
      continue;
    }

    ranked.push({
      account_id: acc.id,
      alias: acc.alias,
      projected_weekly: minWeeklyFraction,
      is_projected_reset: isProjectedResetAny,
      min_five_hour: minFiveHourFraction,
      last_used_at: acc.last_used_at,
      enrolled_at: acc.enrolled_at,
    });
  }

  // 3. 确定性排序：
  ranked.sort((a, b) => {
    if (policy.sticky_active && policy.current_active_account_id) {
      if (a.account_id === policy.current_active_account_id) return -1;
      if (b.account_id === policy.current_active_account_id) return 1;
    }

    // 周余额降序
    if (b.projected_weekly !== a.projected_weekly) {
      return b.projected_weekly - a.projected_weekly;
    }

    // 并列：last_used_at 更早（LRU，更久没用的优先）
    const aUsed = parseTimeMs(a.last_used_at) ?? 0;
    const bUsed = parseTimeMs(b.last_used_at) ?? 0;
    if (aUsed !== bUsed) {
      return aUsed - bUsed;
    }

    // 并列：enrolled_at 更早
    const aEnrolled = parseTimeMs(a.enrolled_at) ?? 0;
    const bEnrolled = parseTimeMs(b.enrolled_at) ?? 0;
    if (aEnrolled !== bEnrolled) {
      return aEnrolled - bEnrolled;
    }

    // 并列：account_id 字典序
    return a.account_id.localeCompare(b.account_id);
  });

  // A candidate can wake only after every required blocking window resets.
  const wakeTimes = accounts
    .filter((a) => a.state === "ready" || a.state === "waiting_quota")
    .filter((a) => !allowedSet || allowedSet.has(a.id))
    .flatMap((a) => {
      const times: number[] = [];
      for (const pool of requiredPoolIds) {
        const s = snapMap.get(a.id)?.get(pool);
        if (!s || s.exhausted?.window === "unknown") return [];
        for (const kind of ["weekly", "five_hour"] as const) {
          const w = s.windows.find((v) => v.kind === kind);
          if (!w || w.status !== "observed" || w.remaining_fraction === null)
            return [];
          if (w.remaining_fraction <= 0) {
            const t = parseTimeMs(w.reset_at);
            if (t === null) return [];
            times.push(t + clockSkewMs);
          }
        }
      }
      const t = Math.max(0, ...times);
      return t > now ? [t] : [];
    });
  const nextEligibleAt = wakeTimes.length
    ? new Date(Math.min(...wakeTimes)).toISOString()
    : null;

  return {
    ranked_candidates: ranked,
    excluded_accounts: excluded,
    next_eligible_at: nextEligibleAt,
  };
}
