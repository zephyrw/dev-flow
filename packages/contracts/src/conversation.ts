import { z } from "zod";
import { Id } from "./base.js";

export const CONVERSATION_ENTITY = {
  node: "conversation_node",
  attempt: "conversation_attempt",
  binding: "conversation_binding",
  cursor: "conversation_cursor",
  control: "conversation_control",
  recovery: "conversation_recovery",
  file: "conversation_file",
  message: "conversation_message",
  projectAsideIndex: "project_aside_index",
  projectAsideCursor: "project_aside_cursor",
} as const;

export const CONVERSATION_EVENT = {
  discovered: "ConversationDiscovered",
  updated: "ConversationUpdated",
  activity: "ConversationActivity",
  controlUpdated: "ConversationControlUpdated",
  asideUpdated: "AsideUpdated",
} as const;

export const CONVERSATION_ERROR = {
  NOT_FOUND: "NOT_FOUND",
  CONVERSATION_NOT_IN_WORKFLOW: "CONVERSATION_NOT_IN_WORKFLOW",
  INVALID_CURSOR: "INVALID_CURSOR",
  STALE_ROOT: "STALE_ROOT",
  VERSION_CONFLICT: "VERSION_CONFLICT",
  STOP_UNCONFIRMED: "STOP_UNCONFIRMED",
  EMPTY_MESSAGE: "EMPTY_MESSAGE",
  EMPTY_QUESTION: "EMPTY_QUESTION",
  INPUT_UNSUPPORTED: "INPUT_UNSUPPORTED",
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  FILE_NOT_READY: "FILE_NOT_READY",
  FILE_IN_USE: "FILE_IN_USE",
  FILE_SCOPE_MISMATCH: "FILE_SCOPE_MISMATCH",
  ASIDE_NOT_IN_PROJECT: "ASIDE_NOT_IN_PROJECT",
  ASIDE_NOT_IN_WORKFLOW: "ASIDE_NOT_IN_WORKFLOW",
  INPUT_READ_SCOPE_UNSUPPORTED: "INPUT_READ_SCOPE_UNSUPPORTED",
} as const;

export const ConversationStatusSchema = z.enum([
  "discovered",
  "starting",
  "running",
  "waiting",
  "pausing",
  "paused",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "unknown",
]);
export type ConversationStatus = z.infer<typeof ConversationStatusSchema>;

export const WORKING_CONVERSATION_STATUSES: ConversationStatus[] = [
  "starting",
  "running",
];

export const ConversationKindSchema = z.enum(["main", "subagent", "aside"]);
export type ConversationKind = z.infer<typeof ConversationKindSchema>;

export const ConversationAttemptReasonSchema = z.enum([
  "user_pause",
  "quota",
  "process_exit",
  "parent_exit",
  "service_restart",
  "permission",
  "native_error",
  "unknown",
]);
export type ConversationAttemptReason = z.infer<
  typeof ConversationAttemptReasonSchema
>;

export const ConversationFreshnessSchema = z.enum([
  "fresh",
  "stale",
  "unavailable",
]);
export type ConversationFreshness = z.infer<typeof ConversationFreshnessSchema>;

export const StopConfirmationSchema = z.enum([
  "native",
  "owned_process_tree",
  "unconfirmed",
]);
export type StopConfirmation = z.infer<typeof StopConfirmationSchema>;

export const ConversationNodeSchema = z
  .object({
    id: Id,
    project_id: Id,
    workflow_id: Id,
    root_id: Id,
    parent_id: Id.optional(),
    kind: ConversationKindSchema,
    adapter_id: z.string().min(1),
    native_session_id: z.string().min(1).optional(),
    native_agent_id: z.string().min(1).optional(),
    native_parent_session_id: z.string().min(1).optional(),
    spawn_call_id: z.string().min(1).optional(),
    title: z.string().min(1).max(200),
    task_summary: z.string().max(500).optional(),
    purpose: z.string().min(1),
    lineage_id: z.string().min(1),
    current_attempt_id: Id.optional(),
    replaces_conversation_id: Id.optional(),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
  })
  .strict();
