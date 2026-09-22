import { z } from "zod";
import type { Store } from "../../store/src/store.js";
import {
  CONVERSATION_ENTITY,
  CONVERSATION_ERROR,
  CONVERSATION_EVENT,
  ConversationControlActionSchema,
  ConversationControlSchema,
  ConversationControlStatusSchema,
  ConversationControlTargetSchema,
  type ConversationAttempt,
  type ConversationControl,
  type ConversationNode,
  type ConversationStatus,
  type ConversationTreeSnapshot,
  type StopConfirmation,
  type SubagentCapabilities,
} from "../../contracts/src/conversation.js";
import {
  FlowError,
  Id,
  type Run,
  type Workflow,
} from "../../contracts/src/index.js";
import type { RunContinuation } from "../../contracts/src/tr-handoff.js";
import { id } from "./util.js";
import { ConversationService } from "./conversation-service.js";

export const PAUSE_HINT_MS = 10_000;
export const PAUSE_PARTIAL_MS = 30_000;
export const CONVERSATION_CONTROL_FENCE = "conversation_control_fence";
const STOP_ROUNDS = 8;
const LIVE_STATUSES = new Set<ConversationStatus>([
  "discovered",
  "starting",
  "running",
  "waiting",
  "pausing",
  "unknown",
]);
const RECOVERY_STATUSES = new Set<ConversationStatus>([
  "paused",
  "interrupted",
  "failed",
]);

export const ConversationControlRequestSchema = z
  .object({
    request_id: z.string().min(1),
    action: ConversationControlActionSchema,
    root_id: Id,
    expected_generation: z.number().int().nonnegative(),
  })
  .strict();
export type ConversationControlRequest = z.infer<
  typeof ConversationControlRequestSchema
>;

export interface StopPortTarget {
  conversation_id: string;
  native_session_id?: string;
  native_agent_id?: string;
  attempt_id?: string;
}

export interface StopPortResult {
  accepted: boolean;
  confirmation?: "exited" | "unknown" | "unsupported";
}

export interface StopPort {
  stopConversation(target: StopPortTarget): Promise<StopPortResult>;
}

export interface ConversationControlClock {
  iso(): string;
  ms(): number;
}

export const systemControlClock: ConversationControlClock = {
  iso: () => new Date().toISOString(),
  ms: () => Date.now(),
};

export interface ControlRecoveryCandidate {
  conversation_id: string;
  parent_id?: string;
  attempt_id?: string;
  native_session_id?: string;
  native_agent_id?: string;
  status: ConversationStatus;
  reason?: string;
}

export interface ConversationControlFence {
  id: string;
  workflow_id: string;
  control_id: string;
  root_id: string;
  expected_generation: number;
  run_id?: string;
  purpose?: string;
  stage?: string;
  adapter?: string;
  profile_id?: string;
  continuation?: RunContinuation;
  recovery_candidates: ControlRecoveryCandidate[];
  dispatch_frozen: boolean;
  started_ms: number;
  created_at: string;
  updated_at: string;
}

export interface ConversationControlResult {
  control_id: string;
  request_id: string;
  action: "pause" | "resume";
  status: "pending" | "partial" | "complete";
  unconfirmed_count: number;
  message?: string;
  targets: ConversationControl["targets"];
  control: ConversationControl;
}

const TargetSchema = ConversationControlTargetSchema;
const StatusSchema = ConversationControlStatusSchema;

export function pausePendingMessage(unconfirmedCount: number): string {
  return `暂停中，${unconfirmedCount} 个状态待确认`;
}

export function isLiveConversationStatus(status: ConversationStatus): boolean {
  return LIVE_STATUSES.has(status);
}

export function isRecoveryConversationStatus(
  status: ConversationStatus,
): boolean {
  return RECOVERY_STATUSES.has(status) || isLiveConversationStatus(status);
}

export class ConversationControlService {
  constructor(
    private store: Store,
    private conversations: ConversationService,
    private stopPort: StopPort,
    private clock: ConversationControlClock = systemControlClock,
  ) {}

