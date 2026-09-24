import type { Store } from "../../store/src/store.js";
import {
  type UserInteractionRecord,
  type UserInteractionResponseInput,
  type UserInteractionReceipt,
} from "../../contracts/src/user-interaction.js";
import { id, now } from "./util.js";
import {
  FlowError,
  CONVERSATION_ENTITY,
  type Workflow,
  type Run,
  type ConversationNode,
  type ConversationAttempt,
} from "../../contracts/src/index.js";
import type { Engine } from "./engine.js";
import { readWaitingContext, type WaitingContext } from "./waiting-context.js";
import {
  normalizeInteractionInput,
  validateInteractionResponse,
  computeInteractionResponseFingerprint,
} from "./user-interaction-normalize.js";

export const USER_INTERACTION_ENTITY = "user_interaction";
export const USER_INTERACTION_RECEIPT_ENTITY = "user_interaction_receipt";

// Native session IDs and UI conversation IDs are separate namespaces. Only a
// root and attempt belonging to the source Run can establish UI ownership.
export function interactionConversationContext(
  store: Store,
  workflowId: string,
  runId?: string,
  nativeSessionId?: string,
) {
  if (!runId || !nativeSessionId)
    return {
      nativeSessionId,
      rootConversationId: undefined,
      sourceGeneration: undefined,
    };
  const roots = store
    .list<ConversationNode>(CONVERSATION_ENTITY.node, workflowId)
    .filter(
      (node) =>
        node.id === node.root_id && node.native_session_id === nativeSessionId,
    );
  const attempts = store
    .list<ConversationAttempt>(CONVERSATION_ENTITY.attempt, workflowId)
    .filter(
      (attempt) =>
        attempt.run_id === runId &&
        roots.some((node) => node.id === attempt.conversation_id),
    )
    .sort((a, b) => b.generation - a.generation);
  const attempt = attempts[0];
  if (new Set(attempts.map((item) => item.root_id)).size > 1)
    return {
      nativeSessionId,
      rootConversationId: undefined,
      sourceGeneration: undefined,
    };
  return {
    nativeSessionId,
    rootConversationId: attempt?.root_id,
    sourceGeneration: attempt?.generation,
  };
}

export interface CreateInteractionParams {
  workflowId: string;
  sourceRunId: string;
  sourcePlanRevision: number;
  rootConversationId?: string;
  sourceGeneration?: number;
  nativeSessionId?: string;
  purpose: string;
  role: string;
  rawInput?: unknown;
  fallbackSummary?: string;
  fallbackQuestions?: string[];
  fallbackNotes?: string;
}

export class UserInteractionService {
  constructor(private store: Store) {}

  listInteractions(workflowId: string): UserInteractionRecord[] {
    return this.store
      .list<UserInteractionRecord>(USER_INTERACTION_ENTITY, workflowId)
      .map((record) => this.safeRecord(record));
  }

  getInteraction(interactionId: string): UserInteractionRecord | undefined {
    const record = this.store.get<UserInteractionRecord>(
      USER_INTERACTION_ENTITY,
      interactionId,
    );
    return record ? this.safeRecord(record) : undefined;
  }

  private safeRecord(record: UserInteractionRecord): UserInteractionRecord {
    return { ...record, request: normalizeInteractionInput(record.request) };
  }

  private belongsToWaiting(
    record: UserInteractionRecord,
    workflowId: string,
    waiting: WaitingContext,
  ) {
    return (
      record.workflow_id === workflowId &&
      record.source_run_id === waiting.run_id &&
      record.purpose === waiting.purpose &&
      record.role === waiting.role
    );
  }

