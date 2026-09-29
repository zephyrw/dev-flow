import type { Run, Workflow } from "../../contracts/src/index.js";
import { CONVERSATION_ENTITY, type ConversationNode, type ConversationAttempt } from "../../contracts/src/conversation.js";
import type { Store } from "../../store/src/store.js";
import { now, redact } from "./util.js";
import type { ExecutionIntent, ReviewIntent } from "./round-intent.js";
import type {
  PlanningHandoff,
  RunContinuation,
} from "../../contracts/src/tr-handoff.js";

export type WaitingPurpose = "execute" | "review" | "planning";
export type WaitingRole = "executor" | "planner";

export interface WaitingContext {
  purpose: WaitingPurpose;
  role: WaitingRole;
  phase?: string;
  run_id?: string;
  conversation_id?: string;
  session_id?: string;
  source_execution_run_id?: string;
  original_text?: string;
  continuation?: boolean;
  intent: ExecutionIntent | ReviewIntent;
  questions?: string[];
  interaction_id?: string;
  created_at: string;
}

export interface ExecutionCompletion {
  run_id: string;
  workflow_id: string;
  intent: "completed";
  assignment_id?: string;
  source_review_id?: string;
  phase?: string;
  summary?: string;
  /** 规划提交结果中的仓库/commit 信息，供 Git 集成使用。 */
  repositories?: Array<{ repo_id: string; commit: string }>;
  recorded_at: string;
}

export function saveWaitingContext(
  store: Store,
  workflowId: string,
  context: Omit<WaitingContext, "created_at"> & { created_at?: string },
) {
  const record: WaitingContext = {
    ...context,
    created_at: context.created_at ?? now(),
  };
  store.put("waiting_context", workflowId, workflowId, record);
  return record;
}

export function readWaitingContext(store: Store, workflowId: string) {
  return store.get<WaitingContext>("waiting_context", workflowId);
}

export function clearWaitingContext(store: Store, workflowId: string) {
  store.remove("waiting_context", workflowId);
}

export function recordExecutionCompletion(
  store: Store,
  completion: ExecutionCompletion,
) {
  store.put(
    "execution_completion",
    completion.run_id,
    completion.workflow_id,
    completion,
  );
  return completion;
}

export function readExecutionCompletion(store: Store, runId: string) {
  return store.get<ExecutionCompletion>("execution_completion", runId);
}

/** Display the executor's handoff; service startup and acceptance remain model/user work. */
export function humanAcceptanceSummary(store: Store, workflow: Workflow) {
  if (workflow.state !== "HUMAN_PENDING") return null;
  const completion = store.list<ExecutionCompletion>("execution_completion", workflow.id)
    .filter((item) => {
      const run = store.get<Run>("run", item.run_id);
      return item.workflow_id === workflow.id && item.intent === "completed" &&
        !!item.summary?.trim() && run?.workflow_id === workflow.id &&
        run.plan_revision === workflow.plan_revision && run.status === "completed" &&
        ["implement", "executor_test", "functional_fix"].includes(run.purpose ?? "implement");
    })
    .sort((a, b) => b.recorded_at.localeCompare(a.recorded_at))[0];
  return completion ? { run_id: completion.run_id, summary: redact(completion.summary!) } : null;
}

export function saveRunContinuation(
  store: Store,
  key: string,
  owner: string,
  continuation: RunContinuation,
) {
  store.put("run_continuation", key, owner, continuation);
  return continuation;
}

export function readRunContinuation(store: Store, key: string) {
  return store.get<RunContinuation>("run_continuation", key);
}

export function clearRunContinuation(store: Store, key: string) {
  store.remove("run_continuation", key);
}

export function savePlanningHandoff(
  store: Store,
  workflowId: string,
  handoff: PlanningHandoff,
) {
  store.put("planning_handoff", workflowId, workflowId, handoff);
  store.put("planning_handoff_record", handoff.handoff_id, workflowId, handoff);
  return handoff;
}

export function readPlanningHandoff(store: Store, workflowId: string) {
  return store.get<PlanningHandoff>("planning_handoff", workflowId);
}

export function continuationFromWaiting(
  waiting: WaitingContext,
  extras?: { kind?: RunContinuation["kind"]; answer?: string },
): RunContinuation {
  const kind =
    extras?.kind ??
    (waiting.intent === "need_user" || extras?.answer
      ? "user_answer"
      : waiting.intent === "unclear" || waiting.continuation
        ? "intent_clarification"
        : "runtime_resume");
  return {
    kind,
    source_run_id: waiting.run_id ?? waiting.source_execution_run_id ?? "",
    purpose: waiting.purpose,
    role: waiting.role,
    phase: waiting.phase,
    conversation_id: waiting.conversation_id,
    original_text: waiting.original_text,
    questions: waiting.questions,
    ...(extras?.answer ? { answer: extras.answer } : {}),
  };
}

