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
  onCaptured?: (data: {
    account: AgyAccount;
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
    if (!active.exists)
      return { success: false, error: "active_credential_missing" };

    // 1. 独立核实身份
    let email: string | undefined;
    try {
      const identityRes = await this.probe.probeIdentity({
        signal: context.signal,
      });
      email = identityRes.email?.trim().toLowerCase();
    } catch (err: any) {
      if (err?.code === "PROCESS_STOP_UNCONFIRMED" || err?.name === "ProcessStopUnconfirmedError") {
        throw err;
      }
      // 容错：尝试从 probeUsage 中获取 email
      try {
        const usageRes = await this.probe.probeUsage({ signal: context.signal });
        email = usageRes.email?.trim().toLowerCase();
      } catch (usageErr: any) {
        if (usageErr?.code === "PROCESS_STOP_UNCONFIRMED" || usageErr?.name === "ProcessStopUnconfirmedError") {
          throw usageErr;
        }
      }
    }

    if (!email)
      return { success: false, error: "account_identity_unverified" };

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

    // 2. 先 capture 新授权完整包保存（授权留存，即便后续配额查询失败也不丢失登录）
    const captured = await this.authHost.captureActive(realmId, accountId);
    this.requireContext(realmId, context);

    const now = new Date().toISOString();
    // 事务保存 pending 账号和操作 journal，避免后续取消或失败留下孤儿 secret
    const pendingAccount: AgyAccount = {
      id: accountId,
      realm_id: realmId,
      revision: (existing?.revision ?? 0) + 1,
      alias: alias || existing?.alias || email.split("@")[0]!,
      identity: { email, verified_at: now },
      secret_ref: captured.secret_ref,
      credential_revision: captured.credential_revision,
      state: existing?.state === "disabled" ? "disabled" : "pending_quota",
      disabled_reason:
        existing?.state === "disabled" ? existing.disabled_reason : undefined,
      enrolled_at: existing?.enrolled_at ?? now,
      enrollment_completed_at: undefined,
      auth: {
        has_refresh_credential: captured.auth?.has_refresh_credential ?? null,
        refresh_expiry_source: captured.auth?.refresh_expiry_source ?? "not_provided",
        access_expires_at: captured.auth?.access_expires_at,
        refresh_expires_at: captured.auth?.refresh_expires_at,
        metadata_status: captured.auth?.metadata_status ?? "unverified",
        last_authenticated_request_at: now,
        last_auth_error: undefined,
        last_refresh_verified_at: undefined,
      },
    };
    this.repository.transaction(() => {
      this.repository.saveAccount(pendingAccount);
      if (context.onCaptured) {
        context.onCaptured({
          account: pendingAccount,
          secret_ref: captured.secret_ref,
          credential_revision: captured.credential_revision,
        });
      }
    });

    // 3. 查询双额度和模型池（允许失败降级为 pending_quota）
    let observation: any;
    try {
      observation = await this.probe.probeUsage({
        signal: context.signal,
        model_id: context.model_id,
        account_id: accountId,
        credential_revision: captured.credential_revision,
      });
    } catch (err: any) {
      if (err?.code === "PROCESS_STOP_UNCONFIRMED" || err?.name === "ProcessStopUnconfirmedError") {
        throw err;
      }
      observation = undefined;
    }
    this.requireContext(realmId, context);

    // CR04 修复：校验后续 usage 观察的身份，若不同直接冻结并报错，杜绝污染
    if (observation?.email && observation.email.toLowerCase() !== email.toLowerCase()) {
      return { success: false, error: "account_identity_mismatch" };
    }

    const pools = observation && observation.capability_verified && !!observation.executable_fingerprint
      ? observation.pools.filter(
          (pool: any) =>
            !context.model_id || pool.model_ids.includes(context.model_id) || pool.model_ids.includes("*"),
        )
      : [];
    // 综合读取账号级顶层双额度与池级双额度判定完成状态 (Q01)
    const allWindows = [
      ...(observation?.windows ?? []),
      ...pools.flatMap((p: any) => p.windows ?? []),
    ];
    const hasValidWindows =
      observation &&
      observation.capability_verified &&
      !!observation.executable_fingerprint &&
      ["weekly", "five_hour"].every((kind: string) =>
        allWindows.some(
          (w: any) =>
            w.kind === kind &&
            w.status === "observed" &&
            typeof w.remaining_fraction === "number" &&
            w.remaining_fraction >= 0 &&
            w.remaining_fraction <= 1,
        ),
      );
    const complete = !!hasValidWindows;
    const isZero = allWindows.some((w: any) => w.remaining_fraction === 0);
    const state: AccountState = !complete
      ? "pending_quota"
      : isZero
        ? "waiting_quota"
        : "ready";

    const account: AgyAccount = {
      ...pendingAccount,
      revision: pendingAccount.revision + 1,
      state: existing?.state === "disabled" ? "disabled" : state,
      enrollment_completed_at: complete ? now : undefined,
    };
    // Interactive authentication proves a request, not refresh of an expired access token.
    const effectivePools = pools.length > 0
      ? pools
      : complete
        ? [{ pool_id: "global", model_ids: ["*"], windows: observation.windows ?? allWindows }]
        : [];
    const snapshots: AgyQuotaSnapshot[] = effectivePools.map((pool: any) => ({
      id: "snp_" + randomUUID(),
      realm_id: realmId,
      account_id: accountId,
      auth_epoch: context.auth_epoch,
      pool_id: pool.pool_id,
      model_ids: pool.model_ids,
      plan_tier: observation?.plan_tier,
      source: "official_cli_usage",
      cli_version: observation?.cli_version ?? "unknown",
      executable_fingerprint: observation?.executable_fingerprint ?? "",
      capability_verified: observation?.capability_verified ?? false,
      parser_revision: 2,
      observed_at: now,
      windows: pool.windows,
    }));
    this.repository.transaction(() => {
      if (
        existing &&
        this.repository.getAccount(realmId, existing.id)?.revision !==
          pendingAccount.revision
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
