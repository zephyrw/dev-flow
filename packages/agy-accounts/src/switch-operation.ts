import { hasDualQuotaWindows, requiredQuotaPools } from "./quota.js";
import type {
  AgyAccount,
  AgyAccountOperation,
  AgyRealm,
  AgyAccountSettings,
  QuotaWindow,
} from "../../contracts/src/agy-account.js";
import type { AgyAccountRepository } from "./repository.js";
import type {
  AuthHostPort,
  AccountProbePort,
  ProcessHostPort,
  AccountConsumerPort,
  ClockPort,
} from "./ports.js";
import {
  selectCandidates,
  nightWindow,
  type SelectionResult,
} from "./selector.js";
import { computeDomainWait } from "./wait-policy.js";

export interface SwitchExecutionOptions {
  operationId: string;
  realmId: string;
  selection: { mode: "auto" } | { mode: "explicit"; account_id: string };
  trigger: AgyAccountOperation["trigger"];
  requiredPoolIds: string[];
  modelId?: string;
  requestId: string;
  expectedEpoch?: number;
  signal?: AbortSignal;
}

export interface SwitchResult {
  success: boolean;
  status:
    | "switched"
    | "already_active"
    | "no_eligible_account"
    | "target_unavailable"
    | "external_blocked"
    | "error";
  active_account_id?: string;
  new_auth_epoch?: number;
  message?: string;
  next_eligible_at?: string | null;
}

export class SwitchOperationExecutor {
  constructor(
    private repository: AgyAccountRepository,
    private authHost: AuthHostPort,
    private probe: AccountProbePort,
    private processHost: ProcessHostPort,
    private consumers: AccountConsumerPort[],
    private clock: ClockPort,
    private consumerIds: Map<AccountConsumerPort, string> = new Map(),
  ) {}

