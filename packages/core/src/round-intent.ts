import type {
  IntentSource,
  PlanningHandoff,
  RunContinuation,
} from "../../contracts/src/tr-handoff.js";

export type ExecutionIntent =
  | "completed"
  | "need_planner"
  | "need_user"
  | "unclear";
export type ReviewIntent =
  | "passed"
  | "changes_required"
  | "need_user"
  | "unclear";
export type { IntentSource };

export const INTENT_CLARIFICATION_INSTRUCTION = "请补充刚才这轮的结果意图";

const COMPLETED = new Set([
  "completed",
  "complete",
  "done",
  "success",
  "passed",
  "pass",
]);
const NEED_PLANNER = new Set([
  "need_planner",
  "planner",
  "design_conflict",
  "conflict",
]);
const NEED_USER = new Set([
  "need_user",
  "waiting_input",
  "ask_user",
  "blocked_on_user",
]);
const REVIEW_PASSED = new Set(["passed", "pass", "quality_pass"]);
const REVIEW_CHANGES = new Set([
  "changes_required",
  "findings",
  "rejected",
  "fail",
  "failed",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function lower(value: unknown): string {
  return text(value)?.toLowerCase() ?? "";
}

function questionsOf(value: Record<string, unknown> | undefined): string[] {
  const raw = value?.unresolved_questions;
  return Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === "string" && !!item.trim())
    : [];
}

function recognizedExecutionIntent(
  status?: string,
): ExecutionIntent | undefined {
  const key = lower(status);
  if (!key) return undefined;
  if (COMPLETED.has(key)) return "completed";
  if (NEED_PLANNER.has(key)) return "need_planner";
  if (NEED_USER.has(key)) return "need_user";
  return "unclear";
}

function intentField(rec: Record<string, unknown> | undefined) {
  return rec ? text(rec.status) ?? text(rec.verdict) : undefined;
}

function nonEmptyEntries(value: unknown) {
  return Array.isArray(value) && value.length > 0;
}

function hasSubmittedWork(rec: Record<string, unknown>) {
  const nested = asRecord(rec.delivery);
  return (
    nonEmptyEntries(rec.implementations) ||
    nonEmptyEntries(rec.test_executions) ||
    nonEmptyEntries(nested?.implementations) ||
    nonEmptyEntries(nested?.test_executions)
  );
}

export type NormalizedExecution = {
  intent: ExecutionIntent;
  status?: string;
  summary?: string;
  notes?: string;
  artifacts?: unknown[];
  payload: Record<string, unknown>;
  intent_source: IntentSource;
  provided_intent_field: boolean;
};

function withCopy(
  rec: Record<string, unknown>,
  nested: Record<string, unknown> | undefined,
  intent: ExecutionIntent,
  status: string | undefined,
  intent_source: IntentSource,
  provided_intent_field: boolean,
): NormalizedExecution {
  const artifacts = Array.isArray(rec.artifacts)
    ? rec.artifacts
    : Array.isArray(nested?.artifacts)
      ? nested.artifacts
      : undefined;
  return {
    intent,
    status,
    summary: text(rec.summary) ?? text(nested?.summary),
    notes: text(rec.notes) ?? text(nested?.notes),
    artifacts,
    payload: rec,
    intent_source,
    provided_intent_field,
  };
}

export function normalizeExecutionIntent(value: unknown): NormalizedExecution {
  const rec = asRecord(value);
  if (!rec)
    return {
      intent: "unclear",
      payload: {},
      intent_source: "missing",
      provided_intent_field: false,
    };
  const nested = asRecord(rec.delivery);
  const outerStatus = intentField(rec);
  const nestedStatus = intentField(nested);
  if (outerStatus)
    return withCopy(
      rec,
      nested,
      recognizedExecutionIntent(outerStatus) ?? "unclear",
      outerStatus,
      "outer",
      true,
    );
  if (nestedStatus)
    return withCopy(
      rec,
      nested,
      recognizedExecutionIntent(nestedStatus) ?? "unclear",
      nestedStatus,
      "nested",
      true,
    );
  return withCopy(rec, nested, "unclear", undefined, "missing", false);
}

export function normalizeDeliveredRound(
  value: unknown,
  options?: { deliverySubmit?: boolean },
) {
  const normalized = normalizeExecutionIntent(value);
  if (normalized.provided_intent_field) return normalized;
  if (options?.deliverySubmit && hasSubmittedWork(normalized.payload))
    return {
      ...normalized,
      intent: "completed" as const,
      intent_source: "legacy_submit" as const,
    };
  return normalized;
}

export function asRunContinuation(value: unknown): RunContinuation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const kind = (value as RunContinuation).kind;
  if (
    kind === "intent_clarification" ||
    kind === "user_answer" ||
    kind === "runtime_resume"
  )
    return value as RunContinuation;
  return undefined;
}

