import type {
  AgyAccountService,
  AccountConsumerPort,
  ConsumerOccupancy,
  AccountCommittedEvent,
  UsagePermit,
} from "../../agy-accounts/src/index.js";
import type {
  AgyRunBinding,
  AgyAccountPolicy,
} from "../../contracts/src/agy-account.js";
import type { AgyFailureFact } from "../../adapters/agy/src/failure-fact.js";
import type { ProcessManager } from "../../process/src/manager.js";
import type { Engine } from "../../core/src/engine.js";
import { FlowError, type Run } from "../../contracts/src/index.js";
import type { AgyAccountProcessHost } from "../../process/src/agy-account-processes.js";
import { resumeApproved } from "./recovery.js";
import { assertAccountModelRetryAccess, buildAccountModelRunRetry, stageAccountModelRunRetry } from "../../core/src/model-retry.js";
import type { AsideSession } from "../../contracts/src/feedback.js";
import { ModelAccessService } from "../../core/src/model-access-service.js";
import { managedAgyAccountIdentityId, readManagedAgyModelIdentity } from "../../core/src/model-identity.js";
import { AgySubagentObserver } from "../../adapters/agy/src/subagent-observer.js";
import {
  AgyRecoveryCheckpointManager,
  type SubagentRecord,
} from "./agy-recovery-checkpoint.js";
import {
  createWorkspaceCheckpoint,
  restoreWorkspaceCheckpoint,
} from "./agy-workspace-checkpoint.js";
import { AgyWorkflowRecoveryCoordinator } from "./agy-workflow-recovery.js";
import { AsideSessionService } from "../../asides/src/service.js";

export interface FrozenAgyRunRequest {
  allowed_account_ids?: string[] | null;
  workflow_id: string;
  run_id: string;
  profile_id?: string;
  effective_model_id: string;
  effective_effort?: string;
  account_policy_revision: number;
  required_pool_ids: string[];
}

export interface ActiveManagedRun {
  effective_model_id?: string;
  account_policy_revision?: number;
  account_settings_revision?: number;
  allowed_account_ids?: string[] | null;
  workflow_id: string;
  run_id: string;
  permit_id: string;
  account_id: string;
  auth_epoch: number;
  process_id?: number;
  required_pool_ids: string[];
}

interface AccountWait extends ActiveManagedRun {
  operation_id: string;
  workflow_version: number;
  plan_revision?: number;
  plan_hash?: string;
}

export class AgyWorkflowBridge implements AccountConsumerPort {
  private activeRuns = new Map<string, ActiveManagedRun>();
  private unregisterFn?: () => void;
  private saved = new Map<string, ActiveManagedRun[]>();
  private childObservers = new Map<string, AgySubagentObserver>();

  constructor(
    private accountService: AgyAccountService,
    private processManager: ProcessManager,
    private onRecoveryNeeded?: (
      event: AccountCommittedEvent,
      affectedRuns: ActiveManagedRun[],
    ) => Promise<void>,
    private engine?: Engine,
    private processHost?: AgyAccountProcessHost,
  ) {
    this.unregisterFn = this.accountService.registerConsumer(this, "workflow");
    this.accountService.setWorkflowWaitValidator((ref) => {
      if (!this.engine || !ref.source_run_id || !ref.workflow_id) return false;
      const wait = this.engine.store.get<AccountWait>("agy_account_wait", ref.source_run_id);
      if (!wait || wait.workflow_id !== ref.workflow_id) return false;
      const operation = this.accountService.getRepository().getOperation(wait.operation_id);
      if (wait.operation_id !== ref.original_operation_id &&
          operation?.original_operation_id !== ref.original_operation_id) return false;
      const valid = this.waitBelongsToOperation(wait, ref.original_operation_id) && this.isCurrentWait(wait);
      if (!valid) this.discardInvalidWait(wait);
      return valid;
    }, (ref) => {
      if (!this.engine || !ref.source_run_id || !ref.workflow_id) return;
      const wait = this.engine.store.get<AccountWait>("agy_account_wait", ref.source_run_id);
      if (!wait || wait.workflow_id !== ref.workflow_id) return;
      const operation = this.accountService.getRepository().getOperation(wait.operation_id);
      if (wait.operation_id !== ref.original_operation_id &&
          operation?.original_operation_id !== ref.original_operation_id) return;
      this.discardInvalidWait(wait);
    });
  }

