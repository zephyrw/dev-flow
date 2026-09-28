import { expect, it, vi } from "vitest";
import { setup } from "../helpers.js";
import { buildServer } from "../../apps/api/src/server.js";
import { conversationServiceOf } from "../../packages/runtime/src/profile-runtime.js";
import { CONVERSATION_ENTITY } from "../../packages/contracts/src/conversation.js";
import { CONVERSATION_CONTROL_FENCE } from "../../packages/core/src/conversation-control.js";

it("pauses the current generation instead of reusing an older completed fence, then stays idempotent", async () => {
  const s = setup();
  const stopConversation = vi.fn(async (_target: unknown) => ({ accepted: true, confirmation: "exited" as const }));
  s.engine.runtime = { stopConversation } as any;
  const app = await buildServer(s.engine, { accountService: { getRepository: () => ({}) } as any });
  const conversations = conversationServiceOf(s.store);
  const workflow = { id: "wf", project_id: "project", title: "fixture", request: "fixture", complexity: "simple",
    workspace_mode: "existing_workspace", state: "EXECUTING", stage: "execute", version: 1,
    plan_revision: 1, environment_revision: 0, feedback: [], created_at: "2026-09-28T00:00:00Z", updated_at: "2026-09-28T00:00:00Z" };
  const discover = (runId: string) => {
    s.store.put("workflow", "wf", "project", { ...workflow, run_id: runId });
    s.store.put("run", runId, "wf", { id: runId, workflow_id: "wf", adapter: "agy", purpose: "implement",
      stage: "execute", status: "running", plan_revision: 1, started_at: "2026-09-28T00:00:00Z", package_hash: "fixture" });
    return conversations.applyEvent({ project_id: "project", workflow_id: "wf", run_id: runId,
      adapter_id: "agy", scope: "fixture", lineage_id: "lineage", purpose: "implement", root_native_id: "native-root" },
    { source_id: runId, source_seq: "1", root_native_id: "native-root", session_native_id: "native-root",
      kind: "discovered", payload: { title: "root", status: "running" } }).node!;
  };
  try {
    const root = discover("old-run");
    await s.engine.pauseTree!("wf", { request_id: "old-pause", action: "pause", root_id: root.id, expected_generation: 0 });
    const oldControl = s.store.list<any>(CONVERSATION_ENTITY.control, "wf")[0];
    expect(oldControl.status).toBe("complete");
    expect(discover("current-run").id).toBe(root.id);
    const current = conversations.getTree("wf").attempts.find((a) => a.run_id === "current-run")!;
    expect(current.generation).toBe(1);

    await s.engine.pauseTree!("wf", { request_id: "current-pause", action: "pause", root_id: root.id, expected_generation: 1 });
    expect(stopConversation).toHaveBeenCalledTimes(2);
    expect(stopConversation.mock.calls[1]?.[0]).toMatchObject({ attempt_id: current.id });
    expect(s.store.get<any>(CONVERSATION_ENTITY.attempt, current.id)?.status).toBe("paused");
    const controls = s.store.list<any>(CONVERSATION_ENTITY.control, "wf");
    expect(controls).toHaveLength(2);
    expect(controls.find((c) => c.expected_generation === 1)).toMatchObject({ status: "complete", unconfirmed_count: 0 });
    expect(s.store.list<any>(CONVERSATION_CONTROL_FENCE, "wf").map((f) => f.expected_generation).sort()).toEqual([0, 1]);

    await s.engine.pauseTree!("wf", { request_id: "repeat-current-pause", action: "pause", root_id: root.id, expected_generation: 1 });
    expect(stopConversation).toHaveBeenCalledTimes(2);
    expect(s.store.list(CONVERSATION_ENTITY.control, "wf")).toHaveLength(2);
  } finally {
    await app.close();
    s.store.close();
  }
});
