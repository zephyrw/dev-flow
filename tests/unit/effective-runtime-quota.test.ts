import { describe, expect, it } from "vitest";
import { effectiveRuntimeQuotaWindows } from "../../packages/presentation/src/agy-accounts.js";

describe("AGY runtime quota uses the same weekly reset rule as accounts", () => {
  const observed = "2026-10-04T00:00:00Z";
  const time = Date.parse(observed);
  const bucket = (reset?: number) => ({ id: "gemini", windows: [
    { window_minutes: 300, used_percent: 40, resets_at: time / 1000 + 60 },
    { window_minutes: 10080, used_percent: 31, resets_at: reset },
  ] });
  it.each([undefined, time / 1000, time / 1000 - 1])("projects a complete due/missing reset %s", reset => {
    const result = effectiveRuntimeQuotaWindows(bucket(reset), "agy", observed, time);
    expect(result[1]).toMatchObject({ used_percent: 0, resets_at: undefined });
    expect(result[0]!.used_percent).toBe(40);
  });
  it("retains future resets, invalid dates, incomplete buckets, and other adapters", () => {
    for (const reset of [time / 1000 + 1, NaN]) {
      const input = bucket(reset);
      expect(effectiveRuntimeQuotaWindows(input, "agy", observed, time)).toEqual(input.windows);
    }
    const input = bucket();
    expect(effectiveRuntimeQuotaWindows(input, "codex", observed, time)).toBe(input.windows);
    input.windows.shift();
    expect(effectiveRuntimeQuotaWindows(input, "agy", observed, time)).toBe(input.windows);
  });
});