  private asideForRun(workflowId: string, runId: string): AsideSession | undefined {
    return this.engine?.store.list<AsideSession>("aside_session", workflowId)
      .find((session) => session.workflow_id === workflowId && session.run_id === runId);
  }

  private waitBelongsToOperation(wait: AccountWait, originalId: string): boolean {
    const operation = this.accountService.getRepository().getOperation(wait.operation_id);
    return !!operation && !operation.cancel_requested &&
      !["completed", "cancelled", "failed"].includes(operation.phase) &&
      (wait.operation_id === originalId || operation.original_operation_id === originalId);
  }

  private isCurrentWait(wait: AccountWait): boolean {
    if (!this.engine) return false;
    const currentWait = this.engine.store.get<AccountWait>("agy_account_wait", wait.run_id);
    if (currentWait?.operation_id !== wait.operation_id || currentWait.workflow_id !== wait.workflow_id) return false;
    const run = this.engine.store.get<Run>("run", wait.run_id);
    if (!run || run.workflow_id !== wait.workflow_id || this.engine.store.get("run_stop", wait.run_id)) return false;
    const w = this.engine.get(wait.workflow_id);
    const repository = this.accountService.getRepository();
    const operation = repository.getOperation(wait.operation_id);
    if (!operation || operation.cancel_requested || ["cancelled", "failed", "completed"].includes(operation.phase)) return false;
    if (["STOPPING", "STOPPED", "COMMITTED", "COMPLETED", "COMMIT_PARTIAL"].includes(w.state) ||
        w.plan_revision !== wait.plan_revision || w.plan_hash !== wait.plan_hash ||
        repository.getPolicy(w.id)?.revision !== wait.account_policy_revision ||
        repository.getSettings("default-agy-realm")?.revision !== wait.account_settings_revision) return false;
    if (run.purpose === "aside") return this.asideForRun(w.id, run.id)?.status === "waiting_account";
    return w.run_id === wait.run_id && w.version === wait.workflow_version &&
      w.state === "BLOCKED" && w.blocker?.code === "AGY_ACCOUNT_WAIT";
  }

  private removeWait(wait: AccountWait): void {
    if (!this.engine) return;
    for (const key of [wait.run_id, wait.workflow_id]) {
      const current = this.engine.store.get<AccountWait>("agy_account_wait", key);
      if (current?.run_id === wait.run_id && current.operation_id === wait.operation_id)
        this.engine.store.remove("agy_account_wait", key);
    }
  }