  async submit(
    workflowId: string,
    body: unknown,
  ): Promise<ConversationControlResult> {
    const request = ConversationControlRequestSchema.parse(body);
    if (request.action === "resume")
      return this.resumeTree(workflowId, request);
    return this.pauseTree(workflowId, request);
  }

  async pauseTree(
    workflowId: string,
    request: ConversationControlRequest,
  ): Promise<ConversationControlResult> {
    const control = this.ensurePauseControl(workflowId, request);
    return this.reconcile(workflowId, control.id);
  }

  resumeTree(
    workflowId: string,
    request: ConversationControlRequest,
  ): ConversationControlResult {
    const control = this.ensureResumeControl(workflowId, request);
    return this.toResult(this.readControl(workflowId, control.id));
  }

  async reconcile(
    workflowId: string,
    controlId: string,
  ): Promise<ConversationControlResult> {
    const control = this.readControl(workflowId, controlId);
    if (control.action !== "pause") return this.toResult(control);
    // CW3-F05: 删除 STOP_ROUNDS 重复控制，单次执行根停止，子 Agent 只观测
    this.absorbLateSpawns(workflowId, controlId);
    const pending = this.unconfirmedStopTargets(workflowId, controlId);
    if (pending.length > 0) {
      const results = await this.invokeStops(pending);
      this.store.transaction(() =>
        this.applyStopResults(workflowId, controlId, pending, results),
      );
    }
    return this.store.transaction(() => this.settle(workflowId, controlId));
  }

  getControl(workflowId: string, controlId: string): ConversationControl {
    return this.readControl(workflowId, controlId);
  }

  isDispatchFrozen(workflowId: string, rootId?: string): boolean {
    return this.store
      .list<ConversationControlFence>(CONVERSATION_CONTROL_FENCE, workflowId)
      .some(
        (fence) =>
          fence.dispatch_frozen && (!rootId || fence.root_id === rootId),
      );
  }

  listRecoveryCandidates(
    workflowId: string,
    rootId: string,
  ): ControlRecoveryCandidate[] {
    const fence = this.store
      .list<ConversationControlFence>(CONVERSATION_CONTROL_FENCE, workflowId)
      .filter((item) => item.root_id === rootId)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
    if (fence) return fence.recovery_candidates.slice();
    const tree = this.conversations.getTree(workflowId, rootId);
    return collectRecoveryCandidates(tree);
  }

  private ensurePauseControl(
    workflowId: string,
    request: ConversationControlRequest,
  ): ConversationControl {
    return this.store.transaction(() => {
      const existing = this.findByRequest(workflowId, request.request_id);
      if (existing) {
        assertSameRequest(existing, request);
        return existing;
      }
      const prepared = this.preparePause(workflowId, request);
      this.cancelModelRetry(workflowId);
      return prepared;
    });
  }

  private ensureResumeControl(
    workflowId: string,
    request: ConversationControlRequest,
  ): ConversationControl {
    return this.store.transaction(() => {
      const existing = this.findByRequest(workflowId, request.request_id);
      if (existing) {
        assertSameRequest(existing, request);
        return existing;
      }
      this.assertResumeReady(workflowId, request);
      return this.writeControl(workflowId, request, [], 0, "pending");
    });
  }

  private preparePause(
    workflowId: string,
    request: ConversationControlRequest,
  ): ConversationControl {
    const workflow = this.requireWorkflow(workflowId);
    const tree = this.assertRootGeneration(workflowId, request);
    const live = collectLiveTargets(tree, request.root_id);
    const recovery = collectRecoveryCandidates(tree);
    const control = this.writeControl(
      workflowId,
      request,
      live,
      live.length,
      "pending",
    );
    this.writeFence(workflow, control, tree, recovery);
    this.markTargetsPausing(tree, live);
    this.emitControl(workflow, control);
    return control;
  }

