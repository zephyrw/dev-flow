import type {
  QuotaWindow,
  WindowKind,
} from "../../../contracts/src/agy-account.js";

export interface ParsedQuotaResult {
  email?: string;
  plan_tier?: string;
  cli_version: string;
  observed_at: string;
  windows: QuotaWindow[];
  pools: Array<{ pool_id: string; models: string[]; windows: QuotaWindow[] }>;
  raw_text: string;
}

/** This parser describes a labelled fixture format, not a verified official CLI contract.
 * Production activation additionally requires a fingerprint-bound capability adapter. */
export function parseRelativeResetToIso(
  value: string,
  baseTimeMs: number,
): string | null {
  if (!Number.isFinite(baseTimeMs)) return null;
  const text = value.trim();
  if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(
      text,
    )
  ) {
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  const units: Record<string, number> = {
    d: 86400000,
    h: 3600000,
    m: 60000,
    s: 1000,
  };
  if (!/^(?:\d+\s*[dhms]\s*)+$/i.test(text)) return null;
  let total = 0;
  const seen = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/(\d+)\s*([dhms])/g)) {
    const unit = match[2]!;
    if (seen.has(unit)) return null;
    seen.add(unit);
    total += Number(match[1]) * units[unit]!;
  }
  const result = baseTimeMs + total;
  return Number.isSafeInteger(result) && Math.abs(result) <= 8640000000000000
    ? new Date(result).toISOString()
    : null;
}

export function parseAgyUsageOutput(
  rawText: string,
  options: { observedAt?: string; cliVersion?: string } = {},
): ParsedQuotaResult {
  const observedAt = options.observedAt ?? new Date().toISOString();
  const text = rawText.replace(/\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const identities = lines.flatMap((line) => {
    const match =
      /^Account:\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})$/.exec(
        line,
      );
    return match ? [match[1]!.toLowerCase()] : [];
  });
  const plans = lines.flatMap(
    (line) => /^Plan:\s*(\S.*)$/.exec(line)?.[1] ?? [],
  );

  // 1. 尝试真实 CLI 制表符/多空格表格格式：
  // "Gemini Models\tWeekly Limit Remaining\t85%\t2026-09-30T09:58:52Z"
  // 或 "Claude and GPT models  Five Hour Limit Remaining  100%  2026-09-24T07:24:16Z"
  const tableRows: Array<{
    poolName: string;
    kind: WindowKind;
    remaining: number;
    resetAt: string | null;
  }> = [];

  for (const line of lines) {
    const tableMatch =
      /^([^\t]+?)\t+(Weekly Limit Remaining|Five Hour Limit Remaining)\t+(\d+(?:\.\d+)?)%\t+(.+)$/.exec(
        line,
      ) ??
      /^([A-Za-z0-9 ]+?)\s{2,}(Weekly Limit Remaining|Five Hour Limit Remaining)\s{2,}(\d+(?:\.\d+)?)%\s{2,}(.+)$/.exec(
        line,
      );
    if (tableMatch) {
      const poolName = tableMatch[1]!.trim();
      const kindStr = tableMatch[2]!;
      const pctStr = tableMatch[3]!;
      const resetStr = tableMatch[4]!.trim();
      const kind: WindowKind =
        kindStr === "Weekly Limit Remaining" ? "weekly" : "five_hour";
      const remaining = Number(pctStr) / 100;
      const resetAt = parseRelativeResetToIso(
        resetStr,
        Date.parse(observedAt),
      );
      if (
        Number.isFinite(remaining) &&
        remaining >= 0 &&
        remaining <= 1
      ) {
        tableRows.push({ poolName, kind, remaining, resetAt });
      }
    }
  }

  let windows: QuotaWindow[];
  const pools: Array<{ pool_id: string; models: string[]; windows: QuotaWindow[] }> = [];

  if (tableRows.length > 0) {
    const poolMap = new Map<string, QuotaWindow[]>();
    for (const row of tableRows) {
      const window: QuotaWindow = {
        kind: row.kind,
        duration_minutes: row.kind === "weekly" ? 10080 : 300,
        remaining_fraction: row.remaining,
        reset_at: row.resetAt,
        observed_at: observedAt,
        status: "observed",
      };
      const list = poolMap.get(row.poolName) ?? [];
      list.push(window);
      poolMap.set(row.poolName, list);
    }

    for (const [poolName, pWindows] of poolMap.entries()) {
      pools.push({
        pool_id: poolName,
        models: [poolName.toLowerCase().includes("gemini") ? "gemini-*" : "*"],
        windows: pWindows,
      });
    }

    // 全局双额度：优先取 Gemini Models 或第一组双额度
    const primaryPool =
      poolMap.get("Gemini Models") ??
      [...poolMap.values()][0] ??
      [];
    const weeklyWin = primaryPool.find((w) => w.kind === "weekly");
    const fiveHourWin = primaryPool.find((w) => w.kind === "five_hour");

    windows = [
      weeklyWin ?? {
        kind: "weekly",
        duration_minutes: 10080,
        remaining_fraction: null,
        reset_at: null,
        observed_at: observedAt,
        status: "missing",
      },
      fiveHourWin ?? {
        kind: "five_hour",
        duration_minutes: 300,
        remaining_fraction: null,
        reset_at: null,
        observed_at: observedAt,
        status: "missing",
      },
    ];
  } else {
    windows = (["weekly", "five_hour"] as const).map(
      (kind) => {
        const label = kind === "weekly" ? "Weekly" : "5-Hour";
        const values = lines.filter((line) => line.startsWith(label + " quota:"));
        const quotaPattern = new RegExp(
          "^" +
            label +
            " quota:\\s*(\\d+(?:\\.\\d+)?)% remaining(?:, resets (?:in|at):? (.+))?$",
        );
        const match = values.length === 1 ? quotaPattern.exec(values[0]!) : null;
        const remaining = match ? Number(match[1]) / 100 : null;
        const resets = lines.filter((line) =>
          line.startsWith(label + " resets "),
        );
        const separateReset =
          resets.length === 1
            ? new RegExp("^" + label + " resets (?:in|at):? (.+)$").exec(
                resets[0]!,
              )?.[1]
            : undefined;
        const resetValue = match?.[2] ?? separateReset;
        const valid =
          remaining !== null &&
          Number.isFinite(remaining) &&
          remaining >= 0 &&
          remaining <= 1;
        return {
          kind: kind as WindowKind,
          duration_minutes: kind === "weekly" ? 10080 : 300,
          remaining_fraction: valid ? remaining : null,
          reset_at:
            resetValue && resets.length <= 1
              ? parseRelativeResetToIso(resetValue, Date.parse(observedAt))
              : null,
          observed_at: observedAt,
          status: valid ? "observed" : "missing",
        };
      },
    );
  }

  return {
    email: identities.length === 1 ? identities[0] : undefined,
    plan_tier: plans.length === 1 ? plans[0] : undefined,
    cli_version: options.cliVersion ?? "unknown",
    observed_at: observedAt,
    windows,
    pools,
    raw_text: text,
  };
}
