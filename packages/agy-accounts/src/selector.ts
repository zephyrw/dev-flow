import { hasDualQuotaWindows, requiredQuotaPools } from "./quota.js";
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
  required_model_ids?: string[];
  cooldown_until?: number;
  retry_after_until?: number;
}

export interface AccountEvaluationInput {
  account: AgyAccount;
  snapshots: AgyQuotaSnapshot[];
  policy: {
    required_pool_ids: string[];
    required_model_ids?: string[];
    allowed_account_ids?: string[] | null;
    night_pool?: "normal" | "strict";
    is_night?: boolean;
    night_end_at?: number;
    refresh_verified_max_age_hours?: number;
    cooldown_until?: number;
    retry_after_until?: number;
    reset_clock_skew_seconds?: number;
    policy_revision?: number;
  };
  evaluationTime: number;
}

export interface AccountEvaluationOutput {
  eligible_for_permit: boolean;
  eligible_for_candidate: boolean;
  excluded_reasons: string[];
  earliest_wake_time: number | null;
  projected_weekly: number;
  min_five_hour: number | null;
  is_projected_reset: boolean;
}

export function evaluateAccountForDemand(
  input: AccountEvaluationInput,
): AccountEvaluationOutput {
  const { account, snapshots, policy, evaluationTime } = input;
  const clockSkewMs = (policy.reset_clock_skew_seconds ?? 60) * 1000;
  const excluded_reasons: string[] = [];
  const blockingTimes: number[] = [];

  // 1. 账号基本状态
  if (account.state === "disabled") excluded_reasons.push("account_disabled");
  if (account.state === "incompatible") excluded_reasons.push("account_incompatible");
  if (account.state === "reauth_required") excluded_reasons.push("reauth_required");
  if (account.state === "pending_quota") excluded_reasons.push("pending_quota_initialization");

  // 2. 白名单
  if (
    policy.allowed_account_ids &&
    !policy.allowed_account_ids.includes(account.id)
  ) {
    excluded_reasons.push("not_in_allowed_policy");
  }

  // 3. 冷却与 Retry-After
  if (policy.cooldown_until && evaluationTime < policy.cooldown_until) {
    excluded_reasons.push("in_cooldown");
    blockingTimes.push(policy.cooldown_until);
  }
  if (policy.retry_after_until && evaluationTime < policy.retry_after_until) {
    excluded_reasons.push("in_retry_after");
    blockingTimes.push(policy.retry_after_until);
  }

  // 4. 夜间策略
  if (policy.is_night) {
    if (policy.night_pool === "strict") {
      const verified = parseTimeMs(account.auth.last_refresh_verified_at);
      if (
        !verified ||
        account.auth.metadata_status !== "verified" ||
        verified > evaluationTime ||
        evaluationTime - verified >
          (policy.refresh_verified_max_age_hours ?? 24) * 3600_000
      ) {
        excluded_reasons.push("night_pool_strict_unverified_refresh");
      }
    }
    if (account.auth.refresh_expires_at) {
      const exp = parseTimeMs(account.auth.refresh_expires_at);
      if (exp && exp <= (policy.night_end_at ?? evaluationTime + 12 * 3600_000)) {
        excluded_reasons.push("refresh_token_expiring_soon");
      }
    }
  }

  // 5. 配额池与模型
  // 按 observed_at 降序稳定排序，确保每池选取最新快照，输入顺序不改变结果
  const poolSnaps = new Map<string, AgyQuotaSnapshot>();
  const accountSnapshots = snapshots
    .filter((s) => s.account_id === account.id)
    .slice()
    .sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at) ||
      b.auth_epoch - a.auth_epoch || b.id.localeCompare(a.id));

  for (const s of accountSnapshots) {
    if (!poolSnaps.has(s.pool_id)) {
      poolSnaps.set(s.pool_id, s);
    }
  }

  let minWeeklyFraction = 1;
  let minFiveHourFraction: number | null = 1;
  let isProjectedResetAny = false;
  let hasZeroWindowUnreset = false;
  let hasZeroWindowProjected = false;

  const demandedPools = requiredQuotaPools([...poolSnaps.values()], policy.required_pool_ids, policy.required_model_ids ?? []);
  if (!demandedPools) excluded_reasons.push("missing_required_quota_pools");
  for (const snap of demandedPools ?? []) {
    if (!snap || snap.capability_verified === false ||
        !hasDualQuotaWindows(snap.windows) || !Number.isFinite(Date.parse(snap.observed_at)) ||
        Date.parse(snap.observed_at) > evaluationTime + clockSkewMs) {
      excluded_reasons.push("missing_required_quota_pools");
      break;
    }
    if (snap.exhausted && snap.exhausted.window === "unknown") {
      excluded_reasons.push("quota_exhausted_unknown_window");
      break;
    }

    const weeklyWindow = snap.windows.find((w) => w.kind === "weekly");
    const fiveHourWindow = snap.windows.find((w) => w.kind === "five_hour");

    if (
      !weeklyWindow ||
      weeklyWindow.status !== "observed" ||
      weeklyWindow.remaining_fraction === null ||
      !fiveHourWindow ||
      fiveHourWindow.status !== "observed" ||
      fiveHourWindow.remaining_fraction === null
    ) {
      excluded_reasons.push("missing_required_quota_pools");
      break;
    }

    // 5小时窗口
    const fhRemain = fiveHourWindow.remaining_fraction;
    if (fhRemain !== null && fhRemain <= 0) {
      const fhReset = parseTimeMs(fiveHourWindow.reset_at);
      if (!fhReset) {
        excluded_reasons.push("five_hour_exhausted_unknown_reset");
      } else if (evaluationTime < fhReset + clockSkewMs) {
        hasZeroWindowUnreset = true;
        blockingTimes.push(fhReset + clockSkewMs);
      } else {
        hasZeroWindowProjected = true;
      }
    }
    if (fhRemain !== null) {
      minFiveHourFraction = Math.min(minFiveHourFraction ?? 1, fhRemain);
    }

    // 周窗口
    const wkRemain = weeklyWindow.remaining_fraction;
    let effectiveWk = wkRemain ?? 0;
    const weeklyReset = parseTimeMs(weeklyWindow.reset_at);
    if (weeklyReset !== null && evaluationTime >= weeklyReset + clockSkewMs) {
      effectiveWk = 1;
      isProjectedResetAny = true;
    }
    if (wkRemain !== null && wkRemain <= 0) {
      if (!weeklyReset) {
        excluded_reasons.push("weekly_exhausted_unknown_reset");
      } else if (evaluationTime < weeklyReset + clockSkewMs) {
        hasZeroWindowUnreset = true;
        blockingTimes.push(weeklyReset + clockSkewMs);
      } else {
        effectiveWk = 1;
        isProjectedResetAny = true;
        hasZeroWindowProjected = true;
      }
    }
    minWeeklyFraction = Math.min(minWeeklyFraction, effectiveWk);
  }

  // 综合评定
  const earliest_wake_time = blockingTimes.length > 0
    ? Math.max(...blockingTimes)
    : null;

  const hasHardExclusion = excluded_reasons.length > 0;
  let eligible_for_permit = false;
  let eligible_for_candidate = false;

  if (!hasHardExclusion && !hasZeroWindowUnreset) {
    if (hasZeroWindowProjected || isProjectedResetAny) {
      // 实测为 0 但到期重置：不能直接发业务许可，但允许作为候选进入串行核验
      eligible_for_permit = false;
      eligible_for_candidate = true;
    } else if (minWeeklyFraction > 0 && (minFiveHourFraction ?? 0) > 0) {
      eligible_for_permit = true;
      eligible_for_candidate = true;
    }
  }

  if (hasZeroWindowUnreset && !hasHardExclusion) {
    excluded_reasons.push("quota_exhausted_not_reset");
  }

  return {
    eligible_for_permit,
    eligible_for_candidate,
    excluded_reasons,
    earliest_wake_time,
    projected_weekly: minWeeklyFraction,
    min_five_hour: minFiveHourFraction,
    is_projected_reset: isProjectedResetAny,
  };
}