  private assertRootGeneration(
    workflowId: string,
    request: ConversationControlRequest,
  ): ConversationTreeSnapshot {
    const all = this.conversations.getTree(workflowId);
    const root = all.nodes.find((node) => node.id === request.root_id);
    if (!root)
      throw new FlowError(CONVERSATION_ERROR.NOT_FOUND, "会话根不存在", 404);
    if (root.id !== root.root_id)
      throw new FlowError(
        CONVERSATION_ERROR.STALE_ROOT,
        "会话根已切换，不能停止新的运行",
        409,
      );
    if (hasSuccessorRoot(all, root))
      throw new FlowError(
        CONVERSATION_ERROR.STALE_ROOT,
        "会话根已切换，不能停止新的运行",
        409,
      );
    const scoped = this.conversations.getTree(workflowId, request.root_id);
    const latest = latestAttempt(scoped.attempts, request.root_id);
    if (!latest || latest.generation !== request.expected_generation)
      throw new FlowError(
        CONVERSATION_ERROR.VERSION_CONFLICT,
        "会话代数已变化，不能停止新的运行",
        409,
      );
    return scoped;
  }

  private assertResumeReady(
    workflowId: string,
    request: ConversationControlRequest,
  ) {
    this.assertRootGeneration(workflowId, request);
    if (this.requireWorkflow(workflowId).state === "STOPPED") return;
    const pause = this.latestPause(workflowId, request.root_id);
    if (pause && pause.unconfirmed_count > 0) {
      throw new FlowError(
        CONVERSATION_ERROR.STOP_UNCONFIRMED,
        "仍有旧子会话可能执行",
        409,
      );
    }
    const live = collectLiveTargets(
      this.conversations.getTree(workflowId, request.root_id),
      request.root_id,
    );
    if (live.length) {
      throw new FlowError(
        CONVERSATION_ERROR.STOP_UNCONFIRMED,
        "仍有旧子会话可能执行",
        409,
      );
    }
  }

  private absorbLateSpawns(workflowId: string, controlId: string) {
    this.store.transaction(() => {
      const control = this.readControl(workflowId, controlId);
      const fence = this.readFence(controlId);
      const tree = this.conversations.getTree(workflowId, control.root_id);
      const known = new Set(
        control.targets.map((target) => target.conversation_id),
      );
      const added = collectLiveTargets(tree, control.root_id, fence.run_id)
        .filter((target) => !known.has(target.conversation_id));
      if (!added.length) {
        this.refreshRecovery(fence, tree);
        return;
      }
      control.targets = [...control.targets, ...added];
      this.markTargetsPausing(tree, added);
      this.saveControl(control, countUnconfirmed(control, tree));
      this.refreshRecovery(fence, tree);
      this.emitControl(this.requireWorkflow(workflowId), control);
    });
  }

  private unconfirmedStopTargets(
    workflowId: string,
    controlId: string,
  ): StopPortTarget[] {
    const control = this.readControl(workflowId, controlId);
    const fence = this.readFence(controlId);
    const tree = this.conversations.getTree(workflowId, control.root_id);
    // CW3-F05: 删除逐 child 补停，子 Agent 只观测，停止仅发往根会话
    return control.targets
      .filter(
        (target) =>
          target.conversation_id === control.root_id &&
          !isTargetResolved(target, tree, fence.run_id),
      )
      .map((target) => ({
        conversation_id: target.conversation_id,
        native_session_id: target.native_session_id,
        native_agent_id: target.native_agent_id,
        attempt_id: target.attempt_id,
      }));
  }

  private async invokeStops(
    targets: StopPortTarget[],
  ): Promise<StopPortResult[]> {
    const results: StopPortResult[] = [];
    for (const target of targets) {
      try {
        results.push(await this.stopPort.stopConversation(target));
      } catch {
        results.push({ accepted: false, confirmation: "unknown" });
      }
    }
    return results;
  }