export type ConversationNode = z.infer<typeof ConversationNodeSchema>;

export const ConversationAttemptSchema = z
  .object({
    id: Id,
    conversation_id: Id,
    root_id: Id,
    workflow_id: Id,
    run_id: Id,
    generation: z.number().int().nonnegative(),
    status: ConversationStatusSchema,
    reason: ConversationAttemptReasonSchema.optional(),
    requested_model: z.string().optional(),
    actual_model: z.string().optional(),
    requested_effort: z.string().optional(),
    actual_effort: z.string().optional(),
    model_source: z.enum(["native_event", "native_session"]).optional(),
    activity_summary: z.string().max(500).optional(),
    observed_at: z.string().min(1),
    activity_at: z.string().optional(),
    terminal_at: z.string().optional(),
    source_cursor: z.string().optional(),
    freshness: ConversationFreshnessSchema.default("fresh"),
    stop_confirmation: StopConfirmationSchema.optional(),
    recovery_id: Id.optional(),
  })
  .strict();
export type ConversationAttempt = z.infer<typeof ConversationAttemptSchema>;

export const ConversationBindingSchema = z
  .object({
    id: z.string().min(1),
    workflow_id: Id,
    adapter_id: z.string().min(1),
    scope: z.string().min(1),
    lineage_id: z.string().min(1),
    native_session_id: z.string().optional(),
    native_agent_id: z.string().optional(),
    conversation_id: Id,
    created_at: z.string().min(1),
  })
  .strict();
export type ConversationBinding = z.infer<typeof ConversationBindingSchema>;

export const ConversationCursorSchema = z
  .object({
    id: z.string().min(1),
    workflow_id: Id,
    adapter_id: z.string().min(1),
    source_id: z.string().min(1),
    conversation_id: Id.optional(),
    source_seq: z.string().min(1),
    file_identity: z.string().optional(),
    applied_at: z.string().min(1),
  })
  .strict();
export type ConversationCursor = z.infer<typeof ConversationCursorSchema>;

export const ConversationControlActionSchema = z.enum(["pause", "resume"]);
export const ConversationControlStatusSchema = z.enum([
  "pending",
  "partial",
  "complete",
]);

export const ConversationControlTargetSchema = z
  .object({
    conversation_id: Id,
    attempt_id: Id.optional(),
    native_session_id: z.string().optional(),
    native_agent_id: z.string().optional(),
    confirmation: StopConfirmationSchema.optional(),
    status: ConversationStatusSchema.optional(),
  })
  .strict();

export const ConversationControlSchema = z
  .object({
    id: Id,
    workflow_id: Id,
    request_id: z.string().min(1),
    action: ConversationControlActionSchema,
    root_id: Id,
    expected_generation: z.number().int().nonnegative(),
    status: ConversationControlStatusSchema,
    targets: z.array(ConversationControlTargetSchema).default([]),
    unconfirmed_count: z.number().int().nonnegative().default(0),
    recovery_id: Id.optional(),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
  })
  .strict();
export type ConversationControl = z.infer<typeof ConversationControlSchema>;

export const RecoveryContinuationSchema = z.enum([
  "resume-native",
  "recreate-after-confirmed-exit",
]);

export const RecoveryPendingChildSchema = z
  .object({
    conversation_id: Id,
    parent_id: Id,
    native_session_id: z.string().optional(),
    native_agent_id: z.string().optional(),
    task_summary: z.string().max(500),
    last_status: ConversationStatusSchema,
    interruption_reason: z.string().optional(),
    last_activity: z.string().optional(),
    requested_model: z.string().optional(),
    actual_model: z.string().optional(),
    effort: z.string().optional(),
    workspace_refs: z.array(z.string()).default([]),
    unfinished_task_ids: z.array(z.string()).default([]),
    continuation: RecoveryContinuationSchema,
  })
  .strict();
export type RecoveryPendingChild = z.infer<typeof RecoveryPendingChildSchema>;