  /**
   * F01, F06: 按当前等待归属返回，且针对旧 need_user waiting 提供确定性兼容视图
   */
  getCurrentInteraction(workflowId: string): UserInteractionRecord | undefined {
    const waiting = readWaitingContext(this.store, workflowId);
    const workflow = this.store.get<Workflow>("workflow", workflowId);
    if (
      !waiting ||
      waiting.intent !== "need_user" ||
      workflow?.state !== "WAITING_INPUT"
    ) {
      return undefined;
    }

    // 1. 如果 waiting 中明确绑定了 interaction_id，直接读取
    if (waiting.interaction_id) {
      const record = this.getInteraction(waiting.interaction_id);
      if (
        record &&
        record.status === "pending" &&
        this.belongsToWaiting(record, workflowId, waiting)
      ) {
        return record;
      }
      // An explicit binding is authoritative, including a terminal decision.
      return undefined;
    }

    // 2. 如果 waiting 是 need_user 但没有 interaction_id，或者关联记录丢失，
    //    按来源 run_id 检查是否有现存 pending 记录
    const records = this.listInteractions(workflowId);
    const matching = records.filter((r) =>
      this.belongsToWaiting(r, workflowId, waiting),
    );
    if (matching.length)
      return matching.length === 1 && matching[0]!.status === "pending"
        ? this.safeRecord(matching[0]!)
        : undefined;

    // 3. F06: 旧任务兼容视图（稳定派生 ID，绝不随机生成，只读不写）
    const run = waiting.run_id
      ? this.store.get<Run>("run", waiting.run_id)
      : undefined;
    if (run?.workflow_id === workflowId) {
      const stableId = `int-legacy-${workflowId}-${waiting.run_id || "pending"}`;
      const existingLegacy = this.getInteraction(stableId);
      if (existingLegacy)
        return existingLegacy.status === "pending" ? existingLegacy : undefined;

      const normalizedRequest = normalizeInteractionInput(undefined, {
        summary: waiting.original_text,
        questions: waiting.questions,
      });
      const context = interactionConversationContext(
        this.store,
        workflowId,
        run.id,
        run.conversation_id,
      );

      return {
        id: stableId,
        workflow_id: workflowId,
        source_run_id: waiting.run_id ?? "",
        source_plan_revision: run.plan_revision,
        root_conversation_id: context.rootConversationId,
        source_generation: context.sourceGeneration,
        native_session_id: run.conversation_id,
        purpose: waiting.purpose ?? "execute",
        role: waiting.role ?? "executor",
        request: normalizedRequest,
        status: "pending",
        created_at: waiting.created_at ?? now(),
      };
    }

    return undefined;
  }

  /**
   * F01, F02: 创建交互并在同一事务中处理防重与旧待办废弃
   */
  createInteraction(params: CreateInteractionParams): UserInteractionRecord {
    const {
      workflowId,
      sourceRunId,
      sourcePlanRevision,
      rootConversationId,
      sourceGeneration,
      nativeSessionId,
      purpose,
      role,
      rawInput,
      fallbackSummary,
      fallbackQuestions,
      fallbackNotes,
    } = params;

    const validatedRequest = normalizeInteractionInput(rawInput, {
      summary: fallbackSummary,
      questions: fallbackQuestions,
      notes: fallbackNotes,
    });

    return this.store.transaction(() => {
      // 检查当前是否已有完全一致的同轮次 pending 记录
      const pending = this.listInteractions(workflowId).filter(
        (record) => record.status === "pending",
      );
      const existing = pending.find(
        (record) =>
          record.source_run_id === sourceRunId &&
          record.source_plan_revision === sourcePlanRevision &&
          record.root_conversation_id === rootConversationId &&
          record.source_generation === sourceGeneration &&
          record.native_session_id === nativeSessionId &&
          record.purpose === purpose &&
          record.role === role,
      );
      if (
        existing &&
        existing.source_run_id === sourceRunId &&
        existing.status === "pending" &&
        JSON.stringify(existing.request) === JSON.stringify(validatedRequest)
      ) {
        return existing;
      }

      // 将该任务的历史 pending 请求标记为 superseded
      for (const existing of pending) {
        const supersededRecord = {
          ...existing,
          status: "superseded" as const,
        };
        this.store.put(
          USER_INTERACTION_ENTITY,
          supersededRecord.id,
          workflowId,
          supersededRecord,
        );
      }

      const record: UserInteractionRecord = {
        id: id("int"),
        workflow_id: workflowId,
        source_run_id: sourceRunId,
        source_plan_revision: sourcePlanRevision,
        root_conversation_id: rootConversationId,
        source_generation: sourceGeneration,
        native_session_id: nativeSessionId,
        purpose,
        role,
        request: validatedRequest,
        status: "pending",
        created_at: now(),
      };

      this.store.put(USER_INTERACTION_ENTITY, record.id, workflowId, record);
      return record;
    });
  }

  /**
   * 将任务的所有 pending 交互标记为 superseded（例如被指导或取消恢复时）
   */
  supersedePendingInteractions(workflowId: string): void {
    this.store.transaction(() => {
      const records = this.listInteractions(workflowId);
      for (const r of records) {
        if (r.status === "pending") {
          this.store.put(USER_INTERACTION_ENTITY, r.id, workflowId, {
            ...r,
            status: "superseded",
          });
        }
      }
    });
  }

