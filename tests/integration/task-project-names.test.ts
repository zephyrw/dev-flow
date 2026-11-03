import { it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, basename } from "node:path";
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
    const workflow = response.json().workflow;
    const workspace = s.store.list("workspace", workflow.id);
    const fileBefore = readFileSync(join(repo.repo, "app.txt"), "utf8");
    for (const title of [undefined, " ", "字".repeat(21)]) {
      expect((await app.inject({ method: "PATCH", url: `/api/workflows/${workflow.id}/name`, headers, payload: { title } })).statusCode).toBe(422);
    }
    const renameTask = await app.inject({ method: "PATCH", url: `/api/workflows/${workflow.id}/name`, headers, payload: { title: " 新任务名称 " } });
    expect(renameTask.statusCode).toBe(200);
    expect(renameTask.json().title).toBe("新任务名称");
    expect(s.store.must("workflow", workflow.id)).toEqual(workflow);
    // Simulate a delayed executor writing its earlier workflow snapshot.
    s.store.put("workflow", workflow.id, p.id, { ...workflow, version: workflow.version + 1 });
    expect(s.engine.get(workflow.id).title).toBe("新任务名称");
    expect((await app.inject({ method: "GET", url: "/api/workflows?visibility=visible", headers })).json()[0].title).toBe("新任务名称");
    const page = await app.inject({ method: "GET", url: `/api/workflows/${workflow.id}?view=page`, headers });
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json().workflow.title).toBe("新任务名称");
    for (const payload of [{}, { confirmed: false }]) {
      expect((await app.inject({ method: "DELETE", url: `/api/projects/${p.id}`, headers, payload })).statusCode).toBe(422);
    }
    expect((await list()).json()).toHaveLength(1);
    const removed = await app.inject({ method: "DELETE", url: `/api/projects/${p.id}`, headers, payload: { confirmed: true } });
    expect(removed.statusCode).toBe(200);
    expect((await list()).json()).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/api/workflows?visibility=visible", headers })).json()).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/api/workflows?visibility=all", headers })).json()).toHaveLength(1);
    expect(s.store.must("project", p.id)).toEqual(p);
    expect(s.store.list("workspace", workflow.id)).toEqual(workspace);
    expect(s.engine.get(workflow.id)).toMatchObject({ state: workflow.state, stage: workflow.stage, request: workflow.request });
    expect(readFileSync(join(repo.repo, "app.txt"), "utf8")).toBe(fileBefore);
    expect((await app.inject({ method: "DELETE", url: `/api/projects/${p.id}`, headers, payload: { confirmed: true } })).statusCode).toBe(200);
    const newTask = await app.inject({ method: "POST", url: "/api/workflows", headers, payload: { ...payload, request_id: "reattach-project", title: "重新关联项目", workspace_mode: "new_worktree" } });
    expect(newTask.statusCode, newTask.body).toBe(200);
    expect((await list()).json()[0].name).toBe("我的项目");
  } finally {
    dispatch.mockRestore();
    await app.close();
    s.store.close();
  }
});
