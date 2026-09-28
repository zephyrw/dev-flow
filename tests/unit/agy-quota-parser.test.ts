import { describe, it, expect } from "vitest";
import { parseAgyUsageOutput, parseRelativeResetToIso } from "../../packages/adapters/agy/src/quota-parser.js";

describe("labelled synthetic usage format (not a verified production capability)", () => {
  it("reads explicit remaining balances without inventing version or pool", () => {
    const result = parseAgyUsageOutput("Account: a@example.com\nWeekly quota: 75% remaining\n5-Hour quota: 0% remaining\nWeekly resets in: 2d 5h\n5-Hour resets in: 30m", { observedAt: "2026-09-20T12:00:00.000Z" });
    expect(result.email).toBe("a@example.com");
    expect(result.windows.map(window => window.remaining_fraction)).toEqual([0.75, 0]);
    expect(result.windows[1]?.reset_at).toBe("2026-09-20T12:30:00.000Z");
    expect(result.pools).toEqual([]);
    expect(result.cli_version).toBe("unknown");
  });
  it.each(["100% used", "50%", "101% remaining", "-1% remaining", "unknown"])("refuses ambiguous or invalid balance %s", value => {
    expect(parseAgyUsageOutput("Weekly quota: " + value).windows[0])
      .toMatchObject({ status: "missing", remaining_fraction: null });
  });
  it("rejects conflicting accounts and repeated quota values", () => {
    const result = parseAgyUsageOutput("Account: a@example.com\nAccount: b@example.com\nWeekly quota: 10% remaining\nWeekly quota: 90% remaining");
    expect(result.email).toBeUndefined();
    expect(result.windows[0]?.status).toBe("missing");
  });
  it("does not treat arbitrary email text as identity", () => {
    expect(parseAgyUsageOutput("Contact help@example.com\na@example.com").email).toBeUndefined();
  });
  it("strips ANSI formatting without changing quota semantics", () => {
    const result = parseAgyUsageOutput("\u001b[32mAccount:\u001b[0m a@example.com\nWeekly quota: 85% remaining");
    expect(result.email).toBe("a@example.com");
    expect(result.windows[0]?.remaining_fraction).toBe(0.85);
  });
  it("requires a complete unambiguous reset duration or zoned timestamp", () => {
    const base = Date.parse("2026-09-20T00:00:00Z");
    expect(parseRelativeResetToIso("1d 2h 30m", base)).toBe("2026-09-21T02:30:00.000Z");
    expect(parseRelativeResetToIso("2026-09-21T02:30:00+08:00", base)).toBe("2026-09-20T18:30:00.000Z");
    for (const text of ["garbage 1h", "1h 2h", "1month", "2026-09-21 02:30", ""])
      expect(parseRelativeResetToIso(text, base)).toBeNull();
  });
  it("当额度为 100% 且未开始会话倒计时时判定没有重置时间，小于 100% 则正常保留重置时间", () => {
    const observedAt = "2026-09-24T13:00:00.000Z";
    // 100% 额度且 CLI 输出的时间正好是 now + 5h (18:00:00) 和 now + 7d (10-01T13:00:00)
    const rawCli = [
      "Gemini Models\tWeekly Limit Remaining\t83%\t2026-09-30T09:58:52Z",
      "Gemini Models\tFive Hour Limit Remaining\t98%\t2026-09-24T17:56:15Z",
      "Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-10-01T13:00:00Z",
      "Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-09-24T18:00:00Z",
    ].join("\n");

    const parsed = parseAgyUsageOutput(rawCli, { observedAt });
    const geminiPool = parsed.pools.find((p) => p.pool_id === "Gemini Models");
    const claudePool = parsed.pools.find((p) => p.pool_id === "Claude and GPT models");

    // 小于 100% 时，重置时间一定保留
    const geminiWeekly = geminiPool?.windows.find((w) => w.kind === "weekly");
    const geminiFiveHour = geminiPool?.windows.find((w) => w.kind === "five_hour");
    expect(geminiWeekly?.remaining_fraction).toBe(0.83);
    expect(geminiWeekly?.reset_at).toBe("2026-09-30T09:58:52.000Z");
    expect(geminiFiveHour?.remaining_fraction).toBe(0.98);
    expect(geminiFiveHour?.reset_at).toBe("2026-09-24T17:56:15.000Z");

    // 100% 额度时，未启动倒计时的虚拟时间被识别为无重置时间 (null)
    const claudeWeekly = claudePool?.windows.find((w) => w.kind === "weekly");
    const claudeFiveHour = claudePool?.windows.find((w) => w.kind === "five_hour");
    expect(claudeWeekly?.remaining_fraction).toBe(1);
    expect(claudeWeekly?.reset_at).toBeNull();
    expect(claudeFiveHour?.remaining_fraction).toBe(1);
    expect(claudeFiveHour?.reset_at).toBeNull();
  });
});
