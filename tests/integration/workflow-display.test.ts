import { afterEach, beforeEach, expect, it } from "vitest";
import { buildServer } from "../../apps/api/src/server.js";
import { setup, project, testConsoleHeaders } from "../helpers.js";
import { now } from "../../packages/core/src/util.js";
import { ConversationService } from "../../packages/core/src/conversation-service.js";

let env: ReturnType<typeof setup>;
let app: Awaited<ReturnType<typeof buildServer>>;
const headers = { host: testConsoleHeaders().host, origin: testConsoleHeaders().origin };
const url = "/api/workflows/wf_display";
beforeEach(async () => {
  env = setup();
  env.store.put("project", "p1", "p1", project(env.root));
  env.store.put("workflow", "wf_display", "p1", {
    id: "wf_display", project_id: "p1", title: "展示", request: "展示进度",
    state: "STOPPED", stage: "execute", version: 1, plan_revision: 0,
    environment_revision: 0, created_at: now(), updated_at: now(),
    feedback: ["historical guidance"], run_id: "r_display",
  });
  env.store.put("run", "r_display", "wf_display", {
    id: "r_display", workflow_id: "wf_display", status: "stopped", stage: "execute",
    purpose: "implement", adapter: "codex", plan_revision: 0, started_at: now(),
    continuation: { instructions: "large historical context".repeat(10000) },
    frozen_invocation: { private_context: "not needed by display" },
  });
  env.store.event("wf_display", "p1", "UserGuidance", { text: "hello" });
  app = await buildServer(env.engine);
});
afterEach(async () => { await app?.close(); env?.store.close(); });

it("returns a bounded display projection while preserving authoritative history", async () => {
  for (let i = 0; i < 250; i++) env.store.event("wf_display", "p1", "ConversationUpdated", { text: "unused context" });
  const response = await app.inject({ url: url + "?view=page", headers });
  expect(response.statusCode).toBe(200);
  const page = response.json();
  expect(page.runs[0]).toMatchObject({ id: "r_display", status: "stopped" });
  expect(page.runs[0].continuation).toBeUndefined();
  expect(page.runs[0].frozen_invocation?.private_context).toBeUndefined();
  expect(page.events.map((event: any) => event.type)).toEqual(["UserGuidance"]);
  expect(page.workflow.feedback).toEqual([]);
  expect(env.store.get<any>("run", "r_display")!.continuation.instructions.length).toBeGreaterThan(100000);
  expect(env.store.get<any>("workflow", "wf_display")!.feedback).toEqual(["historical guidance"]);
  const history = await app.inject({ url: url + "/history?limit=100", headers });
  expect(history.json().events).toHaveLength(100);
  expect(history.json().next_before).not.toBeNull();
});

it("reuses an unchanged snapshot and sends only new events without repeating plan material", async () => {
  const first = (await app.inject({ url: url + "?view=page", headers })).json();
  const same = (await app.inject({ url: url + "?view=page&since=" + encodeURIComponent(first.display_revision), headers })).json();
  expect(same.unchanged).toBe(true);
  env.store.event("wf_display", "p1", "Stopped", { message: "paused" });
  const next = (await app.inject({
    url: url + `?view=page&after=${first.event_cursor}&material=${first.material_revision}&since=${encodeURIComponent(first.display_revision)}`, headers,
  })).json();
  expect(next.unchanged).toBeUndefined();
  expect(next.events.map((event: any) => event.type)).toEqual(["Stopped"]);
  expect(next.plan).toBeUndefined();
  expect(next.display_revision).not.toBe(first.display_revision);
});

it("reads recent tool observations without traversing unrelated execution history", async () => {
  for (let i = 0; i < 250; i++) env.store.event("wf_display", "p1", "ConversationUpdated", {});
  env.store.event("wf_display", "p1", "AgentEvent", { step_update: { tool_name: "run_command", tool_info: { parameters: { CommandLine: "pnpm test" } } } });
  const response = await app.inject({ url: url + "/history?view=progress&limit=200", headers });
  expect(response.statusCode).toBe(200);
  expect(response.json().events).toHaveLength(1);
  expect(response.json().events[0].type).toBe("AgentEvent");
  const runtime = (await app.inject({ url: url + "?view=runtime", headers })).json();
  expect(runtime.workflow.state).toBe("STOPPED");
  expect(runtime.runs).toEqual([]);
  expect(runtime.events).toEqual([]);
});

it("preserves conversation identity and requested model with lightweight run projections", () => {
  const run = env.store.get<any>("run", "r_display")!;
  env.store.put("run", run.id, run.workflow_id, {
    ...run, conversation_id: "native-session",
    frozen_invocation: { ...run.frozen_invocation, modelToken: "requested-model" },
  });
  const conversations = new ConversationService(env.store);
  const full = conversations.getTree("wf_display");
  const projected = conversations.getTree("wf_display", undefined, env.store.runSummaries("wf_display"));
  expect(projected).toEqual(full);
  expect(projected.attempts[0]!.requested_model).toBe("requested-model");
  expect(projected.nodes[0]!.native_session_id).toBe("native-session");
});
