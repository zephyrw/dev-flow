import { randomUUID } from "node:crypto";
import { AccountQuotaAdmissionError, type AgyAccountService, type AgyUsageRequest, type UsagePermit } from "../../agy-accounts/src/service.js";
import type { AccountConsumerPort, AccountCommittedEvent } from "../../agy-accounts/src/ports.js";
import type { AgyQuotaTrigger } from "../../contracts/src/agy-account.js";
import type { AgyFailureFact } from "../../adapters/agy/src/failure-fact.js";

const realmId = "default-agy-realm";
const consumerId = "group-chat";
export type GroupAccountCall = {
  id: string; model: string; signal: AbortSignal; permit?: UsagePermit;
  operation?: string; wake?: () => void;
  ended?: boolean;
};
export class GroupAccountFailure extends Error {
  constructor(readonly fact: AgyFailureFact) { super("AGY 模型调用需要切换账号"); }
}

/** Uses the same admission, quota selection and durable operation lifecycle as workflow calls. */
export class GroupAccountConsumer implements AccountConsumerPort {
  private readonly calls = new Map<string, GroupAccountCall>();
  private readonly unregister: () => void;
  private readonly exclusiveCalls = new Map<string, Set<string>>();
  private readonly quiescenceWake = new Map<string, () => void>();
  private closed = false;
  constructor(private readonly accounts: AgyAccountService) {
    // Register even while management is disabled; users can enable it after startup.
    this.unregister = accounts.registerConsumer(this, consumerId);
  }
  track(model: string, signal: AbortSignal): GroupAccountCall {
    signal.throwIfAborted();
    if (this.closed) throw new Error("群聊正在关闭");
    const call = { id: randomUUID(), model, signal };
    this.calls.set(call.id, call);
    return call;
  }
  finish(call: GroupAccountCall) {
    call.ended = true;
    if (!this.hasLivePermit(call)) this.calls.delete(call.id);
    call.wake?.();
  }
  private hasLivePermit(call: GroupAccountCall) {
    return !!call.permit && this.accounts.getRepository().getPermit(call.permit.permit_id)?.status !== "released";
  }
  isWaitCurrent(ref: { original_operation_id: string; source_run_id?: string }) {
    return !this.closed && [...this.calls.values()].some(call => !call.ended && !call.signal.aborted &&
      (call.id === ref.source_run_id || call.operation === ref.original_operation_id));
  }
  async allowsAutoSwitch() {
    // An idle group consumer must not veto an unrelated workflow policy.
    const occupied = [...this.calls.values()].some(call => (!call.ended && !call.signal.aborted) || this.hasLivePermit(call));
    return !occupied || !!this.accounts.getRepository().getSettings(realmId)?.workflow_auto_switch;
  }
  async listOccupancy() {
    return [...this.calls.values()].filter(call => (!call.ended && !call.signal.aborted) || this.hasLivePermit(call)).map(call => ({
      consumer_id: call.id, permit_ids: call.permit ? [call.permit.permit_id] : [],
      required_model_ids: [call.model], required_pool_ids: this.accounts.resolveModelPools(call.model),
      allowed_account_ids: null, can_pause: true,
    }));
  }
  async prepareSwitch(operationId: string, options?: { preserveRunning: boolean }) {
    if (!options?.preserveRunning && !this.exclusiveCalls.has(operationId)) {
      this.exclusiveCalls.set(operationId, new Set([...this.calls.values()]
        .filter(call => (!call.ended && !call.signal.aborted) || this.hasLivePermit(call)).map(call => call.id)));
    }
    return { savedRef: { runs: [...this.calls.values()].filter(call => !call.ended && !call.signal.aborted &&
      (call.operation === operationId || !options?.preserveRunning)).map(call => call.id) } };
  }
  // Exclusive credential work waits for healthy replies to finish. Their permits
  // are released by the runner only after process-tree exit is confirmed.
  async quiesce(operationId: string) {
    const targets = this.exclusiveCalls.get(operationId);
    if (!targets?.size) return;
    const repo = this.accounts.getRepository();
    const original = repo.getOperation(operationId);
    const generation = original?.control_generation;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let unsubscribe = () => {};
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true; unsubscribe(); if (timer) clearTimeout(timer);
        if (this.quiescenceWake.get(operationId) === schedule) this.quiescenceWake.delete(operationId);
        if (error) { this.exclusiveCalls.delete(operationId); reject(error); }
        else resolve();
      };
      const inspect = () => {
        if (settled) return;
        const op = repo.getOperation(operationId);
        const realm = repo.getRealm(realmId);
        if (this.closed || !op || op.cancel_requested || ["cancelled", "failed", "blocked"].includes(op.phase) ||
            !realm || realm.control_generation !== generation || ["stopping", "stopped", "blocked"].includes(realm.service_state)) {
          finish(new Error("operation_cancelled")); return;
        }
        if (op.deadline_at && Date.now() >= Date.parse(op.deadline_at)) {
          finish(new Error("operation_timeout")); return;
        }
        if (this.permitsReleased(targets)) finish();
      };
      const schedule = () => queueMicrotask(inspect);
      this.quiescenceWake.set(operationId, schedule);
      unsubscribe = repo.onChange(schedule);
      if (original?.deadline_at) timer = setTimeout(() => finish(new Error("operation_timeout")),
        Math.max(1, Date.parse(original.deadline_at) - Date.now()));
      inspect();
    });
  }
  private permitsReleased(targets: Set<string>) {
    const repo = this.accounts.getRepository();
    // Include durable issued permits whose Promise has not yet returned to the
    // runner; an admission/prepareSwitch race cannot hide account occupancy.
    if (repo.listPermits(realmId).some(permit => targets.has(permit.consumer_id) && permit.status !== "released")) return false;
    return [...targets].every(id => {
      const permit = this.calls.get(id)?.permit;
      return !permit || repo.getPermit(permit.permit_id)?.status === "released";
    });
  }
  async confirmStopped(operationId?: string) {
    const targets = operationId ? this.exclusiveCalls.get(operationId) : undefined;
    const confirmed = this.permitsReleased(targets ?? new Set(this.calls.keys()));
    if (confirmed && operationId) this.exclusiveCalls.delete(operationId);
    return confirmed;
  }
  async onAccountCommitted(event: AccountCommittedEvent) {
    for (const call of this.calls.values()) {
      if (!call.ended && !call.signal.aborted && (call.operation === event.operation_id || call.operation === event.original_operation_id))
        call.wake?.();
    }
  }
  async onQuotaExhausted(trigger: AgyQuotaTrigger) {
    if (!await this.allowsAutoSwitch()) return;
    const call = [...this.calls.values()].find(item => !item.ended && !item.signal.aborted && item.permit?.account_id === trigger.account_id &&
      item.permit.auth_epoch === trigger.auth_epoch && this.accounts.resolveModelPools(item.model).includes(trigger.pool_id));
    if (call) await this.requestSwitch(call, trigger.auth_epoch, "workflow_quota");
  }
  async acquire(call: GroupAccountCall, acquire: (request: AgyUsageRequest, signal: AbortSignal) => Promise<UsagePermit>) {
    const repo = this.accounts.getRepository();
    for (;;) {
      this.assertCurrent(call);
      try {
        const permit = await acquire({
          realm_id: realmId, consumer_id: call.id, usage_kind: "execution",
          required_pool_ids: this.accounts.resolveModelPools(call.model), required_model_ids: [call.model], model_id: call.model,
        }, call.signal);
        call.permit = permit;
        // The caller owns this permit immediately, including cancellation before process startup.
        return permit;
      } catch (error) {
        this.assertCurrent(call);
        const realm = repo.getRealm(realmId);
        if (realm?.pending_operation_id) {
          await this.waitForOperation(call, realm.pending_operation_id);
        } else if (error instanceof AccountQuotaAdmissionError) {
          if (!await this.allowsAutoSwitch()) throw new Error("AGY 账号额度不足，自动切换未开启，可切换账号后重试本成员", { cause: error });
          await this.waitForOperation(call, await this.requestSwitch(call, error.auth_epoch, "workflow_quota"));
        } else throw error;
      }
    }
  }
  async recover(call: GroupAccountCall, fact: AgyFailureFact) {
    this.assertCurrent(call);
    call.permit = undefined; // runAttempt has confirmed exit and released it before recovery.
    if (!await this.allowsAutoSwitch()) throw new Error("AGY 账号不可用，自动切换未开启，可切换账号后重试本成员");
    const repo = this.accounts.getRepository();
    const realm = repo.getRealm(realmId);
    if (realm?.auth_epoch !== fact.auth_epoch || realm.active_account_id !== fact.account_id) {
      if (realm?.pending_operation_id) await this.waitForOperation(call, realm.pending_operation_id);
      return;
    }
    if (fact.requires_quota_verification || (fact.category === "quota_exhausted" && (!fact.window || fact.window === "unknown"))) {
      if (!realm.pending_operation_id && !await this.accounts.verifyActiveQuotaExhausted({
        realm_id: realmId, account_id: fact.account_id, auth_epoch: fact.auth_epoch,
        required_pool_ids: this.accounts.resolveModelPools(call.model), required_model_ids: [call.model],
      })) throw new Error("AGY 额度提示未得到当前账号核验确认，可重试本成员");
    }
    this.assertCurrent(call);
    const pending = repo.getRealm(realmId)?.pending_operation_id;
    await this.waitForOperation(call, pending ?? await this.requestSwitch(call, fact.auth_epoch,
      fact.requires_reauth ? "workflow_auth" : "workflow_quota", fact.window));
  }
  private async requestSwitch(call: GroupAccountCall, epoch: number, trigger: "workflow_quota" | "workflow_auth", window?: AgyFailureFact["window"]) {
    this.assertCurrent(call);
    const receipt = await this.accounts.requestWorkflowOperation({
      realm_id: realmId, request_id: `group_${call.id}_${epoch}_${trigger}`, kind: "switch", consumer_id: consumerId,
      source_run_id: call.id, source_event_key: `${call.id}:${epoch}`, trigger, expected_epoch: epoch,
      required_pool_ids: this.accounts.resolveModelPools(call.model).length ? this.accounts.resolveModelPools(call.model) : ["global"],
      required_model_ids: [call.model], model_id: call.model, quota_window: window,
    });
    call.operation = receipt.operation_id;
    this.accounts.triggerOperationImmediate(receipt.operation_id);
    return receipt.operation_id;
  }
  private assertCurrent(call: GroupAccountCall) {
    call.signal.throwIfAborted();
    if (this.closed || call.ended || !this.calls.has(call.id)) throw new Error("群聊账号等待已取消");
  }
  private waitForOperation(call: GroupAccountCall, operationId: string): Promise<void> {
    this.assertCurrent(call);
    const repo = this.accounts.getRepository();
    const first = repo.getOperation(operationId);
    const root = first?.original_operation_id ?? operationId;
    const generation = first?.control_generation;
    call.operation = root;
    return new Promise((resolve, reject) => {
      let settled = false;
      let unsubscribe = () => {};
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true; unsubscribe(); call.signal.removeEventListener("abort", inspect);
        if (call.wake === schedule) call.wake = undefined;
        error ? reject(error) : resolve();
      };
      const inspect = () => {
        try { this.assertCurrent(call); } catch (error) { finish(error); return; }
        const realm = repo.getRealm(realmId);
        if (!realm || !this.accounts.isManaged() || realm.control_generation !== generation ||
            ["stopped", "stopping", "blocked"].includes(realm.service_state)) {
          finish(new Error("AGY 账号等待已停止，请处理账号状态后重试本成员")); return;
        }
        const operations = repo.listOperations(realmId).filter(op => op.operation_id === root || op.original_operation_id === root);
        const success = operations.find(op => op.phase === "completed" && !op.error && !op.cancel_requested);
        if (success && !realm.pending_operation_id && realm.phase === "idle") {
          const commit = repo.getFinalAccountCommit(success.operation_id);
          if (commit?.model_selection_required || success.result?.model_selection_required)
            finish(new Error("切换后的账号需要重新选择模型，请更新群成员后重试"));
          else finish();
          return;
        }
        const active = operations.some(op => !op.cancel_requested && !["failed", "cancelled", "completed", "blocked"].includes(op.phase));
        if (!active) finish(new Error("AGY 账号切换失败或已取消，请处理账号后重试本成员"));
      };
      const schedule = () => queueMicrotask(inspect);
      call.wake = schedule;
      unsubscribe = repo.onChange(schedule);
      call.signal.addEventListener("abort", inspect, { once: true });
      inspect();
    });
  }
  close() {
    this.closed = true;
    for (const call of this.calls.values()) call.wake?.();
    for (const wake of this.quiescenceWake.values()) wake();
    this.exclusiveCalls.clear();
  }
  dispose() {
    this.unregister();
  }
}
