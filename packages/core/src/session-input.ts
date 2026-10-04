import type { FeedbackMessage, Run } from "../../contracts/src/index.js";
import { FlowError } from "../../contracts/src/index.js";
import type { Store } from "../../store/src/store.js";
import { boundConversationContinuation } from "./conversation-lineage.js";
import { nativeAdapter } from "./native-session.js";

export interface SessionInputReceipt {
  run_id: string;
  conversation_id?: string;
  kind: "stage_start" | "followup" | "cross_tool_handoff";
  stage_key: string;
  message_ids: string[];
  state: "prepared" | "started" | "delivered";
  user_input?: boolean;
  target_adapter?: string;
  handoff_source_run_id?: string;
  handoff_context_hash?: string;
}

export function inputStageKey(run: Run): string {
  return JSON.stringify([run.plan_revision, run.purpose, run.routing_role,
    run.assignment_id ?? run.dispatch_context?.assignment_id,
    run.dispatch_context?.review_phase, run.dispatch_context?.repair_batch_id,
    run.dispatch_context?.source_run_id]);
}

/** Assignment to a Run is not delivery, and lack of task completion is not a retry signal. */
export function pendingRunMessages(store: Store, workflowId: string, run: Run): FeedbackMessage[] {
  if (run.purpose === "aside") return [];
  const assigned = new Set([run.id]);
  let cursor = run;
  while (true) {
    const next = boundConversationContinuation(store, cursor);
    if (next?.kind !== "runtime_resume" || assigned.has(next.source_run_id)) break;
    const source = store.get<Run>("run", next.source_run_id);
    if (!source || source.workflow_id !== workflowId || source.status === "completed") break;
    assigned.add(source.id);
    cursor = source;
  }
  const receipts = store.list<SessionInputReceipt>("session_input", workflowId);
  return store.list<FeedbackMessage>("feedback_message", workflowId)
    .filter(message => {
      if (message.workflow_id !== workflowId || !message.ack_run) return false;
      if (assigned.has(message.ack_run)) return true;
      // Native recovery may bind the last process that actually started rather
      // than its rejected child Run. Keep the child's proven unstarted input
      // attached to that same stage and continuation, without replaying siblings
      // whose delivery or stage ownership is ambiguous.
      const source = store.get<Run>("run", message.ack_run);
      if (!source || source.status !== "failed" || source.workflow_id !== workflowId ||
          inputStageKey(source) !== inputStageKey(run)) return false;
      const parent = boundConversationContinuation(store, source);
      return parent?.kind === "runtime_resume" && assigned.has(parent.source_run_id) &&
        rejectedBeforeNativeStart(store, workflowId, source.id);
    })
    .filter(message => {
      const attempts = receipts.filter(receipt => receipt.message_ids.includes(message.message_id));
      if (attempts.some(receipt => receipt.state === "delivered")) return false;
      if (attempts.some(receipt => receipt.state === "started"))
        throw new FlowError("INPUT_DELIVERY_UNKNOWN", "上一条消息的投递结果尚未确认，保留原会话，不自动重复发送", 409);
      // Compatibility for already running installations: a historical native Run
      // already owns these inputs. Never replay it merely because it was paused.
      const source = message.ack_run !== run.id ? store.get<Run>("run", message.ack_run!) : undefined;
      return attempts.length > 0 || !source?.conversation_id ||
        rejectedBeforeNativeStart(store, workflowId, source.id);
    })
    .sort((a, b) => a.seq - b.seq);
}

/** Historical frozen conversation IDs do not prove this Run delivered any input. */
function rejectedBeforeNativeStart(store: Store, workflowId: string, runId: string): boolean {
  let after = 0;
  while (true) {
    const events = store.events(workflowId, after, 1000);
    if (!events.length) return false;
    if (events.some(event => event.run_id === runId && event.type === "AgyAccountAdmissionFailed")) return true;
    after = events[events.length - 1]!.event_seq;
  }
}

