import { expect, it } from "vitest";
import { setup, project } from "../helpers.js";
import { reconcileInactiveRuns } from "../../packages/runtime/src/recovery.js";

it("reconciles exited orphan runs, preserves unknown processes and active workflows", () => {
  const s = setup();
  const p = project(s.root);
  s.store.put("project", p.id, p.id, p);
  try {
    for (const [state, confirmed] of [["STOPPED", true], ["BLOCKED", false], ["EXECUTING", true]] as const) {
      const w = s.engine.create({ project_id: p.id, title: state, request: "fixture", complexity: "simple", workspace_mode: "existing_workspace" }, crypto.randomUUID());
      const run = "run-" + state;
      s.store.put("workflow", w.id, p.id, { ...w, state, run_id: run });
      s.store.put("run", run, w.id, { id: run, workflow_id: w.id, status: "running" });
      s.store.put("process_record", run, w.id, { id: run, status: "exited", confirmed });
    }
    expect(reconcileInactiveRuns(s.engine)).toEqual(["run-STOPPED"]);
    expect(s.store.get<any>("run", "run-BLOCKED").status).toBe("running");
    expect(s.store.get<any>("run", "run-EXECUTING").status).toBe("running");
    expect(reconcileInactiveRuns(s.engine)).toEqual([]);
  } finally { s.store.close(); }
});
