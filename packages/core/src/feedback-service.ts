import type { Store } from "../../store/src/store.js";
import {
  type FeedbackMessage,
  type WorkspaceReference,
  FeedbackMessageSchema,
} from "../../contracts/src/feedback.js";
import { FlowError, requireCondition, Id } from "../../contracts/src/index.js";
import { id, now, objectHash } from "./util.js";

export interface SubmitFeedbackRequest {
  request_id: string;
  workflow_id: string;
  kind: "planning" | "execution" | "functional";
  text: string;
  refs?: WorkspaceReference[];
  target_document_revision?: number;
  interrupt_requested?: boolean;
}

export interface FeedbackMessagePage {
  messages: FeedbackMessage[];
  nextCursor?: number;
  hasMore: boolean;
}

export class FeedbackService {
  constructor(private store: Store) {}

  /**
   * 提交反馈消息 (RQ-08)
   */
  submitFeedback(req: SubmitFeedbackRequest): FeedbackMessage {
    requireCondition(
      req.text && req.text.trim().length > 0,
      "EMPTY_FEEDBACK",
      "反馈正文不能为空",
      400,
    );

    const workflowId = req.workflow_id;
    const existingMessages = this.store.list<FeedbackMessage>(
      "feedback_message",
      workflowId,
    );

    // 幂等防重：同 request_id 直接返回历史
    const matched = existingMessages.find(
      (m) => m.client_request_id === req.request_id,
    );
    if (matched) {
      requireCondition(
        matched.text === req.text &&
          matched.kind === req.kind &&
          objectHash(matched.refs) === objectHash(req.refs ?? []) &&
          matched.target_document_revision ===
            (req.target_document_revision ?? 0),
        "IDEMPOTENCY_CONFLICT",
        "相同请求 ID 的反馈内容不同",
        409,
      );
      return matched;
    }

    const messageId = id("fb");
    const nextSeq =
      existingMessages.length > 0
        ? Math.max(...existingMessages.map((m) => m.seq)) + 1
        : 1;

    const message: FeedbackMessage = {
      message_id: messageId,
      client_request_id: req.request_id,
      seq: nextSeq,
      workflow_id: workflowId,
      kind: req.kind,
      text: req.text,
      refs: req.refs ?? [],
      target_document_revision: req.target_document_revision ?? 0,
      status: "pending",
      created_at: now(),
    };

    FeedbackMessageSchema.parse(message);
    this.store.put("feedback_message", messageId, workflowId, message);

    // 如果是紧急中断反馈，写入中断指令
    if (req.interrupt_requested) {
      this.store.enqueue(workflowId, "dispatch_run", {
        workflow_id: workflowId,
        purpose: "feedback_interrupt",
        message_id: messageId,
        kind: req.kind,
      });
    }

    return message;
  }

  /**
   * 按游标增量查询反馈消息与回复 (第 5.2 节 GET /api/workflows/:id/messages)
   */
  listMessages(
    workflowId: string,
    afterSeq: number = 0,
    limit: number = 50,
  ): FeedbackMessagePage {
    const all = this.store.list<FeedbackMessage>(
      "feedback_message",
      workflowId,
    );
    all.sort((a, b) => a.seq - b.seq);

    const filtered = all.filter((m) => m.seq > afterSeq);
    const slice = filtered.slice(0, limit);
    const hasMore = filtered.length > limit;
    const nextCursor =
      slice.length > 0 ? slice[slice.length - 1]!.seq : undefined;

    return {
      messages: slice,
      nextCursor,
      hasMore,
    };
  }

  /**
   * 模型/系统确认处理反馈游标
   */
  acknowledgeMessage(workflowId: string, messageId: string): FeedbackMessage {
    const msg = this.store.get<FeedbackMessage>("feedback_message", messageId);
    requireCondition(
      msg && msg.workflow_id === workflowId,
      "MESSAGE_NOT_FOUND",
      "消息不存在",
      404,
    );

    msg.status = "acknowledged";
    const run = this.store.get<any>("workflow", workflowId)?.run_id;
    requireCondition(
      run && this.store.get<any>("run", run)?.status === "running",
      "RUN_REQUIRED",
      "只有真实运行轮次可以确认消费反馈",
    );
    msg.ack_run = run;
    this.store.put("feedback_message", messageId, workflowId, msg);
    return msg;
  }
}