export interface SelectionResult {
  ranked_candidates: CandidateEvaluation[];
  excluded_accounts: ExcludedAccountReason[];
  next_eligible_at: string | null;
}

function getLocalParts(utcMs: number, timezone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date(utcMs));
  let year = 0,
    month = 0,
    day = 0,
    hour = 0,
    minute = 0,
    second = 0;
  for (const p of parts) {
    if (p.type === "year") year = Number(p.value);
    else if (p.type === "month") month = Number(p.value);
    else if (p.type === "day") day = Number(p.value);
    else if (p.type === "hour") hour = Number(p.value);
    else if (p.type === "minute") minute = Number(p.value);
    else if (p.type === "second") second = Number(p.value);
  }
  return { year, month, day, hour, minute, second };
}

export function localTimeToUtc(
  timezone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  preferLater = true,
): number {
  const targetLocalUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const initial = getLocalParts(targetLocalUtc, timezone);
  const initialLocalUtc = Date.UTC(
    initial.year,
    initial.month - 1,
    initial.day,
    initial.hour,
    initial.minute,
    initial.second,
    0,
  );
  const offset = initialLocalUtc - targetLocalUtc;
  const guess = targetLocalUtc - offset;

  const matches: number[] = [];
  for (let delta = -120; delta <= 120; delta += 15) {
    const t = guess + delta * 60_000;
    const p = getLocalParts(t, timezone);
    const pUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0);
    if (pUtc === targetLocalUtc && p.second === 0) {
      matches.push(t);
    }
  }

  if (matches.length > 0) {
    matches.sort((a, b) => a - b);
    return preferLater ? matches[matches.length - 1]! : matches[0]!;
  }

  for (let forward = 1; forward <= 120; forward++) {
    const nextLocalUtc = targetLocalUtc + forward * 60_000;
    const nextDate = new Date(nextLocalUtc);
    const ny = nextDate.getUTCFullYear();
    const nm = nextDate.getUTCMonth() + 1;
    const nd = nextDate.getUTCDate();
    const nh = nextDate.getUTCHours();
    const nmin = nextDate.getUTCMinutes();
    const subMatches: number[] = [];
    const subGuess = guess + forward * 60_000;
    for (let delta = -60; delta <= 60; delta += 15) {
      const t = subGuess + delta * 60_000;
      const p = getLocalParts(t, timezone);
      if (
        p.year === ny &&
        p.month === nm &&
        p.day === nd &&
        p.hour === nh &&
        p.minute === nmin &&
        p.second === 0
      ) {
        subMatches.push(t);
      }
    }
    if (subMatches.length > 0) {
      subMatches.sort((a, b) => a - b);
      return preferLater ? subMatches[subMatches.length - 1]! : subMatches[0]!;
    }
  }

  return guess;
}