  private applyStopResults(
    workflowId: string,
    controlId: string,
    targets: StopPortTarget[],
    results: StopPortResult[],
  ) {
    const control = this.readControl(workflowId, controlId);
    const tree = this.conversations.getTree(workflowId, control.root_id);
    const stopKind = tree.capabilities.stop;
    for (let index = 0; index < targets.length; index++) {
      const target = targets[index]!;
      const result = results[index]!;
      const current = control.targets.find(
        (item) => item.conversation_id === target.conversation_id,
      );
      if (!current) continue;
      const attempt = resolveTargetAttempt(current, tree);
      if (
        attempt &&
        (attempt.status === "completed" || attempt.status === "cancelled")
      ) {
        current.status = attempt.status;
        continue;
      }
      const confirmation = mapStopConfirmation(result, stopKind);
      current.confirmation = confirmation;
      if (result.accepted && result.confirmation === "exited") {
        current.status = "paused";
        this.writePaused(tree, current, confirmation);
      } else {
        current.status = current.status ?? "pausing";
        this.writePausing(tree, current);
      }
    }
    this.confirmOwnedProcessTree(control, tree);
    this.saveControl(control, countUnconfirmed(control, tree));
    const fence = this.readFence(controlId);
    this.refreshRecovery(fence, tree);
    this.emitControl(this.requireWorkflow(workflowId), control);
  }

  private settle(
    workflowId: string,
    controlId: string,
  ): ConversationControlResult {
    const control = this.readControl(workflowId, controlId);
    const fence = this.readFence(controlId);
    const tree = this.conversations.getTree(workflowId, control.root_id);
    this.syncObservedTargets(control, tree, fence.run_id);
    const elapsed = this.clock.ms() - fence.started_ms;
    const unconfirmed = countUnconfirmed(control, tree);
    if (unconfirmed === 0) control.status = "complete";
    else if (elapsed >= PAUSE_PARTIAL_MS) {
      control.status = "partial";
      this.markUnknown(control, tree);
    } else control.status = "pending";
    this.saveControl(control, countUnconfirmed(control, tree));
    this.refreshRecovery(fence, tree);
    this.emitControl(this.requireWorkflow(workflowId), control);
    return this.toResult(control, elapsed);
  }

  private syncObservedTargets(
    control: ConversationControl,
    tree: ConversationTreeSnapshot,
    runId?: string,
  ) {
    for (const target of control.targets) {
      const attempt = resolveTargetAttempt(target, tree, runId);
      if (!attempt) continue;
      if (attempt.status === "completed" || attempt.status === "cancelled") {
        target.status = attempt.status;
        continue;
      }
      if (
        attempt.status === "paused" ||
        attempt.status === "failed" ||
        attempt.status === "interrupted"
      ) {
        target.status = attempt.status;
        if (attempt.stop_confirmation)
          target.confirmation = attempt.stop_confirmation;
      }
    }
  }

  private markUnknown(
    control: ConversationControl,
    tree: ConversationTreeSnapshot,
  ) {
    for (const target of control.targets) {
      if (target.status === "paused") continue;
      if (target.status === "completed" || target.status === "cancelled")
        continue;
      if (target.status === "failed" || target.status === "interrupted")
        continue;
      if (target.confirmation === "native" || target.confirmation === "owned_process_tree")
        continue;
      target.status = "unknown";
      target.confirmation = "unconfirmed";
      const attempt = resolveTargetAttempt(target, tree);
      if (!attempt || !isLiveConversationStatus(attempt.status)) continue;
      if (attempt.status === "completed" || attempt.status === "cancelled")
        continue;
      attempt.status = "unknown";
      attempt.stop_confirmation = "unconfirmed";
      attempt.observed_at = this.clock.iso();
      this.store.put(
        CONVERSATION_ENTITY.attempt,
        attempt.id,
        attempt.workflow_id,
        attempt,
      );
    }
  }

  private markTargetsPausing(
    tree: ConversationTreeSnapshot,
    targets: ConversationControl["targets"],
  ) {
    for (const target of targets) this.writePausing(tree, target);
  }