  /**
   * F01 - F04: 人工响应处理核心链路
   * 严格保证：归属校验 + 语义校验 + 幂等指纹 + 事务落库 + 调度续接
   */
  async respondInteraction(
    workflowId: string,
    interactionId: string,
    payload: UserInteractionResponseInput,
    engine: Engine,
  ): Promise<{ success: boolean; interaction: UserInteractionRecord }> {
    const fingerprint = computeInteractionResponseFingerprint(
      workflowId,
      interactionId,
      payload,
    );
    const receiptKey = `${workflowId}:${payload.request_id}`;

    return this.store.transaction(() => {
      // 1. F03: 幂等回执校验
      const existingReceipt = this.store.get<UserInteractionReceipt>(
        USER_INTERACTION_RECEIPT_ENTITY,
        receiptKey,
      );

      if (existingReceipt) {
        if (
          existingReceipt.interaction_id === interactionId &&
          existingReceipt.fingerprint === fingerprint
        ) {
          const existingRecord = this.getInteraction(interactionId);
          if (existingRecord) {
            return { success: true, interaction: existingRecord };
          }
        }
        throw new FlowError(
          "IDEMPOTENCY_CONFLICT",
          "幂等请求 ID 已被用于不同的交互决定或问题",
          409,
        );
      }

      // 2. F01: 校验当前等待归属与当前 workflow 状态
      const workflow =
        typeof engine.get === "function"
          ? engine.get(workflowId)
          : this.store.get<Workflow>("workflow", workflowId);
      if (!workflow) {
        throw new FlowError("NOT_FOUND", `未找到工作流: ${workflowId}`, 404);
      }
      if (workflow.state !== "WAITING_INPUT") {
        throw new FlowError(
          "INVALID_WORKFLOW_STATE",
          `工作流当前状态 (${workflow.state}) 不允许提交人工交互响应`,
          409,
        );
      }

      const waiting = readWaitingContext(this.store, workflowId);
      if (!waiting || waiting.intent !== "need_user") {
        throw new FlowError(
          "WAITING_CONTEXT_MISSING",
          "当前工作流未处于等待人工交互的上下文中",
          409,
        );
      }

      // 检查交互实体（支持 F06 legacy 兼容实体的首次落库）
      let record = this.getInteraction(interactionId);
      if (!record && interactionId.startsWith("int-legacy-")) {
        const currentLegacy = this.getCurrentInteraction(workflowId);
        if (currentLegacy && currentLegacy.id === interactionId) {
          record = currentLegacy;
        }
      }

      if (!record || record.workflow_id !== workflowId) {
        throw new FlowError("NOT_FOUND", "未找到对应的人机交互请求", 404);
      }

      if (record.status !== "pending") {
        throw new FlowError(
          "INTERACTION_ALREADY_RESOLVED",
          `该交互请求已被处理 (${record.status})`,
          409,
        );
      }

      // 验证 WaitingContext 关联与来源一致性
      if (waiting.interaction_id && waiting.interaction_id !== record.id) {
        throw new FlowError(
          "WAITING_MISMATCH",
          "提交的交互请求与当前工作流等待的交互轮次不匹配",
          409,
        );
      }

      if (!this.belongsToWaiting(record, workflowId, waiting)) {
        throw new FlowError(
          "RUN_MISMATCH",
          "交互请求的来源 Run 与当前等待的 Run 不匹配",
          409,
        );
      }

      const sourceRun = this.store.get<Run>("run", record.source_run_id);
      if (
        !sourceRun ||
        workflow.plan_revision !== record.source_plan_revision ||
        (workflow.run_id && workflow.run_id !== record.source_run_id) ||
        sourceRun.workflow_id !== workflowId ||
        sourceRun.plan_revision !== record.source_plan_revision ||
        (record.native_session_id &&
          sourceRun.conversation_id !== record.native_session_id) ||
        (record.native_session_id &&
          record.native_session_id !== waiting.conversation_id)
      ) {
        throw new FlowError(
          "INTERACTION_STALE",
          "交互来源或计划版本已变化，请刷新后处理当前请求",
          409,
        );
      }
      if (record.root_conversation_id) {
        const root = this.store.get<ConversationNode>(
          CONVERSATION_ENTITY.node,
          record.root_conversation_id,
        );
        const attempt = root?.current_attempt_id
          ? this.store.get<ConversationAttempt>(
              CONVERSATION_ENTITY.attempt,
              root.current_attempt_id,
            )
          : undefined;
        if (
          !root ||
          root.workflow_id !== workflowId ||
          !attempt ||
          attempt.run_id !== record.source_run_id ||
          attempt.generation !== record.source_generation ||
          root.native_session_id !== record.native_session_id
        ) {
          throw new FlowError(
            "INTERACTION_STALE",
            "来源会话已恢复或替换，请刷新后处理当前请求",
            409,
          );
        }
      }

      if (payload.source_run_id !== record.source_run_id) {
        throw new FlowError(
          "SOURCE_RUN_MISMATCH",
          "响应提交的来源 Run 与交互记录的来源 Run 不匹配",
          409,
        );
      }

      if (
        payload.source_plan_revision !== undefined &&
        payload.source_plan_revision !== record.source_plan_revision
      ) {
        throw new FlowError(
          "PLAN_REVISION_MISMATCH",
          "响应提交的计划版本已过期",
          409,
        );
      }

      if (
        payload.root_conversation_id !== undefined &&
        payload.root_conversation_id !== record.root_conversation_id
      ) {
        throw new FlowError(
          "CONVERSATION_MISMATCH",
          "响应提交的会话根 ID 不匹配",
          409,
        );
      }

      if (
        payload.expected_generation !== undefined &&
        payload.expected_generation !== record.source_generation
      ) {
        throw new FlowError(
          "GENERATION_MISMATCH",
          "响应提交的会话代数已过期",
          409,
        );
      }
      if (
        payload.native_session_id !== undefined &&
        payload.native_session_id !== record.native_session_id
      ) {
        throw new FlowError("SESSION_MISMATCH", "原生会话已变化", 409);
      }

      // 3. F04: 语义校验
      const semanticValidation = validateInteractionResponse(
        record.request,
        payload,
      );
      if (!semanticValidation.valid) {
        throw new FlowError(
          "INVALID_RESPONSE",
          semanticValidation.error || "提交的响应内容不符合当前交互类型要求",
          400,
        );
      }

      const respondedAt = now();
      const responsePayload = {
        request_id: payload.request_id,
        action: payload.action,
        choice_id: payload.choice_id?.trim() || undefined,
        answer: payload.answer?.trim() || undefined,
      };

      // 4. 取消分支
      if (payload.action === "cancel") {
        record.status = "cancelled";
        record.responded_at = respondedAt;
        record.response = responsePayload;

        this.store.put(USER_INTERACTION_ENTITY, record.id, workflowId, record);
        const receipt: UserInteractionReceipt = {
          id: receiptKey,
          workflow_id: workflowId,
          interaction_id: record.id,
          request_id: payload.request_id,
          fingerprint,
          status: "cancelled",
          created_at: respondedAt,
          payload: responsePayload,
        };
        this.store.put(
          USER_INTERACTION_RECEIPT_ENTITY,
          receiptKey,
          workflowId,
          receipt,
        );

        return { success: true, interaction: record };
      }

      // 5. 确认/回答分支
      record.status = "answered";
      record.responded_at = respondedAt;
      record.response = responsePayload;

      // F06: 组装带原提问背景的文字回答
      let answerText = "";
      if (record.request.kind === "action_required") {
        answerText =
          "用户已在浏览器/界面中确认完成操作。请复查当前页面现场并继续未完成的业务链路。" +
          (payload.answer?.trim()
            ? `\n用户说明: ${payload.answer.trim()}`
            : "");
      } else {
        let choicePart = "";
        if (payload.choice_id) {
          const choice = record.request.choices?.find(
            (c) => c.id === payload.choice_id,
          );
          const label = choice ? choice.label : payload.choice_id;
          choicePart = `[选择项: ${label}] `;
        }
        const freeText = payload.answer?.trim() || "";
        answerText = `${choicePart}${freeText}`.trim() || "用户已提供确认。";
      }

      // F06: 如果有原提问或说明，附加原问题快照，保证重构上下文时背景完整
      if (record.request.question) {
        answerText = `[针对问题: ${record.request.question}] ${answerText}`;
      }
      if (record.request.resume_note) {
        answerText = `${answerText}\n[继续提示: ${record.request.resume_note}]`;
      }
      answerText =
        `[原请求: ${record.request.title}]\n${record.request.message}\n` +
        (record.request.choices?.length
          ? `候选项: ${record.request.choices.map((choice) => choice.label).join("；")}\n`
          : "") +
        answerText;

      // F02: 在同一事务中原子更新交互实体、回执并调用 resumeFromWaiting
      this.store.put(USER_INTERACTION_ENTITY, record.id, workflowId, record);
      const receipt: UserInteractionReceipt = {
        id: receiptKey,
        workflow_id: workflowId,
        interaction_id: record.id,
        request_id: payload.request_id,
        fingerprint,
        status: "queued",
        created_at: respondedAt,
        payload: responsePayload,
      };
      this.store.put(
        USER_INTERACTION_RECEIPT_ENTITY,
        receiptKey,
        workflowId,
        receipt,
      );

      // 同步续接现有 continuation / 调度队列
      engine.resumeFromWaiting(workflowId, answerText, waiting);

      return { success: true, interaction: record };
    });
  }
}
