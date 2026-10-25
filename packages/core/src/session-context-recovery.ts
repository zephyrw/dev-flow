import { requireCondition, type Run, type Workflow } from "../../contracts/src/index.js";
import type { Store } from "../../store/src/store.js";
import { ExecutionSessionStore } from "./execution-session-store.js";
import { now } from "./util.js";

export interface SessionContextRecovery {
  request_id: string;
  source_run_id: string;
  original_conversation_id: string;
  adapter: "agy";
  purpose: Run["purpose"];
  plan_revision: number;
  created_at: string;
}

/** Explicit repair only: preserve native history and reserve a new root with a full handoff. */
export function prepareRejectedSessionRecovery(store: Store, workflowId: string,
  input: { request_id: string; expected_version: number; expected_run_id: string }) {
  return store.transaction(() => {
    const saved = store.get<SessionContextRecovery>("session_context_recovery", workflowId);
    if (saved?.request_id === input.request_id) return saved;
    const workflow = store.must<Workflow>("workflow", workflowId);
    requireCondition(workflow.version === input.expected_version && workflow.run_id === input.expected_run_id,
      "REVISION_CONFLICT", "任务已变化，请刷新后处理当前错误", 409);
    requireCondition(["BLOCKED", "WAITING_INPUT"].includes(workflow.state),
      "SESSION_RECOVERY_NOT_ALLOWED", "只能修复已停止且持续拒绝请求的会话", 409);
    const run = store.must<Run>("run", input.expected_run_id);
    const feedback = store.get<{ message: string }>("model_input_feedback", run.id);
    requireCondition(run.workflow_id === workflowId && (run.profile?.adapterId ?? run.adapter) === "agy" &&
      !!run.conversation_id && ["failed", "waiting"].includes(run.status) &&
      !!feedback && /MODEL_REQUEST_INVALID|INVALID_ARGUMENT/i.test(feedback.message) &&
      /MODEL_REQUEST_INVALID|MODEL_SESSION_REQUEST_REJECTED|INVALID_ARGUMENT/i.test(JSON.stringify(workflow.blocker)),
      "SESSION_RECOVERY_NOT_ALLOWED", "未确认原 AGY 会话在续接后仍拒绝请求，不能重建会话", 409);
    requireCondition(!store.list<Run>("run", workflowId).some(r => ["running", "dispatched"].includes(r.status)) &&
      !store.list<{ status: string }>("process_record", workflowId).some(p => p.status === "running"),
      "SESSION_RECOVERY_BUSY", "仍有任务进程运行，不能重建会话", 409);
    const sessions = new ExecutionSessionStore(store);
    const bindings = sessions.listBindings(workflowId).filter(b => b.adapter_id === "agy" &&
      b.conversation_id === run.conversation_id && b.state === "bound");
    requireCondition(bindings.length > 0, "SESSION_BINDING_UNAVAILABLE", "找不到当前会话绑定，保留现场", 409);
    for (const binding of bindings) sessions.reserveAfterUnavailableRoot(binding, run.conversation_id!);
    const record: SessionContextRecovery = { request_id: input.request_id, source_run_id: run.id,
      original_conversation_id: run.conversation_id!, adapter: "agy", purpose: run.purpose,
      plan_revision: run.plan_revision, created_at: now() };
    store.put("session_context_recovery", workflowId, workflowId, record);
    store.event(workflowId, workflow.project_id, "SessionContextRecoveryPrepared", {
      original_conversation_id: run.conversation_id, source_run_id: run.id,
      message: "原会话持续拒绝请求；保留历史、模型、批准计划和工作区，用新会话读取执行记录后接续。",
    }, run.id);
    return record;
  });
}