  private discardInvalidWait(wait: AccountWait): void {
    if (!this.engine) return;
    const current = this.engine.store.get<AccountWait>("agy_account_wait", wait.run_id);
    if (current?.operation_id !== wait.operation_id || current.workflow_id !== wait.workflow_id) return;
    // Only settle the original waiting question. A newer Run or a terminal
    // session owns its own lifecycle and must not be changed by this callback.
    const aside = this.asideForRun(wait.workflow_id, wait.run_id);
    if (aside?.status === "waiting_account") {
      new AsideSessionService(this.engine.store).failSession(
        wait.workflow_id, aside.id, "账号等待已失效，原任务或恢复条件已变化",
      );
    }
    this.removeWait(wait);
  }
  isManaged() {
    return this.accountService.isManaged();
  }
  observeNativeEvent(runId: string, event: Record<string, unknown>) {
    if (!this.engine || !this.activeRuns.has(runId)) return;
    let observer = this.childObservers.get(runId);
    if (!observer) {
      observer = new AgySubagentObserver();
      observer.subscribe((child) => {
        const key = `${runId}:${child.subagent_id}`;
        const previous = this.engine!.store.get<SubagentRecord>(
          "agy_subagent",
          key,
        );
        if (
          (previous?.status === "completed" || previous?.status === "cancelled") &&
          child.event_type === "spawn"
        ) {
          return;
        }
        this.engine!.store.put("agy_subagent", key, runId, {
          ...previous,
          logical_id: child.subagent_id,
          parent_id: child.parent_id ?? previous?.parent_id,
          native_session_id:
            child.native_session_id ?? previous?.native_session_id,
          role: child.role ?? previous?.role ?? "unknown",
          prompt: child.prompt ?? previous?.prompt ?? "",
          generation: child.generation ?? (previous as any)?.generation ?? 0,
          cursor: child.cursor ?? (previous as any)?.cursor ?? 0,
          workspace_dir: child.workspace_dir ?? (previous as any)?.workspace_dir,
          completeness: child.completeness ?? (previous as any)?.completeness ?? "complete",
          status:
            child.event_type === "complete"
              ? "completed"
              : child.event_type === "cancel"
                ? "cancelled"
                : previous?.status ?? "unknown",
          created_at: previous?.created_at ?? child.timestamp,
          ...(child.event_type === "complete"
            ? { completed_at: child.timestamp }
            : {}),
        });
      });
      this.childObservers.set(runId, observer);
    }
    observer.observeStreamLine(JSON.stringify(event));
  }
  async prepareProfileRun(
    workflowId: string,
    run: Run,
    modelId: string | undefined,
    profileId?: string,
  ): Promise<AgyRunBinding | undefined> {
    if (!this.isManaged()) return undefined;
    if (!modelId)
      throw new FlowError(
        "AGY_ACCOUNT_MODEL_REQUIRED",
        "账号管理需要任务明确选择模型，不能猜测 CLI 默认模型的额度池",
        409,
      );
    const frozen = run.frozen_invocation ?? run.model_binding?.frozen_invocation;
    if (!this.engine || !run.profile || !frozen || frozen.adapterId !== "agy" || frozen.modelToken !== modelId)
      throw new FlowError("AGY_ACCOUNT_BINDING_MISSING", "受管执行缺少一致的冻结模型配置", 409);
    const access = new ModelAccessService(this.engine.store);
    access.assertFrozenAccess(run.profile, frozen);
    const repository = this.accountService.getRepository();
    let policy = repository.getPolicy(workflowId);
    if (!policy) {
      policy = {
        workflow_id: workflowId,
        revision: 1,
        auto_switch: null,
        allowed_account_ids: null,
        recreation_policy: "exact_only",
        night_pool: "normal",
        created_at: new Date().toISOString(),
      };
      repository.savePolicy(policy);
    }
    let binding: AgyRunBinding;
    try {
      binding = await this.prepareRun({
        workflow_id: workflowId,
        run_id: run.id,
        profile_id: profileId,
        effective_model_id: modelId,
        account_policy_revision: policy.revision,
        required_pool_ids: this.accountService.resolveModelPools(modelId),
        allowed_account_ids: policy.allowed_account_ids,
      });
    } catch (error) {
      if (error instanceof FlowError) throw error;
      throw new FlowError(
        "AGY_ACCOUNT_UNAVAILABLE",
        "账号服务、模型额度映射或执行许可尚不可用；请查看账号管理页",
        409,
      );
    }
    try {
      // Permit acquisition can await an account switch. Never launch a command
      // or reuse a session prepared for an identity different from the permit.
      const current = readManagedAgyModelIdentity(this.engine.store);
      const native = access.resolveNativeConfig(run.profile);
      if (!current || current.realmId !== binding.realm_id || current.accountId !== binding.account_id ||
          current.authEpoch !== binding.auth_epoch ||
          native.accountId !== managedAgyAccountIdentityId(binding.realm_id, binding.account_id) ||
          native.accountFingerprint !== frozen.accountScope ||
          native.providerEndpointFingerprint !== frozen.providerScope)
        throw new FlowError("AGY_ACCOUNT_BINDING_STALE", "账号身份在取得执行许可期间已变化，请重新继续任务", 409);
      access.assertFrozenAccess(run.profile, frozen);
      this.engine.store.put("run", run.id, workflowId, {
        ...(this.engine.store.get<Run>("run", run.id) ?? run),
        agy_account: binding,
      });
    } catch (error) {
      await this.releaseRun(run.id, false, "binding_changed");
      throw error;
    }
    return binding;
  }
  attachProcess(binding: AgyRunBinding, pid: number) {
    this.accountService.attachUsageProcess(binding.permit_id, pid);
    const run = this.activeRuns.get(binding.source_run_id!);
    if (run) run.process_id = pid;
  }

