import { describe, expect, it } from "vitest";
import { Store } from "../../packages/store/src/store.js";
import { currentContinuation, saveWaitingContext } from "../../packages/core/src/waiting-context.js";
import type { Run, Workflow } from "../../packages/contracts/src/index.js";
import type { RunContinuation } from "../../packages/contracts/src/tr-handoff.js";

function setup() {
  const store = new Store(":memory:");
  store.put("workflow", "wf", "project", { id: "wf", run_id: "current", plan_revision: 2 } as Workflow);
  const run: Run = { id: "current", workflow_id: "wf", plan_revision: 2, adapter: "codex", purpose: "implement",
    stage: "execute", status: "completed", exit_code: 0, started_at: new Date().toISOString(), package_hash: "pkg" };
  store.put("run", run.id, "wf", run);
  const candidate: RunContinuation = { kind: "user_answer", source_run_id: "current", purpose: "execute", role: "executor" };
  return { store, run, candidate };
}

describe("continuation admission before Run creation", () => {
  it("resolves shared native session IDs by the current Run while rejecting an old stage node", () => {
    const { store, run, candidate } = setup();
    try {
      store.put("run", run.id, "wf", { ...run, purpose: "functional_fix", conversation_id: "shared-native", status: "waiting" });
      saveWaitingContext(store, "wf", { purpose: "execute", role: "executor", run_id: run.id, intent: "need_user" });
      for (const [node, owner] of [["old-stage", "old-run"], ["current-stage", run.id]]) {
        store.put("conversation_node", node!, "wf", { id: node, workflow_id: "wf", native_session_id: "shared-native", current_attempt_id: node + "-attempt" });
        store.put("conversation_attempt", node + "-attempt", "wf", { id: node + "-attempt", conversation_id: node, run_id: owner, generation: 2 });
      }
      const answer = { ...candidate, conversation_id: "shared-native" };
      expect(currentContinuation(store, "wf", answer)).toEqual(answer);
      expect(currentContinuation(store, "wf", { ...answer, conversation_id: "old-stage" })).toBeUndefined();
      expect(currentContinuation(store, "wf", answer, { generation: 1 })).toBeUndefined();
    } finally { store.close(); }
  });
  it.each(["need_user", "unclear"] as const)("preserves business %s despite successful CLI exit", (intent) => {
    const { store, candidate } = setup();
    try {
      saveWaitingContext(store, "wf", { purpose: "execute", role: "executor", run_id: "current", intent });
      expect(currentContinuation(store, "wf", candidate)).toEqual(candidate);
      store.put("run_continuation_superseded", "current", "wf", {});
      expect(currentContinuation(store, "wf", candidate)).toBeUndefined();
    } finally { store.close(); }
  });
  it("retains a consumed answer across an interrupted bound successor", () => {
    const { store, run, candidate } = setup();
    try {
      store.put("run", "successor", "wf", { ...run, id: "successor", status: "failed", exit_code: 1, continuation: candidate });
      store.put("workflow", "wf", "project", { id: "wf", run_id: "successor", plan_revision: 2 });
      expect(currentContinuation(store, "wf", candidate)).toEqual(candidate);
      store.put("execution_completion", "current", "wf", { run_id: "current", workflow_id: "wf", intent: "completed" });
      expect(currentContinuation(store, "wf", candidate)).toBeUndefined();
    } finally { store.close(); }
  });
  it.each(["planner_takeover", "planner_commit"] as const)("retains the planner role for a pending %s answer", (purpose) => {
    const { store, run, candidate } = setup();
    try {
      store.put("run", run.id, "wf", { ...run, purpose, stage: purpose });
      saveWaitingContext(store, "wf", { purpose: "execute", role: "planner", run_id: run.id, intent: "need_user" });
      const plannerAnswer: RunContinuation = { ...candidate, role: "planner" };
      expect(currentContinuation(store, "wf", plannerAnswer, { purpose: "execute", role: "planner" })).toEqual(plannerAnswer);
      expect(currentContinuation(store, "wf", plannerAnswer, { purpose: "execute", role: "executor" })).toBeUndefined();
    } finally { store.close(); }
  });
  it("rejects stale staged/waiting sources and wrong revision or role", () => {
    const { store, run, candidate } = setup();
    try {
      store.put("run", "old", "wf", { ...run, id: "old", status: "waiting" });
      saveWaitingContext(store, "wf", { purpose: "execute", role: "executor", run_id: "old", intent: "need_user" });
      expect(currentContinuation(store, "wf", { ...candidate, source_run_id: "old" })).toBeUndefined();
      saveWaitingContext(store, "wf", { purpose: "execute", role: "executor", run_id: "current", intent: "need_user" });
      expect(currentContinuation(store, "wf", candidate, { role: "planner" })).toBeUndefined();
      store.put("run", "current", "wf", { ...run, plan_revision: 1 });
      expect(currentContinuation(store, "wf", candidate)).toBeUndefined();
    } finally { store.close(); }
  });
  it("rejects a continuation whose conversation has advanced to a different Run generation", () => {
    const { store, run, candidate } = setup();
    try {
      store.put("run", "current", "wf", { ...run, status: "failed", exit_code: 1 });
      store.put("conversation_node", "root", "wf", { id: "root", root_id: "root", workflow_id: "wf", current_attempt_id: "new-attempt" });
      store.put("conversation_attempt", "new-attempt", "wf", { id: "new-attempt", conversation_id: "root", run_id: "new-run", generation: 1 });
      expect(currentContinuation(store, "wf", { ...candidate, conversation_id: "root" })).toBeUndefined();
    } finally { store.close(); }
  });
});
