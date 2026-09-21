import { describe, it, expect } from "vitest";
import { selectCandidates } from "../../packages/agy-accounts/src/selector.js";
import type { AgyAccount, AgyQuotaSnapshot } from "../../packages/contracts/src/agy-account.js";

describe("AGY Account Selector (AC-U04 & AC-U05)", () => {
  const now = Date.parse("2026-09-20T12:00:00.000Z");

  const buildAccount = (id: string, alias: string, state: any = "ready", lastUsed?: string): AgyAccount => ({
    id,
    realm_id: "default",
    revision: 1,
    alias,
    identity: { email: `${id}@example.com`, verified_at: "2026-09-01T00:00:00.000Z" },
    secret_ref: `vault-${id}`,
    credential_revision: 1,
    state,
    enrolled_at: "2026-09-01T00:00:00.000Z",
    last_used_at: lastUsed,
    auth: { has_refresh_credential: true, metadata_status: "verified", refresh_expiry_source: "not_provided" },
  });

  const buildSnapshot = (
    accountId: string,
    weeklyFraction: number,
    weeklyReset?: string,
    fiveHourFraction: number = 0.8,
  ): AgyQuotaSnapshot => ({
    id: `snap-${accountId}`,
    realm_id: "default",
    account_id: accountId,
    auth_epoch: 1,
    pool_id: "default",
    model_ids: ["gemini-2.5-pro"],
    source: "official_cli_usage",
    cli_version: "1.2.7",
    parser_revision: 1,
    observed_at: "2026-09-20T11:55:00.000Z",
    windows: [
      {
        kind: "weekly",
        duration_minutes: 10080,
        remaining_fraction: weeklyFraction,
        reset_at: weeklyReset ?? null,
        observed_at: "2026-09-20T11:55:00.000Z",
        status: "observed",
      },
      {
        kind: "five_hour",
        duration_minutes: 300,
        remaining_fraction: fiveHourFraction,
        reset_at: null,
        observed_at: "2026-09-20T11:55:00.000Z",
        status: "observed",
      },
    ],
  });

  it("ranks accounts with higher weekly quota first", () => {
    const a1 = buildAccount("acc-1", "Account 1");
    const a2 = buildAccount("acc-2", "Account 2");
    const a3 = buildAccount("acc-3", "Account 3");

    const snaps = [
      buildSnapshot("acc-1", 0.3),
      buildSnapshot("acc-2", 0.8),
      buildSnapshot("acc-3", 0.5),
    ];

    const result = selectCandidates([a1, a2, a3], snaps, ["default"], now);

    expect(result.ranked_candidates.map(c => c.account_id)).toEqual(["acc-2", "acc-3", "acc-1"]);
    expect(result.excluded_accounts).toHaveLength(0);
  });

  it("excludes an observed window whose remaining amount is unknown", () => {
    const snapshot = buildSnapshot("unknown", 0.9);
    snapshot.windows.find((w) => w.kind === "five_hour")!.remaining_fraction = null;
    const result = selectCandidates([buildAccount("unknown", "Unknown")], [snapshot], ["default"], now);
    expect(result.ranked_candidates).toEqual([]);
    expect(result.excluded_accounts[0]?.reason).toBe("missing_required_quota_pools");
  });

  it("projects an elapsed weekly window even if its last observed balance was positive", () => {
    const snapshot = buildSnapshot("reset", 0.2, new Date(now - 120_000).toISOString());
    const result = selectCandidates([buildAccount("reset", "Reset")], [snapshot], ["default"], now);
    expect(result.ranked_candidates[0]).toMatchObject({ projected_weekly: 1, is_projected_reset: true });
    expect(snapshot.windows[0]?.remaining_fraction).toBe(0.2);
  });

  it("requires recent refresh evidence for the strict night pool", () => {
    const account = buildAccount("old", "Old");
    account.auth.last_refresh_verified_at = new Date(now - 25 * 3600_000).toISOString();
    const result = selectCandidates([account], [buildSnapshot("old", 0.9)], ["default"], now, { is_night: true, night_pool: "strict", refresh_verified_max_age_hours: 24 });
    expect(result.ranked_candidates).toEqual([]);
  });

  it("breaks ties with LRU (earlier last_used_at gets priority)", () => {
    const a1 = buildAccount("acc-1", "Account 1", "ready", "2026-09-20T10:00:00.000Z");
    const a2 = buildAccount("acc-2", "Account 2", "ready", "2026-09-20T08:00:00.000Z"); // used earlier -> preferred
    const a3 = buildAccount("acc-3", "Account 3", "ready", undefined); // never used -> preferred most

    const snaps = [
      buildSnapshot("acc-1", 0.5),
      buildSnapshot("acc-2", 0.5),
      buildSnapshot("acc-3", 0.5),
    ];

    const result = selectCandidates([a1, a2, a3], snaps, ["default"], now);

    expect(result.ranked_candidates.map(c => c.account_id)).toEqual(["acc-3", "acc-2", "acc-1"]);
  });

  it("projects reset accounts as 100% available once reset timestamp + clockSkew passed", () => {
    const a1 = buildAccount("acc-1", "Depleted But Reset");
    const a2 = buildAccount("acc-2", "Normal 60%");

    // reset_at was 10 minutes ago, skew is 60s
    const passedReset = new Date(now - 10 * 60 * 1000).toISOString();

    const snaps = [
      buildSnapshot("acc-1", 0.0, passedReset),
      buildSnapshot("acc-2", 0.6),
    ];

    const result = selectCandidates([a1, a2], snaps, ["default"], now, { reset_clock_skew_seconds: 60 });

    expect(result.ranked_candidates[0]?.account_id).toBe("acc-1");
    expect(result.ranked_candidates[0]?.is_projected_reset).toBe(true);
    expect(result.ranked_candidates[0]?.projected_weekly).toBe(1);
    expect(result.ranked_candidates[1]?.account_id).toBe("acc-2");
  });

  it("excludes disabled, reauth_required and pending accounts", () => {
    const aReady = buildAccount("acc-ready", "Ready");
    const aDisabled = buildAccount("acc-disabled", "Disabled", "disabled");
    const aReauth = buildAccount("acc-reauth", "Reauth", "reauth_required");
    const aPending = buildAccount("acc-pending", "Pending", "pending_quota");

    const snaps = [buildSnapshot("acc-ready", 0.5)];

    const result = selectCandidates([aReady, aDisabled, aReauth, aPending], snaps, ["default"], now);

    expect(result.ranked_candidates).toHaveLength(1);
    expect(result.ranked_candidates[0]?.account_id).toBe("acc-ready");
    expect(result.excluded_accounts.map(e => e.reason)).toContain("account_disabled");
    expect(result.excluded_accounts.map(e => e.reason)).toContain("reauth_required");
    expect(result.excluded_accounts.map(e => e.reason)).toContain("pending_quota_initialization");
  });

  it("filters accounts by allowed_account_ids policy", () => {
    const a1 = buildAccount("acc-1", "Allowed");
    const a2 = buildAccount("acc-2", "Not Allowed");

    const snaps = [buildSnapshot("acc-1", 0.4), buildSnapshot("acc-2", 0.9)];

    const result = selectCandidates([a1, a2], snaps, ["default"], now, {
      allowed_account_ids: ["acc-1"],
    });

    expect(result.ranked_candidates).toHaveLength(1);
    expect(result.ranked_candidates[0]?.account_id).toBe("acc-1");
    expect(result.excluded_accounts.some(e => e.reason === "not_in_allowed_policy")).toBe(true);
  });

  it("computes next_eligible_at when all accounts are quota-exhausted", () => {
    const a1 = buildAccount("acc-1", "Acc 1");
    const a2 = buildAccount("acc-2", "Acc 2");

    const future1 = new Date(now + 3600 * 1000).toISOString(); // +1 hour
    const future2 = new Date(now + 7200 * 1000).toISOString(); // +2 hours

    const snaps = [
      buildSnapshot("acc-1", 0.0, future1),
      buildSnapshot("acc-2", 0.0, future2),
    ];

    const result = selectCandidates([a1, a2], snaps, ["default"], now, { reset_clock_skew_seconds: 60 });

    expect(result.ranked_candidates).toHaveLength(0);
    expect(result.excluded_accounts).toHaveLength(2);
    expect(result.next_eligible_at).toBe(new Date(now + 3600 * 1000 + 60000).toISOString());
  });
});