  // 为即将启动的 AGY 任务申请执行许可
  async prepareRun(req: FrozenAgyRunRequest): Promise<AgyRunBinding> {
    const permit: UsagePermit = await this.accountService.acquireUsagePermit({
      realm_id: "default-agy-realm",
      consumer_id: req.run_id,
      usage_kind: "execution",
      required_pool_ids: req.required_pool_ids,
      required_model_ids: [req.effective_model_id],
      policy_revision: req.account_policy_revision,
      allowed_account_ids: req.allowed_account_ids,
    });
    const repository = this.accountService.getRepository();
    const account = repository.getAccount(permit.realm_id, permit.account_id);
    const settings = repository.getSettings(permit.realm_id);
    if (!account || !settings) {
      await this.accountService.releaseUsagePermit(permit.permit_id, {
        permit_id: permit.permit_id,
        success: false,
        reason: "binding_missing",
      });
      throw new FlowError(
        "AGY_ACCOUNT_BINDING_MISSING",
        "账号绑定状态已变化",
        409,
      );
    }

    const binding: AgyRunBinding = {
      realm_id: permit.realm_id,
      account_id: permit.account_id,
      auth_epoch: permit.auth_epoch,
      account_policy_revision: req.account_policy_revision,
      credential_revision_at_start: account.credential_revision,
      account_settings_revision_at_start: settings.revision,
      permit_id: permit.permit_id,
      source_run_id: req.run_id,
    };

    this.activeRuns.set(req.run_id, {
      effective_model_id: req.effective_model_id,
      account_policy_revision: req.account_policy_revision,
      account_settings_revision: settings.revision,
      workflow_id: req.workflow_id,
      run_id: req.run_id,
      permit_id: permit.permit_id,
      account_id: permit.account_id,
      auth_epoch: permit.auth_epoch,
      required_pool_ids: req.required_pool_ids,
      allowed_account_ids: req.allowed_account_ids,
    });

    return binding;
  }

  // 释放任务
  async releaseRun(
    runId: string,
    success: boolean,
    reason?: string,
  ): Promise<void> {
    const run = this.activeRuns.get(runId);
    if (!run) return;
    this.activeRuns.delete(runId);
    this.childObservers.delete(runId);
    await this.accountService.releaseUsagePermit(run.permit_id, {
      permit_id: run.permit_id,
      success,
      reason,
    });
  }

