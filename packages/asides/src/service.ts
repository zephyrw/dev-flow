import type { Store } from "../../store/src/store.js";
import type {
  AsideSession,
  WorkspaceReference,
  FeedbackMessage,
} from "../../contracts/src/feedback.js";
import { id, now } from "../../core/src/util.js";
import { FeedbackService } from "../../core/src/feedback-service.js";
import { FlowError, requireCondition } from "../../contracts/src/index.js";
import { ProjectAsideHistory } from "./project-history.js";

const MAX_ACTIVE_ASIDES_GLOBAL = 1;
const MAX_QUEUED_ASIDES = 3;
export const ASIDE_TIMEOUT_MS = 10 * 60 * 1000;

export class AsideSessionService {
  private history: ProjectAsideHistory;

  constructor(private store: Store) {
    this.history = new ProjectAsideHistory(store);
  }

  submitQuestion(
    workflowId: string,
    question: string,
    refs: WorkspaceReference[] = [],
    profileRevision: string = "1",
    planContext?: { plan_revision: number; plan_hash: string },
    attachment_ids: string[] = [],
  ): AsideSession {
    return this.store.transaction(() => {
      const allGlobal = this.store.list<AsideSession>("aside_session");
      const globalActiveCount = allGlobal.filter(
        (s) => (s.status === "active" || s.status === "waiting_account"),
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
        attachment_ids: attachment_ids.slice(),
        status: shouldBeActive ? "active" : "queued",
        created_at: now(),
        expires_at: new Date(Date.now() + ASIDE_TIMEOUT_MS).toISOString(),
      };

      this.saveSession(session);
      if (shouldBeActive) this.enqueueDispatch(session);
      return session;
    });
  }

  completeSession(
    workflowId: string,
    sessionId: string,
    answer: string,
  ): AsideSession {
    return this.store.transaction(() => {
      const session = this.requireSession(workflowId, sessionId);
      if (!isOpenAsideStatus(session.status)) return session;
      const wasActive = session.status === "active" || session.status === "waiting_account";
      session.status = "completed";
      session.answer = answer;
      session.completed_at = now();
      this.saveSession(session);
      if (wasActive) this.promoteNextQueued();
      return session;
    });
  }

  cancelSession(workflowId: string, sessionId: string): void {
    this.store.transaction(() => {
      const session = this.store.get<AsideSession>("aside_session", sessionId);
      if (!session || session.workflow_id !== workflowId) return;
      if (!isOpenAsideStatus(session.status)) return;
      const wasActive = session.status === "active" || session.status === "waiting_account";
      session.status = "cancelled";
      this.saveSession(session);
      if (wasActive) this.promoteNextQueued();
    });
  }

  pauseForAccountWait(workflowId: string, sessionId: string): AsideSession {
    const session = this.store.get<AsideSession>("aside_session", sessionId);
    if (!session || session.workflow_id !== workflowId) {
      throw new Error(`提问会话 ${sessionId} 不存在`);
    }
    session.status = "waiting_account";
    this.saveSession(session);
    // 不调用 promoteNextQueued，仍占全局 aside 槽
    return session;
  }

  resumeFromAccountWait(workflowId: string, sessionId: string): AsideSession {
    const session = this.store.get<AsideSession>("aside_session", sessionId);
    if (!session || session.workflow_id !== workflowId) {
      throw new Error(`提问会话 ${sessionId} 不存在`);
    }
    session.status = "active";
    this.saveSession(session);
    return session;
  }

  failSession(
    workflowId: string,
    sessionId: string,
    message: string,
  ): AsideSession {
    return this.store.transaction(() => {
      const session = this.requireSession(workflowId, sessionId);
      if (!isOpenAsideStatus(session.status)) return session;
      const wasActive = session.status === "active" || session.status === "waiting_account";
      session.status = "expired";
      session.answer = message;
      session.completed_at = now();
      this.saveSession(session);
      if (wasActive) this.promoteNextQueued();
      return session;
    });
  }

  settleRun(
    workflowId: string,
    sessionId: string,
    result: { answer?: string; error?: unknown },
  ): AsideSession | undefined {
    return this.store.transaction(() => {
      const session = this.store.get<AsideSession>("aside_session", sessionId);
      if (!session || session.workflow_id !== workflowId) return;
      if (!isOpenAsideStatus(session.status)) return session;
      if (isAccountWaitError(result.error)) {
        return this.pauseForAccountWait(workflowId, sessionId);
      }
      const answer = result.answer?.trim();
      if (answer) return this.completeSession(workflowId, sessionId, answer);
      const timedOut = isAsideTimeout(result.error);
      const message = timedOut
        ? "提问超时，规划模型未在时限内给出回答。"
        : "这次提问未能完成：" + asideErrorText(result.error);
      return this.failSession(workflowId, sessionId, message);
    });
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
      attachment_ids: session.attachment_ids ?? [],
      target_document_revision: targetRevision,
    });
  }

  private promoteNextQueued(): void {
    const allGlobal = this.store.list<AsideSession>("aside_session");
    const hasActive = allGlobal.some((s) => (s.status === "active" || s.status === "waiting_account"));
    if (hasActive) return;

    // 优先按创建时间唤醒最早排队的 session
    const queuedList = allGlobal
      .filter((s) => s.status === "queued")
      .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));

    const next = queuedList[0];
    if (next) {
      next.status = "active";
      this.saveSession(next);
      this.enqueueDispatch(next);
    }
  }

  private requireSession(workflowId: string, sessionId: string): AsideSession {
    const session = this.store.get<AsideSession>("aside_session", sessionId);
    if (!session || session.workflow_id !== workflowId) {
      throw new Error(`提问会话 ${sessionId} 不存在`);
    }
    return session;
  }

  private saveSession(session: AsideSession): void {
    this.store.put("aside_session", session.id, session.workflow_id, session);
    this.history.recordSession(session);
  }

  private enqueueDispatch(session: AsideSession): void {
    this.store.enqueue(session.workflow_id, "dispatch_run", {
      workflow_id: session.workflow_id,
      aside_id: session.id,
      purpose: "aside",
    });
  }
}

function isOpenAsideStatus(status: AsideSession["status"]): boolean {
  return status === "active" || status === "queued" || status === "waiting_account";
}

function isAsideTimeout(error: unknown) {
  if (error instanceof FlowError) return error.code === "TIMEOUT";
  return /timeout|超时/i.test(asideErrorText(error));
}

function asideErrorText(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message;
  const text = String(error ?? "").trim();
  return text || "未知错误";
}

function isAccountWaitError(error: unknown): boolean {
  if (error instanceof FlowError) {
    return error.code === "AGY_ACCOUNT_WAIT";
  }
  return false;
}
