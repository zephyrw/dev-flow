import type { AgyAccount, AgyQuotaSnapshot, QuotaWindow } from "../../contracts/src/agy-account.js";

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

/** An overall probe success never vouches for an unrelated or malformed pool. */
export function isQuotaPoolVerified(
  observation: { capability_verified: boolean; executable_fingerprint: string },
  pool: { model_ids: string[]; windows: QuotaWindow[]; capability_verified?: boolean },
): boolean {
  return observation.capability_verified && Boolean(observation.executable_fingerprint) &&
    pool.capability_verified !== false && pool.model_ids.length > 0 && hasDualQuotaWindows(pool.windows);
}

export function requiredQuotaPools<T extends { pool_id: string; model_ids: string[] }>(
  pools: T[],
  poolIds: string[],
  models: string[],
  categoryContext?: "gemini" | "other" | "unknown" | null,
): T[] | null {
  if (new Set(pools.map((pool) => pool.pool_id)).size !== pools.length) return null;
  const selected = new Map<string, T>();
  const hasLiteralGlobal = pools.some((p) => p.pool_id.toLowerCase() === "global");
  for (const id of poolIds.length ? poolIds : ["global"]) {
    let exact = pools.find((pool) => pool.pool_id === id);
    if (!exact && id === "global" && hasLiteralGlobal) {
      exact = pools.find((p) => p.pool_id.toLowerCase() === "global");
    }
    // AGY-06: 兼容 global 池 (model_ids 包含 "*")，若请求的类别池不在 pools 中，但存在覆盖该模型的 global 池，匹配 global 池
    if (!exact && (id === "Gemini Models" || id === "Claude and GPT models")) {
      const globalPool = pools.find((p) => p.pool_id.toLowerCase() === "global" && p.model_ids.includes("*"));
      if (globalPool) {
        exact = globalPool;
      }
    }
    if (exact) selected.set(exact.pool_id, exact);
    if (id !== "global" || !models.length) {
      if (!exact && id !== "global") {
        const covered = models.length > 0 && models.some((m) => pools.some((p) => modelCovered(p.model_ids, m)));
        if (!covered) return null;
      }
      continue;
    }
    // 真实 global 与模型专属池可以同时约束同一次请求。
    for (const model of models) {
      const matches = pools.filter((pool) => modelCovered(pool.model_ids, model));
      if (!matches.length) return null;
      for (const pool of matches) selected.set(pool.pool_id, pool);
    }
  }
  const global = pools.find(pool => pool.pool_id.toLowerCase() === "global");
  if (global) selected.set(global.pool_id, global);
  if (models.length > 0) {
    for (const model of models) {
      const matches = pools.filter((pool) => modelCovered(pool.model_ids, model));
      if (!matches.length) return null;
      for (const pool of matches) selected.set(pool.pool_id, pool);
    }
  } else if ((categoryContext !== undefined && categoryContext !== null) ||
      poolIds.length === 0 || poolIds.every(id => id.toLowerCase() === "global") || selected.size === 0) {
    // AGY-08: 无明确模型的独立管理分支，必须结合活跃类别上下文解析，不能默选 Gemini 或列表首池
    if (categoryContext === "gemini") {
      const match = pools.find((p) => p.pool_id.toLowerCase().includes("gemini")) ??
        pools.find((p) => p.pool_id.toLowerCase() === "global" && p.model_ids.includes("*"));
      if (match) selected.set(match.pool_id, match);
      else return null;
    } else if (categoryContext === "other") {
      const match = pools.find((p) => p.pool_id.toLowerCase().includes("claude") || p.pool_id.toLowerCase().includes("gpt")) ??
        pools.find((p) => p.pool_id.toLowerCase() === "global" && p.model_ids.includes("*"));
      if (match) selected.set(match.pool_id, match);
      else return null;
    } else {
      // 无法确认可靠上下文时拒绝默认猜测
      return null;
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

/** Project a five-hour reset only when the provider supplied a valid elapsed timestamp. */
export function computeEffectiveFiveHourQuota(
  window: QuotaWindow | undefined,
  nowMs: number = Date.now(),
  clockSkewMs: number = 0,
): EffectiveWeeklyQuotaResult {
  if (!window || window.kind !== "five_hour" || window.status !== "observed" ||
      typeof window.remaining_fraction !== "number" || !Number.isFinite(window.remaining_fraction) ||
      window.remaining_fraction < 0 || window.remaining_fraction > 1) {
    return { fraction: null, isProjectedReset: false, isValid: false, hasInvalidResetAt: false };
  }
  const resetMs = window.reset_at ? Date.parse(window.reset_at) : null;
  const hasInvalidResetAt = resetMs !== null && !Number.isFinite(resetMs);
  const elapsed = resetMs !== null && !hasInvalidResetAt && nowMs >= resetMs + clockSkewMs;
  return {
    fraction: elapsed ? 1 : window.remaining_fraction,
    isProjectedReset: elapsed && window.remaining_fraction < 1,
    isValid: !hasInvalidResetAt,
    hasInvalidResetAt,
  };
}

/** Derive quota badges without rewriting provider observations or granting execution permits. */
export function resolveEffectiveAccountState(
  account: Pick<AgyAccount, "id" | "state">,
  snapshots: Pick<AgyQuotaSnapshot, "account_id" | "windows" | "capability_verified">[],
  nowMs: number = Date.now(),
): AgyAccount["state"] {
  if (!["ready", "waiting_quota", "pending_quota"].includes(account.state)) return account.state;
  const pools = snapshots.filter(snapshot => snapshot.account_id === account.id);
  if (!pools.length) return account.state === "waiting_quota" ? "pending_quota" : account.state;
  let needsVerification = false;
  let waiting = false;
  for (const pool of pools) {
    if (pool.capability_verified === false || !hasDualQuotaWindows(pool.windows)) {
      needsVerification = true;
      continue;
    }
    for (const window of resolveEffectiveQuotaWindows(pool.windows, nowMs)) {
      if (window.remaining_fraction !== null && window.remaining_fraction <= 0) {
        const resetMs = window.reset_at ? Date.parse(window.reset_at) : NaN;
        if (Number.isFinite(resetMs) && resetMs > nowMs) waiting = true;
        else needsVerification = true;
      }
    }
  }
  return waiting ? "waiting_quota" : needsVerification ? "pending_quota" : "ready";
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
    const eff = w.kind === "weekly"
      ? computeEffectiveWeeklyQuota(w, nowMs)
      : computeEffectiveFiveHourQuota(w, nowMs);
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
