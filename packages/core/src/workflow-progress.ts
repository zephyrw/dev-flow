import type { Workflow, Run } from "../../contracts/src/index.js";
import type { Store } from "../../store/src/store.js";

export interface BusinessProgress {
  index: number;
  activity: string;
  review_phase?: string;
}

function milestone(state: string, stage: string, phase?: string): number {
  if (["COMMITTING", "COMMITTED", "COMPLETED", "INTEGRATING", "CLEANUP_PENDING", "COMMIT_PARTIAL"].includes(state) || stage === "planner_commit") return 7;
  if (stage === "review" || (["REVIEWING", "REVIEW_QUEUED"].includes(state) && stage !== "quality_before_human")) return 6;
  if (state === "HUMAN_PENDING" || ["acceptance_guidance", "functional_fix"].includes(stage)) return 5;
  if (stage === "quality_before_human" || ["planner_takeover", "executor_test"].includes(stage)) return phase === "after_human" ? 6 : 4;
  if (["VERIFYING", "DELIVERY_VERIFYING"].includes(state)) return 3;
  if (["EXECUTING", "QUEUED"].includes(state)) return 2;
  if (["PLAN_PENDING", "REPAIR_PLAN_PENDING"].includes(state)) return 1;
  return 0;
}

/** Business progress survives worker retries, pauses and truncated UI event windows. */
export function readBusinessProgress(store: Store, w: Workflow): BusinessProgress {
  const saved = store.get<BusinessProgress>("workflow_progress", w.id);
  const run = w.run_id ? store.get<Run>("run", w.run_id) : undefined;
  const pending = w.state === "QUEUED" ? store.get<{ purpose?: string; review_phase?: string }>("pending_dispatch_purpose", w.id) : undefined;
  const phase = pending?.review_phase ?? run?.dispatch_context?.review_phase ?? store.get<{ phase?: string }>("quality_flow", w.id)?.phase;
  const technical = ["BLOCKED", "STOPPED", "STOPPING", "RECOVERY_REQUIRED", "WAITING_INPUT", "WAITING_AUTHORIZATION"].includes(w.state);
  const pendingActivity = pending?.purpose === "quality_review" ? w.stage : pending?.purpose;
  const activity = pendingActivity ?? (technical ? run?.purpose === "quality_review" ? run.stage : run?.purpose ?? run?.stage : w.stage) ?? w.stage;
  let index = Math.max(saved?.index ?? 0, milestone(w.state, activity, phase));
  if (!saved) {
    const rows = store.db.prepare("SELECT data FROM events WHERE workflow_id=? AND json_extract(data,'$.type')='StateChanged' ORDER BY seq").all(w.id) as { data: string }[];
    for (const row of rows) {
      const p = JSON.parse(row.data).payload ?? {};
      index = Math.max(index, milestone(p.to, p.stage));
    }
  }
  return { index, activity, review_phase: phase };
}

export function saveBusinessProgress(store: Store, previous: Workflow, next: Workflow) {
  const before = readBusinessProgress(store, previous);
  const after = readBusinessProgress(store, next);
  store.put("workflow_progress", next.id, next.id, { ...after, index: Math.max(before.index, after.index) });
}