export function continuationFromHandoff(
  handoff: PlanningHandoff,
): RunContinuation {
  return {
    kind: "runtime_resume",
    source_run_id: handoff.source_run_id,
    purpose: "planning",
    role: "planner",
    original_text: handoff.original_text,
    questions: handoff.questions,
  };
}

export function waitingBelongsToRun(
  waiting: WaitingContext,
  runId?: string,
  continuation?: RunContinuation,
) {
  if (!runId) return false;
  if (waiting.run_id === runId) return true;
  if (waiting.source_execution_run_id === runId) return true;
  if (continuation?.source_run_id && waiting.run_id === continuation.source_run_id)
    return true;
  return false;
}

export function isPlanningWaiting(waiting: WaitingContext) {
  return waiting.purpose === "planning" || waiting.intent === "need_planner";
}

export function isOpenPlanningHandoff(
  handoff?: PlanningHandoff,
): handoff is PlanningHandoff {
  return !!handoff && ["pending", "assigned"].includes(handoff.status);
}

export function isPlanningRun(run?: { purpose?: string; stage?: string }) {
  return run?.stage === "planning" || run?.purpose === "planning";
}

export function isSubsequentExecuteRun(run?: {
  purpose?: string;
  stage?: string;
}) {
  if (!run) return false;
  if (run.purpose === "implement" || run.purpose === "planner_takeover")
    return true;
  if (run.stage === "execute" || run.stage === "planner_takeover") return true;
  return false;
}

export function isReviewRole(
  continuation?: Pick<RunContinuation, "purpose">,
  run?: { purpose?: string; stage?: string },
) {
  if (continuation?.purpose === "review") return true;
  if (run?.purpose === "quality_review") return true;
  if (run?.stage === "review" || run?.stage === "quality_before_human")
    return true;
  return false;
}

export function boundRunContinuation(store: Store, runId?: string) {
  if (!runId) return;
  const run = store.get<{ continuation?: RunContinuation }>("run", runId);
  return run?.continuation ?? readRunContinuation(store, runId);
}

export function isCurrentPlanningSource(input: {
  handoff?: PlanningHandoff;
  waiting?: WaitingContext;
  state?: string;
  blockerCode?: string;
  runId?: string;
  run?: { purpose?: string; stage?: string };
}) {
  const open = isOpenPlanningHandoff(input.handoff);
  if (!open && !(input.waiting && isPlanningWaiting(input.waiting)))
    return false;
  if (input.state === "PLANNING" || input.blockerCode === "NEED_PLANNER")
    return true;
  if (isPlanningRun(input.run)) return true;
  if (open && input.handoff?.target_run_id === input.runId) return true;
  return false;
}

export function preserveWaitingOwnership(
  waiting: WaitingContext,
): RunContinuation {
  return {
    ...continuationFromWaiting(waiting, { kind: "runtime_resume" }),
    purpose: waiting.purpose,
    role: waiting.role,
    phase: waiting.phase,
    conversation_id: waiting.conversation_id,
    source_run_id:
      waiting.run_id ?? waiting.source_execution_run_id ?? "",
  };
}

export function continuationForRecovery(
  waiting: WaitingContext | undefined,
  fallback: {
    source_run_id: string;
    purpose: WaitingPurpose;
    role: WaitingRole;
    phase?: string;
    conversation_id?: string;
  },
): RunContinuation {
  if (waiting && waitingBelongsToRun(waiting, fallback.source_run_id) &&
      waiting.purpose === fallback.purpose && waiting.role === fallback.role)
    return { ...preserveWaitingOwnership(waiting), source_run_id: fallback.source_run_id };
  return {
    kind: "runtime_resume",
    source_run_id: fallback.source_run_id,
    purpose: fallback.purpose,
    role: fallback.role,
    phase: fallback.phase,
    conversation_id: fallback.conversation_id,
  };
}

export function waitingPurposeFromRun(
  purpose?: string,
  stage?: string,
  continuation?: RunContinuation,
): { purpose: WaitingPurpose; role: WaitingRole; phase?: string } {
  if (continuation) {
    return {
      purpose: continuation.purpose,
      role: continuation.role,
      phase: continuation.phase ?? reviewPhaseOf(stage),
    };
  }
  if (purpose === "planning")
    return { purpose: "planning", role: "planner" };
  if (purpose === "quality_review") {
    return {
      purpose: "review",
      role: "planner",
      phase: reviewPhaseOf(stage) ?? "before_human",
    };
  }
  if (purpose === "planner_takeover" || purpose === "planner_commit")
    return { purpose: "execute", role: "planner", phase: stage };
  return { purpose: "execute", role: "executor", phase: stage };
}

