import { expect, it } from "vitest";
import { setup, project } from "../helpers.js";
import { buildServer } from "../../apps/api/src/server.js";

it("human browser acceptance of two workflows does not occupy automated browser capacity", async () => {
  const s = setup(), p = project(s.root);
  s.store.put("project", p.id, p.id, p);
  const ids = Array.from({ length: 2 }, () => {
    const w = s.engine.create({ project_id: p.id, title: "human", request: "fixture", complexity: "simple", workspace_mode: "existing_workspace" }, crypto.randomUUID());
    s.store.put("workflow", w.id, p.id, { ...w, state: "HUMAN_PENDING" }); return w.id;
  });
  const app = await buildServer(s.engine);
  const headers = { host: "localhost:14810", origin: "http://localhost:14810", "content-type": "application/json" };
  try {
    for (const id of ids) expect((await app.inject({ method: "POST", url: `/api/workflows/${id}/browser/lock`, headers, payload: {} })).statusCode).toBe(200);
    expect(s.store.list("human_browser_acceptance")).toHaveLength(2);
    expect(s.store.list("lease")).toHaveLength(0);
    expect(s.engine.scheduler.acquire("automated", "check", ["browser:session:check"])).toBeTruthy();
    s.engine.scheduler.acquire(ids[0]!, "human", ["browser:shared"]);
    for (const id of ids) expect((await app.inject({ method: "POST", url: `/api/workflows/${id}/browser/release`, headers, payload: {} })).statusCode).toBe(200);
    expect(s.store.get("lease", "browser:shared")).toBeUndefined();
    expect(s.store.get("lease", "browser:session:check")).toBeTruthy();
    expect(s.store.list("human_browser_acceptance")).toHaveLength(0);
  } finally { await app.close(); s.store.close(); }
});
