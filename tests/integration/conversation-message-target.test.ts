import { afterEach, expect, it } from "vitest";
import Fastify from "fastify";
import { setup } from "../helpers.js";
import { conversationPlugin } from "../../apps/api/src/routes/conversations.js";
import { ConversationService } from "../../packages/core/src/conversation-service.js";
import { CONVERSATION_ENTITY, type ConversationAttempt, type ConversationNode, type Workflow, type Run } from "../../packages/contracts/src/index.js";
import { resolveConversationMessageTarget } from "../../apps/web/src/conversation-message-target.js";

const opened: Array<{ app: ReturnType<typeof Fastify>; store: ReturnType<typeof setup>["store"] }> = [];
afterEach(async () => { for (const { app, store } of opened.splice(0)) { await app.close(); store.close(); } });

async function fixture() {
  const s = setup();
  const workflow: Workflow = { id: "wf", project_id: "p1", title: "root scope", request: "fixture", complexity: "simple",
    workspace_mode: "new_worktree", state: "EXECUTING", stage: "exec", version: 1, environment_revision: 0, plan_revision: 1,
    created_at: "2026-10-10", updated_at: "2026-10-10", feedback: [], run_id: "run-current" };
  s.store.put("workflow", "wf", "p1", workflow);
  for (const [id, generation] of [["history", 3], ["current", 4]] as const) {
    const node: ConversationNode = { id, root_id: id, kind: "main", project_id: "p1", workflow_id: "wf", adapter_id: "codex",
      title: id, purpose: "implement", lineage_id: `lineage-${id}`, created_at: "2026-10-10", updated_at: "2026-10-10" };
    const attempt: ConversationAttempt = { id: `attempt-${id}`, conversation_id: id, root_id: id, workflow_id: "wf",
      run_id: `run-${id}`, generation, status: "running", observed_at: "2026-10-10", freshness: "fresh" };
    const run: Run = { id: `run-${id}`, workflow_id: "wf", purpose: "implement", stage: "execute", status: "running",
      started_at: "2026-10-10", adapter: "codex", package_hash: "fixture", plan_revision: 1 };
    s.store.put(CONVERSATION_ENTITY.node, id, "wf", node);
    s.store.put(CONVERSATION_ENTITY.attempt, attempt.id, "wf", attempt);
    s.store.put("run", run.id, "wf", run);
  }
  const app = Fastify();
  await app.register(conversationPlugin, { conversations: new ConversationService(s.store), store: s.store, human: () => {} });
  await app.ready();
  opened.push({ app, store: s.store });
  const urls: string[] = [];
  const request: typeof fetch = async input => {
    const url = String(input); urls.push(url);
    const response = await app.inject({ method: "GET", url });
    return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
  };
  return { app, request, urls };
}

it("refreshes an explicitly viewed historical root through its real API scope without switching to the active root", async () => {
  const f = await fixture();
  const current = (await f.app.inject({ method: "GET", url: "/api/workflows/wf/conversations" })).json();
  expect(current.active_root_id).toBe("current");
  expect(current.nodes.map((node: ConversationNode) => node.id)).toEqual(["current"]);
  expect(await resolveConversationMessageTarget("wf", "history", 1, f.request)).toEqual({ rootId: "history", generation: 3 });
  expect(f.urls).toEqual(["/api/workflows/wf/conversations?root_id=history"]);
});

it("falls back from a removed root only after the real API reports 404", async () => {
  const f = await fixture();
  expect(await resolveConversationMessageTarget("wf", "removed-legacy", 9, f.request)).toEqual({ rootId: "current", generation: 4 });
  expect(f.urls).toEqual(["/api/workflows/wf/conversations?root_id=removed-legacy", "/api/workflows/wf/conversations"]);
});

it("does not switch roots or reuse a stale generation after a rejected scope refresh", async () => {
  const urls: string[] = [];
  const request: typeof fetch = async input => { urls.push(String(input)); return new Response("denied", { status: 403 }); };
  await expect(resolveConversationMessageTarget("wf", "history", 1, request)).rejects.toThrow("无法刷新目标会话");
  expect(urls).toEqual(["/api/workflows/wf/conversations?root_id=history"]);
});