function reviewPhaseOf(stage?: string): string | undefined {
  if (!stage) return undefined;
  if (stage === "before_human" || stage === "quality_before_human")
    return "before_human";
  if (stage === "after_human" || stage === "quality_after_human")
    return "after_human";
  return stage === "review" ? "after_human" : undefined;
}

/** Single admission rule for staged, waiting and bound continuation inputs. */
export function currentContinuation(
  store: Store, workflowId: string, candidate: RunContinuation | undefined,
  expected: { purpose?: WaitingPurpose; role?: WaitingRole; root_id?: string; generation?: number } = {},
): RunContinuation | undefined {
  const workflow = store.get<Workflow>("workflow", workflowId);
  if (!candidate || !workflow?.run_id || !candidate.source_run_id ||
    (expected.purpose && candidate.purpose !== expected.purpose) ||
    (expected.role && candidate.role !== expected.role)) return;
  const waiting = readWaitingContext(store, workflowId);
  const chain = new Set<string>();
  let runId: string | undefined = workflow.run_id;
  let boundParent: RunContinuation | undefined;
  const currentRun = store.get<Run>("run", workflow.run_id);
  while (runId && !chain.has(runId)) {
    const run: Run | undefined = store.get<Run>("run", runId);
    if (!run || run.workflow_id !== workflowId || run.plan_revision !== workflow.plan_revision ||
      run.status === "cancelled" || run.status === "superseded" ||
      store.get("run_continuation_superseded", run.id) || readExecutionCompletion(store, run.id)) return;
    const pendingAnswer = waiting && (waiting.run_id ?? waiting.source_execution_run_id) === run.id &&
      waiting.purpose === candidate.purpose && waiting.role === candidate.role &&
      (waiting.intent === "need_user" || waiting.intent === "unclear" || waiting.continuation);
    // A persisted successor binding remains authoritative after waiting_context
    // was consumed. Only ancestors reached through that binding get this exception;
    // a successful current Run cannot revive its old staged answer.
    const consumedAnswer = boundParent?.source_run_id === run.id &&
      boundParent.purpose === candidate.purpose && boundParent.role === candidate.role;
    if ((run.status === "completed" || run.exit_code === 0) && !pendingAnswer && !consumedAnswer) return;
    chain.add(run.id);
    if (run.id === candidate.source_run_id) {
      const owner = waitingPurposeFromRun(run.purpose, run.stage);
      if (owner.purpose !== candidate.purpose || owner.role !== candidate.role ||
        (candidate.purpose === "review" && candidate.phase && owner.phase && candidate.phase !== owner.phase)) return;
      const conversationId = candidate.conversation_id ?? expected.root_id ?? run.conversation_id;
      if (conversationId) {
        // Native Run/session IDs and internal tree node IDs are both persisted.
        const matches = store.list<ConversationNode>(CONVERSATION_ENTITY.node, workflowId)
          .filter((item) => item.id === conversationId || item.native_session_id === conversationId || item.native_agent_id === conversationId);
        // A native session can back multiple stage nodes. Attribute it using
        // the current attempt's Run, not global uniqueness of the native ID.
        const owned = matches.filter(item => {
          const attempt = item.current_attempt_id
            ? store.get<ConversationAttempt>(CONVERSATION_ENTITY.attempt, item.current_attempt_id) : undefined;
          return attempt?.run_id && chain.has(attempt.run_id);
        });
        const node = owned.length === 1 ? owned[0] : undefined;
        if (currentRun?.conversation_id) {
          const currentNodes = store.list<ConversationNode>(CONVERSATION_ENTITY.node, workflowId)
            .filter((item) => item.id === currentRun.conversation_id || item.native_session_id === currentRun.conversation_id);
          if (!node || !currentNodes.some(item => item.id === node.id)) return;
        }
        if (expected.root_id && node?.id !== expected.root_id) return;
        const attempt = node?.current_attempt_id
          ? store.get<ConversationAttempt>(CONVERSATION_ENTITY.attempt, node.current_attempt_id) : undefined;
        if (!node || node.workflow_id !== workflowId || !attempt || !attempt.run_id || !chain.has(attempt.run_id) ||
          (expected.generation !== undefined && attempt.generation !== expected.generation)) return;
      }
      return candidate;
    }
    boundParent = run.continuation;
    runId = boundParent?.source_run_id;
  }
}
