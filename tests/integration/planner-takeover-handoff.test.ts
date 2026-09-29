import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setup, project, plan, repository } from "../helpers.js";
import { unknownSubagentCapabilities, type Run, type Workflow } from "../../packages/contracts/src/index.js";
import type { RunContinuation } from "../../packages/contracts/src/tr-handoff.js";
import { prepareRepairResume } from "../../packages/core/src/repair.js";
import { boundConversationContinuation, continuationMatchesRun } from "../../packages/core/src/conversation-lineage.js";
import { ProfileRuntime } from "../../packages/runtime/src/profile-runtime.js";
import type { ProcessManager } from "../../packages/process/src/manager.js";
import { ConversationService } from "../../packages/core/src/conversation-service.js";
import { ConversationControlService } from "../../packages/core/src/conversation-control.js";
import { ConversationRecovery, storeRecoveryRunPort } from "../../packages/runtime/src/conversation-recovery.js";

let s: ReturnType<typeof setup>;
const wid = "takeover-handoff";
const findings = Array.from({ length: 11 }, (_, n) => ({ id: `F${n + 1}`, path: `src/${n}.ts`,
  evidence: `evidence ${n}`, suggestion: `repair ${n}`, severity: "P1" }));
const assignment = { assignment_id: "assignment-exact", planner: true, phase: "before_human", source: "quality_review",
  source_review_id: "review-exact", plan_revision: 1, plan_hash: "approved-hash", instructions: "Repair all eleven findings",
  source_review: { workflow_id: wid, run_id: "review-exact", plan_revision: 1, findings } };
function run(extra: Partial<Run> = {}): Run {
  return { id: "takeover", workflow_id: wid, plan_revision: 1, adapter: "codex", purpose: "planner_takeover",
    routing_role: "planner", assignment_id: assignment.assignment_id, quality_policy_version: 2,
    dispatch_context: { purpose: "planner_takeover", source_run_id: "review-exact", assignment_id: assignment.assignment_id },
    stage: "planner_takeover", status: "running", started_at: new Date().toISOString(), package_hash: "pkg", ...extra };
}
const old: RunContinuation = { kind: "intent_clarification", purpose: "execute", role: "executor",
  source_run_id: "old-executor", original_text: "Old delivery, not review findings" };
beforeEach(() => {
  s = setup();
  const time = new Date().toISOString();
  const w: Workflow = { id: wid, project_id: "p1", title: "takeover", request: "Original approved scope", complexity: "simple",
    workspace_mode: "existing_workspace", quality_policy_version: 2, state: "QUEUED", stage: "planner_takeover",
    plan_revision: 1, plan_hash: "approved-hash", version: 1, environment_revision: 0, feedback: [], created_at: time, updated_at: time };
  s.store.put("project", "p1", "p1", project(s.root));
  s.store.put("workflow", wid, "p1", w);
  s.store.put("plan", `${wid}-1`, wid, { revision: 1, hash: w.plan_hash, plan: { ...plan("hash", "a".repeat(40)), task_model: "native-v2" } });
  s.store.put("approval", `${wid}-1`, wid, { plan_hash: w.plan_hash });
  s.store.put("quality_flow", wid, wid, { workflow_id: wid, phase: "before_human", executor_repair_completed: true, planner_repairs_only: true });
  s.store.put("repair_assignment", wid, wid, assignment);
  s.store.put("quality_repair_assignment", assignment.assignment_id, wid, assignment);
  s.store.put("run", "old-executor", wid, run({ id: "old-executor", purpose: "implement", routing_role: "executor", assignment_id: undefined, status: "waiting" }));
  s.store.put("run", "old-clarification", wid, run({ id: "old-clarification", purpose: "implement", routing_role: "executor", assignment_id: undefined, status: "failed", continuation: old }));
});
afterEach(() => { vi.restoreAllMocks(); s.store.close(); });
function materials(r: Run) {
  return (new ProfileRuntime(s.engine, {} as ProcessManager) as any).executeMaterials(s.engine.get(wid), r);
}