  // 观察到运行时失败
  async observeFailure(
    binding: AgyRunBinding,
    fact: AgyFailureFact,
  ): Promise<boolean> {
    if (
      !fact.can_switch_account ||
      fact.auth_epoch !== binding.auth_epoch ||
      fact.account_id !== binding.account_id ||
      fact.run_id !== binding.source_run_id
    ) {
      return false; // 不需要或不能切号
    }

    const runInfo = this.activeRuns.get(
      binding.source_run_id ?? binding.permit_id,
    );
    if (!runInfo) return false;
    const repository = this.accountService.getRepository();
    const realm = repository.getRealm(binding.realm_id);
    const settings = repository.getSettings(binding.realm_id);
    const policy = repository.getPolicy(
      runInfo.workflow_id,
      binding.account_policy_revision,
    );
    if (
      !realm ||
      realm.auth_epoch !== binding.auth_epoch ||
      realm.active_account_id !== binding.account_id ||
      !policy ||
      !(policy.auto_switch ?? settings?.workflow_auto_switch) ||
      this.engine?.store.get("run_stop", runInfo.run_id)
    )
      return false;
    if (this.engine) {
      const workflow = this.engine.get(runInfo.workflow_id);
      const run = this.engine.store.must<Run>("run", runInfo.run_id);
      if (
        (run.purpose === "aside"
          ? this.asideForRun(workflow.id, run.id)?.status !== "active"
          : workflow.run_id !== runInfo.run_id) ||
        [
          "STOPPING",
          "STOPPED",
          "COMMITTED",
          "COMPLETED",
          "COMMIT_PARTIAL",
        ].includes(workflow.state)
      )
        return false;
    }

    // This verified current-turn auth failure will become AGY_ACCOUNT_WAIT;
    // invalidate its original identity before that code hides the auth error.
    if (this.engine && fact.category === "auth_invalid") {
      const failed = this.engine.store.must<Run>("run", runInfo.run_id);
      const frozen = failed.frozen_invocation ?? failed.model_binding?.frozen_invocation;
      if (frozen) new ModelAccessService(this.engine.store).invalidate(frozen, "MODEL_LOGIN_REQUIRED");
    }
    // 触发自动切换操作
    const receipt = await this.accountService
      .requestWorkflowOperation({
        realm_id: binding.realm_id,
        request_id: `req_err_${binding.permit_id}_${fact.source_offset}`,
        kind: "switch",
        workflow_id: runInfo.workflow_id,
        source_run_id: runInfo.run_id,
        model_id: runInfo.effective_model_id,
        required_model_ids: runInfo.effective_model_id
          ? [runInfo.effective_model_id]
          : [],
        selection: { mode: "auto" },
        expected_epoch: binding.auth_epoch,
        required_pool_ids: runInfo.required_pool_ids,
        allowed_account_ids: policy.allowed_account_ids,
        night_pool: policy.night_pool,
        trigger: fact.requires_reauth ? "workflow_auth" : "workflow_quota",
        source_event_key: `${binding.source_run_id}:${binding.auth_epoch}:${fact.source_offset}`,
      })
      .catch(() => {
        throw new FlowError(
          "AGY_ACCOUNT_UNAVAILABLE",
          "账号切换请求未受理，请查看账号操作状态",
          409,
        );
      });
    if (this.engine) {
      const w = this.engine.get(runInfo.workflow_id);
      const isAside = this.engine.store.must<Run>("run", runInfo.run_id).purpose === "aside";
      const waitRecord = {
        ...runInfo,
        operation_id: receipt.operation_id,
        workflow_version: w.version + (isAside || w.state === "BLOCKED" ? 0 : 1),
        plan_revision: w.plan_revision,
        plan_hash: w.plan_hash,
      };
      this.engine.store.put("agy_account_wait", runInfo.run_id, w.id, waitRecord);
      if (!isAside) {
        this.engine.store.put("agy_account_wait", w.id, w.id, waitRecord);
        this.engine.store.remove("model_retry", w.id);
      }
    }
    return !["failed", "cancelled"].includes(receipt.phase);
  }

  // --- AccountConsumerPort 接口实现 ---

  async listOccupancy(): Promise<ConsumerOccupancy[]> {
    const occs: ConsumerOccupancy[] = [];
    for (const run of this.activeRuns.values()) {
      occs.push({
        consumer_id: run.run_id,
        permit_ids: [run.permit_id],
        required_pool_ids: run.required_pool_ids,
        required_model_ids: run.effective_model_id
          ? [run.effective_model_id]
          : [],
        allowed_account_ids: run.allowed_account_ids ?? null,
        can_pause: true,
      });
    }
    return occs;
  }