export const RecoveryManifestSchema = z
  .object({
    recovery_id: Id,
    workflow_id: Id,
    root_conversation_id: Id,
    source_run_id: Id,
    target_run_id: Id,
    reason: z.enum(["user_resume", "quota_retry", "service_recovery"]),
    purpose: z.string().min(1),
    pending_children: z.array(RecoveryPendingChildSchema).default([]),
    completed_children: z
      .array(
        z
          .object({
            conversation_id: Id,
            summary: z.string().max(500),
          })
          .strict(),
      )
      .default([]),
    cancelled_children: z.array(Id).default([]),
    stage: z.enum(["prepared", "delivered", "observed", "partial"]).default(
      "prepared",
    ),
    delivered_count: z.number().int().nonnegative().optional(),
    observed_count: z.number().int().nonnegative().optional(),
  })
  .strict();
export type RecoveryManifest = z.infer<typeof RecoveryManifestSchema>;

export const ConversationActivityPayloadSchema = z
  .object({
    conversation_id: Id,
    attempt_id: Id,
    root_id: Id,
    activity_id: z.string().min(1),
    source_event_id: z.string().min(1),
    public_text: z.string().max(16000).optional(),
    title: z.string().max(200).optional(),
    status: ConversationStatusSchema.optional(),
    kind: z.enum(["tool", "message", "event", "separator"]).optional(),
    command: z.string().max(32000).optional(),
    replaces_conversation_id: Id.optional(),
  })
  .strict();
export type ConversationActivityPayload = z.infer<
  typeof ConversationActivityPayloadSchema
>;

export function conversationActivityKey(
  conversationId: string,
  attemptId: string,
  activityId: string,
): string {
  return `${conversationId}:${attemptId}:${activityId}`;
}

export function isWorkingConversationStatus(
  status: ConversationStatus,
): boolean {
  return status === "starting" || status === "running";
}

export function isTerminalConversationStatus(
  status: ConversationStatus,
): boolean {
  return (
    status === "completed" ||
    status === "cancelled" ||
    status === "failed" ||
    status === "interrupted" ||
    status === "paused"
  );
}

export function canReenterConversationStatus(
  status: ConversationStatus,
): boolean {
  return (
    status === "paused" ||
    status === "interrupted" ||
    status === "failed"
  );
}

export type ConversationParentIssue =
  | "self_reference"
  | "cross_root"
  | "cycle"
  | "missing_parent";

export function conversationParentIssue(
  node: Pick<ConversationNode, "id" | "root_id" | "parent_id">,
  known: Iterable<Pick<ConversationNode, "id" | "root_id" | "parent_id">>,
): ConversationParentIssue | undefined {
  if (!node.parent_id) return undefined;
  if (node.parent_id === node.id) return "self_reference";
  const byId = new Map<string, Pick<ConversationNode, "id" | "root_id" | "parent_id">>();
  for (const item of known) byId.set(item.id, item);
  const parent = byId.get(node.parent_id);
  if (!parent) return "missing_parent";
  if (parent.root_id !== node.root_id) return "cross_root";
  const seen = new Set<string>([node.id]);
  let cursor: string | undefined = node.parent_id;
  while (cursor) {
    if (seen.has(cursor)) return "cycle";
    seen.add(cursor);
    cursor = byId.get(cursor)?.parent_id;
  }
  return undefined;
}

export const SubagentDiscoverySchema = z.enum([
  "native",
  "scoped-record",
  "unavailable",
  "unknown",
]);
export const SubagentActivitySchema = z.enum([
  "native",
  "scoped-record",
  "summary-only",
  "unavailable",
]);
export const SubagentStopSchema = z.enum([
  "native",
  "owned-process-tree",
  "unavailable",
]);
export const SubagentResumeSchema = z.enum([
  "native",
  "parent-instruction",
  "unavailable",
]);
export const ReadonlyDelegationSchema = z.enum([
  "verified",
  "unsupported",
  "unknown",
]);

export const FileInputCapabilitySchema = z
  .object({
    text: z.boolean(),
    image: z.boolean(),
    binary: z.boolean(),
  })
  .strict();

