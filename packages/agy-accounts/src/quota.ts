import type { AgyAccount, QuotaWindow } from "../../contracts/src/agy-account.js";

export function hasAccountIdentityMismatch(account: AgyAccount): boolean {
  return Boolean(
    (account.auth.email && account.auth.email.trim().toLowerCase() !== account.identity.email.trim().toLowerCase()) ||
    (account.auth.subject && account.identity.subject && account.auth.subject !== account.identity.subject),
  );
}

export function modelCovered(patterns: string[], model: string): boolean {
  return patterns.some((pattern) => pattern === "*" || pattern === model ||
    (pattern.endsWith("*") && model.startsWith(pattern.slice(0, -1))));
}

export function hasDualQuotaWindows(windows: QuotaWindow[]): boolean {
  if (windows.length !== 2) return false;
  return (["weekly", "five_hour"] as const).every((kind) => {
    const matches = windows.filter((w) => w.kind === kind);
    const w = matches[0];
    return matches.length === 1 && w?.status === "observed" &&
      typeof w.remaining_fraction === "number" && Number.isFinite(w.remaining_fraction) &&
      w.remaining_fraction >= 0 && w.remaining_fraction <= 1 &&
      Number.isFinite(Date.parse(w.observed_at)) &&
      w.observed_at === windows[0]?.observed_at;
  });
}

export function requiredQuotaPools<T extends { pool_id: string; model_ids: string[] }>(
  pools: T[], poolIds: string[], models: string[],
): T[] | null {
  if (new Set(pools.map((pool) => pool.pool_id)).size !== pools.length) return null;
  const selected = new Map<string, T>();
  for (const id of poolIds.length ? poolIds : ["global"]) {
    let exact = pools.find((pool) => pool.pool_id === id);
    if (!exact && id === "global") {
      // 官方真实CLI池为 "Gemini Models" 和 "Claude and GPT models"，无字面 "global" 时回退匹配默认模型池
      exact = pools.find((p) => p.pool_id.toLowerCase().includes("gemini")) ?? pools[0];
    }
    if (exact) selected.set(exact.pool_id, exact);
    if (id !== "global" || !models.length) {
      if (!exact) return null;
      continue;
    }
    // 真实 global 与模型专属池可以同时约束同一次请求。
    for (const model of models) {
      const matches = pools.filter((pool) => modelCovered(pool.model_ids, model));
      if (!matches.length) return null;
      for (const pool of matches) selected.set(pool.pool_id, pool);
    }
  }
  if (!models.every((model) => [...selected.values()].some((pool) => modelCovered(pool.model_ids, model)))) return null;
  return [...selected.values()];
}

export interface EffectiveWeeklyQuotaResult {
  fraction: number | null;
  isProjectedReset: boolean;
  isValid: boolean;
  hasInvalidResetAt: boolean;
}

export function computeEffectiveWeeklyQuota(
  window: QuotaWindow | undefined,
  nowMs: number = Date.now(),
  clockSkewMs: number = 0,
): EffectiveWeeklyQuotaResult {
  if (
    !window ||
    window.kind !== "weekly" ||
    window.status !== "observed" ||
    typeof window.remaining_fraction !== "number" ||
    !Number.isFinite(window.remaining_fraction) ||
    window.remaining_fraction < 0 ||
    window.remaining_fraction > 1
  ) {
    return {
      fraction: null,
      isProjectedReset: false,
      isValid: false,
      hasInvalidResetAt: false,
    };
  }

  // 1. 周额度没有重置时间（null 或空字符串）：判定为 100%
  if (!window.reset_at) {
    return {
      fraction: 1,
      isProjectedReset: window.remaining_fraction < 1,
      isValid: true,
      hasInvalidResetAt: false,
    };
  }

  // 2. 有重置时间，检查是否合法时间
  const resetMs = Date.parse(window.reset_at);
  if (!Number.isFinite(resetMs)) {
    // 非空非法时间：保留原状态/异常，不能误变满额
    return {
      fraction: window.remaining_fraction,
      isProjectedReset: false,
      isValid: false,
      hasInvalidResetAt: true,
    };
  }

  // 3. 当前时间大于或等于重置时间（包含等于边界）：已到期恢复 100%
  if (nowMs >= resetMs + clockSkewMs) {
    return {
      fraction: 1,
      isProjectedReset: window.remaining_fraction < 1,
      isValid: true,
      hasInvalidResetAt: false,
    };
  }

  // 4. 重置时间在未来：保留实际观测值
  return {
    fraction: window.remaining_fraction,
    isProjectedReset: false,
    isValid: true,
    hasInvalidResetAt: false,
  };
}

export function resolveEffectiveQuotaWindows(
  windows: QuotaWindow[],
  nowMs: number = Date.now(),
): QuotaWindow[] {
  // 不完整窗口集合不得投影满额，保留原始观测及 pending_quota 状态
  if (!hasDualQuotaWindows(windows)) {
    return windows;
  }
  return windows.map((w) => {
    if (w.kind !== "weekly") return w;
    const eff = computeEffectiveWeeklyQuota(w, nowMs);
    if (!eff.isValid || eff.hasInvalidResetAt || eff.fraction === null) {
      return w;
    }
    if (eff.isProjectedReset || (w.remaining_fraction === 1 && w.reset_at && eff.fraction === 1 && nowMs >= Date.parse(w.reset_at))) {
      return {
        ...w,
        remaining_fraction: 1,
        reset_at: null,
      };
    }
    return w;
  });
}