  async prepareSwitch(operationId: string): Promise<{ savedRef: unknown }> {
    const runs = [...this.activeRuns.values()];
    if (this.engine) {
      const operation = this.accountService.getRepository().getOperation(operationId);
      const originalId = operation?.original_operation_id;
      const previousRuns = originalId
        ? this.engine.store.get<{ runs: ActiveManagedRun[] }>("agy_workflow_switch", originalId)?.runs ?? []
        : [];
      for (const waiting of this.engine.store.list<AccountWait>("agy_account_wait")) {
        const belongsToPrevious = originalId && this.waitBelongsToOperation(waiting, originalId) &&
          (previousRuns.some((run) => run.run_id === waiting.run_id && run.workflow_id === waiting.workflow_id) ||
            (waiting.run_id === operation?.source_run_id && waiting.workflow_id === operation?.workflow_id));
        if (
          (waiting.operation_id === operationId || belongsToPrevious) &&
          this.isCurrentWait(waiting) &&
          !runs.some((r) => r.run_id === waiting.run_id)
        )
          runs.push(waiting);
      }
      for (const run of runs) {
        const w = this.engine.get(run.workflow_id);
        const nativeRun = this.engine.store.must<Run>("run", run.run_id);
        const checkpoints = new AgyRecoveryCheckpointManager(this.engine.store);
        const recoveryId = `${operationId}:${run.run_id}`;
        const old = this.engine.store.get<AccountWait>("agy_account_wait", run.run_id);
        const isRebound = !!old && !!originalId && this.waitBelongsToOperation(old, originalId);
        const originalCheckpoint = isRebound && old
          ? checkpoints.getCheckpoint(`${old.operation_id}:${run.run_id}`)
          : undefined;
        if (!checkpoints.getCheckpoint(recoveryId))
          checkpoints.createCheckpoint(originalCheckpoint ? {
            ...originalCheckpoint,
            recovery_id: recoveryId,
          } : {
            recovery_id: recoveryId,
            workflow_id: w.id,
            source_run_id: run.run_id,
            source_account_id: run.account_id,
            source_auth_epoch: run.auth_epoch,
            reason: "account_switch",
            root_purpose: nativeRun.purpose ?? "implement",
            root_conversation_id: nativeRun.conversation_id,
            effective_model_id:
              (nativeRun.frozen_invocation ?? nativeRun.model_binding?.frozen_invocation)?.modelToken ??
              run.effective_model_id ?? "",
            subagents: this.engine.store.list<SubagentRecord>(
              "agy_subagent",
              run.run_id,
            ),
            created_at: new Date().toISOString(),
            workflow_version: w.version,
            plan_revision: w.plan_revision,
            plan_hash: w.plan_hash,
            profile_id: nativeRun.profile?.id,
            account_policy_revision: run.account_policy_revision,
          });
        if (old?.operation_id !== operationId) {
          const waitRecord = isRebound && old ? {
            ...old,
            operation_id: operationId,
          } : {
            ...run,
            operation_id: operationId,
            workflow_version: w.version + (nativeRun.purpose === "aside" || w.state === "BLOCKED" ? 0 : 1),
            plan_revision: w.plan_revision,
            plan_hash: w.plan_hash,
          };
          this.engine.store.put("agy_account_wait", run.run_id, w.id, waitRecord);
          if (nativeRun.purpose !== "aside")
            this.engine.store.put("agy_account_wait", w.id, w.id, waitRecord);
        }
      }
      this.engine.store.put("agy_workflow_switch", operationId, "workflow", {
        operation_id: operationId,
        runs,
      });
    }
    this.saved.set(operationId, runs);
    return { savedRef: { operation_id: operationId, runs } };
  }

  async quiesce(operationId: string): Promise<void> {
    // 停止所有属于受管 AGY Run 的进程
    const runs = this.saved.get(operationId) ?? [];
    await Promise.all(
      runs.map((run) => this.processManager.stop(run.run_id, "account_switch")),
    );
  }