export function nightWindow(
  config: { timezone: string; night_start: string; night_end: string },
  now: number,
): { is_night: boolean; night_start_at: number; night_end_at: number } {
  const parts = getLocalParts(now, config.timezone);
  const current = parts.hour * 60 + parts.minute;
  const minute = (text: string) => {
    const [h, m] = text.split(":").map(Number);
    return h! * 60 + m!;
  };
  const start = minute(config.night_start);
  const end = minute(config.night_end);
  const isOvernight = start > end;

  let isNight = false;
  let startYear = parts.year,
    startMonth = parts.month,
    startDay = parts.day;
  let endYear = parts.year,
    endMonth = parts.month,
    endDay = parts.day;

  if (isOvernight) {
    if (current >= start) {
      isNight = true;
      const nextDay = new Date(
        Date.UTC(parts.year, parts.month - 1, parts.day + 1),
      );
      endYear = nextDay.getUTCFullYear();
      endMonth = nextDay.getUTCMonth() + 1;
      endDay = nextDay.getUTCDate();
    } else if (current < end) {
      isNight = true;
      const prevDay = new Date(
        Date.UTC(parts.year, parts.month - 1, parts.day - 1),
      );
      startYear = prevDay.getUTCFullYear();
      startMonth = prevDay.getUTCMonth() + 1;
      startDay = prevDay.getUTCDate();
    } else {
      isNight = false;
      const nextDay = new Date(
        Date.UTC(parts.year, parts.month - 1, parts.day + 1),
      );
      endYear = nextDay.getUTCFullYear();
      endMonth = nextDay.getUTCMonth() + 1;
      endDay = nextDay.getUTCDate();
    }
  } else {
    if (current >= start && current < end) {
      isNight = true;
    } else if (current < start) {
      isNight = false;
    } else {
      isNight = false;
      const nextDay = new Date(
        Date.UTC(parts.year, parts.month - 1, parts.day + 1),
      );
      startYear = nextDay.getUTCFullYear();
      startMonth = nextDay.getUTCMonth() + 1;
      startDay = nextDay.getUTCDate();
      endYear = startYear;
      endMonth = startMonth;
      endDay = startDay;
    }
  }

  const [startH, startM] = config.night_start.split(":").map(Number);
  const [endH, endM] = config.night_end.split(":").map(Number);

  const night_start_at = localTimeToUtc(
    config.timezone,
    startYear,
    startMonth,
    startDay,
    startH!,
    startM!,
    true,
  );
  const night_end_at = localTimeToUtc(
    config.timezone,
    endYear,
    endMonth,
    endDay,
    endH!,
    endM!,
    true,
  );

  return {
    is_night: isNight,
    night_start_at,
    night_end_at,
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
  const ranked: CandidateEvaluation[] = [];
  const excluded: ExcludedAccountReason[] = [];
  const eligibleTimestamps: number[] = [];

  for (const acc of accounts) {
    const evalRes = evaluateAccountForDemand({
      account: acc,
      snapshots,
      policy: {
        required_pool_ids: requiredPoolIds,
        required_model_ids: policy.required_model_ids,
        allowed_account_ids: policy.allowed_account_ids,
        night_pool: policy.night_pool,
        is_night: policy.is_night,
        night_end_at: policy.night_end_at,
        refresh_verified_max_age_hours: policy.refresh_verified_max_age_hours,
        cooldown_until: policy.cooldown_until,
        retry_after_until: policy.retry_after_until,
        reset_clock_skew_seconds: policy.reset_clock_skew_seconds,
      },
      evaluationTime: now,
    });

    if (evalRes.eligible_for_candidate) {
      ranked.push({
        account_id: acc.id,
        alias: acc.alias,
        projected_weekly: evalRes.projected_weekly,
        is_projected_reset: evalRes.is_projected_reset,
        min_five_hour: evalRes.min_five_hour,
        last_used_at: acc.last_used_at,
        enrolled_at: acc.enrolled_at,
      });
    } else {
      for (const reason of evalRes.excluded_reasons) {
        excluded.push({
          account_id: acc.id,
          alias: acc.alias,
          reason,
        });
      }
    }

    if (evalRes.earliest_wake_time && evalRes.earliest_wake_time > now) {
      eligibleTimestamps.push(evalRes.earliest_wake_time);
    }
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

  const nextEligibleAt = eligibleTimestamps.length
    ? new Date(Math.min(...eligibleTimestamps)).toISOString()
    : null;

  return {
    ranked_candidates: ranked,
    excluded_accounts: excluded,
    next_eligible_at: nextEligibleAt,
  };
}
