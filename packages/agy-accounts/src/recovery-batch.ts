import type {
  AgyAccount,
  AgyQuotaSnapshot,
  AgyPendingDemand,
  AgyRecoveryBatch,
  AgyAccountSettings,
} from "../../contracts/src/agy-account.js";

import { evaluateAccountForDemand } from "./selector.js";

export interface AccountAvailabilityPolicy {
  allowed_account_ids?: string[] | null;
  night_pool?: "normal" | "strict";
  is_night?: boolean;
  night_end_at?: number;
  refresh_verified_max_age_hours?: number;
  reset_clock_skew_seconds?: number;
  cooldown_until?: number;
  current_active_account_id?: string | null;
  sticky_active?: boolean;
  required_model_ids?: string[];
}

export interface AccountAvailabilityResult {
  eligible: boolean;
  blocking_reasons: string[];
  credible_wake_at: number | null;
  projected_weekly: number;
  min_five_hour: number | null;
  is_projected_reset: boolean;
}

export function evaluateAccountAvailability(
  account: AgyAccount,
  snapshots: AgyQuotaSnapshot[],
  requiredPoolIds: string[],
  nowMs: number,
  policy: AccountAvailabilityPolicy = {},
): AccountAvailabilityResult {
  const evalRes = evaluateAccountForDemand({
    account,
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
      reset_clock_skew_seconds: policy.reset_clock_skew_seconds,
    },
    evaluationTime: nowMs,
  });

  return {
    eligible: evalRes.eligible_for_candidate,
    blocking_reasons: evalRes.excluded_reasons,
    credible_wake_at: evalRes.earliest_wake_time,
    projected_weekly: evalRes.projected_weekly,
    min_five_hour: evalRes.min_five_hour,
    is_projected_reset: evalRes.is_projected_reset,
  };
}