  async confirmStopped(operationId: string): Promise<boolean> {
    const runs =
      this.saved.get(operationId) ??
      this.engine?.store.get<{ runs: ActiveManagedRun[] }>(
        "agy_workflow_switch",
        operationId,
      )?.runs;
    if (!runs) return false;
    if (runs.some((run) => this.processManager.get(run.run_id))) return false;
    const stopped = this.processHost
      ? await this.processHost.confirmJobsStopped(runs.map((run) => run.run_id))
      : runs.length === 0;
    if (!stopped) return false;

    // CR20 & CR22: 进程全部确认停止后，冻结执行耗时并增量保存工作区快照
    if (this.engine) {
      for (const run of runs) {
        const runRecord = this.engine.store.get<Run>("run", run.run_id);
        if (!runRecord) continue;
        const now = Date.now();
        const startedAt = runRecord.started_at ? Date.parse(runRecord.started_at) : now;
        const consumedMs = Math.max(0, now - startedAt);

        const checkpoints = new AgyRecoveryCheckpointManager(this.engine.store);
        const recoveryId = `${operationId}:${run.run_id}`;
        const chk = checkpoints.getCheckpoint(recoveryId);
        if (chk) {
          (chk as any).frozen_consumed_ms = consumedMs;
        }

        const workspaceDir = (runRecord as any).cwd ?? (runRecord as any).workspace_dir;
        if (workspaceDir) {
          try {
            const wsRes = await createWorkspaceCheckpoint(workspaceDir, {
              storageRoot: (this as any).config?.storage_root ?? "./.devflow",
              workflowId: run.workflow_id,
              sourceCheckpointId: recoveryId,
            });
            if (chk) {
              (chk as any).workspace_checkpoint_ref = wsRes.checkpoint_ref;
            }
          } catch {}
        }
        if (chk) {
          this.engine.store.put(
            "agy_recovery_checkpoint",
            chk.recovery_id,
            chk.workflow_id,
            chk,
          );
        }
      }
    }
    return true;
  }

