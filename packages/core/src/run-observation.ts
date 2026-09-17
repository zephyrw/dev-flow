import type { Store } from "../../store/src/store.js";
import type { Workflow, Run } from "../../contracts/src/index.js";
import type { RunObservation } from "../../contracts/src/run-observation.js";
import { publicEvent } from "./util.js";

/** Constant-time current-run lookup; never inherit a previous run's model or quota. */
export function currentRunObservation(
  store: Store,
  workflow: Workflow,
): RunObservation | null {
  if (!workflow.run_id) return null;
  const run = store.get<Run>("run", workflow.run_id);
  if (!run || run.workflow_id !== workflow.id) return null;
  const saved = store.get<RunObservation>("run_observation", run.id);
  return publicEvent(
    saved ?? {
      run_id: run.id,
      adapter: run.profile?.adapterId ?? run.adapter,
      purpose: run.purpose,
      requested_model: run.profile?.modelId,
      started_at: run.started_at,
      updated_at: run.started_at,
      status:
        run.status === "running"
          ? "starting"
          : run.status === "failed"
            ? "error"
            : "exited",
      active_tools: 0,
    },
  );
}
