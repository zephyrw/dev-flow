import { expect, it, vi } from "vitest";
import { setup, repository, project, plan, proof, testConsoleHeaders } from "../helpers.js";
import { objectHash } from "../../packages/core/src/util.js";
import { buildServer } from "../../apps/api/src/server.js";
import { ProcessManager } from "../../packages/process/src/manager.js";
import { ConversationService } from "../../packages/core/src/conversation-service.js";
import { CONVERSATION_ENTITY, type Run } from "../../packages/contracts/src/index.js";

async function fixture() {
  const s = setup();
  const r = await repository(s.root);
  const p = project(r.repo);
  await s.engine.registerProject(p);
  const created = s.engine.create({ project_id: p.id, title: "Restart recovery", request: "Recover original run",
    complexity: "simple", workspace_mode: "existing_workspace" }, "fixture");
  await s.engine.git.prepare(p, created.id, created.workspace_mode, { main: r.baseline });
  s.engine.submitPlan(created.id, plan(objectHash(p), r.baseline), created.version, "plan");
  const authorization = proof(s.engine, created.id, "approve");
  s.engine.approve(created.id, authorization.proof, authorization.binding);
  const w = s.engine.transition(created.id, ["QUEUED"], "EXECUTING", "execute", { run_id: "run-test" });
  const run: Run = { id: w.run_id!, workflow_id: w.id, adapter: "agy", purpose: "implement",
    stage: "execute", status: "running", plan_revision: w.plan_revision,
    started_at: new Date().toISOString(), package_hash: "fixture" };
  s.store.put("run", run.id, w.id, run);
  // A previous pause belongs to a different role and must not steer this restart.
  s.store.put("interruption", w.id, w.id, { prior_run_id: "old-review", prior_purpose: "quality_review", prior_stage: "review" });
  const conversations = new ConversationService(s.store);
  const context = { project_id: w.project_id, workflow_id: w.id, run_id: run.id,
    adapter_id: "agy", scope: "fixture", lineage_id: "lineage", purpose: "implement", root_native_id: "native-root" };
  const rootNode = conversations.applyEvent(context, { source_id: "root", source_seq: "1",
    root_native_id: "native-root", session_native_id: "native-root", kind: "discovered",
    payload: { title: "root", status: "running" } }).node!;
  const dispatch = vi.spyOn(s.engine, "dispatch").mockResolvedValue(undefined);
  s.engine.recover();
  const app = await buildServer(s.engine, { accountService: {
    getRepository: () => ({}), syncActiveAccountFromHost: async () => {},
  } as any });
  const recover = () => app.inject({ method: "POST", url: `/api/workflows/${w.id}/recover`,
    headers: { host: testConsoleHeaders().host, origin: testConsoleHeaders().origin }, payload: {} });
  return { ...s, workflow: w, run, rootNode, conversations, dispatch, app, recover };
}

it("the real recovery API reconciles an exited process tree and retains the original task and session", async () => {
  const s = await fixture();
  const manager = new ProcessManager();
  const managed = manager.start({ id: s.run.id, executable: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"], cwd: s.root, env: {}, timeout_ms: 30000 });
  try {
    await managed.ready;
    const identity = { ...managed.identity };
    await managed.stop();
    // Persist the crash-time state, not the manager's later stop receipt.
    s.store.put("process_record", s.run.id, s.workflow.id,
      { id: s.run.id, identity, status: "running", confirmed: false });
    s.store.put("cli_dispatch_record", "crashed-dispatch", s.workflow.id, {
      id: "crashed-dispatch", dispatch_id: "crashed-dispatch", workflow_id: s.workflow.id,
      run_id: s.run.id, state: "needs_reconcile",
    });
    const response = await s.recover();
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ id: s.workflow.id, state: "QUEUED", stage: "execute", plan_hash: s.workflow.plan_hash });
    expect(s.store.get<any>("process_record", s.run.id)).toMatchObject({ status: "exited", confirmed: true });
    expect(s.store.get<any>("cli_dispatch_record", "crashed-dispatch").state).toBe("interrupted");
    expect(s.store.get<any>("run", s.run.id)).toMatchObject({ purpose: "implement", status: "stopped" });
    expect(s.store.get<any>("interruption", s.workflow.id)).toMatchObject({ source: "controller", prior_run_id: s.run.id, prior_purpose: "implement" });
    expect(s.conversations.getTree(s.workflow.id).nodes.find(n => n.id === s.rootNode.id)?.native_session_id).toBe("native-root");
    expect(s.store.list<any>(CONVERSATION_ENTITY.attempt, s.workflow.id).some(a => a.run_id === s.run.id && ["native", "owned_process_tree"].includes(a.stop_confirmation))).toBe(true);
    expect(s.dispatch).toHaveBeenCalledOnce();
  } finally { await manager.close(); await s.app.close(); s.store.close(); }
});

it("does not release a live owned tree or dispatch a duplicate after restart", async () => {
  const s = await fixture();
  const manager = new ProcessManager();
  const managed = manager.start({ id: s.run.id, executable: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"], cwd: s.root, env: {}, timeout_ms: 30000 });
  try {
    await managed.ready;
    s.store.put("process_record", s.run.id, s.workflow.id,
      { id: s.run.id, identity: { ...managed.identity }, status: "running", confirmed: false });
    const response = await s.recover();
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("PROCESS_STILL_ACTIVE");
    expect(s.engine.get(s.workflow.id).state).toBe("RECOVERY_REQUIRED");
    expect(s.dispatch).not.toHaveBeenCalled();
    expect(s.store.list(CONVERSATION_ENTITY.control, s.workflow.id)).toHaveLength(0);
  } finally { await manager.close(); await s.app.close(); s.store.close(); }
});

it.each(["missing", "unknown"])("fails closed with %s process identity instead of trusting the empty in-memory manager", async mode => {
  const s = await fixture();
  try {
    if (mode === "unknown") s.store.put("process_record", s.run.id, s.workflow.id,
      { id: s.run.id, status: "running", confirmed: false });
    const response = await s.recover();
    expect(response.json().error.code).toBe(mode === "missing" ? "PROCESS_RECORD_MISSING" : "PROCESS_STATE_UNKNOWN");
    expect(s.engine.get(s.workflow.id).state).toBe("RECOVERY_REQUIRED");
    expect(s.dispatch).not.toHaveBeenCalled();
  } finally { await s.app.close(); s.store.close(); }
});