  async execute(options: SwitchExecutionOptions): Promise<SwitchResult> {
    const realm = this.repository.getRealm(options.realmId);
    if (!realm) {
      return {
        success: false,
        status: "error",
        message: `Realm ${options.realmId} not found`,
      };
    }
    const operation = this.repository.getOperation(options.operationId);
    if (
      !operation ||
      !this.authHost.isDomainLockHeld(options.realmId) ||
      realm.service_state !== "running" ||
      realm.pending_operation_id !== options.operationId
    ) {
      return {
        success: false,
        status: "error",
        message: "operation_not_owned",
      };
    }
    const guard = () => {
      const current = this.repository.getRealm(options.realmId),
        op = this.repository.getOperation(options.operationId);
      if (
        !this.authHost.isDomainLockHeld(options.realmId) ||
        !current ||
        current.service_state !== "running" ||
        current.control_generation !== operation.control_generation ||
        op?.cancel_requested ||
        options.signal?.aborted
      )
        throw new Error("operation_cancelled");
      if (
        operation.deadline_at &&
        this.clock.now() >= Date.parse(operation.deadline_at)
      )
        throw new Error("operation_timeout");
      if (
        this.repository.getSettings(options.realmId)?.revision !==
        operation.expected_settings_revision
      )
        throw new Error("settings_revision_changed");
    };
    guard();

    const settings = this.repository.getSettings(options.realmId) ?? {
      realm_id: options.realmId,
      revision: 1,
      standalone_model_id: null,
      workflow_auto_switch: true,
      pause_managed_for_manual_switch: true,
      switch_gap_seconds: 3,
      reset_clock_skew_seconds: 60,
      probe_timeout_seconds: 30,
      switch_timeout_seconds: 300,
      max_candidates_per_operation: 20,
      local_snapshot_stale_hours: 24,
      maintenance: {
        timezone: "Asia/Shanghai",
        local_report_time: "17:30",
        night_start: "20:00",
        night_end: "08:00",
        refresh_verified_max_age_hours: 24,
        auto_network_check: false,
      },
      updated_at: this.clock.toISOString(),
    };

    // 1. CAS 校验 epoch
    if (
      options.expectedEpoch !== undefined &&
      options.expectedEpoch !== realm.auth_epoch
    ) {
      return {
        success: false,
        status: "error",
        message: `Epoch mismatch: expected ${options.expectedEpoch}, got ${realm.auth_epoch}`,
      };
    }

    // 2. 检查外部 AGY 进程
    const externalProcs = await this.processHost.findExternalAgyProcesses();
    if (externalProcs.length > 0) {
      operation.phase = "waiting_external_exit";
      operation.external_processes = externalProcs.map(({ pid, exe_path }) => ({
        pid,
        exe_path,
      }));
      operation.revision++;
      this.repository.saveOperation(operation);
      // 外部有运行中的 CLI，进入等待退出或阻断
      return {
        success: false,
        status: "external_blocked",
        message: `External AGY processes detected (PIDs: ${externalProcs.map((p) => p.pid).join(", ")}). Please exit them before switching accounts.`,
      };
    }
    guard();
    const occupancy = (
      await Promise.all(this.consumers.map((c) => c.listOccupancy()))
    ).flat();
    if (
      occupancy.some((o) => !o.can_pause) ||
      (options.trigger.startsWith("manual") &&
        !settings.pause_managed_for_manual_switch &&
        occupancy.length)
    )
      throw new Error("managed_busy");
    options.requiredPoolIds = [...new Set([
      ...(options.requiredPoolIds.length ? options.requiredPoolIds : ["global"]),
      ...occupancy.flatMap((item) => item.required_pool_ids ?? []),
    ])];
    for (const item of occupancy)
      if (item.allowed_account_ids !== null)
        operation.allowed_account_ids =
          operation.allowed_account_ids === null
            ? item.allowed_account_ids
            : operation.allowed_account_ids.filter((id) =>
                item.allowed_account_ids!.includes(id),
              );
    operation.required_pool_ids = options.requiredPoolIds;
    operation.required_model_ids = [
      ...new Set([
        ...operation.required_model_ids,
        ...occupancy.flatMap((o) => o.required_model_ids ?? []),
      ]),
    ];
    this.repository.saveOperation(operation);
    const selectionPolicy = {
      required_model_ids: operation.required_model_ids,
      allowed_account_ids: operation.allowed_account_ids,
      reset_clock_skew_seconds: settings.reset_clock_skew_seconds,
      ...nightWindow(settings.maintenance, this.clock.now()),
      night_pool: operation.night_pool,
      refresh_verified_max_age_hours:
        settings.maintenance.refresh_verified_max_age_hours,
    };
    const initialSelection = selectCandidates(
      this.repository.listAccounts(options.realmId),
      this.repository.listQuotaSnapshots(options.realmId),
      options.requiredPoolIds,
      this.clock.now(),
      selectionPolicy,
    );
    if (
      options.selection.mode === "explicit" &&
      !initialSelection.ranked_candidates.some(
        (candidate) =>
          candidate.account_id ===
          (options.selection as { account_id: string }).account_id,
      )
    )
      return {
        success: false,
        status: "target_unavailable",
        message: "target_unavailable",
      };
    const requested =
      options.selection.mode === "explicit"
        ? options.selection.account_id
        : initialSelection.ranked_candidates[0]?.account_id;
    if (
      options.trigger.startsWith("manual") &&
      requested &&
      requested === realm.active_account_id
    )
      return {
        success: true,
        status: "already_active",
        active_account_id: requested,
        new_auth_epoch: realm.auth_epoch,
      };

    // 3. 关域 admission: phase -> quiescing
    const beforeAccountId = realm.active_account_id ?? undefined;
    const beforeEpoch = realm.auth_epoch;
    realm.phase = "quiescing";
    realm.pending_operation_id = options.operationId;
    realm.revision += 1;
    this.repository.saveRealm(realm);

    // 4. 通知所有消费者 quiesce 并确认停止
    for (const consumer of this.consumers) {
      guard();
      const prepared = await consumer.prepareSwitch(options.operationId);
      operation.consumer_refs.push({
        consumer_id: this.consumerIds.get(consumer) ?? "workflow",
        saved_ref: prepared.savedRef,
        delivered: false,
      });
      operation.phase = "quiescing";
      operation.revision++;
      this.repository.saveOperation(operation);
      await consumer.quiesce(options.operationId);
      const stopped = await consumer.confirmStopped(options.operationId);
      if (!stopped) {
        realm.phase = "idle";
        realm.pending_operation_id = null;
        this.repository.saveRealm(realm);
        return {
          success: false,
          status: "error",
          message: "Failed to confirm all managed processes stopped",
        };
      }
    }
    const processes = await this.processHost.listManagedProcesses(
      options.realmId,
    );
    if (
      processes.length &&
      !(await this.processHost.confirmProcessesStopped(
        processes.map((p) => p.pid),
        settings.probe_timeout_seconds * 1000,
      ))
    )
      throw new Error("managed_processes_not_stopped");
    guard();

    // 5. 如果原先有活动账号，捕获最新活动凭据保存到 Vault
    if (
      realm.active_secret_ref &&
      !(await this.authHost.compareActive(
        options.realmId,
        realm.active_secret_ref,
      ))
    ) {
      const expectedAccount = beforeAccountId
        ? this.repository.getAccount(options.realmId, beforeAccountId)
        : undefined;
      if (!occupancy.length || !expectedAccount)
        throw new Error("external_change");
      const observed = await this.probe.probeUsage({
        signal: options.signal,
        account_id: beforeAccountId,
        timeoutMs: settings.probe_timeout_seconds * 1000,
      });
      if (
        observed.email?.toLowerCase() !==
        expectedAccount.identity.email.toLowerCase()
      )
        throw new Error("external_change");
    }
    const captured = await this.authHost.captureActive(
      options.realmId,
      beforeAccountId ?? `backup_${operation.operation_id}`,
    );
    operation.before_secret_ref = captured.secret_ref;
    operation.phase = "selecting";
    operation.revision++;
    this.repository.saveOperation(operation);
    if (beforeAccountId) {
      const before = this.repository.getAccount(
        options.realmId,
        beforeAccountId,
      )!;
      before.secret_ref = captured.secret_ref;
      before.credential_revision = captured.credential_revision;
      before.auth = { ...before.auth, ...captured.auth };
      before.revision++;
      this.repository.saveAccount(before);
    }

    // 6. 确定候选
    const accounts = this.repository.listAccounts(options.realmId);
    const snapshots = this.repository.listQuotaSnapshots(options.realmId);
    const now = this.clock.now();

    let targetAccountId: string | undefined;

    if (options.selection.mode === "explicit") {
      // 显式指定账号
      const explicitId = options.selection.account_id;
      const targetAcc = accounts.find((a) => a.id === explicitId);
      if (!targetAcc) {
        this.finishRealmPhase(realm);
        return {
          success: false,
          status: "target_unavailable",
          message: `Account ${explicitId} not found`,
        };
      }
      if (
        targetAcc.state === "disabled" ||
        targetAcc.state === "incompatible"
      ) {
        this.finishRealmPhase(realm);
        return {
          success: false,
          status: "target_unavailable",
          message: `Account ${explicitId} is ${targetAcc.state}`,
        };
      }
      if (targetAcc.state === "pending_quota") {
        this.finishRealmPhase(realm);
        return {
          success: false,
          status: "target_unavailable",
          message: `Account ${explicitId} quota not initialized`,
        };
      }
      if (explicitId === beforeAccountId) {
        this.finishRealmPhase(realm);
        return {
          success: true,
          status: "already_active",
          active_account_id: explicitId,
          new_auth_epoch: realm.auth_epoch,
          message: "Account is already currently active",
        };
      }
      targetAccountId = explicitId;
    } else {
      // 自动选优
      const selResult = selectCandidates(
        accounts,
        snapshots,
        options.requiredPoolIds,
        now,
        {
          reset_clock_skew_seconds: settings.reset_clock_skew_seconds,
          current_active_account_id: beforeAccountId,
          required_model_ids: operation.required_model_ids,
          allowed_account_ids: operation.allowed_account_ids,
          ...nightWindow(settings.maintenance, this.clock.now()),
          night_pool: operation.night_pool,
          refresh_verified_max_age_hours:
            settings.maintenance.refresh_verified_max_age_hours,
        },
      );

      if (selResult.ranked_candidates.length === 0) {
        this.finishRealmPhase(realm);
        const waitEval = computeDomainWait(
          accounts,
          snapshots,
          options.requiredPoolIds,
          now,
          {
            clockSkewSeconds: settings.reset_clock_skew_seconds,
            allowedAccountIds: operation.allowed_account_ids,
            requiredModelIds: operation.required_model_ids,
          },
        );
        if (options.trigger.startsWith("workflow") && waitEval.should_wait) {
          this.repository.saveDomainWait({
            realm_id: options.realmId,
            blocked_window: waitEval.blocked_window,
            next_eligible_at: waitEval.next_eligible_at,
            source_epoch: realm.auth_epoch,
            reason: waitEval.reason,
            created_at: this.clock.toISOString(),
          });
        }
        return {
          success: false,
          status: "no_eligible_account",
          next_eligible_at: waitEval.next_eligible_at,
          message: "No eligible account available in account pool",
        };
      }

      const best = selResult.ranked_candidates[0]!;
      if (
        options.trigger.startsWith("manual") &&
        best.account_id === beforeAccountId &&
        beforeAccountId
      ) {
        // 当前账号就是最佳候选，无需切换
        this.finishRealmPhase(realm);
        return {
          success: true,
          status: "already_active",
          active_account_id: beforeAccountId,
          new_auth_epoch: realm.auth_epoch,
          message: "Current account is already the best eligible candidate",
        };
      }
      targetAccountId = best.account_id;
    }

    // Freeze this operation's bounded candidate set. Explicit selection never falls back.
    const candidateIds =
      options.selection.mode === "explicit"
        ? [targetAccountId!]
        : initialSelection.ranked_candidates
            .map((c) => c.account_id)
            .slice(0, settings.max_candidates_per_operation);
    const initialCandidateCount = candidateIds.length;
    operation.candidate_ids = candidateIds;
    this.repository.saveOperation(operation);
    for (
      let candidateIndex = 0;
      candidateIndex < candidateIds.length;
      candidateIndex++
    ) {
      guard();
      targetAccountId = candidateIds[candidateIndex]!;
      operation.attempted_account_ids.push(targetAccountId);
      // 7. 安装新身份并核验
      const targetAcc = accounts.find((a) => a.id === targetAccountId)!;
      realm.phase = "installing";
      this.repository.saveRealm(realm);
      if ((await this.processHost.findExternalAgyProcesses()).length)
        throw new Error("external_change");
      const expectedRef =
        operation.installed_secret_ref ?? operation.before_secret_ref;
      if (
        !expectedRef ||
        !(await this.authHost.compareActive(options.realmId, expectedRef))
      )
        throw new Error("external_change");
      guard();
      operation.install_target_ref = targetAcc.secret_ref;
      operation.install_target_account_id = targetAcc.id;
      operation.install_epoch =
        this.repository.getRealm(options.realmId)!.auth_epoch + 1;
      operation.phase = "install_intent";
      operation.revision++;
      this.repository.saveOperation(operation);

      try {
        await this.authHost.activateSaved(
          options.realmId,
          targetAcc.id,
          targetAcc.secret_ref,
        );
        guard();
        if (
          !(await this.authHost.compareActive(
            options.realmId,
            targetAcc.secret_ref,
          ))
        )
          throw new Error("credential_readback_failed");
        operation.installed_secret_ref = targetAcc.secret_ref;
        operation.phase = "installed_unverified";
        operation.revision++;
        this.repository.saveOperation(operation);
        realm.auth_epoch = operation.install_epoch;
        realm.active_secret_ref = targetAcc.secret_ref;
        this.repository.saveRealm(realm);
      } catch (err: any) {
        // The service owns verified rollback; never swallow a failed restore here.
        throw new Error(
          err instanceof Error &&
          ["operation_cancelled", "operation_timeout"].includes(err.message)
            ? err.message
            : "credential_install_failed",
        );
      }

      // 8. 核验新账号身份
      realm.phase = "verifying";
      this.repository.saveRealm(realm);

      operation.phase = "verifying";
      operation.revision++;
      this.repository.saveOperation(operation);
      guard();
      let probeRes:
        | Awaited<ReturnType<AccountProbePort["probeUsage"]>>
        | undefined;
      let authFailed = false;
      for (let retry = 0; retry < 3; retry++) {
        try {
          probeRes = await this.probe.probeUsage({
            signal: options.signal,
            timeoutMs: settings.probe_timeout_seconds * 1000,
            account_id: targetAcc.id,
            credential_revision: targetAcc.credential_revision,
            model_id: options.modelId,
          });
          break;
        } catch (error) {
          if ((error as any)?.code === "PROCESS_STOP_UNCONFIRMED" || (error as any)?.name === "ProcessStopUnconfirmedError") {
            throw error;
          }
          const code =
            (error as { code?: string }).code ?? (error as Error).message;
          if (
            /authentication_required|invalid_grant|unauthenticated/i.test(code)
          ) {
            authFailed = true;
            break;
          }
          if (options.signal?.aborted) throw new Error("operation_cancelled");
          // Unclassified CLI exits are not evidence of a network failure.
          // Only a verified adapter's network category or our bounded timeout is retryable.
          if (!["probe_timeout", "network_error"].includes(code))
            throw new Error("probe_failed");
          if (retry === 2) throw new Error("network_wait");
          await this.pause(retry === 0 ? 3000 : 10000, options.signal);
          guard();
        }
      }
      if (authFailed) {
        targetAcc.state = "reauth_required";
        targetAcc.auth.last_auth_error = "authentication_required";
        targetAcc.revision++;
        this.repository.saveAccount(targetAcc);
        if (options.selection.mode === "explicit")
          throw new Error("target_unavailable");
        if (candidateIndex + 1 < candidateIds.length) {
          await this.pause(settings.switch_gap_seconds * 1000, options.signal);
          continue;
        }
        throw new Error("no_eligible_account");
      }
      if (!probeRes) throw new Error("probe_failed");
      const verifiedEmail = (probeRes.email ?? (await this.probe.probeIdentity({ signal: options.signal })).email).toLowerCase();
      const expectedEmail = targetAcc.identity.email.toLowerCase();

      if (!verifiedEmail || verifiedEmail !== expectedEmail) {
        // 身份不符！必须立刻回滚并冻结
        realm.phase = "blocked";
        this.repository.saveRealm(realm);
        throw new Error("identity_mismatch");
      }

      guard();
      const refreshed = await this.authHost.captureActive(
        options.realmId,
        targetAcc.id,
      );
      targetAcc.secret_ref = refreshed.secret_ref;
      targetAcc.credential_revision = refreshed.credential_revision;
      targetAcc.auth = { ...targetAcc.auth, ...refreshed.auth };
      operation.installed_secret_ref = refreshed.secret_ref;
      operation.revision++;
      this.repository.saveOperation(operation);
      const targetPools = requiredQuotaPools(probeRes.pools, options.requiredPoolIds, operation.required_model_ids);
      const complete = probeRes.capability_verified && !!probeRes.executable_fingerprint &&
        !!targetPools?.length && targetPools.every((pool) => hasDualQuotaWindows(pool.windows));
      this.repository.retainQuotaPools(options.realmId, targetAcc.id, probeRes.pools.map((pool) => pool.pool_id));
      for (const pool of probeRes.pools) {
        this.repository.saveQuotaSnapshot({
          id: `snp_${options.operationId}_${candidateIndex}_${pool.pool_id}`,
          realm_id: options.realmId,
          account_id: targetAcc.id,
          auth_epoch: realm.auth_epoch,
          pool_id: pool.pool_id,
          model_ids: pool.model_ids,
          source: "official_cli_usage",
          cli_version: probeRes.cli_version,
          parser_revision: 1,
          executable_fingerprint: probeRes.executable_fingerprint,
          capability_verified: probeRes.capability_verified,
          observed_at: this.clock.toISOString(),
          windows: pool.windows,
        });

      }
      if (!complete) {
        targetAcc.state = "pending_quota";
        targetAcc.revision++;
        this.repository.saveAccount(targetAcc);
        throw new Error("quota_capability_unavailable");
      }
      const poolsToCheck = targetPools!;
      const zero = poolsToCheck.some((p) =>
        p.windows.some(
          (w) => w.remaining_fraction === null || w.remaining_fraction <= 0,
        ),
      );
      targetAcc.state = zero ? "waiting_quota" : "ready";
      targetAcc.revision++;
      this.repository.saveAccount(targetAcc);
      let accessible = !zero;
      const verifiedModelIds: string[] = [];
      if (accessible)
        for (const modelId of operation.required_model_ids) {
          guard();
          if (
            !(await this.probe.probeModelAccess(modelId, {
              signal: options.signal,
              account_id: targetAcc.id,
              credential_revision: targetAcc.credential_revision,
              model_id: modelId,
              timeoutMs: settings.probe_timeout_seconds * 1000,
            }))
          ) {
            accessible = false;
            break;
          }
          verifiedModelIds.push(modelId);
        }
      if (zero || !accessible) {
        if (options.selection.mode === "explicit")
          throw new Error("target_unavailable");
        if (candidateIndex + 1 < candidateIds.length) {
          await this.pause(settings.switch_gap_seconds * 1000, options.signal);
          continue;
        }
        const prior = operation.candidate_results.sort(
          (a, b) => b.weekly - a.weekly,
        )[0];
        if (
          prior &&
          candidateIndex < initialCandidateCount &&
          this.clock.now() - Date.parse(prior.verified_at) <= 120_000
        ) {
          candidateIds.push(prior.account_id);
          await this.pause(settings.switch_gap_seconds * 1000, options.signal);
          continue;
        }
        throw new Error("no_eligible_account");
      }
      const weekly = poolsToCheck.length > 0
        ? Math.min(
            ...poolsToCheck.map(
              (p) =>
                p.windows.find((w) => w.kind === "weekly")?.remaining_fraction ?? 1,
            ),
          )
        : 1;
      operation.candidate_results = operation.candidate_results.filter(
        (r) => r.account_id !== targetAcc.id,
      );
      operation.candidate_results.push({
        account_id: targetAcc.id,
        weekly,
        verified_at: this.clock.toISOString(),
        verified_model_ids: verifiedModelIds,
        credential_revision: targetAcc.credential_revision,
      });
      operation.revision++;
      this.repository.saveOperation(operation);
      if (
        options.selection.mode === "auto" &&
        candidateIndex < initialCandidateCount
      ) {
        const remainingBetter = initialSelection.ranked_candidates.some(
          (c) =>
            candidateIds.indexOf(c.account_id) > candidateIndex &&
            c.projected_weekly > weekly,
        );
        if (remainingBetter) {
          await this.pause(settings.switch_gap_seconds * 1000, options.signal);
          continue;
        }
        const best = [...operation.candidate_results].sort(
          (a, b) => b.weekly - a.weekly,
        )[0]!;
        if (best.account_id !== targetAcc.id) {
          if (this.clock.now() - Date.parse(best.verified_at) > 120_000)
            throw new Error("candidate_snapshot_expired");
          candidateIds.splice(
            candidateIndex + 1,
            candidateIds.length,
            best.account_id,
          );
          await this.pause(settings.switch_gap_seconds * 1000, options.signal);
          continue;
        }
      }
      guard();

      // 9. 提交新代次与状态
      const newAuthEpoch = realm.auth_epoch;
      realm.active_account_id = targetAcc.id;
      realm.auth_epoch = newAuthEpoch;
      realm.phase = "committed";
      realm.active_secret_ref = targetAcc.secret_ref;
      realm.revision += 1;
      this.repository.saveRealm(realm);

      targetAcc.last_used_at = this.clock.toISOString();
      targetAcc.revision += 1;
      this.repository.saveAccount(targetAcc);

      // 清理旧的域等待
      this.repository.clearDomainWait(options.realmId);

      // 持久化不可变 FinalAccountCommit
      this.repository.saveFinalAccountCommit({
        commit_id: `commit_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        operation_id: options.operationId,
        realm_id: options.realmId,
        outcome: "switched",
        account_id: targetAcc.id,
        secret_ref: targetAcc.secret_ref,
        credential_revision: targetAcc.credential_revision,
        auth_epoch: newAuthEpoch,
        control_generation: operation.control_generation,
        committed_at: this.clock.toISOString(),
        stopped_job_ids: [],
      });

      operation.phase = "committed";
      operation.result = {
        outcome: "switched",
        active_account_id: targetAcc.id,
        auth_epoch: newAuthEpoch,
      };
      operation.revision++;
      this.repository.saveOperation(operation);

      return {
        success: true,
        status: "switched",
        active_account_id: targetAcc.id,
        new_auth_epoch: newAuthEpoch,
        message: `Successfully switched active account to ${targetAcc.alias}`,
      };
    }
    return {
      success: false,
      status: "no_eligible_account",
      message: "no_eligible_account",
    };
  }

  private finishRealmPhase(realm: AgyRealm): void {
    // The service performs durable completion and consumer delivery before admission reopens.
    realm.phase = "completing";
    realm.revision += 1;
    this.repository.saveRealm(realm);
  }

  private pause(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("operation_cancelled"));
        return;
      }
      const abort = () => {
        clearTimeout(timer);
        reject(new Error("operation_cancelled"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}
