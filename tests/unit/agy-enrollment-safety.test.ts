import { describe, it, expect, vi } from "vitest";
import { AgyEnrollmentService } from "../../packages/agy-accounts/src/enrollment.js";
import type { AgyAccountRepository } from "../../packages/agy-accounts/src/repository.js";
import type { AuthHostPort, AccountProbePort, AccountProbeResult } from "../../packages/agy-accounts/src/ports.js";
import type { AgyAccount } from "../../packages/contracts/src/agy-account.js";

const context = { operation_id: "operation", auth_epoch: 4, signal: new AbortController().signal, model_id: "m" };
function setup(observation: Partial<AccountProbeResult> = {}) {
  const stored: AgyAccount[] = [];
  const repository = { getAccount: (_realm: string, id: string) => stored.find(account => account.id === id),
    listAccounts: () => stored, saveAccount: vi.fn((account: AgyAccount) => stored.push(account)),
    saveQuotaSnapshot: vi.fn(), transaction: <T>(fn: () => T) => fn() };
  const auth = { isDomainLockHeld: () => true, inspectActive: async () => ({ exists: true }),
    captureActive: vi.fn(async () => ({ secret_ref: "sec_saved", credential_revision: 3 })),
    clearActiveForLogin: vi.fn(), restoreBackup: vi.fn() };
  const probe = { probeUsage: vi.fn(async (): Promise<AccountProbeResult> => ({ email: "a@example.com", cli_version: "unknown",
    windows: [], pools: [], executable_fingerprint: "", capability_verified: false, raw_output: "", ...observation })) };
  const service = new AgyEnrollmentService(repository as unknown as AgyAccountRepository,
    auth as unknown as AuthHostPort, probe as unknown as AccountProbePort);
  return { service, auth, repository, stored };
}
describe("enrollment safety under a durable operation", () => {
  const verifiedObservation: Partial<AccountProbeResult> = {
    cli_version: "synthetic-verified-version", executable_fingerprint: "synthetic-verified-fingerprint", capability_verified: true,
    pools: [{ pool_id: "synthetic-pool", model_ids: ["m"], windows: [
      { kind: "weekly", duration_minutes: 10080, remaining_fraction: 0.7, status: "observed", observed_at: "2026-09-20T00:00:00Z", reset_at: "2026-09-27T00:00:00Z" },
      { kind: "five_hour", duration_minutes: 300, remaining_fraction: 0.6, status: "observed", observed_at: "2026-09-20T00:00:00Z", reset_at: "2026-09-20T05:00:00Z" },
    ] }],
  };
  it("preserves observed capability and executable fingerprint in the first completed enrollment snapshot", async () => {
    const { service, repository } = setup(verifiedObservation);
    const result = await service.enrollCurrentAccount("realm", "alias", context);
    expect(result.account?.state).toBe("ready");
    expect(repository.saveQuotaSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      executable_fingerprint: verifiedObservation.executable_fingerprint, capability_verified: true,
      cli_version: verifiedObservation.cli_version, model_ids: ["m"], pool_id: "synthetic-pool",
    }));
  });
  it("does not complete enrollment without the observed executable binding", async () => {
    const { service, repository } = setup({ ...verifiedObservation, executable_fingerprint: "" });
    const result = await service.enrollCurrentAccount("realm", "alias", context);
    expect(result.account?.state).toBe("pending_quota");
    expect(repository.saveQuotaSnapshot).not.toHaveBeenCalled();
  });
  it("saves identity with missing quota as pending without fake pool or refresh proof", async () => {
    const { service, repository } = setup();
    const result = await service.enrollCurrentAccount("realm", "alias", context);
    expect(result.account).toMatchObject({ state: "pending_quota", credential_revision: 3,
      auth: { has_refresh_credential: false, refresh_expiry_source: "not_provided" } });
    expect(result.account?.enrollment_completed_at).toBeUndefined();
    expect(result.account?.auth.last_refresh_verified_at).toBeUndefined();
    expect(repository.saveQuotaSnapshot).not.toHaveBeenCalled();
  });
  it("rejects a client-supplied different identity before any login or credential mutation", async () => {
    const { service, auth, stored } = setup();
    stored.push({ id: "a", identity: { email: "a@example.com" } } as AgyAccount);
    expect(await service.reauthAccount("realm", "a", "b@example.com", context))
      .toMatchObject({ success: false, error: "expected_identity_conflict" });
    expect(auth.captureActive).not.toHaveBeenCalled();
    expect(auth.clearActiveForLogin).not.toHaveBeenCalled();
  });
  it("does not perform credential rollback from the enrollment component", async () => {
    const { service, auth } = setup();
    expect(await service.enrollNewAccount("realm", "alias", context))
      .toMatchObject({ success: false, error: "interactive_login_capability_unverified" });
    expect(auth.clearActiveForLogin).not.toHaveBeenCalled();
    expect(auth.restoreBackup).not.toHaveBeenCalled();
  });
});
