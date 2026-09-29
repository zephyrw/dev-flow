import { expect, it } from "vitest";
import { canPauseWorkflow, getWorkflowTone } from "../../packages/presentation/src/workflow-status.js";

it.each(["RESEARCHING", "PLANNING", "REPAIR_RESEARCH_REQUIRED", "QUEUED", "EXECUTING", "VERIFYING", "DELIVERY_VERIFYING", "QUALITY_REVIEW", "PLANNER_TAKEOVER", "REVIEW_QUEUED", "REVIEWING", "STOPPING"])("offers the existing pause action during %s", state => {
  expect(canPauseWorkflow({ state })).toBe(true);
});
it.each(["COMMITTED", "COMPLETED", "COMMITTING", "INTEGRATING", "CLEANUP_PENDING", "COMMIT_PARTIAL", "STOPPED", "PAUSED"])("does not offer pause during %s even with an outdated running record", state => {
  expect(canPauseWorkflow({ state, run_id: "r" }, [{ id: "r", status: "running" }])).toBe(false);
});
it("recognizes an actual active run without treating an old run as current activity", () => {
  expect(canPauseWorkflow({ state: "WAITING_INPUT", run_id: "r" }, [{ id: "r", status: "running" }])).toBe(true);
  expect(canPauseWorkflow({ state: "WAITING_INPUT", run_id: "r" }, [{ id: "old", status: "running" }])).toBe(false);
});
it.each(["STOPPED", "STOPPING", "PAUSED", "PLAN_PENDING", "HUMAN_PENDING", "WAITING_INPUT", "WAITING_AUTHORIZATION"])("uses yellow for %s rather than an error", state => {
  expect(getWorkflowTone({ state, blocker: { code: "OLD_ERROR" } })).toBe("warning");
});
it.each(["NEED_USER", "NEED_PLANNER", "REVIEW_NEEDS_USER", "SOURCE_CHANGED", "DESIGN_CONFLICT", "CONTROLLER_RESTARTED", "MODEL_QUOTA"])("shows the normal %s wait without claiming a failure", code => {
  expect(getWorkflowTone({ state: "BLOCKED", blocker: { code } })).toBe("warning");
});
it("reserves red for recorded errors and keeps unknown recovery yellow", () => {
  expect(getWorkflowTone({ state: "BLOCKED", blocker: { code: "MODEL_CONNECTION_FAILED" } })).toBe("error");
  expect(getWorkflowTone({ state: "RECOVERY_REQUIRED", blocker: { code: "PROCESS_EXIT_FAILED" } })).toBe("error");
  expect(getWorkflowTone({ state: "COMMIT_PARTIAL" })).toBe("error");
  expect(getWorkflowTone({ state: "RECOVERY_REQUIRED" })).toBe("warning");
  expect(getWorkflowTone({ state: "BLOCKED" })).toBe("warning");
  expect(getWorkflowTone({ state: "QUEUED" })).toBe("neutral");
});