  private confirmOwnedProcessTree(
    control: ConversationControl,
    tree: ConversationTreeSnapshot,
  ) {
    if (tree.capabilities.stop !== "owned-process-tree") return;
    const rootTarget = control.targets.find(
      (target) => target.conversation_id === control.root_id,
    );
    const rootStopped =
      rootTarget &&
      (rootTarget.confirmation === "owned_process_tree" ||
        rootTarget.confirmation === "native");
    if (!rootStopped) return;
    for (const target of control.targets) {
      if (isTargetResolved(target, tree)) continue;
      target.confirmation = "owned_process_tree";
      target.status = "paused";
      this.writePaused(tree, target, "owned_process_tree");
    }
  }

  private writePausing(
    tree: ConversationTreeSnapshot,
    target: ConversationControl["targets"][number],
  ) {
    const attempt = resolveTargetAttempt(target, tree);
    if (!attempt || !canMarkPausing(attempt.status)) return;
    attempt.status = "pausing";
    attempt.reason = "user_pause";
    attempt.stop_confirmation = "unconfirmed";
    attempt.observed_at = this.clock.iso();
    this.store.put(
      CONVERSATION_ENTITY.attempt,
      attempt.id,
      attempt.workflow_id,
      attempt,
    );
    target.status = "pausing";
    target.confirmation = target.confirmation ?? "unconfirmed";
  }

  private writePaused(
    tree: ConversationTreeSnapshot,
    target: ConversationControl["targets"][number],
    confirmation: StopConfirmation,
  ) {
    const attempt = resolveTargetAttempt(target, tree);
    if (!attempt || !canMarkPaused(attempt.status)) return;
    attempt.status = "paused";
    attempt.reason = "user_pause";
    attempt.stop_confirmation = confirmation;
    attempt.terminal_at = attempt.terminal_at ?? this.clock.iso();
    attempt.observed_at = this.clock.iso();
    this.store.put(
      CONVERSATION_ENTITY.attempt,
      attempt.id,
      attempt.workflow_id,
      attempt,
    );
  }

  private writeControl(
    workflowId: string,
    request: ConversationControlRequest,
    targets: ConversationControl["targets"],
    unconfirmed: number,
    status: ConversationControl["status"],
  ): ConversationControl {
    const timestamp = this.clock.iso();
    const control = ConversationControlSchema.parse({
      id: id("ctl"),
      workflow_id: workflowId,
      request_id: request.request_id,
      action: request.action,
      root_id: request.root_id,
      expected_generation: request.expected_generation,
      status,
      targets,
      unconfirmed_count: unconfirmed,
      created_at: timestamp,
      updated_at: timestamp,
    });
    this.store.put(
      CONVERSATION_ENTITY.control,
      control.id,
      workflowId,
      control,
    );
    return control;
  }

  private writeFence(
    workflow: Workflow,
    control: ConversationControl,
    tree: ConversationTreeSnapshot,
    recovery: ControlRecoveryCandidate[],
  ) {
    const run = workflow.run_id
      ? this.store.get<Run>("run", workflow.run_id)
      : undefined;
    const rootAttempt = latestAttempt(tree.attempts, control.root_id);
    const fence: ConversationControlFence = {
      id: control.id,
      workflow_id: workflow.id,
      control_id: control.id,
      root_id: control.root_id,
      expected_generation: control.expected_generation,
      run_id: rootAttempt?.run_id ?? run?.id,
      purpose: run?.purpose ?? rootPurpose(tree, control.root_id),
      stage: run?.stage ?? workflow.stage,
      adapter: run?.adapter,
      profile_id: run?.profile?.id,
      continuation: run?.continuation,
      recovery_candidates: recovery,
      dispatch_frozen: true,
      started_ms: this.clock.ms(),
      created_at: control.created_at,
      updated_at: control.updated_at,
    };
    this.store.put(CONVERSATION_CONTROL_FENCE, fence.id, workflow.id, fence);
  }

  private refreshRecovery(
    fence: ConversationControlFence,
    tree: ConversationTreeSnapshot,
  ) {
    fence.recovery_candidates = collectRecoveryCandidates(tree);
    fence.updated_at = this.clock.iso();
    this.store.put(
      CONVERSATION_CONTROL_FENCE,
      fence.id,
      fence.workflow_id,
      fence,
    );
  }

