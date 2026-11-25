import { randomUUID } from "node:crypto";
import type {
  AgyAccount,
  AgyQuotaSnapshot,
  AccountState,
} from "../../contracts/src/agy-account.js";
import type { AgyAccountRepository } from "./repository.js";
import type { AuthHostPort, AccountProbePort, AccountProbeResult } from "./ports.js";
import { isQuotaPoolVerified, quotaPoolCoversModel } from "./quota.js";
import { AgyLoginLauncher } from "./login.js";
export interface EnrollmentResult {
  success: boolean;
  account?: AgyAccount;
  snapshot?: AgyQuotaSnapshot;
  error?: string;
  blocked?: boolean;
  session_kept?: boolean;
}
export interface EnrollmentContext {
  operation_id: string;
  auth_epoch: number;
  signal: AbortSignal;
  model_id?: string;
  keep_session_on_success?: boolean;
  onCurrentSaved?: (account: AgyAccount, alreadyManaged: boolean) => void;
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
    return this.capture(realmId, alias, context, undefined, true);
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
    const normalizedExpected = expectedEmail.trim().toLowerCase();
    if (account.identity.email.toLowerCase() !== normalizedExpected)
      return { success: false, error: "expected_identity_conflict" };
    let nextIdentityProbe = 0;
    const checkCredentialReady = async (): Promise<{
      status: "waiting" | "ready" | "mismatch";
      error?: string;
    }> => {
      if (context.signal.aborted) return { status: "waiting" };
      const first = await this.authHost.inspectActive(realmId);
      if (!first.exists || first.auth?.metadata_status === "unrecognized") {
        return { status: "waiting" };
      }
      // 200ms stability debounce to ensure CLI finished writing the credential.
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (context.signal.aborted) return { status: "waiting" };
      const second = await this.authHost.inspectActive(realmId);
      if (!second.exists || second.auth?.metadata_status === "unrecognized") {
        return { status: "waiting" };
      }
      let email = second.auth?.email?.trim().toLowerCase();
      let subject = second.auth?.subject;
      if (!email && Date.now() >= nextIdentityProbe) {
        nextIdentityProbe = Date.now() + 5_000;
        try {
          const probed = await this.probe.probeIdentity({ signal: context.signal });
          email = probed.email?.trim().toLowerCase();
          subject = probed.subject ?? subject;
        } catch {
          return { status: "waiting" };
        }
      }
      if (!email) return { status: "waiting" };
      if (
        email !== normalizedExpected ||
        (account.identity.subject && subject && account.identity.subject !== subject)
      ) {
        return { status: "mismatch", error: "account_identity_mismatch" };
      }
      return { status: "ready" };
    };
    let captured: EnrollmentResult | undefined;
    const login = await this.loginLauncher.startInteractiveLogin({
      signal: context.signal,
      keepSessionOnSuccess: context.keep_session_on_success,
      checkCredentialReady,
      saveBeforeDetach: async () => {
        captured = await this.capture(realmId, account.alias, context, account);
        if (!captured.success) throw new Error(captured.error ?? "enrollment_failed");
      },
    });
    if (!login.completed)
      return {
        success: false,
        blocked: !login.fully_stopped && !login.session_kept,
        error: login.error ?? "login_incomplete",
      };
    return {
      ...(captured ?? await this.capture(realmId, account.alias, context, account)),
      ...(login.session_kept ? { session_kept: true } : {}),
    };
  }
  private async capture(
    realmId: string,
    alias: string,
    context: EnrollmentContext,
    expected?: AgyAccount,
    currentOnly = false,
  ): Promise<EnrollmentResult> {
    this.requireContext(realmId, context);
    const active = await this.authHost.inspectActive(realmId);
    if (!active.exists) return { success: false, error: "active_credential_missing" };
    const identityOnly = currentOnly || Boolean(expected);

    // 先独立保存候选凭据；本地 claim 不会覆盖任何现有账号。
    const candidateId = expected ? expected.id : "acc_" + randomUUID();
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
    if (!currentOnly) this.repository.transaction(() => {
      this.repository.putRecord("agy_pending_enrollment", context.operation_id, realmId, pending);
      if (!expected) context.onCaptured?.({
        account: { id: candidateId, state: "pending_quota" },
        secret_ref: captured.secret_ref,
        credential_revision: captured.credential_revision,
      });
    });
    this.requireContext(realmId, context);

    let identity: { email: string; subject?: string };
    try {
      identity = identityOnly && captured.auth?.email
        ? { email: captured.auth.email, subject: captured.auth.subject }
        : await this.probe.probeIdentity({ signal: context.signal });
    } catch (error: any) {
      if (error?.code === "PROCESS_STOP_UNCONFIRMED" || error?.name === "ProcessStopUnconfirmedError") throw error;
      const activeAuth = captured.auth?.email ? captured.auth : (await this.authHost.inspectActive(realmId)).auth;
      const fallbackEmail = activeAuth?.email;
      if (fallbackEmail) {
        identity = { email: fallbackEmail, subject: activeAuth?.subject };
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
    if (!identityOnly) try {
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
    if (existing && !identityOnly && !verified) {
      return { success: false, error: "quota_capability_unavailable" };
    }
    const pools = verified ? observation!.pools : [];
    const targetPools = pools.filter(pool => !context.model_id || quotaPoolCoversModel(pool, context.model_id));
    const validPools = pools.filter(pool => isQuotaPoolVerified(observation!, pool));
    const complete = context.model_id
      ? targetPools.length > 0 && targetPools.every(pool => isQuotaPoolVerified(observation!, pool))
      : validPools.length > 0;
    if (existing && !identityOnly && !complete) return { success: false, error: "quota_capability_unavailable" };

    const accountId = existing?.id ?? candidateId;
    // 只在身份核验后将保存包绑定到最终账号 ID，旧 secret_ref 尚未改变。
    const accepted = (currentOnly && !existing) || expected ? captured : await this.authHost.captureActive(realmId, accountId);
    if (identityOnly) {
      const latest = await this.authHost.inspectActive(realmId);
      if (!latest.exists) return { success: false, error: "active_credential_missing" };
      if ((existing?.identity.subject && identity.subject && existing.identity.subject !== identity.subject) ||
          [accepted.auth, latest.auth].some(auth =>
            (auth?.email && auth.email.trim().toLowerCase() !== email) ||
            (auth?.subject && identity.subject && auth.subject !== identity.subject)) ||
          !(await this.authHost.compareActive(realmId, captured.secret_ref)) ||
          (accepted !== captured && !(await this.authHost.compareActive(realmId, accepted.secret_ref))))
        return { success: false, error: "external_change" };
    }
    this.requireContext(realmId, context);
    const timestamp = new Date().toISOString();
    const subject = identity.subject ?? (identityOnly ? existing?.identity.subject : undefined);
    const state: AccountState = expected ? "pending_quota" : identityOnly
      ? existing?.state === "disabled" ? existing.state_before_disabled ?? "pending_quota"
        : existing?.state === "ready" || existing?.state === "waiting_quota" ? existing.state : "pending_quota"
      : !complete ? "pending_quota" :
      validPools.every((pool) => pool.windows.some((window) => window.remaining_fraction === 0))
        ? "waiting_quota" : "ready";
    const account: AgyAccount = {
      ...existing,
      id: accountId,
      realm_id: realmId,
      revision: (existing?.revision ?? 0) + 1,
      alias: alias || existing?.alias || email.split("@")[0]!,
      identity: { email, ...(subject ? { subject } : {}), verified_at: timestamp },
      secret_ref: accepted.secret_ref,
      credential_revision: accepted.credential_revision,
      state: existing?.state === "disabled" ? "disabled" : state,
      state_before_disabled: existing?.state === "disabled" ? state : existing?.state_before_disabled,
      enrolled_at: existing?.enrolled_at ?? timestamp,
      enrollment_completed_at: identityOnly ? existing?.enrollment_completed_at : complete ? timestamp : undefined,
      auth: {
        has_refresh_credential: accepted.auth?.has_refresh_credential ?? null,
        refresh_expiry_source: accepted.auth?.refresh_expiry_source ?? "not_provided",
        access_expires_at: accepted.auth?.access_expires_at,
        refresh_expires_at: accepted.auth?.refresh_expires_at,
        metadata_status: "unverified",
        last_authenticated_request_at: identityOnly ? existing?.auth.last_authenticated_request_at : timestamp,
        ...(identityOnly ? { quota_verification_pending: true } : {}),
        email,
        ...(subject ? { subject } : {}),
      },
    };
    const snapshots: AgyQuotaSnapshot[] = pools.map((pool) => ({
      id: "snp_" + randomUUID(), realm_id: realmId, account_id: accountId,
      auth_epoch: context.auth_epoch, pool_id: pool.pool_id, model_ids: pool.model_ids,
      plan_tier: observation?.plan_tier, source: "official_cli_usage",
      cli_version: observation!.cli_version, executable_fingerprint: observation!.executable_fingerprint,
      capability_verified: isQuotaPoolVerified(observation!, pool), parser_revision: 2, observed_at: timestamp, windows: pool.windows,
    }));
    this.repository.transaction(() => {
      if (existing && this.repository.getAccount(realmId, existing.id)?.revision !== existing.revision)
        throw new Error("account_revision_conflict");
      if (currentOnly) {
        this.repository.saveAccount(account);
        context.onCurrentSaved?.(account, Boolean(existing));
        return;
      }
      if (!identityOnly) this.repository.retainQuotaPools(realmId, accountId, pools.map((pool) => pool.pool_id));
      for (const snapshot of snapshots) this.repository.saveQuotaSnapshot(snapshot);
      this.repository.saveAccount(account);
      this.repository.putRecord("agy_pending_enrollment", context.operation_id, realmId, {
        ...pending, status: "committed", committed_account_id: accountId,
      });
      context.onCaptured?.({ account, secret_ref: accepted.secret_ref, credential_revision: accepted.credential_revision });
      if (expected) context.onCurrentSaved?.(account, true);
    });
    return { success: true, account, snapshot: snapshots[0] };
  }
  cancelLogin(): void {
    this.loginLauncher.cancelLogin();
  }
}
