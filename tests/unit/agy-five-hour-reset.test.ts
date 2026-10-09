import { describe, expect, it } from "vitest";
import type { AgyQuotaSnapshot, QuotaWindow } from "../../packages/contracts/src/agy-account.js";
import { computeEffectiveFiveHourQuota, resolveEffectiveAccountState, resolveEffectiveQuotaWindows } from "../../packages/agy-accounts/src/quota.js";
import { formatSnapshotQuotaWindow, effectiveRuntimeQuotaWindows } from "../../packages/presentation/src/agy-accounts.js";
import { evaluateAccountForDemand } from "../../packages/agy-accounts/src/selector.js";
import { AgyAccountSchema } from "../../packages/contracts/src/agy-account.js";

const reset = Date.parse("2026-10-09T08:00:00Z");
const observed = "2026-10-09T07:00:00Z";
function snapshot(resetAt: string | null = new Date(reset).toISOString()): AgyQuotaSnapshot {
  return {
    id: "snapshot", realm_id: "realm", account_id: "account", auth_epoch: 1,
    pool_id: "Gemini Models", model_ids: ["gemini-*"], source: "official_cli_usage",
    cli_version: "1.3.1", parser_revision: 1, executable_fingerprint: "fixture",
    capability_verified: true, observed_at: observed,
    windows: [
      { kind: "weekly", duration_minutes: 10080, remaining_fraction: 1, reset_at: null, observed_at: observed, status: "observed" },
      { kind: "five_hour", duration_minutes: 300, remaining_fraction: 0, reset_at: resetAt, observed_at: observed, status: "observed" },
    ],
  };
}
const account = AgyAccountSchema.parse({
  id: "account", realm_id: "realm", alias: "Account", identity: { email: "account@example.com", verified_at: observed },
  secret_ref: "fixture", credential_revision: 1, state: "waiting_quota", enrolled_at: observed, auth: { refresh_expiry_source: "not_provided" },
});

describe("five-hour quota reset", () => {
  it.each([reset, reset + 1, reset + 9 * 86400_000])("projects an elapsed reset at %s consistently without changing observations", now => {
    const snap = snapshot();
    const original = structuredClone(snap);
    expect(resolveEffectiveQuotaWindows(snap.windows, now)[1]).toMatchObject({ remaining_fraction: 1, reset_at: null });
    expect(formatSnapshotQuotaWindow(snap, "five_hour", now)).toMatchObject({ percentageText: "100%", fraction: 1, shortResetText: "", isZero: false });
    expect(resolveEffectiveAccountState(account, [snap], now)).toBe("ready");
    expect(snap).toEqual(original);
  });

  it("retains zero and a countdown before reset, and unknown resets require verification", () => {
    expect(formatSnapshotQuotaWindow(snapshot(), "five_hour", reset - 1)).toMatchObject({ percentageText: "0%", shortResetText: "<1m" });
    expect(resolveEffectiveAccountState(account, [snapshot()], reset - 1)).toBe("waiting_quota");
    for (const time of [null, "invalid"]) {
      expect(formatSnapshotQuotaWindow(snapshot(time), "five_hour", reset)).toMatchObject({ percentageText: "0%", shortResetText: "待核验" });
      expect(resolveEffectiveAccountState(account, [snapshot(time)], reset)).toBe("pending_quota");
    }
    expect(resolveEffectiveAccountState(account, [], reset)).toBe("pending_quota");
  });

  it("does not turn incomplete or unverified observations into full quota", () => {
    const snap = snapshot();
    snap.capability_verified = false;
    expect(formatSnapshotQuotaWindow(snap, "five_hour", reset)).toMatchObject({ fraction: 0, shortResetText: "待核验" });
    expect(resolveEffectiveAccountState(account, [snap], reset)).toBe("pending_quota");
    snap.capability_verified = true;
    snap.windows = snap.windows.filter(window => window.kind === "five_hour");
    expect(resolveEffectiveQuotaWindows(snap.windows, reset)[0]?.remaining_fraction).toBe(0);
    expect(formatSnapshotQuotaWindow(snap, "five_hour", reset).fraction).toBe(0);
    for (const state of ["disabled", "reauth_required", "incompatible"] as const) {
      expect(resolveEffectiveAccountState({ ...account, state }, [snapshot()], reset)).toBe(state);
    }
  });

  it("recovers partial quota and honours the admission clock skew without issuing permits", () => {
    const snap = snapshot();
    snap.windows[1]!.remaining_fraction = 0.3;
    expect(computeEffectiveFiveHourQuota(snap.windows[1], reset, 60_000).fraction).toBe(0.3);
    expect(computeEffectiveFiveHourQuota(snap.windows[1], reset + 60_000, 60_000).fraction).toBe(1);
    const evaluation = evaluateAccountForDemand({ account, snapshots: [snap], evaluationTime: reset + 60_000,
      policy: { required_pool_ids: ["Gemini Models"], required_model_ids: ["gemini-test"] } });
    expect(evaluation).toMatchObject({ min_five_hour: 1, eligible_for_candidate: true, eligible_for_permit: false, is_projected_reset: true });
    snap.windows[1]!.remaining_fraction = 0;
    expect(evaluateAccountForDemand({ account, snapshots: [snap], evaluationTime: reset + 60_000,
      policy: { required_pool_ids: ["Gemini Models"], required_model_ids: ["gemini-test"] } })).toMatchObject({
        min_five_hour: 1, eligible_for_candidate: true, eligible_for_permit: false,
      });
  });

  it("rejects malformed window observations", () => {
    const short = snapshot().windows[1]!;
    for (const remaining of [NaN, -1, 2, null]) {
      expect(computeEffectiveFiveHourQuota({ ...short, remaining_fraction: remaining }, reset).isValid).toBe(false);
    }
    expect(computeEffectiveFiveHourQuota({ ...short, status: "missing" }, reset).isValid).toBe(false);
    expect(computeEffectiveFiveHourQuota(undefined, reset).isValid).toBe(false);
    const weekly: QuotaWindow = snapshot().windows[0]!;
    expect(computeEffectiveFiveHourQuota(weekly, reset).isValid).toBe(false);
  });

  it("projects runtime five-hour quota while leaving other adapters unchanged", () => {
    const bucket = { id: "gemini", windows: [
      { window_minutes: 10080, used_percent: 0 },
      { window_minutes: 300, used_percent: 100, resets_at: reset / 1000 },
    ] };
    expect(effectiveRuntimeQuotaWindows(bucket, "agy", observed, reset)[1]).toMatchObject({ used_percent: 0, resets_at: undefined });
    expect(effectiveRuntimeQuotaWindows(bucket, "codex", observed, reset)).toEqual(bucket.windows);
  });
});
