import { describe, it, expect } from "vitest";
import { computeDomainWait } from "../../packages/agy-accounts/src/wait-policy.js";
import type { AgyAccount, AgyQuotaSnapshot } from "../../packages/contracts/src/agy-account.js";

describe("AGY Domain Wait Policy (AC-U06)", () => {
  const now = Date.parse("2026-09-20T12:00:00.000Z");

  const buildAccount = (id: string, state: any = "ready"): AgyAccount => ({
    id,
    realm_id: "default",
    revision: 1,
    alias: id,
    identity: { email: `${id}@example.com`, verified_at: "2026-09-01T00:00:00.000Z" },
    secret_ref: `vault-${id}`,
    credential_revision: 1,
    state,
    enrolled_at: "2026-09-01T00:00:00.000Z",
    auth: { has_refresh_credential: true, refresh_expiry_source: "not_provided" },
  });

  const buildSnapshotWithWindows = (
    accountId: string,
    windows: Array<{ kind: "weekly" | "five_hour"; remaining: number; resetAt?: string | null }>,
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
    observed_at: "2026-09-20T11:59:00.000Z",
    windows: windows.map(w => ({
      kind: w.kind,
      duration_minutes: w.kind === "weekly" ? 10080 : 300,
      remaining_fraction: w.remaining,
      reset_at: w.resetAt ?? null,
      observed_at: "2026-09-20T11:59:00.000Z",
      status: "observed",
    })),
  });

  it("calculates max(resets) for a single account with multiple exhausted windows", () => {
    const acc = buildAccount("acc-1");
    // 5-hour window resets in 30 mins, weekly window resets in 2 hours
    const r5h = new Date(now + 30 * 60 * 1000).toISOString();
    const rWk = new Date(now + 2 * 3600 * 1000).toISOString();

    const snap = buildSnapshotWithWindows("acc-1", [
      { kind: "five_hour", remaining: 0, resetAt: r5h },
      { kind: "weekly", remaining: 0, resetAt: rWk },
    ]);

    const result = computeDomainWait([acc], [snap], ["default"], now, { clockSkewSeconds: 60 });

    expect(result.should_wait).toBe(true);
    // Should wait until weekly reset + 60s
    const expected = new Date(now + 2 * 3600 * 1000 + 60000).toISOString();
    expect(result.next_eligible_at).toBe(expected);
  });

  it("calculates min across multiple accounts in the pool", () => {
    const a1 = buildAccount("acc-1");
    const a2 = buildAccount("acc-2");

    // a1 available in 3 hours
    const r1 = new Date(now + 3 * 3600 * 1000).toISOString();
    // a2 available in 45 mins -> min
    const r2 = new Date(now + 45 * 60 * 1000).toISOString();

    const snap1 = buildSnapshotWithWindows("acc-1", [
      { kind: "weekly", remaining: 0, resetAt: r1 },
    ]);
    const snap2 = buildSnapshotWithWindows("acc-2", [
      { kind: "five_hour", remaining: 0, resetAt: r2 },
      { kind: "weekly", remaining: 0.5, resetAt: null },
    ]);

    const result = computeDomainWait([a1, a2], [snap1, snap2], ["default"], now, { clockSkewSeconds: 60 });

    expect(result.should_wait).toBe(true);
    const expected = new Date(now + 45 * 60 * 1000 + 60000).toISOString();
    expect(result.next_eligible_at).toBe(expected);
  });

  it("returns null next_eligible_at if all accounts lack known reset timestamps", () => {
    const a1 = buildAccount("acc-1");
    const aDisabled = buildAccount("acc-2", "disabled");

    // a1 exhausted but reset_at is null
    const snap1 = buildSnapshotWithWindows("acc-1", [
      { kind: "weekly", remaining: 0, resetAt: null },
    ]);

    const result = computeDomainWait([a1, aDisabled], [snap1], ["default"], now);

    expect(result.should_wait).toBe(true);
    expect(result.next_eligible_at).toBeNull();
    expect(result.reason).toBe("all_accounts_exhausted_or_blocked_without_known_reset");
  });
});
