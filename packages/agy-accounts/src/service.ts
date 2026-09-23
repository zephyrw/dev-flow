import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import {
  AgyAccountSettingsSchema,
  AgyAccountSettingsPatchSchema,
  AgyAccountPolicyPatchSchema,
  AgyAccountOperationSchema,
  AgyUsagePermitSchema,
  AgyAccountPolicySchema,
  AgyAccountDtoSchema,
} from "../../contracts/src/agy-account.js";
import type {
  AgyRealm,
  AgyUsagePermit,
  AgyAccountOperation,
  AgyAccountSettings,
  AgyAccountSettingsPatch,
  AgyAccount,
  AgyQuotaSnapshot,
  AgyPendingDemand,
} from "../../contracts/src/agy-account.js";
import type { AgyAccountRepository } from "./repository.js";
import type {
  AuthHostPort,
  AccountProbePort,
  ProcessHostPort,
  AccountConsumerPort,
  ClockPort,
  AuditPort,
} from "./ports.js";
import {
  SwitchOperationExecutor,
  type SwitchResult,
} from "./switch-operation.js";
import { AgyReconciler } from "./reconcile.js";
import { AgyEnrollmentService } from "./enrollment.js";
import { AgyManualSwitchService } from "./manual-switch.js";
import { AgyMaintenanceService } from "./maintenance.js";
import { selectCandidates, evaluateAccountForDemand } from "./selector.js";
import { computeDomainWait } from "./wait-policy.js";
import { AgyDomainCoordinator } from "./coordinator.js";
import { AgyLoginLauncher } from "./login.js";

export class AccountServiceError extends Error {
  constructor(
    public code: string,
    public statusCode = 409,
  ) {
    super(code);
  }
}

export interface ServiceControlRequest {
  realmId: string;
  requestId: string;
  expectedRevision?: number;
  expectedControlGeneration?: number;
}

export interface OperationReceipt {
  operation_id: string;
  revision: number;
  phase: string;
  error?: string;
}

export interface AgyUsageRequest {
  realm_id: string;
  consumer_id: string;
  usage_kind: "execution" | "probe" | "login";
  required_pool_ids: string[];
  required_model_ids?: string[];
  allowed_account_ids?: string[] | null;
  policy_revision?: number;
}

export interface UsagePermit {
  permit_id: string;
  realm_id: string;
  account_id: string;
  auth_epoch: number;
  realm_revision: number;
}

export interface UsageOutcome {
  permit_id: string;
  success: boolean;
  reason?: string;
}

export interface AccountOperationRequest {
  realm_id: string;
  request_id: string;
  kind: AgyAccountOperation["kind"];
  selection?: { mode: "auto" } | { mode: "explicit"; account_id: string };
  model_id?: string;
  expected_epoch?: number;
  required_pool_ids?: string[];
  expected_revision?: number;
  expected_settings_revision?: number;
  expected_account_revision?: number;
  account_id?: string;
  alias?: string;
  mode?: "login" | "capture_current";
  expected_identity?: string;
  selected_account_ids?: string[];
  operation_id?: string;
  workflow_id?: string;
  source_run_id?: string;
  original_operation_id?: string;
}

export interface WorkflowAccountOperationRequest
  extends AccountOperationRequest {
  kind: "switch";
  trigger: "workflow_quota" | "workflow_auth";
  source_event_key: string;
  allowed_account_ids?: string[] | null;
  night_pool?: "normal" | "strict";
  required_model_ids?: string[];
}

export interface WorkflowWaitReference {
  original_operation_id: string;
  workflow_id?: string;
  source_run_id?: string;
}

export class DefaultClockPort implements ClockPort {
  now(): number {
    return Date.now();
  }
  toISOString(): string {
    return new Date().toISOString();
  }
}

export class AgyAccountService {
  private consumers: AccountConsumerPort[] = [];
  private switchExecutor: SwitchOperationExecutor;
  private reconciler: AgyReconciler;
  private enrollmentService: AgyEnrollmentService;
  private manualSwitchService: AgyManualSwitchService;
  private maintenanceService: AgyMaintenanceService;
  private isTicking = false;
  private closing = false;
  private domainLockRelease?: () => Promise<void>;
  // Keep responsibility after lease loss until owned jobs have actually stopped.
  private ownedRealms = new Set<string>();
  private coordinator = new AgyDomainCoordinator();
  private consumerIds = new Map<AccountConsumerPort, string>();
  private activeAbort?: AbortController;
  private capabilitySnapshot?: any;
  private automationRealms = new Set<string>();
  private workflowWaitValidator?: (ref: WorkflowWaitReference) => boolean;
  private workflowWaitDiscarded?: (ref: WorkflowWaitReference) => void;

  setWorkflowWaitValidator(
    validator: ((ref: WorkflowWaitReference) => boolean) | undefined,
    onDiscard?: (ref: WorkflowWaitReference) => void,
  ): void {
    this.workflowWaitValidator = validator;
    this.workflowWaitDiscarded = onDiscard;
  }

  constructor(
    private repository: AgyAccountRepository,
    private authHost: AuthHostPort,
    private probe: AccountProbePort,
    private processHost: ProcessHostPort,
    private clock: ClockPort = new DefaultClockPort(),
    private audit?: AuditPort,
    loginLauncher?: AgyLoginLauncher,
    capabilitySnapshot?: any,
  ) {
    this.capabilitySnapshot = capabilitySnapshot;
    this.switchExecutor = new SwitchOperationExecutor(
      this.repository,
      this.authHost,
      this.probe,
      this.processHost,
      this.consumers,
      this.clock,
      this.consumerIds,
    );
    this.reconciler = new AgyReconciler(
      this.repository,
      this.authHost,
      this.probe,
      this.processHost,
    );
    this.enrollmentService = new AgyEnrollmentService(
      this.repository,
      this.authHost,
      this.probe,
      loginLauncher,
    );
    this.manualSwitchService = new AgyManualSwitchService(
      this.repository,
      this.switchExecutor,
      this.clock,
    );
    this.maintenanceService = new AgyMaintenanceService(
      this.repository,
      this.authHost,
      this.probe,
      this.clock,
    );
  }

  // 消费者注册
  registerConsumer(
    consumer: AccountConsumerPort,
    consumerId = "workflow",
  ): () => void {
    if ([...this.consumerIds.values()].includes(consumerId))
      throw new AccountServiceError("consumer_already_registered");
    this.consumerIds.set(consumer, consumerId);
    this.consumers.push(consumer);
    return () => {
      const idx = this.consumers.indexOf(consumer);
      if (idx >= 0) this.consumers.splice(idx, 1);
      this.consumerIds.delete(consumer);
    };
  }

  initializeSettings(
    realmId: string,
    defaults: Partial<AgyAccountSettings> & { enabled?: boolean } = {},
  ): AgyAccountSettings {
    const existing = this.repository.getSettings(realmId);
    if (existing) return existing;
    const settings = AgyAccountSettingsSchema.parse({
      ...defaults,
      realm_id: realmId,
      revision: 1,
      updated_at: this.clock.toISOString(),
    });
    this.repository.saveSettings(settings);
    if (!this.repository.getRealm(realmId) && defaults.enabled)
      this.repository.saveRealm({
        realm_id: realmId,
        owner: "devflow",
        active_account_id: null,
        auth_epoch: 0,
        phase: "idle",
        revision: 1,
        service_state: "stopped",
        desired_enabled: true,
        control_generation: 0,
      });
    return settings;
  }

  isManaged(realmId = "default-agy-realm"): boolean {
    const realm = this.repository.getRealm(realmId);
    return (
      !!realm && (realm.desired_enabled || realm.service_state === "stopping")
    );
  }

  resolveModelPools(_modelId: string, _realmId = "default-agy-realm"): string[] {
    // Compatibility entry point: quota admission always checks the two account windows.
    // Selecting this key grants no usage permit; observed quota is checked separately.
    return ["global"];
  }

  private deduplicate<T>(
    scope: string,
    requestId: string,
    payload: unknown,
    action: () => T,
  ): T {
    if (!requestId) throw new AccountServiceError("request_id_required", 400);
    const digest = createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex");
    return this.repository.transaction(() => {
      const key = `${scope}:${requestId}`;
      const previous = this.repository.getRecord<{ digest: string; result: T }>(
        "agy_request",
        key,
      );
      if (previous) {
        if (previous.digest !== digest)
          throw new AccountServiceError("request_id_conflict");
        return previous.result;
      }
      const result = action();
      this.repository.putRecord("agy_request", key, scope, { digest, result });
      return result;
    });
  }

  updateSettings(
    realmId: string,
    patch: AgyAccountSettingsPatch,
    expectedRevision: number,
    requestId: string,
  ): AgyAccountSettings {
    const allowed = AgyAccountSettingsPatchSchema.parse(patch);
    return this.deduplicate(
      `settings:${realmId}`,
      requestId,
      { allowed, expectedRevision },
      () => {
        if (this.automationRealms.has(realmId))
          throw new AccountServiceError("automation_change_in_progress");
        const current = this.initializeSettings(realmId);
        if (current.revision !== expectedRevision)
          throw new AccountServiceError("settings_revision_conflict");
        const updated = AgyAccountSettingsSchema.parse({
          ...current,
          ...allowed,
          maintenance: { ...current.maintenance, ...allowed.maintenance },
          revision: current.revision + 1,
          updated_at: this.clock.toISOString(),
        });
        new Intl.DateTimeFormat("en", {
          timeZone: updated.maintenance.timezone,
        });
        for (const time of [
          updated.maintenance.night_start,
          updated.maintenance.night_end,
          updated.maintenance.local_report_time,
        ])
          if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
            throw new AccountServiceError("invalid_maintenance_time", 400);
        this.repository.saveSettings(updated);
        return updated;
      },
    );
  }

  updateAccount(
    realmId: string,
    accountId: string,
    patch: { alias?: string; enabled?: boolean },
    expectedRevision: number,
    requestId: string,
  ) {
    const value = z
      .object({
        alias: z.string().min(1).optional(),
        enabled: z.boolean().optional(),
      })
      .strict()
      .parse(patch);
    return this.deduplicate(
      `account:${accountId}`,
      requestId,
      { value, expectedRevision },
      () => {
        const account = this.repository.getAccount(realmId, accountId);
        if (!account) throw new AccountServiceError("account_not_found", 404);
        if (account.revision !== expectedRevision)
          throw new AccountServiceError("account_revision_conflict");
        const realm = this.repository.getRealm(realmId);
        if (realm?.pending_operation_id)
          throw new AccountServiceError("operation_in_progress");
        if (value.enabled === false && realm?.active_account_id === accountId)
          throw new AccountServiceError("account_in_use");
        if (value.alias !== undefined) account.alias = value.alias;
        if (value.enabled === false && account.state !== "disabled") {
          account.state_before_disabled = account.state;
          account.state = "disabled";
        }
        if (value.enabled === true && account.state === "disabled")
          account.state = account.state_before_disabled ?? "pending_quota";
        account.revision++;
        this.repository.saveAccount(account);
        return AgyAccountDtoSchema.parse(account);
      },
    );
  }