  private saveControl(control: ConversationControl, unconfirmed: number) {
    control.unconfirmed_count = unconfirmed;
    control.updated_at = this.clock.iso();
    control.status = StatusSchema.parse(control.status);
    this.store.put(
      CONVERSATION_ENTITY.control,
      control.id,
      control.workflow_id,
      ConversationControlSchema.parse(control),
    );
  }

  private emitControl(workflow: Workflow, control: ConversationControl) {
    this.store.event(
      workflow.id,
      workflow.project_id,
      CONVERSATION_EVENT.controlUpdated,
      { control },
      workflow.run_id,
    );
  }

  private cancelModelRetry(workflowId: string) {
    this.store.remove("model_retry", workflowId);
  }

  private toResult(
    control: ConversationControl,
    elapsed?: number,
  ): ConversationControlResult {
    const wait = elapsed ?? this.elapsed(control);
    const message =
      control.status === "pending" &&
      control.unconfirmed_count > 0 &&
      wait >= PAUSE_HINT_MS
        ? pausePendingMessage(control.unconfirmed_count)
        : undefined;
    return {
      control_id: control.id,
      request_id: control.request_id,
      action: control.action,
      status: control.status,
      unconfirmed_count: control.unconfirmed_count,
      message,
      targets: control.targets,
      control,
    };
  }

  private elapsed(control: ConversationControl): number {
    const fence = this.store.get<ConversationControlFence>(
      CONVERSATION_CONTROL_FENCE,
      control.id,
    );
    if (!fence) return 0;
    return this.clock.ms() - fence.started_ms;
  }

  private findByRequest(
    workflowId: string,
    requestId: string,
  ): ConversationControl | undefined {
    return this.store
      .list<ConversationControl>(CONVERSATION_ENTITY.control, workflowId)
      .find((item) => item.request_id === requestId);
  }

  private latestPause(
    workflowId: string,
    rootId: string,
  ): ConversationControl | undefined {
    return this.store
      .list<ConversationControl>(CONVERSATION_ENTITY.control, workflowId)
      .filter((item) => item.action === "pause" && item.root_id === rootId)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  }

  private readControl(
    workflowId: string,
    controlId: string,
  ): ConversationControl {
    const control = this.store.get<ConversationControl>(
      CONVERSATION_ENTITY.control,
      controlId,
    );
    if (!control)
      throw new FlowError(CONVERSATION_ERROR.NOT_FOUND, "控制记录不存在", 404);
    if (control.workflow_id !== workflowId)
      throw new FlowError(
        CONVERSATION_ERROR.CONVERSATION_NOT_IN_WORKFLOW,
        "控制记录不属于该任务",
        409,
      );
    return ConversationControlSchema.parse(control);
  }

  private readFence(controlId: string): ConversationControlFence {
    const fence = this.store.get<ConversationControlFence>(
      CONVERSATION_CONTROL_FENCE,
      controlId,
    );
    if (!fence)
      throw new FlowError(CONVERSATION_ERROR.NOT_FOUND, "控制冻结记录不存在", 404);
    return fence;
  }

  private requireWorkflow(workflowId: string): Workflow {
    const workflow = this.store.get<Workflow>("workflow", workflowId);
    if (!workflow)
      throw new FlowError(CONVERSATION_ERROR.NOT_FOUND, "任务不存在", 404);
    return workflow;
  }
}

function assertSameRequest(
  existing: ConversationControl,
  request: ConversationControlRequest,
) {
  const same =
    existing.action === request.action &&
    existing.root_id === request.root_id &&
    existing.expected_generation === request.expected_generation;
  if (!same)
    throw new FlowError(
      "IDEMPOTENCY_CONFLICT",
      "同一幂等键的参数不同",
      409,
    );
}

function hasSuccessorRoot(
  tree: ConversationTreeSnapshot,
  root: ConversationNode,
): boolean {
  return tree.nodes.some(
    (node) =>
      node.id === node.root_id &&
      node.id !== root.id &&
      (node.replaces_conversation_id === root.id ||
        (node.lineage_id === root.lineage_id &&
          node.adapter_id === root.adapter_id &&
          node.kind === root.kind &&
          node.created_at > root.created_at)),
  );
}

