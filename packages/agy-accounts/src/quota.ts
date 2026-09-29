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
