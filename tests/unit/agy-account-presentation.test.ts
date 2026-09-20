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
});