export function isSessionFollowup(store: Store, run: Run, conversationId: string | undefined,
  messages: Pick<FeedbackMessage, "kind">[]): boolean {
  if (run.purpose === "aside" || run.purpose === "diagnose" || run.purpose === "merge_conflict") return false;
  const continuation = boundConversationContinuation(store, run);
  if (!conversationId) {
    const source = continuation && store.get<Run>("run", continuation.source_run_id);
    const changedTool = source && nativeAdapter(source) !== nativeAdapter(run);
    if (!changedTool && ((source?.purpose === run.purpose && source?.conversation_id) || run.dispatch_context?.guidance_mode === "human_acceptance"))
      throw new FlowError("SESSION_CONTINUATION_UNAVAILABLE", "原会话不可恢复，未新建会话或重新注入任务，请处理会话绑定", 409);
    return false;
  }
  const source = continuation && store.get<Run>("run", continuation.source_run_id);
  const receipts = store.list<SessionInputReceipt>("session_input", run.workflow_id)
    .filter(receipt => receipt.run_id !== run.id && receipt.conversation_id === conversationId);
  const sourceWasGuidance = source && store.get<SessionInputReceipt>("session_input", source.id)?.user_input;
  const stageHasContext = receipts.some(receipt => {
    if (receipt.state !== "delivered" || receipt.user_input) return false;
    const prior = store.get<Run>("run", receipt.run_id);
    if (!prior) return false;
    // A guidance turn can add a new continuation source without changing the
    // role, repair assignment or review phase that was previously initialized.
    return inputStageKey({...prior, dispatch_context: {...prior.dispatch_context,
      purpose: prior.dispatch_context?.purpose ?? prior.purpose ?? "implement",
      source_run_id: run.dispatch_context?.source_run_id}}) === inputStageKey(run);
  });
  if ((continuation && (!source || source.purpose === run.purpose) && (!sourceWasGuidance || stageHasContext)) ||
      run.dispatch_context?.guidance_mode === "human_acceptance") return true;
  // A planning revision produced by the preceding turn is still the same
  // planning conversation; feedback does not create a new planning stage.
  if (run.purpose === "planning" && messages.length && store.list<Run>("run", run.workflow_id)
    .some(prior => prior.id !== run.id && prior.purpose === "planning" && prior.conversation_id === conversationId)) return true;
  const key = inputStageKey(run);
  const stageReceipts = receipts.filter(receipt => receipt.stage_key === key && !receipt.user_input);
  if (stageReceipts.some(receipt => receipt.state === "delivered")) return true;
  if (stageReceipts.some(receipt => receipt.state === "started"))
    throw new FlowError("INPUT_DELIVERY_UNKNOWN", "上次阶段输入的投递结果尚未确认，未重新发送任务", 409);
  return store.list<Run>("run", run.workflow_id).some(prior => prior.id !== run.id &&
    prior.conversation_id === conversationId && inputStageKey(prior) === key &&
    !store.get("session_input", prior.id));
}

export function followupText(store: Store, run: Run, messages: Pick<FeedbackMessage, "text">[]): string {
  const userInput = runUserInputText(store, run, messages);
  if (userInput !== undefined) return userInput;
  const continuation = boundConversationContinuation(store, run);
  if (continuation?.kind === "intent_clarification")
    return "请说明刚才的结果是已完成、需要用户补充、需要规划调整还是遇到阻塞，并返回当前阶段约定的结果。";
  return "继续";
}

/** One CLI turn owns one unmodified user message, even across stage/tool changes. */
export function selectRunInputMessages(store: Store, workflowId: string, run: Run): FeedbackMessage[] {
  const waiting = pendingRunMessages(store, workflowId, run);
  for (const deferred of waiting.slice(1)) {
    store.put("feedback_message", deferred.message_id, workflowId,
      { ...deferred, status: "pending", ack_run: undefined });
  }
  return waiting.slice(0, 1);
}

export function runUserInputText(store: Store, run: Run, messages: Pick<FeedbackMessage, "text">[]): string | undefined {
  if (run.purpose === "aside") return undefined;
  if (messages.length) return messages[0]!.text;
  const continuation = boundConversationContinuation(store, run);
  if (continuation?.kind === "user_answer" && continuation.answer !== undefined) return continuation.answer;
  return undefined;
}