export function applyContinuationMaterials(
  fullMaterials: Record<string, unknown>,
  continuation?: RunContinuation,
): Record<string, unknown> {
  if (!continuation) return fullMaterials;
  if (continuation.kind === "intent_clarification") {
    const result: Record<string, unknown> = {
      instructions: INTENT_CLARIFICATION_INSTRUCTION,
      original_text: continuation.original_text,
      kind: continuation.kind,
      source_run_id: continuation.source_run_id,
      purpose: continuation.purpose,
      role: continuation.role,
    };
    if (fullMaterials.approved_execution_instructions) {
      result.approved_execution_instructions =
        fullMaterials.approved_execution_instructions;
    }
    return result;
  }
  if (continuation.kind === "user_answer")
    return {
      ...fullMaterials,
      questions: continuation.questions,
      answer: continuation.answer,
    };
  return fullMaterials;
}

export function applyPlanningHandoffMaterials(
  materials: Record<string, unknown>,
  handoff?: PlanningHandoff,
): Record<string, unknown> {
  if (!handoff) return materials;
  if (handoff.status !== "pending" && handoff.status !== "assigned")
    return materials;
  return {
    ...materials,
    original_text: handoff.original_text,
    summary: handoff.summary,
    notes: handoff.notes,
    questions: handoff.questions,
    source_execution: {
      run_id: handoff.source_run_id,
      role: handoff.source_role,
      conversation_id: handoff.source_conversation_id,
      plan_revision: handoff.plan_revision,
    },
  };
}

export function selectConversationToResume(input: {
  purpose: string;
  continuation?: Pick<RunContinuation, "conversation_id">;
  planningSession?: { id: string };
  defaultSession?: { id: string };
}): { id: string } | undefined {
  if (input.purpose === "aside") return undefined;
  if (input.purpose === "planning") return input.planningSession;
  if (input.continuation?.conversation_id)
    return { id: input.continuation.conversation_id };
  // 独立审查无 continuation 时开新会话，不继承旧审查/执行会话。
  // 规划侧会话可续接（quality_review/planner_takeover/planner_commit 同属规划职责组）。
  if (
    input.purpose === "quality_review" ||
    input.purpose === "planner_takeover" ||
    input.purpose === "planner_commit"
  )
    return input.planningSession;
  return input.defaultSession;
}

export function continuationSessionRequired(
  purpose: string,
  continuation?: RunContinuation,
) {
  if (purpose === "planning" || purpose === "aside") return false;
  return (
    continuation?.kind === "intent_clarification" ||
    continuation?.kind === "user_answer"
  );
}

function hasConfirmedCodeFindings(payload: Record<string, unknown>) {
  const findings = Array.isArray(payload.findings) ? payload.findings : [];
  return findings.some((item) => {
    const finding = asRecord(item);
    return (
      finding?.disposition === "confirmed" &&
      ["introduced", "in_scope"].includes(
        String(finding.relation_to_change ?? ""),
      )
    );
  });
}

export function normalizeReviewIntent(value: unknown): {
  intent: ReviewIntent;
  verdict?: string;
  questions: string[];
  payload: Record<string, unknown>;
} {
  const rec = asRecord(value) ?? {};
  const quality = asRecord(rec.quality);
  const verdict =
    text(rec.verdict) ?? text(quality?.verdict) ?? text(rec.status);
  const questions = [
    ...questionsOf(rec),
    ...questionsOf(quality),
  ];
  const key = lower(verdict);
  let intent: ReviewIntent = "unclear";
  if (questions.length) intent = "need_user";
  else if (REVIEW_PASSED.has(key) && hasConfirmedCodeFindings(rec))
    intent = "changes_required";
  else if (REVIEW_PASSED.has(key)) intent = "passed";
  else if (REVIEW_CHANGES.has(key)) intent = "changes_required";
  else if (NEED_USER.has(key)) intent = "need_user";
  return { intent, verdict, questions, payload: rec };
}

export function reviewIdentity(payload: Record<string, unknown>) {
  const quality = asRecord(payload.quality);
  const findings = [
    ...(Array.isArray(payload.findings) ? payload.findings : []),
    ...(Array.isArray(quality?.findings) ? quality.findings : []),
  ]
    .map((item) => asRecord(item)?.finding_id)
    .filter((id): id is string => typeof id === "string")
    .sort();
  return {
    intent: normalizeReviewIntent(payload).intent,
    summary: payload.summary ?? quality?.summary,
    notes: payload.notes ?? quality?.notes,
    findings,
    repair: payload.repair_document ?? quality?.repair_plan,
  };
}
