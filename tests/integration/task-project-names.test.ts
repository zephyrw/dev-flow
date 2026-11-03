import { it, expect, vi } from "vitest";
import { basename } from "node:path";
import { setup, repository, project, testConsoleHeaders, seedCreateAccess } from "../helpers.js";
import { buildServer } from "../../apps/api/src/server.js";

it("项目默认目录名、重命名持久化且不改变配置；任务名称必填并限制 20 字", async () => {
  const s = setup();
  const repo = await repository(s.root);
  const p = project(repo.repo);
  s.store.put("project", p.id, p.id, p);
  const dispatch = vi.spyOn(s.engine, "dispatch").mockResolvedValue(undefined);
  seedCreateAccess(s.store);
  const app = await buildServer(s.engine);
  const headers = testConsoleHeaders();
  try {
    const list = () => app.inject({ method: "GET", url: "/api/projects", headers });
    expect((await list()).json()[0].name).toBe(basename(repo.repo));
    for (const name of [" ", "字".repeat(101)]) {
      expect((await app.inject({ method: "PATCH", url: `/api/projects/${p.id}/name`, headers, payload: { name } })).statusCode).toBe(422);
    }
    const renamed = await app.inject({ method: "PATCH", url: `/api/projects/${p.id}/name`, headers, payload: { name: " 我的项目 " } });
    expect(renamed.statusCode).toBe(200);
    expect((await list()).json()[0]).toMatchObject({ name: "我的项目", repositories: p.repositories });
    expect(s.store.must("project", p.id)).toEqual(p);
    const payload = { request_id: "named-task", workspace_root: repo.repo, request_text: "完整需求不应成为任务名称", workspace_mode: "existing_workspace" };
    for (const title of [undefined, " ", "字".repeat(21)]) {
      expect((await app.inject({ method: "POST", url: "/api/workflows", headers, payload: { ...payload, title } })).statusCode).toBe(422);
    }
    expect(s.store.list("workflow")).toHaveLength(0);
    const title = "字".repeat(20);
    const response = await app.inject({ method: "POST", url: "/api/workflows", headers, payload: { ...payload, title } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().workflow).toMatchObject({ title, request: payload.request_text });
    expect((await app.inject({ method: "POST", url: "/api/workflows", headers, payload: { ...payload, title } })).json().is_existing).toBe(true);
  } finally {
    dispatch.mockRestore();
    await app.close();
    s.store.close();
  }
});