  async onAccountCommitted(event: AccountCommittedEvent): Promise<void> {
    const currentRealm = this.accountService
      .getRepository()
      .getRealm(event.realm_id);
    if (
      !currentRealm ||
      currentRealm.auth_epoch !== event.auth_epoch ||
      currentRealm.active_account_id !== event.account_id
    )
      throw new FlowError(
        "AGY_ACCOUNT_RECOVERY_STALE",
        "账号已发生变化，不能执行旧恢复回调",
        409,
      );
    const affected =
      this.saved.get(event.operation_id) ??
      this.engine?.store.get<{ runs: ActiveManagedRun[] }>(
        "agy_workflow_switch",
        event.operation_id,
      )?.runs ??
      [];
    if (this.onRecoveryNeeded) {
      await this.onRecoveryNeeded(event, affected);
    }
    if (this.engine)
      for (const affectedRun of affected) {
        const engine = this.engine;
        await engine.waitForIdle(affectedRun.workflow_id);
        const saved = engine.store.get<AccountWait>("agy_account_wait", affectedRun.run_id);
        if (!saved || saved.run_id !== affectedRun.run_id ||
            saved.workflow_id !== affectedRun.workflow_id || saved.operation_id !== event.operation_id) continue;
        const w = engine.get(affectedRun.workflow_id);
        const run = engine.store.get<Run>("run", saved.run_id);
        const repository = this.accountService.getRepository();
        const aside = run?.purpose === "aside" ? this.asideForRun(w.id, run.id) : undefined;
        if (!this.isCurrentWait(saved)) {
          this.discardInvalidWait(saved);
          continue;
        }
        const committed = repository.getRealm(event.realm_id);
        if (committed?.active_account_id !== event.account_id || committed.auth_epoch !== event.auth_epoch)
          throw new FlowError("AGY_ACCOUNT_RECOVERY_STALE", "账号已变化，不能恢复旧账号操作", 409);
        try {
          const coordinator = new AgyWorkflowRecoveryCoordinator();
          const plans = await coordinator.planRecovery(
            event,
            [affectedRun],
            engine.store,
            new AgyRecoveryCheckpointManager(engine.store),
          );
          const plan = plans[0];
          if (!this.isCurrentWait(saved)) {
            this.discardInvalidWait(saved);
            continue;
          }
          // N06 修复：恢复决策是启动门禁，manual_required、superseded 不得创建可执行派发
          if (
            !plan ||
            plan.decision === "manual_required" ||
            plan.state === "manual_required" ||
            plan.decision === "superseded"
          ) {
            if (aside) {
              new AsideSessionService(engine.store).failSession(w.id, aside.id, "账号恢复需要人工介入或预算耗尽");
            } else {
              engine.block(
                w.id,
                new FlowError(
                  "RECOVERY_MANUAL_REQUIRED",
                  "恢复决策需要人工介入或预算耗尽",
                  422,
                ),
              );
            }
            this.removeWait(saved);
            continue;
          }

          if (plan?.continuation) {
            engine.store.put(
              "account_recovery_continuation",
              saved.run_id,
              w.id,
              plan.continuation,
            );
            if (plan.target_run_id) {
              engine.store.put(
                "account_recovery_continuation",
                plan.target_run_id,
                w.id,
                plan.continuation,
              );
            }
          }

          const chk = new AgyRecoveryCheckpointManager(engine.store).getCheckpoint(`${event.operation_id}:${saved.run_id}`);
          const wsRef = (chk as any)?.workspace_checkpoint_ref;
          const targetDir = (run as any)?.cwd ?? (run as any)?.workspace_dir;
          if (wsRef && targetDir) {
            const res = await restoreWorkspaceCheckpoint(wsRef, targetDir);
            if (!res.success || !res.complete) {
              throw new FlowError(
                  "WORKSPACE_RESTORE_FAILED",
                  `工作区材料恢复失败: ${res.error ?? "incomplete"}`,
                  422,
                );
            }
          }
          if (!this.isCurrentWait(saved)) {
            this.discardInvalidWait(saved);
            continue;
          }
          if (!run?.profile) throw new FlowError("RUN_BINDING_INVALID", "账号恢复缺少原轮工具配置", 409);
          const recoveryInfo = {
            recovery_id: plan.recovery_id,
            continuation: plan.continuation,
            remaining_budget_ms: plan.continuation?.remaining_budget_ms,
          };
          const access = new ModelAccessService(engine.store);
          if (aside) {
            const pending = buildAccountModelRunRetry(engine.store, w.id, saved.run_id, recoveryInfo);
            access.recordAccountRecoveryAccess(run.profile, pending.account_recovery!.frozen_invocation, event.operation_id);
            access.assertFrozenAccess(run.profile, pending.account_recovery!.frozen_invocation);
            // No await between the last source check, retry persistence and dispatch.
            engine.store.transaction(() => {
              if (!this.isCurrentWait(saved)) return;
              const resumed = new AsideSessionService(engine.store).resumeFromAccountWait(w.id, aside.id);
              engine.store.put("aside_session", aside.id, w.id, { ...resumed, account_recovery: pending });
              engine.store.enqueue(w.id, "dispatch_run", { workflow_id: w.id, aside_id: aside.id, purpose: "aside" });
              this.removeWait(saved);
            });
            void engine.dispatch();
            continue;
          }
          const pending = stageAccountModelRunRetry(engine.store, w.id, saved.run_id, recoveryInfo);
          access.recordAccountRecoveryAccess(run.profile, pending.account_recovery!.frozen_invocation, event.operation_id);
          assertAccountModelRetryAccess(engine.store, w.id, saved.run_id);
          if (!engine.restoreFailedRole(w.id, "账号切换完成，继续原角色"))
            resumeApproved(engine, w.id, { autoRetry: true });
        } catch (error) {
          if (!(error instanceof FlowError)) throw error;
          if (aside) {
            new AsideSessionService(engine.store).failSession(w.id, aside.id, error.message);
            this.removeWait(saved);
            continue;
          }
          const waitingForAccess = ["MODEL_ACCESS_REQUIRED", "MODEL_LOGIN_REQUIRED", "MODEL_FORBIDDEN", "MODEL_UNAVAILABLE"].includes(error.code);
          engine.block(w.id, waitingForAccess
            ? new FlowError("MODEL_ACCESS_REQUIRED", error.message, 422, { reason: error.code })
            : error);
          this.removeWait(saved);
          continue;
        }
        this.removeWait(saved);
        void engine.dispatch();
      }
    this.saved.delete(event.operation_id);
  }

  dispose(): void {
    this.accountService.setWorkflowWaitValidator(undefined);
    if (this.unregisterFn) {
      this.unregisterFn();
    }
  }
}
