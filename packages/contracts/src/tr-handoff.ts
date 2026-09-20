export type IntentSource = "outer" | "nested" | "legacy_submit" | "missing";

export type ContinuationKind =
  | "intent_clarification"
  | "user_answer"
  | "runtime_resume";

export type ContinuationPurpose = "execute" | "review" | "planning";
export type ContinuationRole = "executor" | "planner";

export interface RunContinuation {
  kind: ContinuationKind;
  source_run_id: string;
  purpose: ContinuationPurpose;
  role: ContinuationRole;
  phase?: string;
  conversation_id?: string;
  original_text?: string;
  questions?: string[];
  answer?: string;
}

export interface PlanningHandoff {
  handoff_id: string;
  source_run_id: string;
  source_role: ContinuationRole;
  source_conversation_id?: string;
  plan_revision?: number;
  original_text?: string;
  summary?: string;
  notes?: string;
  questions?: string[];
  target_role: "planner";
  target_run_id?: string;
  status: "pending" | "assigned" | "resolved" | "superseded";
}

export type AttachmentArchiveState =
  | "pending"
  | "archived"
  | "missing"
  | "unreadable"
  | "archive_failed"
  | "skipped";

export interface AttachmentArchiveRecord {
  delivery_id: string;
  repo_id: string;
  path: string;
  state: AttachmentArchiveState;
  detail?: string;
}

export interface ArchiveOutboxItem {
  delivery_id: string;
  workflow_id: string;
  run_id: string;
  items: { repo_id: string; path: string }[];
}

export type ConflictFunctionImpact = "none" | "changed" | "uncertain";
