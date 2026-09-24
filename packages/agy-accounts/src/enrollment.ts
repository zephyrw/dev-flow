import { randomUUID } from "node:crypto";
import type {
  AgyAccount,
  AgyQuotaSnapshot,
  AccountState,
} from "../../contracts/src/agy-account.js";
import type { AgyAccountRepository } from "./repository.js";
import type { AuthHostPort, AccountProbePort, AccountProbeResult } from "./ports.js";
import { hasDualQuotaWindows, modelCovered } from "./quota.js";
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
  onCaptured?: (data: {
    account: Pick<AgyAccount, "id" | "state">;
    secret_ref: string;
    credential_revision: number;
  }) => void;
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
    if (!active.exists) return { success: false, error: "active_credential_missing" };

    // 先独立保存候选凭据；本地 claim 不会覆盖任何现有账号。
    const candidateId = "acc_" + randomUUID();
    const captured = await this.authHost.captureActive(realmId, candidateId);
    const pending = {
      operation_id: context.operation_id,
      realm_id: realmId,
      account_id: candidateId,
      claimed_email: active.auth?.email,
      secret_ref: captured.secret_ref,
      credential_revision: captured.credential_revision,
      status: "pending_identity",
      created_at: new Date().toISOString(),
    };
    this.repository.transaction(() => {
      this.repository.putRecord("agy_pending_enrollment", context.operation_id, realmId, pending);
      context.onCaptured?.({
        account: { id: candidateId, state: "pending_quota" },
        secret_ref: captured.secret_ref,
        credential_revision: captured.credential_revision,
      });
    });
    this.requireContext(realmId, context);

    let identity: { email: string; subject?: string; cli_version?: string; raw_output?: string } | undefined;
    try {
      identity = await this.probe.probeIdentity({ signal: context.signal });
    } catch (error: any) {
      if (error?.code === "PROCESS_STOP_UNCONFIRMED" || error?.name === "ProcessStopUnconfirmedError") throw error;
      const activeAuth = captured.auth?.email ? captured.auth : (await this.authHost.inspectActive(realmId)).auth;
      const fallbackEmail = activeAuth?.email;
      if (fallbackEmail) {
        identity = { email: fallbackEmail, subject: activeAuth?.subject, cli_version: "verified", raw_output: "" };
      } else {
        this.requireContext(realmId, context);
        return { success: false, error: "account_identity_unverified" };
      }
    }
    const email = identity.email.trim().toLowerCase();
    if (!email || (expected && expected.identity.email.toLowerCase() !== email)) {
      return { success: false, error: "account_identity_mismatch" };
    }
    const existing = expected ?? this.repository.listAccounts(realmId)
      .find((account) => account.identity.email.toLowerCase() === email);
    let observation: AccountProbeResult | undefined;
    try {
      observation = await this.probe.probeUsage({
        signal: context.signal,
        model_id: context.model_id,
        account_id: candidateId,
        credential_revision: captured.credential_revision,
      });
    } catch (error: any) {
      if (error?.code === "PROCESS_STOP_UNCONFIRMED" || error?.name === "ProcessStopUnconfirmedError") throw error;
    }
    this.requireContext(realmId, context);
    if (observation?.email && observation.email.toLowerCase() !== email) {
      return { success: false, error: "account_identity_mismatch" };
    }
    const verified = Boolean(observation?.capability_verified && observation.executable_fingerprint);
    // 已有账号在远端核验失败时保持原样，候选包与操作记录保留用于后续处理。
    if (existing && !verified) {
      return { success: false, error: "quota_capability_unavailable" };
    }
    const pools = verified ? observation!.pools.filter((pool) =>
      pool.model_ids.length > 0 && (!context.model_id || modelCovered(pool.model_ids, context.model_id!))) : [];
    const complete = pools.length > 0 && pools.every((pool) => hasDualQuotaWindows(pool.windows));
    if (existing && !complete) return { success: false, error: "quota_capability_unavailable" };

    const accountId = existing?.id ?? candidateId;
    // 只在身份核验后将保存包绑定到最终账号 ID，旧 secret_ref 尚未改变。
    const accepted = await this.authHost.captureActive(realmId, accountId);
    this.requireContext(realmId, context);
    const timestamp = new Date().toISOString();
    const state: AccountState = !complete ? "pending_quota" :
      pools.some((pool) => pool.windows.some((window) => window.remaining_fraction === 0))
        ? "waiting_quota" : "ready";
    const account: AgyAccount = {
      ...existing,
      id: accountId,
      realm_id: realmId,
      revision: (existing?.revision ?? 0) + 1,
      alias: alias || existing?.alias || email.split("@")[0]!,
      identity: { email, ...(identity.subject ? { subject: identity.subject } : {}), verified_at: timestamp },
      secret_ref: accepted.secret_ref,
      credential_revision: accepted.credential_revision,
      state: existing?.state === "disabled" ? "disabled" : state,
      state_before_disabled: existing?.state === "disabled" ? state : existing?.state_before_disabled,
      enrolled_at: existing?.enrolled_at ?? timestamp,
      enrollment_completed_at: complete ? timestamp : undefined,
      auth: {
        has_refresh_credential: accepted.auth?.has_refresh_credential ?? null,
        refresh_expiry_source: accepted.auth?.refresh_expiry_source ?? "not_provided",
        access_expires_at: accepted.auth?.access_expires_at,
        refresh_expires_at: accepted.auth?.refresh_expires_at,
        metadata_status: "unverified",
        last_authenticated_request_at: timestamp,
        email,
        ...(identity.subject ? { subject: identity.subject } : {}),
      },
    };
    const snapshots: AgyQuotaSnapshot[] = pools.map((pool) => ({
      id: "snp_" + randomUUID(), realm_id: realmId, account_id: accountId,
      auth_epoch: context.auth_epoch, pool_id: pool.pool_id, model_ids: pool.model_ids,
      plan_tier: observation?.plan_tier, source: "official_cli_usage",
      cli_version: observation!.cli_version, executable_fingerprint: observation!.executable_fingerprint,
      capability_verified: true, parser_revision: 2, observed_at: timestamp, windows: pool.windows,
    }));
    this.repository.transaction(() => {
      if (existing && this.repository.getAccount(realmId, existing.id)?.revision !== existing.revision)
        throw new Error("account_revision_conflict");
      this.repository.retainQuotaPools(realmId, accountId, pools.map((pool) => pool.pool_id));
      for (const snapshot of snapshots) this.repository.saveQuotaSnapshot(snapshot);
      this.repository.saveAccount(account);
      this.repository.putRecord("agy_pending_enrollment", context.operation_id, realmId, {
        ...pending, status: "committed", committed_account_id: accountId,
      });
      context.onCaptured?.({ account, secret_ref: accepted.secret_ref, credential_revision: accepted.credential_revision });
    });
    return { success: true, account, snapshot: snapshots[0] };
  }
  cancelLogin(): void {
    this.loginLauncher.cancelLogin();
  }
}