export const SubagentCapabilitiesSchema = z
  .object({
    discovery: SubagentDiscoverySchema.default("unknown"),
    activity: SubagentActivitySchema.default("unavailable"),
    stop: SubagentStopSchema.default("unavailable"),
    resume: SubagentResumeSchema.default("unavailable"),
    readonly_delegation: ReadonlyDelegationSchema.default("unknown"),
    file_input: FileInputCapabilitySchema.default({
      text: false,
      image: false,
      binary: false,
    }),
    cli_version: z.string().optional(),
    reason: z.string().optional(),
  })
  .strict();
export type SubagentCapabilities = z.infer<typeof SubagentCapabilitiesSchema>;

export function unknownSubagentCapabilities(
  reason?: string,
): SubagentCapabilities {
  return SubagentCapabilitiesSchema.parse({
    discovery: "unknown",
    activity: "unavailable",
    stop: "unavailable",
    resume: "unavailable",
    readonly_delegation: "unknown",
    file_input: { text: false, image: false, binary: false },
    reason,
  });
}

export const ConversationTreeSnapshotSchema = z
  .object({
    nodes: z.array(ConversationNodeSchema).default([]),
    attempts: z.array(ConversationAttemptSchema).default([]),
    active_root_id: Id.optional(),
    capabilities: SubagentCapabilitiesSchema,
    cursor: z.number().int().nonnegative(),
  })
  .strict();
export type ConversationTreeSnapshot = z.infer<
  typeof ConversationTreeSnapshotSchema
>;

export const ConversationWorkCountsSchema = z
  .object({
    working: z.number().int().nonnegative(),
    waiting: z.number().int().nonnegative(),
    pausing: z.number().int().nonnegative(),
    paused: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    interrupted: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    stale: z.number().int().nonnegative(),
  })
  .strict();
export type ConversationWorkCounts = z.infer<
  typeof ConversationWorkCountsSchema
>;

export function emptyConversationWorkCounts(): ConversationWorkCounts {
  return {
    working: 0,
    waiting: 0,
    pausing: 0,
    paused: 0,
    failed: 0,
    interrupted: 0,
    unknown: 0,
    completed: 0,
    stale: 0,
  };
}

export function countConversationWork(
  attempts: Array<Pick<ConversationAttempt, "conversation_id" | "status" | "freshness">>,
): ConversationWorkCounts {
  const latest = new Map<string, Pick<ConversationAttempt, "status" | "freshness">>();
  for (const attempt of attempts) latest.set(attempt.conversation_id, attempt);
  const counts = emptyConversationWorkCounts();
  for (const attempt of latest.values()) {
    if (attempt.freshness === "stale" || attempt.freshness === "unavailable")
      counts.stale += 1;
    if (isWorkingConversationStatus(attempt.status)) counts.working += 1;
    else if (attempt.status === "waiting") counts.waiting += 1;
    else if (attempt.status === "pausing") counts.pausing += 1;
    else if (attempt.status === "paused") counts.paused += 1;
    else if (attempt.status === "failed") counts.failed += 1;
    else if (attempt.status === "interrupted") counts.interrupted += 1;
    else if (attempt.status === "unknown") counts.unknown += 1;
    else if (attempt.status === "completed") counts.completed += 1;
  }
  return counts;
}

export const ProjectAsideIndexSchema = z
  .object({
    id: Id,
    project_id: Id,
    workflow_id: Id,
    workflow_title: z.string().min(1),
    question_preview: z.string().max(500),
    status: z.enum(["active", "queued", "completed", "expired", "cancelled"]),
    created_at: z.string().min(1),
    created_project_seq: z.number().int().positive(),
    updated_project_seq: z.number().int().positive(),
  })
  .strict();
export type ProjectAsideIndex = z.infer<typeof ProjectAsideIndexSchema>;

export const ProjectAsideCursorSchema = z
  .object({
    project_id: Id,
    seq: z.number().int().nonnegative(),
    updated_at: z.string().min(1),
  })
  .strict();
export type ProjectAsideCursor = z.infer<typeof ProjectAsideCursorSchema>;