  updatePolicy(
    workflowId: string,
    patch: Record<string, unknown>,
    expectedRevision: number,
    requestId: string,
  ) {
    const value = AgyAccountPolicyPatchSchema.parse(patch);
    return this.deduplicate(
      `policy:${workflowId}`,
      requestId,
      { value, expectedRevision },
      () => {
        const current = this.repository.getPolicy(workflowId);
        if ((current?.revision ?? 0) !== expectedRevision)
          throw new AccountServiceError("policy_revision_conflict");
        const next = AgyAccountPolicySchema.parse({
          ...current,
          ...value,
          workflow_id: workflowId,
          revision: (current?.revision ?? 0) + 1,
          created_at: this.clock.toISOString(),
        });
        this.repository.savePolicy(next);
        return next;
      },
    );
  }

  getPresentation(realmId = "default-agy-realm") {
    const settings =
        this.repository.getSettings(realmId) ??
        AgyAccountSettingsSchema.parse({
          realm_id: realmId,
          updated_at: this.clock.toISOString(),
        }),
      realm = this.repository.getRealm(realmId);
    const accounts = this.repository.listAccounts(realmId),
      snapshots = this.repository.listQuotaSnapshots(realmId);
    const pools = ["global"];
    const selection = selectCandidates(accounts, snapshots, pools, this.clock.now(), {
      reset_clock_skew_seconds: settings.reset_clock_skew_seconds,
    });
    const { active_secret_ref: _secret, ...publicRealm } = realm ?? {};
    return {
      accounts: accounts.map((a) => AgyAccountDtoSchema.parse(a)),
      snapshots,
      realm: publicRealm,
      settings,
      candidates: selection.ranked_candidates,
      excluded_accounts: selection.excluded_accounts,
      next_eligible_at: selection.next_eligible_at,
      required_pool_ids: pools,
      model_id: settings.standalone_model_id,
      capability: {
        supported: this.capabilitySnapshot?.supported ?? false,
        reason: this.capabilitySnapshot?.reason,
        snapshot: this.getCapabilitySnapshot(),
      },
    };
  }

  getCapabilitySnapshot(): any {
    if (this.capabilitySnapshot) return this.capabilitySnapshot;
    return {
      host_platform: process.platform,
      host_version: "unverified",
      dpapi_available: false,
      cred_manager_available: false,
      named_mutex_available: false,
      capabilities: {
        identity: { status: "unverified", reason: "未执行能力核验" },
        dual_quota: { status: "unverified", reason: "未执行能力核验" },
        interactive_login: { status: "unverified", reason: "未执行能力核验" },
        model_access: { status: "unverified", reason: "未执行能力核验" },
      },
      supported: false,
      reason: "能力快照未就绪",
    };
  }

  setCapabilitySnapshot(snapshot: any): void {
    this.capabilitySnapshot = snapshot;
  }

  async setAutomation(input: ServiceControlRequest & { enabled: boolean }): Promise<{
    enabled: boolean;
    service_state: string;
    revision: number;
  }> {
    const key = `automation:${input.realmId}:${input.requestId}`;
    const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const replay = this.repository.getRecord<{
      digest: string;
      result: { enabled: boolean; service_state: string; revision: number };
    }>("agy_request", key);
    if (replay) {
      if (replay.digest !== digest) throw new AccountServiceError("request_id_conflict");
      return replay.result;
    }
    // Stop can cancel a credential job before waiting for its queue slot.
    // Replayed or stale requests must not cancel a newer operation.
    const settings = this.initializeSettings(input.realmId);
    if (!input.enabled &&
        (input.expectedRevision === undefined || input.expectedRevision === settings.revision)) {
      this.activeAbort?.abort();
    }
    return this.coordinator.enqueue(async () => {
      if (this.closing) throw new AccountServiceError("account_service_closing");
      const previous = this.repository.getRecord<{
        digest: string;
        result: { enabled: boolean; service_state: string; revision: number };
      }>("agy_request", key);
      if (previous) {
        if (previous.digest !== digest) throw new AccountServiceError("request_id_conflict");
        return previous.result;
      }
      const before = this.initializeSettings(input.realmId);
      if (input.expectedRevision !== undefined && input.expectedRevision !== before.revision)
        throw new AccountServiceError("settings_revision_conflict");
      const realm = this.repository.getRealm(input.realmId);
      if (input.enabled && (realm?.service_state === "stopping" || realm?.pending_operation_id))
        throw new AccountServiceError("operation_in_progress");

      this.automationRealms.add(input.realmId);
      try {
        if (input.enabled) {
          await this.startOwned({ ...input, expectedRevision: before.revision });
        } else {
          await this.stopOwned({ ...input, expectedControlGeneration: realm?.control_generation });
        }
        // Do not change the setting before start succeeds. This avoids a
        // rollback revision that permanently invalidates the original request.
        return this.repository.transaction(() => {
          const current = this.initializeSettings(input.realmId);
          if (current.revision !== before.revision)
            throw new AccountServiceError("settings_revision_conflict");
          const updated = AgyAccountSettingsSchema.parse({
            ...current,
            workflow_auto_switch: input.enabled,
            revision: current.revision + 1,
            updated_at: this.clock.toISOString(),
          });
          this.repository.saveSettings(updated);
          const actual = this.repository.getRealm(input.realmId);
          const result = {
            enabled: Boolean(actual?.desired_enabled && updated.workflow_auto_switch),
            service_state: actual?.service_state ?? "stopped",
            revision: updated.revision,
          };
          this.repository.putRecord("agy_request", key, input.realmId, { digest, result });
          return result;
        });
      } finally {
        this.automationRealms.delete(input.realmId);
      }
    });
  }

  // 模块启动
  async start(input: ServiceControlRequest): Promise<OperationReceipt> {
    return this.coordinator.enqueue(async () => {
      const previous = this.controlReceipt(input, "start");
      if (previous) return previous;
      const receipt = await this.startOwned(input);
      return this.recordControl(input, "start", receipt, "completed");
    });
  }

  private async startOwned(
    input: ServiceControlRequest,
  ): Promise<OperationReceipt> {
    if (this.closing) throw new AccountServiceError("account_service_closing");
    const settings = this.initializeSettings(input.realmId);
    if (
      input.expectedRevision !== undefined &&
      settings.revision !== input.expectedRevision
    )
      throw new AccountServiceError("settings_revision_conflict");
    let realm = this.repository.getRealm(input.realmId);
    if (!realm) {
      realm = {
        realm_id: input.realmId,
        owner: "devflow",
        active_account_id: null,
        auth_epoch: 0,
        phase: "idle",
        revision: 1,
        service_state: "stopped",
        desired_enabled: false,
        control_generation: 0,
      };
      this.repository.saveRealm(realm);
    }

    if (
      realm.service_state === "running" &&
      this.authHost.isDomainLockHeld(input.realmId)
    ) {
      this.ownedRealms.add(input.realmId);
      return {
        operation_id: `op_start_${input.requestId}`,
        revision: realm.revision,
        phase: realm.phase,
      };
    }

    const capability = await this.authHost.capabilities();
    if (
      !capability.supported ||
      !capability.dpapi_available ||
      !capability.cred_manager_available ||
      !capability.named_mutex_available ||
      capability.version !== "3.0.0-node"
    ) {
      realm.service_state = "blocked";
      realm.last_error = "auth_host_capability_unavailable";
      this.repository.saveRealm(realm);
      throw new AccountServiceError("auth_host_capability_unavailable");
    }
    await this.processHost.listManagedProcesses(input.realmId);
    await this.processHost.findExternalAgyProcesses();

    // A retained one-shot lease is already ours and must not be reacquired.
    if (!this.authHost.isDomainLockHeld(input.realmId)) {
      const lockRes = await this.authHost.acquireDomainLock(input.realmId);
      if (!lockRes.acquired) {
        realm.service_state = "blocked";
        realm.last_error = "domain_owned_elsewhere";
        this.repository.saveRealm(realm);
        throw new AccountServiceError("domain_owned_elsewhere");
      }
      this.domainLockRelease = lockRes.release;
    }
    this.ownedRealms.add(input.realmId);

    // 2. 回读本地活动项
    const inspection = await this.authHost.inspectActive(input.realmId);
    if (
      !realm.pending_operation_id &&
      realm.active_secret_ref &&
      !(await this.authHost.compareActive(
        input.realmId,
        realm.active_secret_ref,
      ))
    ) {
      realm.service_state = "blocked";
      realm.last_error = "external_change";
      this.repository.saveRealm(realm);
      throw new AccountServiceError("external_change");
    }
    if (
      inspection.exists &&
      !realm.active_account_id &&
      inspection.account_id &&
      inspection.secret_ref
    ) {
      const account = this.repository.getAccount(
        input.realmId,
        inspection.account_id,
      );
      if (
        account &&
        (await this.authHost.compareActive(input.realmId, account.secret_ref))
      ) {
        realm.active_account_id = account.id;
        realm.active_secret_ref = account.secret_ref;
        realm.auth_epoch++;
      }
    }

    const resumeIntent = realm.desired_enabled;
    realm.service_state = "running";
    realm.desired_enabled = true;
    if (!resumeIntent) realm.control_generation += 1;
    realm.revision += 1;
    this.repository.saveRealm(realm);

    return {
      operation_id: `op_start_${input.requestId}`,
      revision: realm.revision,
      phase: realm.phase,
    };
  }

  // 模块停止
  async stop(input: ServiceControlRequest): Promise<OperationReceipt> {
    if (this.automationRealms.has(input.realmId))
      return this.coordinator.enqueue(() => this.stop(input));
    const previous = this.controlReceipt(input, "stop");
    if (previous) return previous;
    const receipt = await this.stopOwned(input);
    return this.recordControl(
      input,
      "stop",
      receipt,
      receipt.phase === "stopping" ? "stopping" : "completed",
    );
  }

  private controlReceipt(
    input: ServiceControlRequest,
    kind: "start" | "stop",
  ): OperationReceipt | undefined {
    const op = this.repository.getOperation(`op_${kind}_${input.requestId}`);
    if (!op) return undefined;
    if (
      op.realm_id !== input.realmId ||
      op.request_digest !==
        createHash("sha256").update(JSON.stringify(input)).digest("hex")
    )
      throw new AccountServiceError("request_id_conflict");
    return {
      operation_id: op.operation_id,
      revision: op.revision,
      phase: op.phase,
    };
  }

  private recordControl(
    input: ServiceControlRequest,
    kind: "start" | "stop",
    receipt: OperationReceipt,
    phase: string,
  ): OperationReceipt {
    const op = AgyAccountOperationSchema.parse({
      operation_id: receipt.operation_id,
      realm_id: input.realmId,
      revision: 1,
      kind,
      trigger: "manual_auto",
      selection: { mode: "auto" },
      request_id: input.requestId,
      request_digest: createHash("sha256")
        .update(JSON.stringify(input))
        .digest("hex"),
      phase,
      created_at: this.clock.toISOString(),
      completed_at:
        phase === "completed" ? this.clock.toISOString() : undefined,
    });
    this.repository.saveOperation(op);
    return {
      operation_id: op.operation_id,
      revision: op.revision,
      phase: op.phase,
    };
  }

