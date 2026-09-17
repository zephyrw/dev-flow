import type { Store } from "../../store/src/store.js";
import type {
  AsideSession,
  WorkspaceReference,
  FeedbackMessage,
} from "../../contracts/src/feedback.js";
import { id, now } from "../../core/src/util.js";
import { FeedbackService } from "../../core/src/feedback-service.js";
import { requireCondition } from "../../contracts/src/index.js";

const MAX_ACTIVE_ASIDES_GLOBAL = 1; // 全局严格只允许 1 个活跃 aside 槽位
const MAX_QUEUED_ASIDES = 3;
const ASIDE_TIMEOUT_MS = 120 * 1000;

export class AsideSessionService {
  constructor(private store: Store) {}

  submitQuestion(
    workflowId: string,
    question: string,
    refs: WorkspaceReference[] = [],
    profileRevision: string = "1",
    planContext?: { plan_revision: number; plan_hash: string },
  ): AsideSession {
    const allGlobal = this.store.list<AsideSession>("aside_session");
    const globalActiveCount = allGlobal.filter(
      (s) => s.status === "active",
    ).length;

    const wfSessions = allGlobal.filter((s) => s.workflow_id === workflowId);
    const wfQueuedCount = wfSessions.filter(
      (s) => s.status === "queued",
    ).length;

    if (wfQueuedCount >= MAX_QUEUED_ASIDES) {
      throw new Error(
        `排队提问已达上限 (${MAX_QUEUED_ASIDES} 个)，请等待解答完成`,
      );
    }

    const sessionId = id("aside");
    const shouldBeActive = globalActiveCount < MAX_ACTIVE_ASIDES_GLOBAL;

    const session: AsideSession = {
      id: sessionId,
      workflow_id: workflowId,
      profile_revision: profileRevision,
      context_ref: planContext
        ? `workflow:${workflowId}:plan:${planContext.plan_revision}`
        : `workflow:${workflowId}:context`,
      ...planContext,
      question,
      refs,
      status: shouldBeActive ? "active" : "queued",
      created_at: now(),
      expires_at: new Date(Date.now() + ASIDE_TIMEOUT_MS).toISOString(),
    };

    this.store.put("aside_session", sessionId, workflowId, session);

    if (shouldBeActive) {
      this.store.enqueue(workflowId, "dispatch_run", {
        workflow_id: workflowId,
        aside_id: sessionId,
        purpose: "aside",
      });
    }

    return session;
  }

  completeSession(
    workflowId: string,
    sessionId: string,
    answer: string,
  ): AsideSession {
    const session = this.store.get<AsideSession>("aside_session", sessionId);
    if (!session || session.workflow_id !== workflowId) {
      throw new Error(`提问会话 ${sessionId} 不存在`);
    }
    const wasActive = session.status === "active";
    session.status = "completed";
    session.answer = answer;
    session.completed_at = now();
    this.store.put("aside_session", sessionId, workflowId, session);

    if (wasActive) {
      this.promoteNextQueued();
    }
    return session;
  }

  cancelSession(workflowId: string, sessionId: string): void {
    const session = this.store.get<AsideSession>("aside_session", sessionId);
    if (session && session.workflow_id === workflowId) {
      const wasActive = session.status === "active";
      session.status = "cancelled";
      this.store.put("aside_session", sessionId, workflowId, session);
      // 仅当原本处于 active 状态被取消时，才唤醒下一个排队项
      if (wasActive) {
        this.promoteNextQueued();
      }
    }
  }

  /**
   * 提问转为正式迭代反馈（严格幂等，RQ-09 & R09）
   */
  promoteToFormalFeedback(
    workflowId: string,
    sessionId: string,
    editedText: string,
    targetRevision: number = 0,
  ): FeedbackMessage {
    const session = this.store.get<AsideSession>("aside_session", sessionId);
    if (!session || session.workflow_id !== workflowId) {
      throw new Error(`提问会话 ${sessionId} 不存在`);
    }

    requireCondition(
      session.status === "completed" && !!session.answer,
      "ASIDE_NOT_COMPLETED",
      "提问完成后才能转为正式反馈",
    );
    requireCondition(
      editedText?.trim(),
      "EMPTY_FEEDBACK",
      "正式反馈内容不能为空",
    );
    return new FeedbackService(this.store).submitFeedback({
      request_id: "promoted_" + sessionId,
      workflow_id: workflowId,
      kind: [
        "PLANNING",
        "PLAN_PENDING",
        "REPAIR_PLAN_PENDING",
        "RESEARCHING",
      ].includes(this.store.must<any>("workflow", workflowId).state)
        ? "planning"
        : "execution",
      text: editedText,
      refs: session.refs,
      target_document_revision: targetRevision,
    });
  }

  private promoteNextQueued(): void {
    const allGlobal = this.store.list<AsideSession>("aside_session");
    const hasActive = allGlobal.some((s) => s.status === "active");
    if (hasActive) return;

    // 优先按创建时间唤醒最早排队的 session
    const queuedList = allGlobal
      .filter((s) => s.status === "queued")
      .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));

    const next = queuedList[0];
    if (next) {
      next.status = "active";
      this.store.put("aside_session", next.id, next.workflow_id, next);
      this.store.enqueue(next.workflow_id, "dispatch_run", {
        workflow_id: next.workflow_id,
        aside_id: next.id,
        purpose: "aside",
      });
    }
  }
}
