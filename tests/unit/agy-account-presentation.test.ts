import { describe, it, expect } from "vitest";
import { formatQuotaWindow } from "../../packages/presentation/src/agy-accounts.js";
import type { QuotaWindow } from "../../packages/contracts/src/agy-account.js";
describe("quota presentation", () => {
  it("keeps measured zero after projected reset and labels uncertainty", () => {
    const window: QuotaWindow = {
      kind: "weekly",
      duration_minutes: 10080,
      remaining_fraction: 0,
      reset_at: "2026-09-20T00:00:00Z",
      observed_at: "2026-09-19T00:00:00Z",
      status: "observed",
    };
    const view = formatQuotaWindow(window, Date.parse("2026-09-20T01:00:00Z"));
    expect(view).toMatchObject({
      fraction: 0,
      percentageText: "0%",
      isUnknown: false,
      isResetDue: true,
      resetText: "预计已重置，待核验",
      shortResetText: "",
    });
    expect(window.remaining_fraction).toBe(0);
  });
  it("does not render missing usage as full quota", () => {
    expect(formatQuotaWindow(undefined)).toMatchObject({
      fraction: null,
      percentageText: "待补测",
      isUnknown: true,
    });
  });

  it("当额度为 100% 且没有重置时间或为漂移时间时，shortResetText 为空，不显示重置时间", () => {
    // 1. reset_at 为 null
    const windowNoReset: QuotaWindow = {
      kind: "five_hour",
      duration_minutes: 300,
      remaining_fraction: 1,
      reset_at: null,
      observed_at: "2026-09-24T13:00:00Z",
      status: "observed",
    };
    const resNoReset = formatQuotaWindow(windowNoReset, Date.parse("2026-09-24T13:05:00Z"));
    expect(resNoReset.percentageText).toBe("100%");
    expect(resNoReset.shortResetText).toBe("");

    // 2. 虽有 reset_at 但差值刚好等于 5 小时满周期（未开始会话的漂移时间）
    const windowDriftReset: QuotaWindow = {
      kind: "five_hour",
      duration_minutes: 300,
      remaining_fraction: 1,
      reset_at: "2026-09-24T18:00:00Z",
      observed_at: "2026-09-24T13:00:00Z",
      status: "observed",
    };
    const resDrift = formatQuotaWindow(windowDriftReset, Date.parse("2026-09-24T13:05:00Z"));
    expect(resDrift.percentageText).toBe("100%");
    expect(resDrift.shortResetText).toBe("");

    // 3. 额度已经是 100%，且当前时间已经超过了过去的 reset_at：说明重置早已完成并已满额，绝不显示“待重置”
    const windowPastResetFull: QuotaWindow = {
      kind: "five_hour",
      duration_minutes: 300,
      remaining_fraction: 1,
      reset_at: "2026-09-24T18:06:28.000Z",
      observed_at: "2026-09-24T13:25:32.000Z",
      status: "observed",
    };
    const resPastReset = formatQuotaWindow(windowPastResetFull, Date.parse("2026-09-25T01:12:00.000Z"));
    expect(resPastReset.percentageText).toBe("100%");
    expect(resPastReset.shortResetText).toBe("");
    expect(resPastReset.isResetDue).toBe(false);
    expect(resPastReset.resetText).toBe("—");
  });

  it("当额度小于 100% 时，必须正常展示重置时间倒计时", () => {
    const windowActive: QuotaWindow = {
      kind: "five_hour",
      duration_minutes: 300,
      remaining_fraction: 0.53,
      reset_at: "2026-09-24T14:47:00Z",
      observed_at: "2026-09-24T13:00:00Z",
      status: "observed",
    };
    const resActive = formatQuotaWindow(windowActive, Date.parse("2026-09-24T13:05:00Z"));
    expect(resActive.percentageText).toBe("53%");
    expect(resActive.shortResetText).toBe("1h42m");
  });
});