  private async stopOwned(
    input: ServiceControlRequest,
  ): Promise<OperationReceipt> {
    const realm = this.repository.getRealm(input.realmId);
    if (!realm) {
      return {
        operation_id: `op_stop_${input.requestId}`,
        revision: 1,
        phase: "idle",
      };
    }

    if (
      input.expectedControlGeneration !== undefined &&
      realm.control_generation !== input.expectedControlGeneration
    )
      throw new AccountServiceError("control_generation_conflict");
    realm.service_state = "stopping";
    realm.desired_enabled = false;
    realm.control_generation++;
    realm.revision += 1;
    this.repository.saveRealm(realm);

    // 释放域等待并废止旧 waiting/deferred demand (R04)
    this.repository.clearDomainWait(input.realmId);
    const pendingDemands = this.repository.listDemands(input.realmId).filter(
      (d) => d.status === "waiting" || d.status === "deferred" || d.status === "selected",
    );
    for (const d of pendingDemands) {
      this.cancelWaitingDemand(input.realmId, d, "service_stopped");
    }

    this.activeAbort?.abort();
    if (realm.pending_operation_id) {
      const operation = this.repository.getOperation(
        realm.pending_operation_id,
      );
      if (operation) {
        operation.cancel_requested = true;
        operation.revision++;
        this.repository.saveOperation(operation);
        this.discardOperationWait(operation);
      }
    }
    if (
      this.coordinator.isBusy() ||
      realm.pending_operation_id ||
      this.repository
        .listPermits(input.realmId)
        .some((p) => p.status !== "released") ||
      (await this.processHost.listManagedProcesses(input.realmId)).length
    ) {
      return {
        operation_id: `op_stop_${input.requestId}`,
        revision: realm.revision,
        phase: "stopping",
      };
    }
    // No identity user remains: release the OS lease last.
    if (this.domainLockRelease) {
      await this.domainLockRelease();
      this.domainLockRelease = undefined;
    }

    realm.service_state = "stopped";
    realm.revision += 1;
    this.repository.saveRealm(realm);
    this.ownedRealms.delete(input.realmId);

    return {
      operation_id: `op_stop_${input.requestId}`,
      revision: realm.revision,
      phase: realm.phase,
    };
  }

  // 获取执行许可
  // Keep a model probe in the same account queue as credential switches. The
  // caller supplies the exact frozen invocation and owns its timeout/cancel.
  async withModelVerification<T>(
    input: { realm_id: string; account_id: string; auth_epoch?: number },
    verify: () => Promise<T>,
  ): Promise<T> {
    return this.coordinator.enqueue(async () => {
      const assertCurrent = () => {
        const realm = this.repository.getRealm(input.realm_id);
        if (
          this.closing || !realm || !realm.desired_enabled ||
          realm.service_state !== "running" || realm.phase !== "idle" ||
          realm.pending_operation_id ||
          realm.active_account_id !== input.account_id ||
          (input.auth_epoch !== undefined && realm.auth_epoch !== input.auth_epoch) ||
          !realm.active_secret_ref || !this.authHost.isDomainLockHeld(input.realm_id)
        ) throw new AccountServiceError("model_verification_account_changed");
        return realm;
      };
      const before = assertCurrent();
      const assertCredential = async () => {
        await this.processHost.listManagedProcesses(input.realm_id);
        if ((await this.processHost.findExternalAgyProcesses()).length)
          throw new AccountServiceError("external_owner");
        if (!(await this.authHost.compareActive(input.realm_id, before.active_secret_ref!)))
          throw new AccountServiceError("external_change");
        const current = assertCurrent();
        if (current.auth_epoch !== before.auth_epoch || current.revision !== before.revision)
          throw new AccountServiceError("model_verification_account_changed");
      };
      await assertCredential();
      const result = await verify();
      await assertCredential();
      return result;
    });
  }

  async acquireUsagePermit(input: AgyUsageRequest): Promise<UsagePermit> {
    return this.coordinator.enqueue(() => this.acquireUsagePermitOwned(input));
  }