it("preserves the policy-2 assignment through actual recovery dispatch and supplies all eleven findings", async () => {
  const repo = await repository(s.root);
  s.store.put("project", "p1", "p1", project(repo.repo));
  const saved = s.engine.plan(wid);
  saved.plan.baselines.main = repo.baseline;
  s.store.put("plan", `${wid}-1`, wid, saved);
  const originalPlan = s.engine.plan(wid);
  s.store.put("pending_dispatch_purpose", wid, wid, run().dispatch_context);
  s.store.put("run_continuation", wid, wid, old);
  const oldGate = s.engine.quality.getOrCreateGate(wid, "before_human");
  expect(oldGate.status).toBe("pending");
  expect(s.engine.quality.canTakeOver(wid, "before_human")).toBe(false);
  prepareRepairResume(s.engine, wid);
  expect(s.store.get("repair_assignment", wid)).toEqual(assignment);
  // Reproduce the already-corrupt saved Run, then use the real recovery arranger.
  const source = run({ id: "saved-takeover", status: "failed", continuation: old });
  s.store.put("run", source.id, wid, source);
  s.store.put("workflow", wid, "p1", { ...s.engine.get(wid), state: "STOPPED", run_id: source.id });
  const conversations = new ConversationService(s.store);
  conversations.setCapabilities(wid, { ...unknownSubagentCapabilities(), resume: "native", stop: "native" });
  const root = conversations.applyEvent({ project_id: "p1", workflow_id: wid, run_id: source.id,
    adapter_id: "codex", scope: "planner", lineage_id: "planner", purpose: "planner_takeover", root_native_id: "original-native" },
    { source_id: "source", source_seq: "1", kind: "discovered", root_native_id: "original-native", session_native_id: "original-native",
      payload: { title: "Original planner", status: "paused" } }).node!;
  const controls = new ConversationControlService(s.store, conversations, { stopConversation: async () => ({ accepted: true, confirmation: "exited" }) });
  const recovery = new ConversationRecovery({ store: s.store, conversations, controls, runPort: storeRecoveryRunPort(s.store) });
  const arranged = recovery.commitArrangement(wid, { action: "resume", request_id: "recover-takeover", root_id: root.id, expected_generation: 0 }, { reason: "user_resume" });
  const restored = s.store.must<Run>("run", arranged.manifest.target_run_id);
  expect(restored).toMatchObject({ purpose: "planner_takeover", assignment_id: assignment.assignment_id,
    continuation: { role: "planner", kind: "runtime_resume", source_run_id: source.id } });
  s.store.put("run_continuation", wid, wid, restored.continuation);
  s.store.put("workflow", wid, "p1", { ...s.engine.get(wid), state: "QUEUED", stage: "planner_takeover" });
  let received: any;
  let dispatched: Run | undefined;
  s.engine.runtime = { execute: async (_w: Workflow, r: Run) => {
    dispatched = r;
    received = materials(r);
    await s.engine.receiveRoundResult(wid, r.id, { status: "need_user", summary: "Fixture ends after material capture" });
  }, review: async () => { throw new Error("unexpected review"); },
    stop: async () => {}, check: async () => { throw new Error("unexpected check"); }, close: async () => {} };
  await (s.engine as any).run(wid, "recovered-takeover", false, []);
  expect(dispatched).toMatchObject({ purpose: "planner_takeover", routing_role: "planner", assignment_id: assignment.assignment_id });
  expect(dispatched?.continuation).toMatchObject({ role: "planner", kind: "runtime_resume", source_run_id: source.id });
  expect(received.source_review.findings).toEqual(findings);
  expect(received.repair_instructions).toBe(assignment.instructions);
  expect(received.instructions).not.toContain("补充刚才");
  expect(received.continuation_handoff?.kind).toBe("runtime_resume");
  expect(received.test_result_targets).toEqual([{ test_id: "UT01", case_id: "updates content", layer: "unit" }]);
  expect(s.engine.plan(wid)).toEqual(originalPlan);
});

it("resolves a missing active pointer from the exact archived assignment and rejects an already bound executor clarification", () => {
  s.store.remove("repair_assignment", wid);
  const r = run({ continuation: old });
  expect(boundConversationContinuation(s.store, r)).toBeUndefined();
  const m = materials(r);
  expect(m.source_review.findings).toEqual(findings);
  expect(m.repair_instructions).toBe(assignment.instructions);
  expect(m.continuation_handoff).toBeUndefined();
});

