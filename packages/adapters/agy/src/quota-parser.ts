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
  const lines = text.split(/\r?\n/).map((line) => line.trim());
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
  const windows: QuotaWindow[] = (["weekly", "five_hour"] as const).map(
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
  return {
    email: identities.length === 1 ? identities[0] : undefined,
    plan_tier: plans.length === 1 ? plans[0] : undefined,
    cli_version: options.cliVersion ?? "unknown",
    observed_at: observedAt,
    windows,
    // A model list is not proof of a shared quota pool. Never infer this mapping.
    pools: [],
    raw_text: text,
  };
}
