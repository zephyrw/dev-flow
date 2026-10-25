import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setup, repository, project, plan } from "../helpers.js";
import { ProfileRuntime } from "../../packages/runtime/src/profile-runtime.js";
import { ProcessManager } from "../../packages/process/src/manager.js";
import { prepareRejectedSessionRecovery } from "../../packages/core/src/session-context-recovery.js";
import { ExecutionSessionStore } from "../../packages/core/src/execution-session-store.js";
import { FlowError, type Run } from "../../packages/contracts/src/index.js";

it("explicitly recreates a repeatedly rejected AGY root with the same model, workspace, plan and history, exactly once", async () => {
  const s = setup(), repo = await repository(s.root), p = project(repo.repo);
  s.store.put("project", p.id, p.id, p);
  const created = s.engine.create({ project_id: p.id, title: "rejected context", request: "Preserve task", complexity: "simple", workspace_mode: "existing_workspace" }, "create");
  await s.engine.git.prepare(p, created.id, "existing_workspace", { main: repo.baseline });
  s.store.put("plan", `${created.id}-1`, created.id, { revision: 1, hash: "plan", plan: plan("project", repo.baseline) });
  const w = { ...created, plan_revision: 1, plan_hash: "plan", binding_strategy: "unified" as const };
  const processManager = new ProcessManager(), runtime = new ProfileRuntime(s.engine, processManager);
  const original: Run = { id: "original", workflow_id: w.id, plan_revision: 1, adapter: "agy", purpose: "implement", stage: "execute",
    protocol: "lightweight", status: "running", started_at: new Date().toISOString(), package_hash: "fixture",
    profile: { id: "agy", revision: 1, adapterId: "agy", executableRef: process.execPath, modelSelection: "explicit", modelId: "fixture-model",
      options: { prefixArgs: [resolve("tests/fixtures/session-switch-cli.mjs"), "agy"] } } };
  const invoke = async (run: Run) => {
    s.store.put("run", run.id, w.id, run);
    s.store.put("workflow", w.id, p.id, { ...w, state: "EXECUTING", run_id: run.id });
    await (runtime as any).invoke(s.engine.get(w.id), run, { request: "Preserve task", plan_hash: "plan" }, {});
    return s.store.must<Run>("run", run.id);
  };
  try {
    const first = await invoke(original);
    s.store.put("run", first.id, w.id, { ...first, status: "waiting" });
    const blocked = { ...w, state: "WAITING_INPUT" as const, run_id: first.id, blocker: { code: "NEED_USER", message: "MODEL_REQUEST_INVALID INVALID_ARGUMENT" } };
    s.store.put("workflow", w.id, p.id, blocked);
    const request = { request_id: "repair", expected_version: w.version, expected_run_id: first.id };
    expect(() => prepareRejectedSessionRecovery(s.store, w.id, request)).toThrow(/未确认/);
    s.store.put("model_input_feedback", first.id, w.id, { message: "MODEL_REQUEST_INVALID first retry failed" });
    expect(() => prepareRejectedSessionRecovery(s.store, w.id, { ...request, expected_version: 999 })).toThrow(/任务已变化/);
    s.store.put("workflow", w.id, p.id, { ...blocked, state: "EXECUTING" });
    expect(() => prepareRejectedSessionRecovery(s.store, w.id, request)).toThrow(/只能修复/);
    s.store.put("workflow", w.id, p.id, blocked);
    s.store.put("run", "child", w.id, { ...first, id: "child", status: "running" });
    expect(() => prepareRejectedSessionRecovery(s.store, w.id, request)).toThrow(/仍有任务进程/);
    s.store.remove("run", "child");
    const repair = prepareRejectedSessionRecovery(s.store, w.id, request);
    expect(prepareRejectedSessionRecovery(s.store, w.id, request)).toEqual(repair);
    expect(new ExecutionSessionStore(s.store).listBindings(w.id).some(b => b.conversation_id === first.conversation_id && b.state === "retired")).toBe(true);
    expect(s.engine.get(w.id)).toMatchObject({ plan_revision: 1, plan_hash: "plan" });
    const next = await invoke({ ...original, id: "next", continuation: { kind: "runtime_resume", source_run_id: first.id, purpose: "execute", role: "executor" } });
    expect(next.conversation_id).not.toBe(first.conversation_id);
    expect(next.profile).toEqual(first.profile);
    const handoff = JSON.parse(readFileSync(join(s.config.storage_root, "native-runs/next/HANDOFF.json"), "utf8"));
    expect(handoff.cross_tool_handoff).toMatchObject({ reason: "rejected_session", source_adapter: "agy", target_adapter: "agy", source_run_id: first.id });
    expect(handoff.cross_tool_handoff.instructions).toContain("同一模型");
    expect(handoff.cross_tool_handoff.progress.map((r: any) => r.run_id)).toContain(first.id);
    const followup = await invoke({ ...original, id: "followup", continuation: { kind: "runtime_resume", source_run_id: next.id, purpose: "execute", role: "executor" } });
    expect(followup.conversation_id).toBe(next.conversation_id);
    expect(s.store.get<any>("session_input", followup.id)?.kind).toBe("followup");
  } finally { await processManager.close(); s.store.close(); }
}, 90000);

it("reports repeated native rejection as a runtime problem without claiming the model received repair instructions", () => {
  const s = setup();
  try {
    const p = project(s.root); s.store.put("project", p.id, p.id, p);
    const w = s.engine.create({ project_id: p.id, title: "rejection", request: "task", complexity: "simple", workspace_mode: "existing_workspace" }, "create");
    const run: Run = { id: "repeat", workflow_id: w.id, plan_revision: 0, adapter: "agy", purpose: "implement", stage: "execute", status: "failed", started_at: new Date().toISOString(), package_hash: "p", conversation_id: "old" };
    s.store.put("workflow", w.id, p.id, { ...w, state: "EXECUTING", run_id: run.id });
    s.store.put("run", run.id, w.id, run);
    s.store.put("model_input_feedback", run.id, w.id, { message: "MODEL_REQUEST_INVALID" });
    s.engine.returnInputFailureToModel(w.id, run.id, new FlowError("MODEL_REQUEST_INVALID", "INVALID_ARGUMENT (code 400)", 422));
    expect(s.engine.get(w.id)).toMatchObject({ state: "BLOCKED", blocker: { code: "MODEL_SESSION_REQUEST_REJECTED" } });
    expect(s.store.list("user_interaction", w.id)).toEqual([]);
  } finally { s.store.close(); }
});