it.each(["owner", "plan", "source", "aside", "assignment"])("does not backfill an archive with mismatched %s", (mismatch) => {
  s.store.remove("repair_assignment", wid);
  const a = { ...assignment };
  const r = run();
  if (mismatch === "owner") s.store.put("quality_repair_assignment", a.assignment_id, "other-workflow", a);
  if (mismatch === "plan") { a.plan_revision = 2; s.store.put("quality_repair_assignment", a.assignment_id, wid, a); }
  if (mismatch === "source") r.dispatch_context = { purpose: "planner_takeover", source_run_id: "unrelated-review" };
  if (mismatch === "aside") r.purpose = "aside";
  if (mismatch === "assignment") r.assignment_id = "unrelated-assignment";
  expect(materials(r).source_review).toBeNull();
});

it.each(["user_answer", "runtime_resume", "intent_clarification"] as const)("preserves legitimate same-role same-purpose %s", (kind) => {
  const source = run({ id: "same-source" });
  s.store.put("run", source.id, wid, source);
  const value = { ...old, kind, role: "planner" as const, source_run_id: source.id };
  expect(continuationMatchesRun(s.store, run(), value)).toBe(true);
  s.store.put("run_continuation", wid, wid, value);
  expect((s.engine as any).consumeContinuation(wid, "execute", "planner", run())).toEqual(value);
});

it("rejects different real purpose or assignment and preserves legacy same-role review resume", () => {
  const source = run({ id: "same-source", purpose: "implement" });
  s.store.put("run", source.id, wid, source);
  const value = { ...old, role: "planner" as const, source_run_id: source.id };
  expect(continuationMatchesRun(s.store, run(), value)).toBe(false);
  s.store.put("run", source.id, wid, { ...source, purpose: "planner_takeover", assignment_id: "old-assignment" });
  expect(continuationMatchesRun(s.store, run(), value)).toBe(false);
  const legacy = run({ id: "legacy-review", purpose: undefined, routing_role: undefined, assignment_id: undefined });
  s.store.put("run", legacy.id, wid, legacy);
  const review = run({ purpose: "quality_review", assignment_id: undefined });
  expect(continuationMatchesRun(s.store, review, { ...value, purpose: "review", source_run_id: legacy.id })).toBe(true);
});

it("keeps policy-1 takeover checks in force and does not retain invalid policy-2 plan assignments", () => {
  s.store.put("workflow", wid, "p1", { ...s.engine.get(wid), quality_policy_version: 1 });
  const gate = s.engine.quality.getOrCreateGate(wid, "before_human");
  const ids = ["review-one", "review-two", "review-exact"];
  ids.forEach(id => {
    s.store.put("run", id + "-repair", wid, run({ id: id + "-repair", purpose: "implement", status: "completed", exit_code: 0 }));
    s.store.put("quality_review", id, wid, { workflow_id: wid, phase: "before_human", verdict: "changes_required", plan_revision: 1, executor_repair_run_id: id + "-repair" });
  });
  const validGate = { ...gate, current_review_id: "review-exact", status: "rejected", takeover: true, executor_rejections: 3, failed_repair_review_ids: ids };
  s.store.put("quality_gate", s.engine.quality.getGateKey(wid, "before_human"), wid, validGate);
  expect(s.engine.quality.canTakeOver(wid, "before_human")).toBe(true);
  prepareRepairResume(s.engine, wid);
  expect(s.store.get("repair_assignment", wid)).toEqual(assignment);
  s.store.put("quality_gate", s.engine.quality.getGateKey(wid, "before_human"), wid, { ...validGate, takeover: false });
  prepareRepairResume(s.engine, wid);
  expect(s.store.get("repair_assignment", wid)).toBeUndefined();
  s.store.put("workflow", wid, "p1", { ...s.engine.get(wid), quality_policy_version: 2 });
  s.store.put("repair_assignment", wid, wid, { ...assignment, plan_hash: "wrong" });
  prepareRepairResume(s.engine, wid);
  expect(s.store.get("repair_assignment", wid)).toBeUndefined();
});