  private async acquireUsagePermitOwned(
    input: AgyUsageRequest,
  ): Promise<UsagePermit> {
    if (this.closing) throw new AccountServiceError("account_service_closing");
    await this.processHost.listManagedProcesses(input.realm_id);
    if ((await this.processHost.findExternalAgyProcesses()).length)
      throw new AccountServiceError("external_owner");
    let realm = this.repository.getRealm(input.realm_id);
    if (
      !realm ||
      realm.service_state !== "running" ||
      realm.phase !== "idle" ||
      realm.pending_operation_id ||
      !this.authHost.isDomainLockHeld(input.realm_id)
    ) {
      throw new Error(`Account realm ${input.realm_id} is not running`);
    }

    if (!realm.active_account_id) {
      throw new Error(
        `No active AGY account selected for realm ${input.realm_id}`,
      );
    }
    let activeAccount = this.repository.getAccount(
      input.realm_id,
      realm.active_account_id,
    );
    if (!activeAccount) {
      throw new AccountServiceError("active_account_unavailable");
    }

    const poolsToEvaluate = input.required_pool_ids.length > 0 ? input.required_pool_ids : ["global"];
    let evalOutput = evaluateAccountForDemand({
      account: activeAccount,
      snapshots: this.repository.listQuotaSnapshots(input.realm_id),
      policy: {
        required_pool_ids: poolsToEvaluate,
        required_model_ids: input.required_model_ids,
        allowed_account_ids: input.allowed_account_ids,
        reset_clock_skew_seconds: this.initializeSettings(input.realm_id).reset_clock_skew_seconds,
      },
      evaluationTime: this.clock.now(),
    });

    // Q01/R05 修复：区分 candidate 与 permit。核对返回身份及凭据上下文，再保存快照
    if (!evalOutput.eligible_for_permit && evalOutput.eligible_for_candidate) {
      try {
        const fresh = await this.probe.probeUsage({
          account_id: activeAccount.id,
          credential_revision: activeAccount.credential_revision,
          timeoutMs: this.initializeSettings(input.realm_id).probe_timeout_seconds * 1000,
        });
        if (
          fresh.capability_verified &&
          fresh.email &&
          fresh.email.trim().toLowerCase() === activeAccount.identity.email.trim().toLowerCase()
        ) {
          // 同账号真实刷新：捕获最新凭据引用，更新账号与 realm，避免后置 compareActive 误判 external_change (R05)
          try {
            const capture = await this.authHost.captureActive(input.realm_id, activeAccount.id);
            this.saveCapture(input.realm_id, activeAccount.id, capture);
            const currentRealm = this.repository.getRealm(input.realm_id);
            if (currentRealm) {
              currentRealm.active_secret_ref = capture.secret_ref;
              currentRealm.last_capture_at = this.clock.toISOString();
              currentRealm.revision++;
              this.repository.saveRealm(currentRealm);
              realm = currentRealm;
            }
            activeAccount = this.repository.getAccount(input.realm_id, activeAccount.id)!;
          } catch {}

          for (const p of fresh.pools) {
            this.repository.saveQuotaSnapshot({
              id: `snp_refresh_${activeAccount.id}_${Date.now()}`,
              realm_id: input.realm_id,
              account_id: activeAccount.id,
              auth_epoch: realm.auth_epoch,
              pool_id: p.pool_id,
              model_ids: p.model_ids,
              source: "official_cli_usage",
              cli_version: fresh.cli_version,
              parser_revision: 1,
              executable_fingerprint: fresh.executable_fingerprint,
              capability_verified: fresh.capability_verified,
              observed_at: this.clock.toISOString(),
              windows: p.windows,
            });
          }
        }
      } catch (err: any) {
        if (err?.code === "PROCESS_STOP_UNCONFIRMED" || err?.name === "ProcessStopUnconfirmedError") {
          throw err;
        }
      }
      evalOutput = evaluateAccountForDemand({
        account: activeAccount,
        snapshots: this.repository.listQuotaSnapshots(input.realm_id),
        policy: {
          required_pool_ids: poolsToEvaluate,
          required_model_ids: input.required_model_ids,
          allowed_account_ids: input.allowed_account_ids,
          reset_clock_skew_seconds: this.initializeSettings(input.realm_id).reset_clock_skew_seconds,
        },
        evaluationTime: this.clock.now(),
      });
    }

    if (!evalOutput.eligible_for_permit) {
      throw new AccountServiceError("active_account_unavailable");
    }
    if (
      !realm.active_secret_ref ||
      !(await this.authHost.compareActive(
        input.realm_id,
        realm.active_secret_ref,
      ))
    )
      throw new AccountServiceError("external_change");
    for (const modelId of input.required_model_ids ?? [])
      if (
        !(await this.probe.probeModelAccess(modelId, {
          account_id: activeAccount.id,
          credential_revision: activeAccount.credential_revision,
          model_id: modelId,
          timeoutMs:
            this.initializeSettings(input.realm_id).probe_timeout_seconds *
            1000,
        }))
      )
        throw new AccountServiceError("target_model_unavailable");
    const current = this.repository.getRealm(input.realm_id)!;
    if (
      this.closing ||
      current.revision !== realm.revision ||
      current.pending_operation_id ||
      current.service_state !== "running"
    )
      throw new AccountServiceError("permit_admission_changed");

    const permitId = `pmt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const permit: AgyUsagePermit = AgyUsagePermitSchema.parse({
      permit_id: permitId,
      realm_id: input.realm_id,
      account_id: realm.active_account_id,
      auth_epoch: realm.auth_epoch,
      consumer_id: input.consumer_id,
      usage_kind: input.usage_kind,
      status: "issued",
      issued_at: this.clock.toISOString(),
      required_pool_ids: input.required_pool_ids,
      allowed_account_ids: input.allowed_account_ids ?? null,
      policy_revision: input.policy_revision,
      realm_revision: realm.revision,
    });

    this.repository.savePermit(permit);

    return {
      permit_id: permit.permit_id,
      realm_id: permit.realm_id,
      account_id: permit.account_id,
      auth_epoch: permit.auth_epoch,
      realm_revision: realm.revision,
    };
  }

  markUsageStarted(permitId: string, processId?: number): void {
    if (this.closing) throw new AccountServiceError("account_service_closing");
    this.repository.transaction(() => {
      const permit = this.repository.getPermit(permitId);
      if (!permit || permit.status !== "issued")
        throw new AccountServiceError("permit_not_issued");
      const realm = this.repository.getRealm(permit.realm_id);
      if (
        !realm ||
        !this.authHost.isDomainLockHeld(permit.realm_id) ||
        realm.service_state !== "running" ||
        realm.phase !== "idle" ||
        realm.pending_operation_id ||
        realm.auth_epoch !== permit.auth_epoch ||
        realm.active_account_id !== permit.account_id
      )
        throw new AccountServiceError("permit_stale");
      permit.status = "started";
      permit.process_id = processId;
      this.repository.savePermit(permit);
    });
  }

  attachUsageProcess(permitId: string, processId: number): void {
    const permit = this.repository.getPermit(permitId);
    if (!permit || permit.status !== "started")
      throw new AccountServiceError("permit_not_started");
    permit.process_id = processId;
    this.repository.savePermit(permit);
  }

  // 释放执行许可
  async releaseUsagePermit(
    permitId: string,
    outcome: UsageOutcome,
  ): Promise<void> {
    const permit = this.repository.getPermit(permitId);
    if (!permit) return;
    permit.status = "released";
    permit.released_at = this.clock.toISOString();
    this.repository.savePermit(permit);
    if (
      !outcome.success ||
      this.repository
        .listPermits(permit.realm_id)
        .some((p) => p.status !== "released")
    )
      return;
    const atRelease = this.repository.getRealm(permit.realm_id);
    if (
      !atRelease ||
      atRelease.pending_operation_id ||
      atRelease.phase !== "idle"
    )
      return;
    await this.coordinator.enqueue(async () => {
      const realm = this.repository.getRealm(permit.realm_id);
      if (
        !realm ||
        realm.pending_operation_id ||
        realm.phase !== "idle" ||
        realm.auth_epoch !== permit.auth_epoch ||
        !this.authHost.isDomainLockHeld(permit.realm_id) ||
        (await this.processHost.findExternalAgyProcesses()).length
      )
        return;
      if (
        realm.last_capture_at &&
        this.clock.now() - Date.parse(realm.last_capture_at) < 60_000
      )
        return;
      const account = this.repository.getAccount(
        permit.realm_id,
        permit.account_id,
      );
      if (!account) return;
      realm.phase = "capturing";
      realm.revision++;
      this.repository.saveRealm(realm);
      try {
        const observed = await this.probe.probeUsage({
          account_id: account.id,
          credential_revision: account.credential_revision,
          timeoutMs:
            this.initializeSettings(permit.realm_id).probe_timeout_seconds *
            1000,
        });
        if (
          observed.email?.toLowerCase() !== account.identity.email.toLowerCase()
        )
          throw new AccountServiceError("external_change");
        const capture = await this.authHost.captureActive(
          permit.realm_id,
          account.id,
        );
        this.saveCapture(permit.realm_id, account.id, capture);
        const current = this.repository.getRealm(permit.realm_id)!;
        if (current.auth_epoch !== permit.auth_epoch)
          throw new AccountServiceError("epoch_conflict");
        current.active_secret_ref = capture.secret_ref;
        current.last_capture_at = this.clock.toISOString();
        current.revision++;
        this.repository.saveRealm(current);
        for (const pool of observed.pools)
          this.repository.saveQuotaSnapshot({
            id: randomUUID(),
            realm_id: permit.realm_id,
            account_id: account.id,
            auth_epoch: permit.auth_epoch,
            pool_id: pool.pool_id,
            model_ids: pool.model_ids,
            source: "official_cli_usage",
            cli_version: observed.cli_version,
            parser_revision: 1,
            executable_fingerprint: observed.executable_fingerprint,
            capability_verified: observed.capability_verified,
            observed_at: this.clock.toISOString(),
            windows: pool.windows,
          });
      } catch (error) {
        const current = this.repository.getRealm(permit.realm_id)!;
        current.last_error =
          error instanceof AccountServiceError
            ? error.code
            : "final_snapshot_failed";
        if (current.last_error === "external_change") current.phase = "blocked";
        this.repository.saveRealm(current);
      } finally {
        const current = this.repository.getRealm(permit.realm_id)!;
        if (current.phase === "capturing") {
          current.phase = "idle";
          current.revision++;
          this.repository.saveRealm(current);
        }
      }
    });
  }

  // 手动操作
  async requestOperation(
    input: AccountOperationRequest,
  ): Promise<OperationReceipt> {
    if (input.required_pool_ids !== undefined)
      throw new AccountServiceError("client_pool_forbidden", 400);
    return this.acceptOperation(input);
  }

  async requestWorkflowOperation(
    input: WorkflowAccountOperationRequest,
  ): Promise<OperationReceipt> {
    if (
      !input.source_event_key ||
      !input.required_pool_ids?.length ||
      input.expected_epoch === undefined ||
      !this.consumers.length
    )
      throw new AccountServiceError("invalid_workflow_source", 400);
    return this.acceptOperation(input, input);
  }

  private demandWaitReference(demand: AgyPendingDemand): WorkflowWaitReference {
    const saved = demand.opaque_recovery_ref as Partial<WorkflowWaitReference> | undefined;
    const originalId = saved?.original_operation_id ?? demand.fairness_key;
    const original = this.repository.getOperation(originalId);
    return {
      original_operation_id: originalId,
      workflow_id: saved?.workflow_id ?? original?.workflow_id,
      source_run_id: saved?.source_run_id ?? original?.source_run_id,
    };
  }

  private discardOperationWait(operation: AgyAccountOperation): void {
    this.workflowWaitDiscarded?.({
      original_operation_id: operation.original_operation_id ?? operation.operation_id,
      workflow_id: operation.workflow_id,
      source_run_id: operation.source_run_id,
    });
  }

  private waitInvalidReason(
    realmId: string,
    generation: number,
    ref: WorkflowWaitReference,
  ): string | undefined {
    const original = this.repository.getOperation(ref.original_operation_id);
    if (!original || original.realm_id !== realmId) return "original_operation_missing";
    if (original.cancel_requested || ["completed", "failed", "cancelled"].includes(original.phase))
      return "original_operation_cancelled_or_finished";
    if (original.control_generation !== generation) return "control_generation_stale";
    if (ref.workflow_id || ref.source_run_id) {
      // Wait until its consumer is attached after startup; absence is not permission to switch.
      if (!this.workflowWaitValidator) return "workflow_validator_unavailable";
      try {
        if (!this.workflowWaitValidator(ref)) return "workflow_source_invalid";
      } catch {
        return "workflow_validator_unavailable";
      }
    }
    return undefined;
  }

  private cancelWaitingDemand(realmId: string, demand: AgyPendingDemand, reason: string): void {
    demand.status = "cancelled";
    demand.wake_at = null;
    demand.last_reason = reason;
    demand.revision++;
    this.repository.saveDemand(demand, realmId);
    const originalId = this.demandWaitReference(demand).original_operation_id;
    const realm = this.repository.getRealm(realmId);
    for (const related of this.repository.listOperations(realmId)) {
      if (
        (related.original_operation_id ?? related.operation_id) === originalId &&
        related.phase === "waiting" && realm?.pending_operation_id !== related.operation_id
      ) {
        related.cancel_requested = true;
        related.phase = "cancelled";
        related.completed_at = this.clock.toISOString();
        related.revision++;
        this.repository.saveOperation(related);
      }
    }
    const wait = this.repository.getDomainWait(realmId);
    const operation = wait?.operation_id ? this.repository.getOperation(wait.operation_id) : undefined;
    if (operation && (operation.original_operation_id ?? operation.operation_id) ===
      originalId)
      this.repository.clearDomainWait(realmId);
    this.workflowWaitDiscarded?.(this.demandWaitReference(demand));
  }

  private acceptOperation(
    input: AccountOperationRequest,
    trusted?: WorkflowAccountOperationRequest,
  ): OperationReceipt {
    if (this.closing) throw new AccountServiceError("account_service_closing");
    if (this.automationRealms.has(input.realm_id))
      throw new AccountServiceError("automation_change_in_progress");
    return this.deduplicate(
      `operation:${input.realm_id}`,
      input.request_id,
      input,
      () => {
        const isManualOneShot =
          input.kind === "enroll" ||
          input.kind === "delete" ||
          input.kind === "probe" ||
          input.kind === "reauth" ||
          (input.kind === "switch" && input.selection?.mode === "explicit");
        let realm = this.repository.getRealm(input.realm_id);
        const expectedRealmRevision = realm?.revision ?? 0;
        if (!realm) {
          if (isManualOneShot) {
            realm = {
              realm_id: input.realm_id,
              owner: "devflow",
              active_account_id: null,
              auth_epoch: 0,
              phase: "idle",
              revision: 1,
              service_state: "stopped",
              desired_enabled: false,
              control_generation: 0,
            };
            this.repository.saveRealm(realm);
          } else {
            throw new AccountServiceError("realm_not_found", 404);
          }
        }
        if (input.kind === "cancel") {
          const op = input.operation_id
            ? this.repository.getOperation(input.operation_id)
            : undefined;
          if (!op || op.realm_id !== input.realm_id)
            throw new AccountServiceError("operation_not_found", 404);
          if (
            input.expected_revision !== undefined &&
            input.expected_revision !== op.revision
          )
            throw new AccountServiceError("operation_revision_conflict");
          const originalId = op.original_operation_id ?? op.operation_id;
          for (const demand of this.repository.listDemands(input.realm_id)) {
            if (
              this.demandWaitReference(demand).original_operation_id === originalId &&
              ["waiting", "deferred", "selected"].includes(demand.status)
            ) this.cancelWaitingDemand(input.realm_id, demand, "operation_cancelled");
          }
          for (const related of this.repository.listOperations(input.realm_id)) {
            if (
              (related.original_operation_id ?? related.operation_id) !== originalId ||
              ["completed", "failed", "cancelled"].includes(related.phase)
            ) continue;
            related.cancel_requested = true;
            // A detached wait has already restored its identity; no job cleanup remains.
            if (related.phase === "waiting" && realm.pending_operation_id !== related.operation_id) {
              related.phase = "cancelled";
              related.completed_at = this.clock.toISOString();
            }
            related.revision++;
            this.repository.saveOperation(related);
            if (realm.pending_operation_id === related.operation_id) this.activeAbort?.abort();
          }
          const cancelled = this.repository.getOperation(op.operation_id)!;
          this.discardOperationWait(cancelled);
          return {
            operation_id: cancelled.operation_id,
            revision: cancelled.revision,
            phase: cancelled.phase,
          };
        }
        if (
          (input.kind === "reauth" ||
            (input.kind === "enroll" && input.mode !== "capture_current")) &&
          !this.enrollmentService.isLoginAvailable()
        )
          throw new AccountServiceError(
            "interactive_login_capability_unverified",
          );
        if (
          !isManualOneShot &&
          (realm.service_state !== "running" ||
            !realm.desired_enabled ||
            !this.authHost.isDomainLockHeld(input.realm_id))
        )
          throw new AccountServiceError("account_service_not_running");
        if (
          input.expected_epoch !== undefined &&
          input.expected_epoch !== realm.auth_epoch
        )
          throw new AccountServiceError("epoch_conflict");
        if (
          input.expected_revision !== undefined &&
          input.expected_revision !== expectedRealmRevision
        )
          throw new AccountServiceError("realm_revision_conflict");
        const settings = this.initializeSettings(input.realm_id);
        if (
          input.expected_settings_revision !== undefined &&
          input.expected_settings_revision !== settings.revision
        )
          throw new AccountServiceError("settings_revision_conflict");
        if (realm.pending_operation_id) {
          const op = this.repository.getOperation(realm.pending_operation_id)!;
          if (
            trusted &&
            op.before_auth_epoch === input.expected_epoch &&
            op.trigger.startsWith("workflow")
          )
            return {
              operation_id: op.operation_id,
              revision: op.revision,
              phase: op.phase,
            };
          throw new AccountServiceError("operation_in_progress");
        }
        if (input.account_id) {
          const account = this.repository.getAccount(
            input.realm_id,
            input.account_id,
          );
          if (!account) throw new AccountServiceError("account_not_found", 404);
          if (
            input.expected_account_revision !== undefined &&
            account.revision !== input.expected_account_revision
          )
            throw new AccountServiceError("account_revision_conflict");
          if (
            input.expected_identity &&
            input.expected_identity.toLowerCase() !==
              account.identity.email.toLowerCase()
          )
            throw new AccountServiceError("identity_conflict");
          if (input.kind === "delete" && account.id === realm.active_account_id)
            throw new AccountServiceError("account_in_use");
        }
        const model = input.model_id ??
          (trusted ? undefined : settings.standalone_model_id ?? undefined);
        const pools = input.kind === "switch" ? ["global"] : [];
        const op = AgyAccountOperationSchema.parse({
          operation_id: randomUUID(),
          realm_id: input.realm_id,
          revision: 1,
          kind: input.kind,
          trigger:
            trusted?.trigger ??
            (input.kind === "maintenance"
              ? "maintenance"
              : input.kind === "enroll" || input.kind === "reauth"
                ? "enrollment"
                : input.selection?.mode === "explicit"
                  ? "manual_explicit"
                  : "manual_auto"),
          selection: input.selection ?? { mode: "auto" },
          target_account_id:
            input.selection?.mode === "explicit"
              ? input.selection.account_id
              : input.account_id,
          before_account_id: realm.active_account_id ?? undefined,
          before_auth_epoch: realm.auth_epoch,
          control_generation: realm.control_generation,
          expected_settings_revision: settings.revision,
          expected_account_revision: input.expected_account_revision,
          request_id: input.request_id,
          request_digest: createHash("sha256")
            .update(JSON.stringify(input))
            .digest("hex"),
          phase: "queued",
          created_at: this.clock.toISOString(),
          deadline_at: new Date(
            this.clock.now() +
              (input.kind === "enroll" || input.kind === "reauth"
                ? 900
                : settings.switch_timeout_seconds) *
                1000,
          ).toISOString(),
          required_pool_ids: pools,
          required_model_ids: [
            ...new Set([
              ...(model ? [model] : []),
              ...(trusted?.required_model_ids ?? []),
            ]),
          ],
          model_id: model,
          account_id: input.account_id,
          alias: input.alias,
          mode: input.mode,
          expected_identity: input.expected_identity,
          selected_account_ids: input.selected_account_ids ?? [],
          allowed_account_ids: trusted?.allowed_account_ids ?? null,
          night_pool: trusted?.night_pool ?? "normal",
          source_event_key: trusted?.source_event_key,
          workflow_id: input.workflow_id ?? (trusted as any)?.workflow_id,
          source_run_id: input.source_run_id ?? (trusted as any)?.source_run_id,
          original_operation_id: input.original_operation_id ?? (trusted as any)?.original_operation_id,
        });
        this.repository.saveOperation(op);
        realm.pending_operation_id = op.operation_id;
        realm.phase = "queued";
        realm.revision++;
        this.repository.saveRealm(realm);
        return {
          operation_id: op.operation_id,
          revision: op.revision,
          phase: op.phase,
        };
      },
    );
  }

  // 启动收敛
  async reconcileStartup(): Promise<void> {
    for (const realm of this.repository.listRealms()) {
      try {
        if (realm.desired_enabled) {
          await this.start({
            realmId: realm.realm_id,
            requestId: `restart_${randomUUID()}`,
          });
          await this.reconciler.reconcileStartup(realm.realm_id);
        } else {
          // N04 修复：desired_enabled = false 的域保持 stopped，不改 desired=true
          // 仅当存在残留未收尾操作时才进入专用 cleanup 周期
          const hasResidual = this.repository
            .listOperations(realm.realm_id)
            .some((op) => op.phase !== "completed" && op.phase !== "failed" && op.phase !== "cancelled");
          if (hasResidual) {
            if (!this.authHost.isDomainLockHeld(realm.realm_id)) {
              const lock = await this.authHost.acquireDomainLock(realm.realm_id);
              if (!lock.acquired) throw new AccountServiceError("domain_owned_elsewhere");
              this.domainLockRelease = lock.release;
            }
            this.ownedRealms.add(realm.realm_id);
            await this.reconciler.reconcileStartup(realm.realm_id);
            const cleaned = this.repository.getRealm(realm.realm_id)!;
            if (!cleaned.pending_operation_id && cleaned.phase !== "blocked") {
              await this.domainLockRelease?.();
              this.domainLockRelease = undefined;
              this.ownedRealms.delete(realm.realm_id);
              cleaned.service_state = "stopped";
              cleaned.last_error = undefined;
              cleaned.revision++;
              this.repository.saveRealm(cleaned);
            }
          }
          const current = this.repository.getRealm(realm.realm_id)!;
          if (current.service_state !== "blocked") {
            current.service_state = "stopped";
            current.phase = "idle";
            this.repository.saveRealm(current);
          }
        }
      } catch (error) {
        const current = this.repository.getRealm(realm.realm_id)!;
        current.service_state = "blocked";
        current.last_error =
          error instanceof AccountServiceError
            ? error.code
            : "reconcile_failed";
        this.repository.saveRealm(current);
      }
    }
  }

  // 定时驱动 tick（5 秒调用一次，无任务无网络请求）
  async tick(now: number): Promise<void> {
    if (this.closing || this.isTicking) return;
    this.isTicking = true;
    try {
      for (const realm of this.repository.listRealms()) {
        const settings = this.repository.getSettings(realm.realm_id);
        if (settings) {
          const parts = new Intl.DateTimeFormat("sv-SE", {
            timeZone: settings.maintenance.timezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
          }).formatToParts(new Date(now));
          const component = (type: string) =>
            parts.find((p) => p.type === type)?.value ?? "";
          const date = `${component("year")}-${component("month")}-${component("day")}`;
          if (
            `${component("hour")}:${component("minute")}` >=
              settings.maintenance.local_report_time &&
            !this.repository.getRecord(
              "agy_local_report",
              `${realm.realm_id}:${date}`,
            )
          )
            this.repository.putRecord(
              "agy_local_report",
              `${realm.realm_id}:${date}`,
              realm.realm_id,
              this.maintenanceService.generateLocalReport(realm.realm_id),
            );
        }
        if (
          realm.service_state === "running" &&
          !this.authHost.isDomainLockHeld(realm.realm_id)
        ) {
          realm.service_state = "blocked";
          realm.phase = "blocked";
          realm.last_error = "domain_lock_lost";
          realm.revision++;
          this.repository.saveRealm(realm);
          for (const process of await this.processHost.listManagedProcesses(
            realm.realm_id,
          ))
            await this.processHost.stopProcess(process.pid, "account_switch");
          continue;
        }
        if (realm.pending_operation_id) {
          const operation = this.repository.getOperation(
            realm.pending_operation_id,
          );
          if (operation?.phase === "blocked" && operation.cancel_requested && !realm.desired_enabled) {
            await this.coordinator.enqueue(async () => {
              await this.reconciler.reconcileStartup(realm.realm_id);
              const cleaned = this.repository.getRealm(realm.realm_id)!;
              if (!cleaned.pending_operation_id && cleaned.phase !== "blocked") {
                cleaned.service_state = "stopping";
                cleaned.last_error = undefined;
                cleaned.revision++;
                this.repository.saveRealm(cleaned);
              }
            });
            // The existing stopping branch releases the lease on the next tick.
            continue;
          }
          if (operation?.phase === "waiting" && !operation.cancel_requested) {
            const reason = this.waitInvalidReason(realm.realm_id, realm.control_generation, {
              original_operation_id: operation.original_operation_id ?? operation.operation_id,
              workflow_id: operation.workflow_id,
              source_run_id: operation.source_run_id,
            });
            if (reason === "workflow_validator_unavailable") continue;
            if (reason) {
              operation.cancel_requested = true;
              operation.revision++;
              this.repository.saveOperation(operation);
              this.discardOperationWait(operation);
            }
          }
          if (
            operation &&
            operation.phase !== "blocked" &&
            (operation.cancel_requested ||
              operation.phase !== "waiting" ||
              (!!operation.retry_at &&
                now >= Date.parse(operation.retry_at))) &&
            (operation.cancel_requested ||
              !operation.retry_at ||
              now >= Date.parse(operation.retry_at))
          )
            await this.coordinator.enqueue(() =>
              this.driveOperation(operation),
            );
        } else if (realm.service_state === "running" && !this.coordinator.isBusy()) {
          // N03 / Q05 / R04 修复：当 pending_operation_id 为空时，扫描到期且同代次的有效 demand
          const dueDemands = this.repository.listDemands(realm.realm_id).filter((d) => {
            if ((d.status !== "waiting" && d.status !== "deferred") || !d.wake_at || now < Date.parse(d.wake_at)) {
              return false;
            }
            if (d.control_generation !== realm.control_generation) {
              this.cancelWaitingDemand(realm.realm_id, d, "control_generation_stale");
              return false;
            }
            const reason = this.waitInvalidReason(
              realm.realm_id, realm.control_generation, this.demandWaitReference(d),
            );
            if (reason) {
              if (reason !== "workflow_validator_unavailable")
                this.cancelWaitingDemand(realm.realm_id, d, reason);
              return false;
            }
            return true;
          });
          if (dueDemands.length > 0) {
            const dueDemand = dueDemands[0]!;
            const prevWake = dueDemand.wake_at;
            dueDemand.consumed_wake_key = dueDemand.wake_at!;
            dueDemand.wake_at = null;
            dueDemand.status = "selected";
            dueDemand.revision++;
            this.repository.saveDemand(dueDemand, realm.realm_id);

            const ref = this.demandWaitReference(dueDemand);

            await this.coordinator.enqueue(async () => {
              try {
                const current = this.repository.getRealm(realm.realm_id);
                const demand = this.repository.getDemand(dueDemand.demand_id);
                if (!current || !demand || demand.status !== "selected") return;
                const reason = current.control_generation !== demand.control_generation
                  ? "control_generation_stale"
                  : this.waitInvalidReason(current.realm_id, current.control_generation, ref);
                if (reason && reason !== "workflow_validator_unavailable") {
                  this.cancelWaitingDemand(current.realm_id, demand, reason);
                  return;
                }
                if (reason || current.service_state !== "running" || !current.desired_enabled)
                  throw new AccountServiceError(reason ?? "account_service_not_running");
                await this.requestWorkflowOperation({
                  realm_id: realm.realm_id,
                  request_id: randomUUID(),
                  kind: "switch",
                  trigger: "workflow_quota",
                  ...ref,
                  source_event_key: `wake_${dueDemand.demand_id}_${Date.now()}`,
                  required_pool_ids: dueDemand.required_pool_ids.length > 0 ? dueDemand.required_pool_ids : ["global"],
                  allowed_account_ids: dueDemand.allowed_account_ids,
                  night_pool: dueDemand.night_pool,
                  required_model_ids: dueDemand.required_model_keys,
                  expected_epoch: current.auth_epoch,
                });
              } catch (err) {
                // Q05: 失败时不吞掉，恢复 waiting 状态，防止永久丢失唤醒
                const d = this.repository.getDemand(dueDemand.demand_id);
                if (d && d.status === "selected") {
                  d.status = "waiting";
                  d.wake_at = prevWake;
                  d.revision++;
                  this.repository.saveDemand(d, realm.realm_id);
                }
              }
            });
          }
        }
        const current = this.repository.getRealm(realm.realm_id)!;
        if (
          current.service_state === "stopping" &&
          !this.coordinator.isBusy() &&
          !current.pending_operation_id &&
          !this.repository
            .listPermits(realm.realm_id)
            .some((p) => p.status !== "released") &&
          !(await this.processHost.listManagedProcesses(realm.realm_id)).length
        ) {
          if (this.domainLockRelease) {
            await this.domainLockRelease();
            this.domainLockRelease = undefined;
          }
          current.service_state = "stopped";
          current.phase = "idle";
          current.revision++;
          this.repository.saveRealm(current);
          this.ownedRealms.delete(realm.realm_id);
          for (const op of this.repository.listOperations(realm.realm_id))
            if (op.kind === "stop" && op.phase === "stopping") {
              op.phase = "completed";
              op.completed_at = this.clock.toISOString();
              op.revision++;
              this.repository.saveOperation(op);
            }
        }
      }
    } finally {
      this.isTicking = false;
    }
  }

  private assertOperation(op: AgyAccountOperation, signal?: AbortSignal): void {
    const realm = this.repository.getRealm(op.realm_id)!;
    const isManualOneShot =
      op.kind === "enroll" ||
      op.kind === "delete" ||
      op.kind === "probe" ||
      op.kind === "reauth" ||
      (op.kind === "switch" && op.selection?.mode === "explicit");

    if (!this.authHost.isDomainLockHeld(op.realm_id))
      throw new AccountServiceError("domain_lock_lost");
    if (
      !realm ||
      realm.pending_operation_id !== op.operation_id ||
      realm.control_generation !== op.control_generation ||
      (!isManualOneShot && realm.service_state !== "running") ||
      this.repository.getOperation(op.operation_id)?.cancel_requested ||
      signal?.aborted
    )
      throw new AccountServiceError("operation_cancelled");
    if (op.deadline_at && this.clock.now() >= Date.parse(op.deadline_at))
      throw new AccountServiceError("operation_timeout");
    if (
      this.initializeSettings(op.realm_id).revision !==
      op.expected_settings_revision
    )
      throw new AccountServiceError("settings_revision_changed");
  }

  private saveStep(op: AgyAccountOperation, phase: string): void {
    op.phase = phase;
    op.revision++;
    this.repository.saveOperation(op);
    const realm = this.repository.getRealm(op.realm_id)!;
    realm.phase = phase;
    realm.revision++;
    this.repository.saveRealm(realm);
  }

  private async driveOperation(original: AgyAccountOperation): Promise<void> {
    let op = this.repository.getOperation(original.operation_id)!;
    this.activeAbort = new AbortController();
    const signal = this.activeAbort.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let temporaryLockRelease: (() => Promise<void>) | undefined;

    const isManualOneShot =
      op.kind === "enroll" ||
      op.kind === "delete" ||
      op.kind === "probe" ||
      op.kind === "reauth" ||
      (op.kind === "switch" && op.selection?.mode === "explicit");

    if (isManualOneShot && !this.authHost.isDomainLockHeld(op.realm_id)) {
      try {
        const lockRes = await this.authHost.acquireDomainLock(op.realm_id);
        if (lockRes.acquired && lockRes.release) {
          temporaryLockRelease = lockRes.release;
          this.domainLockRelease = lockRes.release;
          this.ownedRealms.add(op.realm_id);
        } else {
          op.error = "domain_lock_acquire_failed";
          this.finishOperation(op, "failed");
          this.activeAbort = undefined;
          return;
        }
      } catch (err) {
        op.error = err instanceof Error ? err.message : "domain_lock_acquire_failed";
        this.finishOperation(op, "failed");
        this.activeAbort = undefined;
        return;
      }
    }

    if (op.deadline_at)
      timer = setTimeout(
        () => this.activeAbort?.abort(),
        Math.max(1, Date.parse(op.deadline_at) - this.clock.now()),
      );
    try {
      if (!["committed", "recovering"].includes(op.phase)) {
        if (op.original_operation_id && !op.cancel_requested) {
          const reason = this.waitInvalidReason(op.realm_id, op.control_generation, {
            original_operation_id: op.original_operation_id,
            workflow_id: op.workflow_id,
            source_run_id: op.source_run_id,
          });
          if (reason === "workflow_validator_unavailable") return;
          if (reason) {
            op.cancel_requested = true;
            op.revision++;
            this.repository.saveOperation(op);
            this.discardOperationWait(op);
            throw new AccountServiceError("operation_cancelled");
          }
        }
        this.assertOperation(op, signal);
        const external = await this.processHost.findExternalAgyProcesses();
        if (external.length) {
          op.external_processes = external.map(({ pid, exe_path }) => ({
            pid,
            exe_path,
          }));
          this.saveStep(op, "waiting_external_exit");
          return;
        }
        if (op.kind === "switch") {
          const result = await this.switchExecutor.execute({
            operationId: op.operation_id,
            realmId: op.realm_id,
            selection: op.selection,
            trigger: op.trigger,
            requiredPoolIds: op.required_pool_ids,
            modelId: op.model_id,
            requestId: op.request_id,
            expectedEpoch: op.before_auth_epoch,
            signal,
          });
          op = this.repository.getOperation(op.operation_id)!;
          if (result.status === "external_blocked") return;
          op.result = { ...result };
          if (!result.success) {
            if (
              result.status === "no_eligible_account" &&
              op.trigger.startsWith("workflow")
            ) {
              op.retry_at = result.next_eligible_at ?? undefined;
              op.deadline_at = undefined; // Q05 修复：清除切号单次300秒超时，避免长等待提前超时
              this.repository.saveDomainWait({
                realm_id: op.realm_id,
                operation_id: op.operation_id,
                next_eligible_at: result.next_eligible_at ?? null,
                source_epoch: this.repository.getRealm(op.realm_id)!.auth_epoch,
                control_generation: op.control_generation,
                reason: "no_eligible_account",
                created_at: this.clock.toISOString(),
              });
              this.saveStep(op, "waiting");
              return;
            }
            throw new AccountServiceError(result.message ?? result.status);
          }
          this.saveStep(op, "committed");
        } else {
          await this.executeAccountOperation(op, signal);
          op = this.repository.getOperation(op.operation_id)!;
        }
      }
      const currentRealm = this.repository.getRealm(op.realm_id);
      const delivered = await this.deliverConsumers(op);
      if (delivered || op.cancel_requested || currentRealm?.service_state === "stopping")
        this.finishOperation(
          op,
          op.cancel_requested ? "cancelled" : op.error ? "failed" : "completed",
        );
    } catch (error) {
      op = this.repository.getOperation(op.operation_id)!;
      op.error =
        error instanceof Error ? error.message : "account_operation_failed";
      try {
        const isProcessStopUnconfirmed =
          (error as any)?.code === "PROCESS_STOP_UNCONFIRMED" ||
          (error as any)?.name === "ProcessStopUnconfirmedError";
        if (
          isProcessStopUnconfirmed ||
          [
            "external_change",
            "identity_mismatch",
            "domain_lock_lost",
            "managed_processes_not_stopped",
          ].includes(op.error)
        ) {
          if (isProcessStopUnconfirmed) {
            op.phase = "blocked";
            this.repository.saveOperation(op);
            const realm = this.repository.getRealm(op.realm_id);
            if (realm) {
              realm.phase = "blocked";
              realm.service_state = "blocked";
              realm.last_error = "process_stop_unconfirmed";
              realm.revision++;
              this.repository.saveRealm(realm);
            }
          }
          throw error;
        }
        await this.rollbackOperation(op);
        if (
          op.error === "network_wait" &&
          op.trigger.startsWith("workflow") &&
          !op.cancel_requested
        ) {
          await this.enterDomainWait(op.realm_id, op, "network_wait", {
            next_eligible_at: new Date(this.clock.now() + 60_000).toISOString(),
          });
          return;
        }
        if (
          op.trigger.startsWith("workflow") &&
          op.error === "no_eligible_account" &&
          !op.cancel_requested
        ) {
          const wait = computeDomainWait(
            this.repository
              .listAccounts(op.realm_id)
              .filter(
                (a) =>
                  !op.allowed_account_ids ||
                  op.allowed_account_ids.includes(a.id),
              ),
            this.repository.listQuotaSnapshots(op.realm_id),
            op.required_pool_ids,
            this.clock.now(),
            {
              allowedAccountIds: op.allowed_account_ids,
            },
          );
          await this.enterDomainWait(op.realm_id, op, "no_eligible_account", wait);
          return;
        }
        const currentRealm = this.repository.getRealm(op.realm_id);
        const delivered = await this.deliverConsumers(op);
        if (delivered || op.cancel_requested || currentRealm?.service_state === "stopping")
          this.finishOperation(
            op,
            op.cancel_requested || op.error === "operation_cancelled"
              ? "cancelled"
              : "failed",
          );
      } catch {
        this.saveStep(op, "blocked");
        const realm = this.repository.getRealm(op.realm_id)!;
        realm.last_error = op.error;
        this.repository.saveRealm(realm);
      }
    } finally {
      if (timer) clearTimeout(timer);
      this.activeAbort = undefined;
      if (temporaryLockRelease) {
        const latestOp = this.repository.getOperation(op.operation_id);
        const latestRealm = this.repository.getRealm(op.realm_id);
        const isBlocked =
          latestOp?.phase === "blocked" ||
          latestRealm?.phase === "blocked" ||
          latestRealm?.service_state === "blocked";
        if (!isBlocked) {
          try {
            await temporaryLockRelease();
            if (this.domainLockRelease === temporaryLockRelease) {
              this.domainLockRelease = undefined;
              this.ownedRealms.delete(op.realm_id);
            }
          } catch {
            // Keep ownership so stop/close can retry releasing the same lease.
            if (latestRealm) {
              latestRealm.service_state = "blocked";
              latestRealm.phase = "blocked";
              latestRealm.last_error = "domain_lock_release_failed";
              latestRealm.revision++;
              this.repository.saveRealm(latestRealm);
            }
          }
        }
      }
    }
  }

  private async enterDomainWait(
    realmId: string,
    op: AgyAccountOperation,
    reason: string,
    waitResult: { next_eligible_at: string | null },
  ): Promise<void> {
    const current = this.repository.getRealm(realmId)!;
    op.retry_at = waitResult.next_eligible_at ?? undefined;
    op.deadline_at = undefined; // Q05 修复：清除切号单次300秒超时
    op.before_auth_epoch = current.auth_epoch;
    op.before_secret_ref = current.active_secret_ref;
    op.installed_secret_ref = undefined;
    op.install_target_ref = undefined;

    // 持久化待处理需求 AgyPendingDemand (N03 修复)
    const existingDemand = op.workflow_id
      ? this.repository.listDemands(realmId).find((d) => d.consumer_id === op.workflow_id)
      : undefined;

    const origOpId = op.original_operation_id ?? op.operation_id;
    const demand: AgyPendingDemand = {
      demand_id: existingDemand?.demand_id ?? `demand_${randomUUID()}`,
      revision: (existingDemand?.revision ?? 0) + 1,
      demand_generation: (existingDemand?.demand_generation ?? 0) + 1,
      consumer_id: op.workflow_id ?? op.operation_id,
      opaque_recovery_ref: {
        original_operation_id: origOpId,
        workflow_id: op.workflow_id,
        source_run_id: op.source_run_id,
      },
      first_wait_at: existingDemand?.first_wait_at ?? this.clock.toISOString(),
      fairness_key: existingDemand?.fairness_key ?? origOpId,
      source_revision: 1,
      policy_revision: 1,
      settings_revision: 1,
      control_generation: op.control_generation,
      required_model_keys: op.required_model_ids,
      required_pool_ids: op.required_pool_ids,
      allowed_account_ids: op.allowed_account_ids,
      night_pool: op.night_pool,
      status: "waiting",
      wake_at: waitResult.next_eligible_at,
      last_reason: reason,
    };
    this.repository.saveDemand(demand, realmId);

    this.repository.saveDomainWait({
      realm_id: realmId,
      operation_id: op.operation_id,
      source_epoch: current.auth_epoch,
      control_generation: op.control_generation,
      next_eligible_at: waitResult.next_eligible_at,
      reason,
      created_at: this.clock.toISOString(),
    });

    this.saveStep(op, "waiting");
    current.pending_operation_id = null;
    this.repository.saveRealm(current);
  }

  private async deliverConsumers(op: AgyAccountOperation): Promise<boolean> {
    if (op.phase === "waiting") return true; // waiting 分支立即结束本次投递
    if (!this.authHost.isDomainLockHeld(op.realm_id)) {
      op.phase = "blocked";
      op.error = "domain_lock_lost";
      this.saveStep(op, "blocked");
      return false;
    }

    // N05 修复：优先使用不可变 FinalAccountCommit 进行 guard 校验
    const finalCommit = this.repository.getFinalAccountCommit(op.operation_id);
    const targetRef =
      finalCommit?.secret_ref ??
      (op.result?.outcome === "restored"
        ? op.before_secret_ref
        : (op.installed_secret_ref ?? op.install_target_ref));

    if (targetRef && !(await this.authHost.compareActive(op.realm_id, targetRef))) {
      op.phase = "blocked";
      op.error = "external_change";
      this.saveStep(op, "blocked");
      return false;
    }

    const realm = this.repository.getRealm(op.realm_id)!;
    const committedAccountId: string | null =
      finalCommit?.account_id ??
      (op.result?.outcome === "restored"
        ? op.before_account_id ?? null
        : (op.target_account_id ?? realm.active_account_id));
    const committedAuthEpoch: number =
      finalCommit?.auth_epoch ??
      (typeof op.result?.auth_epoch === "number" ? (op.result.auth_epoch as number) : realm.auth_epoch);
    const outcome = finalCommit?.outcome ?? (op.result?.outcome === "restored" ? "restored" : "switched");

    for (const ref of op.consumer_refs) {
      if (ref.delivered) continue;
      // 每次异步投递前执行 guard：核查 realm 状态与代次
      const currentRealm = this.repository.getRealm(op.realm_id);
      if (
        !currentRealm ||
        currentRealm.service_state !== "running" ||
        currentRealm.control_generation !== op.control_generation ||
        op.cancel_requested
      ) {
        return false;
      }
      const consumer = this.consumers.find(
        (c) => this.consumerIds.get(c) === ref.consumer_id,
      );
      if (!consumer) {
        op.error = "consumer_unavailable";
        this.saveStep(op, "recovering");
        return false;
      }
      if (committedAccountId) {
        try {
          await consumer.onAccountCommitted({
            realm_id: op.realm_id,
            operation_id: op.operation_id,
            account_id: committedAccountId,
            auth_epoch: committedAuthEpoch,
            saved_ref: ref.saved_ref,
            outcome,
            original_operation_id: op.original_operation_id,
            workflow_id: op.workflow_id,
          });
        } catch {
          this.saveStep(op, "recovering");
          return false;
        }
      }
      ref.delivered = true;
      this.saveStep(op, "recovering");
    }
    return true;
  }

  private finishOperation(
    op: AgyAccountOperation,
    phase: "completed" | "failed" | "cancelled",
  ): void {
    this.repository.transaction(() => {
      op.phase = phase;
      op.completed_at = this.clock.toISOString();
      op.revision++;
      this.repository.saveOperation(op);
      const realm = this.repository.getRealm(op.realm_id)!;
      if (realm.pending_operation_id === op.operation_id) {
        realm.pending_operation_id = null;
        if (realm.service_state === "stopping" || realm.service_state === "stopped") {
          realm.phase = "stopped";
        } else if (realm.service_state === "blocked" || realm.phase === "blocked") {
          realm.phase = "blocked";
        } else {
          realm.phase = "idle";
        }
        realm.revision++;
        this.repository.saveRealm(realm);
      }
      this.repository.clearDomainWait(op.realm_id);
      const seq =
        (this.repository.listAudits(op.realm_id, 1)[0]?.event_seq ?? 0) + 1;
      this.repository.saveAudit({
        audit_id: randomUUID(),
        realm_id: op.realm_id,
        event_seq: seq,
        operation_id: op.operation_id,
        account_id: realm.active_account_id ?? undefined,
        action: phase,
        details: { kind: op.kind, trigger: op.trigger, error: op.error },
        timestamp: this.clock.toISOString(),
      });
    });
  }

  private async executeAccountOperation(
    op: AgyAccountOperation,
    signal: AbortSignal,
  ): Promise<void> {
    this.assertOperation(op, signal);
    if (op.kind === "delete") {
      const account = this.repository.getAccount(op.realm_id, op.account_id!);
      if (
        !account ||
        this.repository.getRealm(op.realm_id)!.active_account_id === account.id
      )
        throw new AccountServiceError("account_in_use");
      this.saveStep(op, "deleting");
      await this.authHost.deleteSaved(op.realm_id, account.secret_ref);
      this.repository.deleteAccount(account.id);
      op.result = { deleted: true };
      this.saveStep(op, "committed");
      return;
    }
    const occupancy = (
      await Promise.all(this.consumers.map((c) => c.listOccupancy()))
    ).flat();
    if (
      occupancy.some((o) => !o.can_pause) ||
      (!this.initializeSettings(op.realm_id).pause_managed_for_manual_switch &&
        occupancy.length)
    )
      throw new AccountServiceError("managed_busy");
    this.saveStep(op, "quiescing");
    for (const consumer of this.consumers) {
      const { savedRef } = await consumer.prepareSwitch(op.operation_id);
      op.consumer_refs.push({
        consumer_id: this.consumerIds.get(consumer)!,
        saved_ref: savedRef,
        delivered: false,
      });
      this.saveStep(op, "quiescing");
      await consumer.quiesce(op.operation_id);
      if (!(await consumer.confirmStopped(op.operation_id)))
        throw new AccountServiceError("managed_processes_not_stopped");
    }
    const processes = await this.processHost.listManagedProcesses(op.realm_id);
    if (
      processes.length &&
      !(await this.processHost.confirmProcessesStopped(
        processes.map((p) => p.pid),
        30_000,
      ))
    )
      throw new AccountServiceError("managed_processes_not_stopped");
    this.assertOperation(op, signal);
    if ((await this.processHost.findExternalAgyProcesses()).length)
      throw new AccountServiceError("external_change");
    const realm = this.repository.getRealm(op.realm_id)!;
    if (
      realm.active_secret_ref &&
      !(await this.authHost.compareActive(op.realm_id, realm.active_secret_ref))
    )
      throw new AccountServiceError("external_change");
    this.assertOperation(op, signal);
    this.saveStep(op, "capturing");
    const backup = await this.authHost.captureActive(
      op.realm_id,
      op.before_account_id ?? `backup_${op.operation_id}`,
    );
    op.before_secret_ref = backup.secret_ref;
    this.saveStep(op, "prepared");
    if (op.before_account_id)
      this.saveCapture(op.realm_id, op.before_account_id, backup);
    this.assertOperation(op, signal);
    if (op.kind === "enroll" || op.kind === "reauth") {
      if (
        (op.kind === "reauth" || op.mode !== "capture_current") &&
        !this.enrollmentService.isLoginAvailable()
      )
        throw new AccountServiceError(
          "interactive_login_capability_unverified",
        );
      const context = {
        operation_id: op.operation_id,
        auth_epoch: Math.max(
          1,
          realm.auth_epoch + (op.mode === "capture_current" ? 0 : 1),
        ),
        signal,
        model_id: op.model_id,
      };
      if (op.kind === "reauth" || op.mode !== "capture_current") {
        this.saveStep(op, "login_intent");
        await this.authHost.clearActiveForLogin(op.realm_id);
        const empty = await this.authHost.captureActive(
          op.realm_id,
          `login_${op.operation_id}`,
        );
        op.installed_secret_ref = empty.secret_ref;
        this.saveStep(op, "login_waiting");
      }
      this.assertOperation(op, signal);
      const epochRealm = this.repository.getRealm(op.realm_id)!;
      epochRealm.auth_epoch = context.auth_epoch;
      epochRealm.revision++;
      this.repository.saveRealm(epochRealm);
      const enrollmentContext = {
        ...context,
        onCaptured: (capturedData: { account: any; secret_ref: string; credential_revision: number }) => {
          op.installed_secret_ref = capturedData.secret_ref;
          op.install_target_account_id = capturedData.account.id;
          op.result = {
            account_id: capturedData.account.id,
            state: capturedData.account.state,
          };
          this.saveStep(op, "captured_pending");
        },
      };
      const result =
        op.kind === "reauth"
          ? await this.enrollmentService.reauthAccount(
              op.realm_id,
              op.account_id!,
              this.repository.getAccount(op.realm_id, op.account_id!)!.identity
                .email,
              enrollmentContext,
            )
          : op.mode === "capture_current"
            ? await this.enrollmentService.enrollCurrentAccount(
                op.realm_id,
                op.alias ?? "",
                enrollmentContext,
              )
            : await this.enrollmentService.enrollNewAccount(
                op.realm_id,
                op.alias ?? "",
                enrollmentContext,
              );
      if (result.blocked)
        throw new AccountServiceError("managed_processes_not_stopped");
      if (!result.success || !result.account)
        throw new AccountServiceError(result.error ?? "enrollment_failed");
      op.installed_secret_ref = result.account.secret_ref;
      op.install_target_account_id = result.account.id;
      op.result = {
        account_id: result.account.id,
        state: result.account.state,
      };
      this.saveStep(op, "enrollment_saved");
      if (op.mode === "capture_current" && !op.before_account_id) {
        const current = this.repository.getRealm(op.realm_id)!;
        current.active_account_id = result.account.id;
        current.active_secret_ref = result.account.secret_ref;
        current.revision++;
        this.repository.saveRealm(current);
        op.before_account_id = result.account.id;
        op.before_secret_ref = result.account.secret_ref;
      } else if (op.before_account_id === result.account.id)
        op.before_secret_ref = result.account.secret_ref;
    } else if (op.kind === "probe" || op.kind === "maintenance") {
      const ids =
        op.kind === "probe"
          ? [op.account_id!]
          : [...new Set(op.selected_account_ids)];
      const results: Array<{ id: string; ok: boolean; error?: string }> = [];
      for (const id of ids) {
        this.assertOperation(op, signal);
        const account = this.repository.getAccount(op.realm_id, id);
        if (!account) {
          results.push({ id, ok: false, error: "account_not_found" });
          continue;
        }
        const expected = op.installed_secret_ref ?? op.before_secret_ref;
        if (
          !expected ||
          !(await this.authHost.compareActive(op.realm_id, expected))
        )
          throw new AccountServiceError("external_change");
        if ((await this.processHost.findExternalAgyProcesses()).length)
          throw new AccountServiceError("external_change");
        this.assertOperation(op, signal);
        op.install_target_ref = account.secret_ref;
        op.install_target_account_id = id;
        op.install_epoch =
          this.repository.getRealm(op.realm_id)!.auth_epoch + 1;
        this.saveStep(op, "install_intent");
        await this.authHost.activateSaved(op.realm_id, id, account.secret_ref);
        this.assertOperation(op, signal);
        if (
          !(await this.authHost.compareActive(op.realm_id, account.secret_ref))
        )
          throw new AccountServiceError("identity_mismatch");
        const current = this.repository.getRealm(op.realm_id)!;
        current.auth_epoch = op.install_epoch;
        current.revision++;
        this.repository.saveRealm(current);
        op.installed_secret_ref = account.secret_ref;
        this.saveStep(op, "verifying");
        try {
          const result = await this.probe.probeUsage({
            signal,
            account_id: id,
            credential_revision: account.credential_revision,
            model_id: op.model_id,
            timeoutMs:
              this.initializeSettings(op.realm_id).probe_timeout_seconds * 1000,
          });
          this.assertOperation(op, signal);
          if (
            !result.email ||
            result.email.toLowerCase() !== account.identity.email.toLowerCase()
          )
            throw new AccountServiceError("identity_mismatch");
          const capture = await this.authHost.captureActive(op.realm_id, id);
          this.saveCapture(op.realm_id, id, capture);
          op.installed_secret_ref = capture.secret_ref;
          let complete = result.capability_verified && result.pools.length > 0;
          for (const pool of result.pools) {
            complete &&= ["weekly", "five_hour"].every((k) =>
              pool.windows.some(
                (w) =>
                  w.kind === k &&
                  w.status === "observed" &&
                  w.remaining_fraction !== null,
              ),
            );
            this.repository.saveQuotaSnapshot({
              id: randomUUID(),
              realm_id: op.realm_id,
              account_id: id,
              auth_epoch: current.auth_epoch,
              pool_id: pool.pool_id,
              model_ids: pool.model_ids,
              plan_tier: result.plan_tier,
              source: "official_cli_usage",
              cli_version: result.cli_version,
              parser_revision: 1,
              executable_fingerprint: result.executable_fingerprint,
              capability_verified: result.capability_verified,
              observed_at: this.clock.toISOString(),
              windows: pool.windows,
            });
          }
          const latest = this.repository.getAccount(op.realm_id, id)!;
          const observedState = !complete
            ? "pending_quota"
            : result.pools.some((p) =>
                  p.windows.some((w) => w.remaining_fraction === 0),
                )
              ? "waiting_quota"
              : "ready";
          if (latest.state === "disabled")
            latest.state_before_disabled = observedState;
          else latest.state = observedState;
          latest.auth.last_authenticated_request_at = this.clock.toISOString();
          latest.revision++;
          if (complete)
            latest.enrollment_completed_at ??= this.clock.toISOString();
          this.repository.saveAccount(latest);
          results.push({
            id,
            ok: complete,
            error: complete ? undefined : "quota_capability_unavailable",
          });
        } catch (error) {
          if (
            (error as any)?.code === "PROCESS_STOP_UNCONFIRMED" ||
            (error as any)?.name === "ProcessStopUnconfirmedError" ||
            (error instanceof AccountServiceError &&
              error.code === "identity_mismatch")
          )
            throw error;
          results.push({ id, ok: false, error: "probe_failed" });
          if (signal.aborted)
            throw new AccountServiceError("operation_cancelled");
          break; // A network failure must not turn into whole-pool probing.
        }
        this.saveStep(op, "maintenance_checking");
      }
      op.result = { checked_accounts: results };
    } else if (op.kind === "capability_check") {
      const hostCaps = await this.authHost.capabilities();
      const snapshot = {
        ...this.getCapabilitySnapshot(),
        host_platform: hostCaps.platform,
        host_version: hostCaps.version,
        dpapi_available: hostCaps.dpapi_available,
        cred_manager_available: hostCaps.cred_manager_available,
        named_mutex_available: hostCaps.named_mutex_available,
      };
      this.capabilitySnapshot = snapshot;
      op.result = {
        capabilities: snapshot,
      };
    } else throw new AccountServiceError("unsupported_operation", 400);
    await this.rollbackOperation(op);
  }

  private saveCapture(
    realmId: string,
    accountId: string,
    capture: {
      secret_ref: string;
      credential_revision: number;
      auth?: Partial<AgyAccount["auth"]>;
    },
  ): void {
    const account = this.repository.getAccount(realmId, accountId)!;
    if (capture.credential_revision < account.credential_revision)
      throw new AccountServiceError("credential_revision_stale");
    account.secret_ref = capture.secret_ref;
    account.credential_revision = capture.credential_revision;
    account.auth = { ...account.auth, ...capture.auth };
    account.revision++;
    this.repository.saveAccount(account);
  }

  private async rollbackOperation(op: AgyAccountOperation): Promise<void> {
    if (!op.before_secret_ref) return;
    if (!this.authHost.isDomainLockHeld(op.realm_id))
      throw new AccountServiceError("domain_lock_lost");
    if ((await this.processHost.findExternalAgyProcesses()).length)
      throw new AccountServiceError("external_change");
    let known = false;
    for (const ref of [
      op.installed_secret_ref,
      op.install_target_ref,
      op.before_secret_ref,
    ])
      if (ref && (await this.authHost.compareActive(op.realm_id, ref))) {
        known = true;
        break;
      }
    if (!known) throw new AccountServiceError("external_change");
    this.saveStep(op, "rollback_required");
    if (
      !(await this.authHost.compareActive(op.realm_id, op.before_secret_ref))
    ) {
      await this.authHost.restoreBackup(op.realm_id, op.before_secret_ref);
      if (
        !(await this.authHost.compareActive(op.realm_id, op.before_secret_ref))
      )
        throw new AccountServiceError("rollback_verification_failed");
      const realm = this.repository.getRealm(op.realm_id)!;
      realm.auth_epoch = Math.max(realm.auth_epoch, op.install_epoch ?? 0) + 1;
      realm.revision++;
      this.repository.saveRealm(realm);
    }
    const realm = this.repository.getRealm(op.realm_id)!;
    realm.active_account_id = op.before_account_id ?? null;
    realm.active_secret_ref = op.before_secret_ref;
    realm.revision++;
    this.repository.saveRealm(realm);
    op.result = {
      ...op.result,
      outcome: "restored",
      active_account_id: realm.active_account_id,
      auth_epoch: realm.auth_epoch,
    };

    // CR17: 维护后安全恢复凭据后，核查原账号资格
    let beforeEligible = true;
    if (op.before_account_id) {
      const beforeAcc = this.repository.getAccount(op.realm_id, op.before_account_id);
      if (!beforeAcc || beforeAcc.state !== "ready") {
        beforeEligible = false;
      }
    }
    if (beforeEligible) {
      this.saveStep(op, "committed");
    } else {
      if (!op.error) op.error = "before_account_not_eligible";
      this.saveStep(op, "waiting");
      realm.pending_operation_id = null;
      this.repository.saveRealm(realm);
    }
  }

  beginShutdown(): void {
    this.closing = true;
    this.activeAbort?.abort();
  }

  async close(): Promise<void> {
    this.beginShutdown();
    for (const realmId of this.ownedRealms) {
      // Closing the controller stops its own jobs; ordinary stop() deliberately does not.
      const processes = await this.processHost.listManagedProcesses(realmId);
      for (const process of processes)
        await this.processHost.stopProcess(process.pid, "account_switch");
      if (
        processes.length &&
        !(await this.processHost.confirmProcessesStopped(
          processes.map((p) => p.pid),
          30_000,
        ))
      )
        throw new AccountServiceError("managed_processes_not_stopped");
    }
    await this.coordinator.enqueue(async () => {});
    for (const realmId of this.ownedRealms) {
      const realm = this.repository.getRealm(realmId);
      if (realm && !realm.desired_enabled && realm.pending_operation_id) {
        await this.reconciler.reconcileStartup(realmId);
        const cleaned = this.repository.getRealm(realmId)!;
        if (cleaned.pending_operation_id || cleaned.phase === "blocked")
          throw new AccountServiceError("account_cleanup_incomplete");
        cleaned.service_state = "stopped";
        cleaned.last_error = undefined;
        cleaned.revision++;
        this.repository.saveRealm(cleaned);
      }
    }
    if (this.domainLockRelease) {
      await this.domainLockRelease();
      this.domainLockRelease = undefined;
    }
    this.ownedRealms.clear();
  }

  // 暴露给外部获取子服务的 getter
  getRepository(): AgyAccountRepository {
    return this.repository;
  }
  getEnrollmentService(): AgyEnrollmentService {
    return this.enrollmentService;
  }
  getAuthHost(): AuthHostPort {
    return this.authHost;
  }
  getMaintenanceService(): AgyMaintenanceService {
    return this.maintenanceService;
  }
}