function latestAttempt(
  attempts: ConversationAttempt[],
  conversationId: string,
): ConversationAttempt | undefined {
  return attempts
    .filter((item) => item.conversation_id === conversationId)
    .sort((a, b) => a.generation - b.generation)
    .at(-1);
}

function collectLiveTargets(
  tree: ConversationTreeSnapshot,
  rootId: string,
  runId?: string,
): ConversationControl["targets"] {
  const targets: ConversationControl["targets"] = [];
  for (const node of tree.nodes) {
    if (node.root_id !== rootId) continue;
    const attempt = latestAttempt(tree.attempts, node.id);
    if (!attempt || !isLiveConversationStatus(attempt.status)) continue;
    if (runId && attempt.run_id !== runId) continue;
    targets.push(
      TargetSchema.parse({
        conversation_id: node.id,
        attempt_id: attempt.id,
        native_session_id: node.native_session_id,
        native_agent_id: node.native_agent_id,
        confirmation: "unconfirmed",
        status: "pausing",
      }),
    );
  }
  return targets;
}

function collectRecoveryCandidates(
  tree: ConversationTreeSnapshot,
): ControlRecoveryCandidate[] {
  const candidates: ControlRecoveryCandidate[] = [];
  for (const node of tree.nodes) {
    const attempt = latestAttempt(tree.attempts, node.id);
    if (!attempt) continue;
    if (attempt.status === "completed" || attempt.status === "cancelled")
      continue;
    if (!isRecoveryConversationStatus(attempt.status)) continue;
    candidates.push({
      conversation_id: node.id,
      parent_id: node.parent_id,
      attempt_id: attempt.id,
      native_session_id: node.native_session_id,
      native_agent_id: node.native_agent_id,
      status: attempt.status,
      reason: attempt.reason,
    });
  }
  return candidates;
}

function resolveTargetAttempt(
  target: ConversationControl["targets"][number],
  tree: ConversationTreeSnapshot,
  runId?: string,
): ConversationAttempt | undefined {
  if (target.attempt_id) {
    const pinned = tree.attempts.find((item) => item.id === target.attempt_id);
    if (pinned) return pinned;
  }
  const latest = latestAttempt(tree.attempts, target.conversation_id);
  if (!latest) return undefined;
  if (runId && latest.run_id !== runId) return undefined;
  return latest;
}

function isTargetResolved(
  target: ConversationControl["targets"][number],
  tree: ConversationTreeSnapshot,
  runId?: string,
): boolean {
  if (target.confirmation === "native" || target.confirmation === "owned_process_tree")
    return true;
  const attempt = resolveTargetAttempt(target, tree, runId);
  if (!attempt) return true;
  return (
    attempt.status === "paused" ||
    attempt.status === "completed" ||
    attempt.status === "cancelled" ||
    attempt.status === "failed" ||
    attempt.status === "interrupted"
  );
}

function countUnconfirmed(
  control: ConversationControl,
  tree: ConversationTreeSnapshot,
): number {
  return control.targets.filter(
    (target) => !isTargetResolved(target, tree),
  ).length;
}

function canMarkPausing(status: ConversationStatus): boolean {
  return isLiveConversationStatus(status);
}

function canMarkPaused(status: ConversationStatus): boolean {
  return (
    status === "pausing" ||
    status === "starting" ||
    status === "running" ||
    status === "waiting" ||
    status === "discovered" ||
    status === "unknown"
  );
}

function mapStopConfirmation(
  result: StopPortResult,
  stop: SubagentCapabilities["stop"],
): StopConfirmation {
  if (result.accepted && result.confirmation === "exited") {
    return stop === "owned-process-tree" ? "owned_process_tree" : "native";
  }
  return "unconfirmed";
}

function rootPurpose(
  tree: ConversationTreeSnapshot,
  rootId: string,
): string | undefined {
  return tree.nodes.find((node) => node.id === rootId)?.purpose;
}
