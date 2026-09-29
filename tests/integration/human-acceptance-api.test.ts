import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../../apps/api/src/server.js";
import { setup, plan, project } from "../helpers.js";
import { objectHash } from "../../packages/core/src/util.js";

const open: Array<{ app: Awaited<ReturnType<typeof buildServer>>; store: ReturnType<typeof setup>["store"] }> = [];
afterEach(async () => {
  for (const { app, store } of open.splice(0)) { await app.close(); store.close(); }
});
const headers = { host: "localhost:14810", origin: "http://localhost:14810", "content-type": "application/json" };

async function fixture() {
  const s = setup();
  const p = project(s.root); s.store.put("project", p.id, "global", p);
  const initial = s.engine.create({ project_id: p.id, title: "验收请求信封", request: "测试请求兼容",
    complexity: "simple", workspace_mode: "existing_workspace" }, crypto.randomUUID());
  s.engine.submitPlan(initial.id, plan(objectHash(p), "a".repeat(40)), initial.version, "plan");
  const pending = s.engine.get(initial.id);
  s.engine.transition(initial.id, [pending.state], "HUMAN_PENDING", "accept");
  // No runtime or real account service is installed: HTTP injection cannot launch a CLI.
  const app = await buildServer(s.engine, { accountService: { getRepository: () => ({}) } as any });
  open.push({ app, store: s.store });
  const binding = s.engine.binding(initial.id, "accept");
  return { ...s, app, id: initial.id, binding };
}

describe("human acceptance console envelope", () => {
  it.each(["legacy", "v2"])("accepts the %s envelope and queues only the existing review transition", async version => {
    const s = await fixture();
    const payload = { binding: s.binding, ...(version === "v2" ? { schema_version: 2, request_id: crypto.randomUUID() } : {}) };
    const response = await s.app.inject({ method: "POST", url: `/api/workflows/${s.id}/accept`, headers, payload });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ id: s.id, state: "REVIEW_QUEUED" });
    expect(s.store.get("acceptance", s.id)).toBeDefined();
    expect(s.store.list("human_proof")).toHaveLength(0);
    expect(s.store.list("run", s.id)).toHaveLength(0);
  });

  it("still rejects stale acceptance bindings without changing the workflow", async () => {
    const s = await fixture();
    const response = await s.app.inject({ method: "POST", url: `/api/workflows/${s.id}/accept`, headers,
      payload: { schema_version: 2, request_id: crypto.randomUUID(), binding: { ...s.binding, version: s.binding.version - 1 } } });
    expect(response.statusCode).toBe(409);
    expect(response.body).toContain("BINDING_CHANGED");
    expect(s.engine.get(s.id).state).toBe("HUMAN_PENDING");
    expect(s.store.get("acceptance", s.id)).toBeUndefined();
    expect(s.store.list("human_proof")).toHaveLength(0);
  });

  it("keeps unknown payload fields, invalid envelopes and model callers rejected", async () => {
    const s = await fixture();
    for (const extra of [{ bypass: true }, { schema_version: 3 }, { request_id: "invalid" }]) {
      const response = await s.app.inject({ method: "POST", url: `/api/workflows/${s.id}/accept`, headers,
        payload: { binding: s.binding, ...extra } });
      expect(response.statusCode).toBe(422);
    }
    const forbidden = await s.app.inject({ method: "POST", url: `/api/workflows/${s.id}/accept`,
      headers: { ...headers, authorization: "Bearer fixture-model-token" },
      payload: { schema_version: 2, request_id: crypto.randomUUID(), binding: s.binding } });
    expect(forbidden.statusCode).toBe(403);
    expect(s.engine.get(s.id).state).toBe("HUMAN_PENDING");
    expect(s.store.get("acceptance", s.id)).toBeUndefined();
  });
});
