import type { Store } from "../../store/src/store.js";
import {
  type UserInteractionInput,
  type UserInteractionRecord,
  type UserInteractionResponseInput,
  UserInteractionInputSchema,
} from "../../contracts/src/user-interaction.js";
import { id, now } from "./util.js";
import { FlowError } from "../../contracts/src/index.js";
import type { Engine } from "./engine.js";
import { readWaitingContext } from "./waiting-context.js";

export const USER_INTERACTION_ENTITY = "user_interaction";
export const USER_INTERACTION_RECEIPT_ENTITY = "user_interaction_receipt";

export interface CreateInteractionParams {
  workflowId: string;
  sourceRunId: string;
  sourcePlanRevision: number;
  rootConversationId?: string;
  sourceGeneration?: number;
  purpose: string;
  role: string;
  rawInput?: unknown;
  fallbackSummary?: string;
  fallbackQuestions?: string[];
}

export class UserInteractionService {
  constructor(private store: Store) {}

  listInteractions(workflowId: string): UserInteractionRecord[] {
    return this.store.list<UserInteractionRecord>(
      USER_INTERACTION_ENTITY,
      workflowId,
    );
  }

  getInteraction(interactionId: string): UserInteractionRecord | undefined {
    return this.store.get<UserInteractionRecord>(
      USER_INTERACTION_ENTITY,
      interactionId,
    );
  }

  getCurrentInteraction(workflowId: string): UserInteractionRecord | undefined {
    const records = this.listInteractions(workflowId);
    return records
      .filter((r) => r.status === "pending")
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  }

  createInteraction(params: CreateInteractionParams): UserInteractionRecord {
    const {
      workflowId,
      sourceRunId,
      sourcePlanRevision,
      rootConversationId,
      sourceGeneration,
      purpose,
      role,
      rawInput,
      fallbackSummary,
      fallbackQuestions,
    } = params;

    let validatedRequest: UserInteractionInput | undefined;
    if (rawInput && typeof rawInput === "object") {
      const parsed = UserInteractionInputSchema.safeParse(rawInput);
      if (parsed.success) {
        validatedRequest = parsed.data;
      }
    }

    if (!validatedRequest) {
      if (fallbackQuestions && fallbackQuestions.length > 0) {
        validatedRequest = {
          kind: "question",
          title: "请回答执行提问",
          message: fallbackSummary || "执行模型需要用户协助决策",
          question: fallbackQuestions[0],
          allow_free_text: true,
        };
      } else {
        validatedRequest = {
          kind: "action_required",
          title: "请完成操作协助",
          message:
            fallbackSummary ||
            "执行模型需要用户在界面中完成必要操作，完成后请点击确认继续。",
          action_label: "我已完成，继续",
        };
      }
    }

    // 检查是否已有同一轮次的 pending 记录
    const existing = this.getCurrentInteraction(workflowId);
    if (
      existing &&
      existing.source_run_id === sourceRunId &&
      JSON.stringify(existing.request) === JSON.stringify(validatedRequest)
    ) {
      return existing;
    }

    // 将同一 workflow 的历史 pending 请求标记为 superseded
    if (existing) {
      existing.status = "superseded";
      this.store.put(
        USER_INTERACTION_ENTITY,
        existing.id,
        workflowId,
        existing,
      );
    }

    const record: UserInteractionRecord = {
      id: id("int"),
      workflow_id: workflowId,
      source_run_id: sourceRunId,
      source_plan_revision: sourcePlanRevision,
      root_conversation_id: rootConversationId,
      source_generation: sourceGeneration,
      purpose,
      role,
      request: validatedRequest,
      status: "pending",
      created_at: now(),
    };

    this.store.put(USER_INTERACTION_ENTITY, record.id, workflowId, record);
    return record;
  }

  async respondInteraction(
    workflowId: string,
    interactionId: string,
    payload: UserInteractionResponseInput,
    engine: Engine,
  ): Promise<{ success: boolean; interaction: UserInteractionRecord }> {
    // 1. 幂等回执优先检查
    const receiptKey = `${workflowId}:${payload.request_id}`;
    const existingReceipt = this.store.get<{
      interaction_id: string;
      response: UserInteractionRecord["response"];
      responded_at: string;
    }>(USER_INTERACTION_RECEIPT_ENTITY, receiptKey);

    const record = this.getInteraction(interactionId);
    if (!record || record.workflow_id !== workflowId) {
      throw new FlowError("NOT_FOUND", "未找到对应的人机交互请求", 404);
    }

    if (existingReceipt) {
      // 客户端重复提交相同 request_id，返回已有结果
      return { success: true, interaction: record };
    }

    if (record.status !== "pending") {
      throw new FlowError("CONFLICT", "该交互请求已被处理或失效", 409);
    }

    // 2. 校验来源与归属
    if (payload.source_run_id && record.source_run_id !== payload.source_run_id) {
      throw new FlowError("RUN_MISMATCH", "交互请求来源轮次不匹配", 400);
    }

    const respondedAt = now();
    const responsePayload = {
      request_id: payload.request_id,
      action: payload.action,
      choice_id: payload.choice_id,
      answer: payload.answer,
    };

    if (payload.action === "cancel") {
      record.status = "cancelled";
      record.responded_at = respondedAt;
      record.response = responsePayload;
      this.store.put(USER_INTERACTION_ENTITY, record.id, workflowId, record);
      this.store.put(USER_INTERACTION_RECEIPT_ENTITY, receiptKey, workflowId, {
        interaction_id: record.id,
        response: responsePayload,
        responded_at: respondedAt,
      });
      return { success: true, interaction: record };
    }

    // confirm 或 answer
    record.status = "answered";
    record.responded_at = respondedAt;
    record.response = responsePayload;

    // 组装传回模型的文字回答
    let answerText = "";
    if (record.request.kind === "action_required") {
      answerText =
        payload.answer?.trim() ||
        "用户已在浏览器/界面中确认完成操作。请复查当前页面现场并继续未完成的业务链路。";
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

    // 在同一个事务中更新 interaction 并续接调度
    this.store.put(USER_INTERACTION_ENTITY, record.id, workflowId, record);
    this.store.put(USER_INTERACTION_RECEIPT_ENTITY, receiptKey, workflowId, {
      interaction_id: record.id,
      response: responsePayload,
      responded_at: respondedAt,
    });

    const waiting = readWaitingContext(this.store, workflowId);
    if (waiting) {
      engine.resumeFromWaiting(workflowId, answerText, waiting);
    } else {
      engine.feedback(workflowId, answerText, "within_plan");
    }

    return { success: true, interaction: record };
  }
}
