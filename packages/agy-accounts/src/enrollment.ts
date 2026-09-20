import { randomUUID } from "node:crypto";
import type {
  AgyAccount,
  AgyQuotaSnapshot,
  AccountState,
} from "../../contracts/src/agy-account.js";
import type { AgyAccountRepository } from "./repository.js";
import type { AuthHostPort, AccountProbePort } from "./ports.js";
import { AgyLoginLauncher } from "./login.js";
export interface EnrollmentResult {
  success: boolean;
  account?: AgyAccount;
  snapshot?: AgyQuotaSnapshot;
  error?: string;
  blocked?: boolean;
}
export interface EnrollmentContext {
  operation_id: string;
  auth_epoch: number;
  signal: AbortSignal;
  model_id?: string;
}
/** Invoked only inside the service's durable exclusive operation. It never clears/restores credentials. */
export class AgyEnrollmentService {
  constructor(
    private repository: AgyAccountRepository,
    private authHost: AuthHostPort,
    private probe: AccountProbePort,
    private loginLauncher = new AgyLoginLauncher(),
  ) {}
  isLoginAvailable(): boolean {
    return this.loginLauncher.available;
  }
  private requireContext(realmId: string, context: EnrollmentContext) {
    if (
      !context?.operation_id ||
      !Number.isSafeInteger(context.auth_epoch) ||
      context.auth_epoch < 1
    )
      throw new Error("enrollment_operation_required");
    context.signal.throwIfAborted();
    if (!this.authHost.isDomainLockHeld(realmId))
      throw new Error("domain_lock_not_held");
  }
  async enrollCurrentAccount(
    realmId: string,
    alias: string,
    context: EnrollmentContext,
  ): Promise<EnrollmentResult> {
    return this.capture(realmId, alias, context);
  }
  async enrollNewAccount(
    realmId: string,
    alias: string,
    context: EnrollmentContext,
  ): Promise<EnrollmentResult> {
    this.requireContext(realmId, context);
    const login = await this.loginLauncher.startInteractiveLogin({
      signal: context.signal,
    });
    if (!login.completed)
      return {
        success: false,
        blocked: !login.fully_stopped,
        error:
          login.error ??
          (login.timed_out ? "login_timeout" : "login_cancelled"),
      };
    return this.capture(realmId, alias, context);
  }
  async reauthAccount(
    realmId: string,
    accountId: string,
    expectedEmail: string,
    context: EnrollmentContext,
  ): Promise<EnrollmentResult> {
    this.requireContext(realmId, context);
    const account = this.repository.getAccount(realmId, accountId);
    if (!account) return { success: false, error: "account_not_found" };
    if (
      account.identity.email.toLowerCase() !==
      expectedEmail.trim().toLowerCase()
    )
      return { success: false, error: "expected_identity_conflict" };
    const login = await this.loginLauncher.startInteractiveLogin({
      signal: context.signal,
    });
    if (!login.completed)
      return {
        success: false,
        blocked: !login.fully_stopped,
        error: login.error ?? "login_incomplete",
      };
    return this.capture(realmId, account.alias, context, account);
  }
  private async capture(
    realmId: string,
    alias: string,
    context: EnrollmentContext,
    expected?: AgyAccount,
  ): Promise<EnrollmentResult> {
    this.requireContext(realmId, context);
    const active = await this.authHost.inspectActive(realmId);
    if (!active.exists)
      return { success: false, error: "active_credential_missing" };
    const observation = await this.probe.probeUsage({
      signal: context.signal,
      model_id: context.model_id,
    });
    this.requireContext(realmId, context);
    if (!observation.email)
      return { success: false, error: "account_identity_unverified" };
    const email = observation.email.trim().toLowerCase();
    if (expected && expected.identity.email.toLowerCase() !== email)
      return { success: false, error: "account_identity_mismatch" };
    const existing =
      expected ??
      this.repository
        .listAccounts(realmId)
        .find((account) => account.identity.email.toLowerCase() === email);
    if (
      expected &&
      this.repository.getAccount(realmId, expected.id)?.revision !==
        expected.revision
    )
      return { success: false, error: "account_revision_conflict" };
    const accountId = existing?.id ?? "acc_" + randomUUID();
    const captured = await this.authHost.captureActive(realmId, accountId);
    this.requireContext(realmId, context);
    const pools = observation.capability_verified && !!observation.executable_fingerprint
      ? observation.pools.filter(
          (pool) =>
            !context.model_id || pool.model_ids.includes(context.model_id),
        )
      : [];
    const complete =
      pools.length > 0 &&
      pools.every((pool) =>
        ["weekly", "five_hour"].every(
          (kind) =>
            pool.windows.filter(
              (window) =>
                window.kind === kind &&
                window.status === "observed" &&
                typeof window.remaining_fraction === "number" &&
                window.remaining_fraction >= 0 &&
                window.remaining_fraction <= 1 &&
                !!window.reset_at &&
                Number.isFinite(Date.parse(window.reset_at)),
            ).length === 1,
        ),
      );
    const state: AccountState = !complete
      ? "pending_quota"
      : pools.some((pool) =>
            pool.windows.some((window) => window.remaining_fraction === 0),
          )
        ? "waiting_quota"
        : "ready";
    const now = new Date().toISOString();
    const account: AgyAccount = {
      id: accountId,
      realm_id: realmId,
      revision: (existing?.revision ?? 0) + 1,
      alias: alias || existing?.alias || email.split("@")[0]!,
      identity: { email, verified_at: now },
      secret_ref: captured.secret_ref,
      credential_revision: captured.credential_revision,
      state: existing?.state === "disabled" ? "disabled" : state,
      disabled_reason:
        existing?.state === "disabled" ? existing.disabled_reason : undefined,
      enrolled_at: existing?.enrolled_at ?? now,
      enrollment_completed_at: complete ? now : undefined,
      auth: {
        has_refresh_credential: false,
        refresh_expiry_source: "not_provided",
        ...captured.auth,
        last_authenticated_request_at: now,
        last_auth_error: undefined,
        last_refresh_verified_at: undefined,
      },
    };
    // Interactive authentication proves a request, not refresh of an expired access token.
    const snapshots: AgyQuotaSnapshot[] = pools.map((pool) => ({
      id: "snp_" + randomUUID(),
      realm_id: realmId,
      account_id: accountId,
      auth_epoch: context.auth_epoch,
      pool_id: pool.pool_id,
      model_ids: pool.model_ids,
      plan_tier: observation.plan_tier,
      source: "official_cli_usage",
      cli_version: observation.cli_version,
      executable_fingerprint: observation.executable_fingerprint,
      capability_verified: observation.capability_verified,
      parser_revision: 2,
      observed_at: now,
      windows: pool.windows,
    }));
    this.repository.transaction(() => {
      if (
        existing &&
        this.repository.getAccount(realmId, existing.id)?.revision !==
          existing.revision
      )
        throw new Error("account_revision_conflict");
      for (const snapshot of snapshots)
        this.repository.saveQuotaSnapshot(snapshot);
      this.repository.saveAccount(account);
    });
    return { success: true, account, snapshot: snapshots[0] };
  }
  cancelLogin(): void {
    this.loginLauncher.cancelLogin();
  }
}