export function planRecoveryBatch(
  demands: AgyPendingDemand[],
  accounts: AgyAccount[],
  snapshots: AgyQuotaSnapshot[],
  nowMs: number,
  settings: AgyAccountSettings,
  options: {
    nightWindowInfo?: { is_night: boolean; night_end_at: number };
    operationId?: string;
  } = {},
): {
  batch: AgyRecoveryBatch | null;
  demandsWakeAt: Map<string, number | null>;
} {
  const validDemands = demands.filter(
    (d) => d.status === "waiting" || d.status === "deferred",
  );
  const demandsWakeAt = new Map<string, number | null>();

  if (validDemands.length === 0) {
    return { batch: null, demandsWakeAt };
  }

  const opId = options.operationId ?? `op_${Date.now()}`;

  // 对每个 demand 评估所有账号的可用性
  const demandCandidateMap = new Map<
    string,
    Array<{ account: AgyAccount; eval: AccountAvailabilityResult }>
  >();

  for (const demand of validDemands) {
    const policy: AccountAvailabilityPolicy = {
      allowed_account_ids: demand.allowed_account_ids,
      night_pool: demand.night_pool,
      is_night: options.nightWindowInfo?.is_night,
      night_end_at: options.nightWindowInfo?.night_end_at,
      refresh_verified_max_age_hours:
        settings.maintenance.refresh_verified_max_age_hours,
      reset_clock_skew_seconds: settings.reset_clock_skew_seconds,
      required_model_ids: demand.required_model_keys,
    };

    const candidates: Array<{
      account: AgyAccount;
      eval: AccountAvailabilityResult;
    }> = [];
    const wakeTimestamps: number[] = [];

    for (const acc of accounts) {
      const res = evaluateAccountAvailability(
        acc,
        snapshots,
        demand.required_pool_ids,
        nowMs,
        policy,
      );
      candidates.push({ account: acc, eval: res });
      if (res.credible_wake_at !== null) {
        wakeTimestamps.push(res.credible_wake_at);
      }
    }

    demandCandidateMap.set(demand.demand_id, candidates);

    // 每池跨账号取 min 作为该 demand 的 wake_at
    demandsWakeAt.set(
      demand.demand_id,
      wakeTimestamps.length > 0 ? Math.min(...wakeTimestamps) : null,
    );
  }

  // 1. 尝试全部需求的共同本地候选
  const commonEligibleAccounts = accounts.filter((acc) =>
    validDemands.every((d) => {
      const c = demandCandidateMap
        .get(d.demand_id)
        ?.find((item) => item.account.id === acc.id);
      return c?.eval.eligible === true;
    }),
  );

  if (commonEligibleAccounts.length > 0) {
    // 存在共同候选，按所有选中需求涉及池的最小周余额降序、上次使用时间升序、账号 ID 稳定排序
    commonEligibleAccounts.sort((a, b) => {
      const getMinWeekly = (accId: string) => {
        let minWk = 1;
        for (const d of validDemands) {
          const item = demandCandidateMap.get(d.demand_id)?.find((c) => c.account.id === accId);
          if (item) {
            minWk = Math.min(minWk, item.eval.projected_weekly);
          }
        }
        return minWk;
      };

      const minWkA = getMinWeekly(a.id);
      const minWkB = getMinWeekly(b.id);
      if (minWkB !== minWkA) {
        return minWkB - minWkA;
      }

      const aUsed = a.last_used_at ? Date.parse(a.last_used_at) : 0;
      const bUsed = b.last_used_at ? Date.parse(b.last_used_at) : 0;
      if (aUsed !== bUsed) {
        return aUsed - bUsed;
      }

      return a.id.localeCompare(b.id);
    });

    const chosenAccount = commonEligibleAccounts[0]!;
    const batch: AgyRecoveryBatch = {
      batch_id: `batch_${Date.now()}`,
      operation_id: opId,
      revision: 1,
      anchor_demand_id: validDemands[0]!.demand_id,
      selected_demand_ids: validDemands.map((d) => d.demand_id),
      deferred_demand_ids: [],
      candidate_account_ids: commonEligibleAccounts.map((a) => a.id),
      committed_account_id: chosenAccount.id,
      status: "planned",
      created_at: new Date(nowMs).toISOString(),
    };
    return { batch, demandsWakeAt };
  }

  // 2. 没有共同候选时，按 first_wait_at、fairness_key、demand_id 排序
  const sortedDemands = [...validDemands].sort((a, b) => {
    const tA = Date.parse(a.first_wait_at);
    const tB = Date.parse(b.first_wait_at);
    if (tA !== tB) return tA - tB;
    if (a.fairness_key !== b.fairness_key) {
      return a.fairness_key.localeCompare(b.fairness_key);
    }
    return a.demand_id.localeCompare(b.demand_id);
  });

  // 取至少有本地可核验候选的最早需求作为 anchor
  let anchorDemand: AgyPendingDemand | null = null;
  let anchorEligibleCandidates: Array<{
    account: AgyAccount;
    eval: AccountAvailabilityResult;
  }> = [];

  for (const d of sortedDemands) {
    const list = (demandCandidateMap.get(d.demand_id) ?? []).filter(
      (c) => c.eval.eligible,
    );
    if (list.length > 0) {
      anchorDemand = d;
      anchorEligibleCandidates = list;
      break;
    }
  }

  if (!anchorDemand) {
    // 没有任何需求有本地合格候选
    return { batch: null, demandsWakeAt };
  }

  // 3. 按 anchor 的约束和周余额降序、使用时间升序排序选择候选
  anchorEligibleCandidates.sort((a, b) => {
    if (b.eval.projected_weekly !== a.eval.projected_weekly) {
      return b.eval.projected_weekly - a.eval.projected_weekly;
    }
    const aUsed = a.account.last_used_at ? Date.parse(a.account.last_used_at) : 0;
    const bUsed = b.account.last_used_at ? Date.parse(b.account.last_used_at) : 0;
    if (aUsed !== bUsed) {
      return aUsed - bUsed;
    }
    return a.account.id.localeCompare(b.account.id);
  });
  const bestCandidate = anchorEligibleCandidates[0]!;

  // 逐项评估其他需求，满足全部模型/池、白名单、night 策略者加入 selected，其余 deferred
  const selectedDemandIds: string[] = [anchorDemand.demand_id];
  const deferredDemandIds: string[] = [];

  for (const d of validDemands) {
    if (d.demand_id === anchorDemand.demand_id) continue;
    const c = demandCandidateMap
      .get(d.demand_id)
      ?.find((item) => item.account.id === bestCandidate.account.id);
    if (c?.eval.eligible) {
      selectedDemandIds.push(d.demand_id);
    } else {
      deferredDemandIds.push(d.demand_id);
    }
  }

  const batch: AgyRecoveryBatch = {
    batch_id: `batch_${Date.now()}`,
    operation_id: opId,
    revision: 1,
    anchor_demand_id: anchorDemand.demand_id,
    selected_demand_ids: selectedDemandIds,
    deferred_demand_ids: deferredDemandIds,
    candidate_account_ids: anchorEligibleCandidates.map((c) => c.account.id),
    committed_account_id: bestCandidate.account.id,
    status: "planned",
    created_at: new Date(nowMs).toISOString(),
  };

  return { batch, demandsWakeAt };
}
