import type { Store } from "../../store/src/store.js";
import { now } from "./util.js";
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
  if (waiting) return preserveWaitingOwnership(waiting);
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
  if (purpose === "planner_takeover")
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
