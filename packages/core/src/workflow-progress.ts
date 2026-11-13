import type { Workflow, Run } from "../../contracts/src/index.js";
import type { Store } from "../../store/src/store.js";

export interface BusinessProgress {
  index: number;
  activity: string;
  review_phase?: string;
}

type PendingPurpose = {
  purpose?: string;
  review_phase?: string;
  repair_kind?: string;
  guidance_mode?: string;
};

type ActiveQualityAssignment = {
  source?: string;
  plan_revision?: number;
  plan_hash?: string;
  phase?: string;
  current_attempt_run_id?: string;
  consumed_completion_run_id?: string;
};

const TECHNICAL_STATES = new Set([
  "BLOCKED",
  "STOPPED",
  "STOPPING",
  "RECOVERY_REQUIRED",
  "WAITING_INPUT",
  "WAITING_AUTHORIZATION",
]);

const TRANSITIONAL_STATES = new Set([
  "VERIFYING",
  "DELIVERY_VERIFYING",
]);

function milestone(state: string, stage: string, phase?: string, repairKind?: string): number {
  if (["COMMITTING", "COMMITTED", "COMPLETED", "INTEGRATING", "CLEANUP_PENDING", "COMMIT_PARTIAL"].includes(state) || stage === "planner_commit") return 7;
  if (stage === "review" || (["REVIEWING", "REVIEW_QUEUED"].includes(state) && stage !== "quality_before_human" && phase !== "before_human")) return 6;
  if (state === "HUMAN_PENDING" || ["acceptance_guidance", "functional_fix"].includes(stage)) return 5;
  if (stage === "quality_before_human" || ["planner_takeover", "executor_test"].includes(stage) || (repairKind === "quality" && ["implement", "execute"].includes(stage))) {
    return phase === "after_human" ? 6 : 4;
  }
  if (TRANSITIONAL_STATES.has(state)) return 3;
  if (["EXECUTING", "QUEUED"].includes(state)) return 2;
  if (["PLAN_PENDING", "REPAIR_PLAN_PENDING"].includes(state)) return 1;
  if (["RESEARCHING", "PLANNING", "REPAIR_RESEARCH_REQUIRED"].includes(state)) return 0;
  return -1;
}

function resolveActivity(stage: string, purpose?: string, guidanceMode?: string): string {
  if (guidanceMode === "human_acceptance") return "acceptance_guidance";
  if (purpose === "quality_review") return stage;
  return purpose ?? stage;
}

function computeBusinessProgress(store: Store, w: Workflow): { progress: BusinessProgress; resolved: boolean } {
  const run = w.run_id ? store.get<Run>("run", w.run_id) : undefined;
  const technical = TECHNICAL_STATES.has(w.state);
  const transitional = TRANSITIONAL_STATES.has(w.state);
  const activeRun = run && run.workflow_id === w.id && run.plan_revision === w.plan_revision &&
    (!technical || run.status !== "completed")
    ? run
    : undefined;
  const pending = w.state === "QUEUED" || (technical && !activeRun) || (["EXECUTING", "REVIEWING"].includes(w.state) && !run)
    ? store.get<PendingPurpose>("pending_dispatch_purpose", w.id)
    : undefined;

  const activity = pending
    ? resolveActivity(w.stage, pending.purpose, pending.guidance_mode)
    : (technical || transitional) && activeRun
      ? resolveActivity(activeRun.stage, activeRun.purpose, activeRun.dispatch_context?.guidance_mode)
      : activeRun?.dispatch_context?.guidance_mode === "human_acceptance" && w.state === "EXECUTING"
        ? "acceptance_guidance"
        : w.stage;

  let repairKind = pending?.repair_kind ?? activeRun?.dispatch_context?.repair_kind;
  let assignmentPhase: string | undefined;
  if (!repairKind && ["implement", "execute"].includes(activity)) {
    const assignment = store.get<ActiveQualityAssignment>("repair_assignment", w.id);
    if (
      assignment?.source === "quality_review" &&
      assignment.plan_revision === w.plan_revision &&
      assignment.plan_hash === w.plan_hash &&
      !assignment.consumed_completion_run_id &&
      (!assignment.current_attempt_run_id || assignment.current_attempt_run_id === w.run_id)
    ) {
      repairKind = "quality";
      assignmentPhase = assignment.phase;
    }
  }

  const phase = pending?.review_phase ?? activeRun?.dispatch_context?.review_phase ?? assignmentPhase ??
    store.get<{ phase?: string }>("quality_flow", w.id)?.phase;
  const index = milestone(w.state, activity, phase, repairKind);
  return { progress: { index, activity, review_phase: phase }, resolved: index >= 0 };
}

/** Business progress survives worker retries, pauses and truncated UI event windows. */
export function readBusinessProgress(store: Store, w: Workflow): BusinessProgress {
  const { progress, resolved } = computeBusinessProgress(store, w);
  if (resolved) return progress;

  const saved = store.get<BusinessProgress>("workflow_progress", w.id);
  let index = saved?.index ?? 0;
  if (!saved) {
    // Recover from the latest business milestone rather than taking a historical maximum across earlier cycles.
    const rows = store.db.prepare(
      "SELECT data FROM events WHERE workflow_id=? AND json_extract(data,'$.type')='StateChanged' ORDER BY seq DESC",
    ).all(w.id) as { data: string }[];
    for (const row of rows) {
      const p = JSON.parse(row.data).payload ?? {};
      const candidate = milestone(p.to, p.stage, p.stage === "quality_before_human" ? "before_human" : progress.review_phase);
      if (candidate >= 0) {
        index = candidate;
        break;
      }
    }
  }
  return { ...progress, index };
}

export function saveBusinessProgress(store: Store, previous: Workflow, next: Workflow) {
  const { progress, resolved } = computeBusinessProgress(store, next);
  if (resolved) {
    store.put("workflow_progress", next.id, next.id, progress);
    return;
  }
  const before = readBusinessProgress(store, previous);
  store.put("workflow_progress", next.id, next.id, { ...progress, index: before.index });
}
