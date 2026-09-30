import { describe, it, expect } from "vitest";
import { formatQuotaWindow, formatSnapshotQuotaWindow } from "../../packages/presentation/src/agy-accounts.js";
import type { AgyQuotaSnapshot, QuotaWindow } from "../../packages/contracts/src/agy-account.js";
describe("quota presentation", () => {
  it("A01: 60%/69%且reset_at=null或空值：fraction=1，文字及条宽100%，没有倒计时或待重置", () => {
    const w60: QuotaWindow = {
      kind: "weekly",
      duration_minutes: 10080,
      remaining_fraction: 0.6,
      reset_at: null,
      observed_at: "2026-09-24T12:00:00Z",
      status: "observed",
    };
    const res60 = formatQuotaWindow(w60, Date.parse("2026-09-24T13:00:00Z"));
    expect(res60).toMatchObject({
      fraction: 1,
      percentageText: "100%",
      resetText: "—",
      shortResetText: "",
      isResetDue: false,
      statusClass: "normal",
    });

    const w69: QuotaWindow = {
      kind: "weekly",
      duration_minutes: 10080,
      remaining_fraction: 0.69,
      reset_at: "",
      observed_at: "2026-09-24T12:00:00Z",
      status: "observed",
    };
    const res69 = formatQuotaWindow(w69, Date.parse("2026-09-24T13:00:00Z"));
    expect(res69).toMatchObject({
      fraction: 1,
      percentageText: "100%",
      resetText: "—",
      shortResetText: "",
      isResetDue: false,
    });
  });

  it("A02: 0%及其他低值，reset_at刚过或等于now：100%；边界前为原实际值", () => {
    const resetIso = "2026-09-24T12:00:00.000Z";
    const resetMs = Date.parse(resetIso);

    const w0: QuotaWindow = {
      kind: "weekly",
      duration_minutes: 10080,
      remaining_fraction: 0,
      reset_at: resetIso,
      observed_at: "2026-09-23T12:00:00Z",
      status: "observed",
    };

    // 边界前1毫秒：原实际值0%，显示倒计时
    const before = formatQuotaWindow(w0, resetMs - 1);
    expect(before.percentageText).toBe("0%");
    expect(before.fraction).toBe(0);
    expect(before.resetText).toContain("重置");

    // 等于边界：恢复100%，无倒计时
    const exact = formatQuotaWindow(w0, resetMs);
    expect(exact.percentageText).toBe("100%");
    expect(exact.fraction).toBe(1);
    expect(exact.resetText).toBe("—");
    expect(exact.shortResetText).toBe("");
    expect(exact.isResetDue).toBe(false);

    // 刚过边界：恢复100%，无倒计时
    const after = formatQuotaWindow(w0, resetMs + 1000);
    expect(after.percentageText).toBe("100%");
    expect(after.fraction).toBe(1);
    expect(after.resetText).toBe("—");
    expect(after.shortResetText).toBe("");
    expect(after.isResetDue).toBe(false);

    // 0.25其他低值过期同样恢复100%
    const w25: QuotaWindow = {
      kind: "weekly",
      duration_minutes: 10080,
      remaining_fraction: 0.25,
      reset_at: resetIso,
      observed_at: "2026-09-23T12:00:00Z",
      status: "observed",
    };
    const res25 = formatQuotaWindow(w25, resetMs + 5000);
    expect(res25.percentageText).toBe("100%");
    expect(res25.fraction).toBe(1);
  });

  it("A03: 未来周时间：83%等实际值与正确倒计时；UTC/偏移表达同一时刻结果一致", () => {
    const nowMs = Date.parse("2026-09-24T12:00:00.000Z");
    const futureUtc = "2026-09-26T14:30:00.000Z";
    const futureOffset = "2026-09-26T22:30:00+08:00"; // 同一绝对时刻

    const wUtc: QuotaWindow = {
      kind: "weekly",
      duration_minutes: 10080,
      remaining_fraction: 0.83,
      reset_at: futureUtc,
      observed_at: "2026-09-24T10:00:00Z",
      status: "observed",
    };
    const resUtc = formatQuotaWindow(wUtc, nowMs);

    const wOffset: QuotaWindow = {
      kind: "weekly",
      duration_minutes: 10080,
      remaining_fraction: 0.83,
      reset_at: futureOffset,
      observed_at: "2026-09-24T10:00:00Z",
      status: "observed",
    };
    const resOffset = formatQuotaWindow(wOffset, nowMs);

    expect(resUtc.percentageText).toBe("83%");
    expect(resUtc.fraction).toBe(0.83);
    expect(resUtc.shortResetText).toBe("2d2h");
    expect(resUtc.resetText).toBe("2天2小时后重置");

    expect(resOffset).toEqual(resUtc);
  });

  it("A04: 缺失、missing/unsupported、null或非法额度、非空非法时间：不能误变满额", () => {
    // undefined
    expect(formatQuotaWindow(undefined).percentageText).toBe("待补测");
    // status !== "observed"
    expect(
      formatQuotaWindow({
        kind: "weekly",
        duration_minutes: 10080,
        remaining_fraction: 0.6,
        reset_at: null,
        observed_at: "2026-09-24T12:00:00Z",
        status: "missing",
      }).percentageText,
    ).toBe("待补测");
    // null 额度
    expect(
      formatQuotaWindow({
        kind: "weekly",
        duration_minutes: 10080,
        remaining_fraction: null,
        reset_at: null,
        observed_at: "2026-09-24T12:00:00Z",
        status: "observed",
      }).percentageText,
    ).toBe("待补测");
    // 非法额度 (<0 或 >1)
    expect(
      formatQuotaWindow({
        kind: "weekly",
        duration_minutes: 10080,
        remaining_fraction: -0.1,
        reset_at: null,
        observed_at: "2026-09-24T12:00:00Z",
        status: "observed",
      }).percentageText,
    ).toBe("待补测");
    // 非空非法时间：不能误变满额！保持原值
    const invalidTime = formatQuotaWindow({
      kind: "weekly",
      duration_minutes: 10080,
      remaining_fraction: 0.6,
      reset_at: "invalid-timestamp",
      observed_at: "2026-09-24T12:00:00Z",
      status: "observed",
    });
    expect(invalidTime.percentageText).toBe("60%");
    expect(invalidTime.fraction).toBe(0.6);
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

describe("AGY-WEEKLY-03 snapshot presentation", () => {
  const observedAt = "2026-09-24T12:00:00.000Z";
  const nowMs = Date.parse("2026-09-24T13:00:00.000Z");
  const weekly: QuotaWindow = {
    kind: "weekly",
    duration_minutes: 10080,
    remaining_fraction: 0.6,
    reset_at: null,
    observed_at: observedAt,
    status: "observed",
  };
  const short: QuotaWindow = {
    kind: "five_hour",
    duration_minutes: 300,
    remaining_fraction: 0.85,
    reset_at: "2026-09-24T14:00:00.000Z",
    observed_at: observedAt,
    status: "observed",
  };

  it.each([false, true, undefined])("keeps incomplete weekly observations raw with capability_verified=%s", (verified) => {
    const snapshot = { windows: [weekly], capability_verified: verified };
    expect(formatSnapshotQuotaWindow(snapshot, "weekly", nowMs)).toMatchObject({
      percentageText: "60%",
      fraction: 0.6,
      resetText: "—",
      shortResetText: "",
      isResetDue: false,
    });
    expect(snapshot.windows[0]).toEqual(weekly);
  });

  it.each([null, "", observedAt])("does not project complete but unverified snapshots with reset=%s", (resetAt) => {
    const snapshot = {
      windows: [{ ...weekly, reset_at: resetAt }, short],
      capability_verified: false,
    };
    const before = structuredClone(snapshot);
    expect(formatSnapshotQuotaWindow(snapshot, "weekly", nowMs)).toMatchObject({
      percentageText: "60%",
      fraction: 0.6,
      shortResetText: "",
      isResetDue: false,
    });
    expect(formatSnapshotQuotaWindow(snapshot, "five_hour", nowMs)).toEqual(formatQuotaWindow(short, nowMs));
    expect(snapshot).toEqual(before);
  });

  it("rejects invalid companion windows while preserving the valid weekly observation", () => {
    const snapshot = {
      windows: [weekly, { ...short, status: "missing" as const, remaining_fraction: null }],
      capability_verified: true,
    };
    expect(formatSnapshotQuotaWindow(snapshot, "weekly", nowMs).fraction).toBe(0.6);
    expect(formatSnapshotQuotaWindow(snapshot, "five_hour", nowMs).isUnknown).toBe(true);
  });

  it.each([true, undefined])("preserves reset boundaries and future quota for valid snapshots with capability_verified=%s", (verified) => {
    const snapshot: Pick<AgyQuotaSnapshot, "windows" | "capability_verified"> = {
      windows: [weekly, short],
      capability_verified: verified,
    };
    expect(formatSnapshotQuotaWindow(snapshot, "weekly", nowMs).fraction).toBe(1);
    const resetMs = nowMs + 3600_000;
    snapshot.windows = [{ ...weekly, reset_at: new Date(resetMs).toISOString() }, short];
    expect(formatSnapshotQuotaWindow(snapshot, "weekly", resetMs - 1).fraction).toBe(0.6);
    expect(formatSnapshotQuotaWindow(snapshot, "weekly", resetMs).fraction).toBe(1);
    expect(formatSnapshotQuotaWindow(snapshot, "weekly", resetMs + 1).shortResetText).toBe("");
    expect(formatSnapshotQuotaWindow(snapshot, "five_hour", nowMs)).toEqual(formatQuotaWindow(short, nowMs));
    expect(snapshot.windows[0]!.remaining_fraction).toBe(0.6);
  });

  it("keeps absent snapshots unknown", () => {
    expect(formatSnapshotQuotaWindow(undefined, "weekly", nowMs)).toMatchObject({
      percentageText: "待补测",
      fraction: null,
      isUnknown: true,
    });
  });
});
