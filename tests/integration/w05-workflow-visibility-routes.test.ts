import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { setup, repository, project } from "../helpers.js";
import { buildServer } from "../../apps/api/src/server.js";

describe("W05: 任务归档与可见性 HTTP 接口集成测试", () => {
  let fixtureRoot: string | undefined;

  afterEach(() => {
    if (fixtureRoot) {
      try {
        rmSync(fixtureRoot, { recursive: true, force: true });
      } catch {}
    }
  });

  it("通过 REST 接口测试归档、恢复、列表过滤与归档查询", async () => {
    const s = setup();
    fixtureRoot = s.root;
    const r = await repository(s.root);
    const p = project(r.repo);
    await s.engine.registerProject(p);

    const app = await buildServer(s.engine);

    // 创建两个任务
    const w1 = s.engine.create(
      {
        project_id: p.id,
        title: "任务一 (保持活跃)",
        request: "需求1",
        complexity: "simple",
        workspace_mode: "existing_workspace",
      },
      "fixture-w1",
    );

    const w2 = s.engine.create(
      {
        project_id: p.id,
        title: "任务二 (待归档)",
        request: "需求2",
        complexity: "simple",
        workspace_mode: "existing_workspace",
      },
      "fixture-w2",
    );

    const headers = {
      host: "localhost:14810",
      origin: "http://localhost:14810",
    };

    // 1. 默认 GET /api/workflows 返回全部
    const resAll = await app.inject({
      method: "GET",
      url: "/api/workflows",
      headers,
    });
    expect(resAll.statusCode).toBe(200);
    const allFlows = resAll.json();
    expect(allFlows.some((f: any) => f.id === w1.id)).toBe(true);
    expect(allFlows.some((f: any) => f.id === w2.id)).toBe(true);

    // 2. 读取 w2 的初始可见性
    const resVis = await app.inject({
      method: "GET",
      url: `/api/workflows/${w2.id}/visibility`,
      headers,
    });
    expect(resVis.statusCode).toBe(200);
    const visData = resVis.json();
    expect(visData.visibility.archived).toBe(false);
    expect(visData.visibility.revision).toBe(0);

    // 3. 将 w2 归档
    const resArchive = await app.inject({
      method: "PUT",
      url: `/api/workflows/${w2.id}/visibility`,
      headers,
      payload: {
        request_id: "req-vis-archive-1",
        expected_visibility_revision: 0,
        archived: true,
      },
    });
    expect(resArchive.statusCode).toBe(200);
    const archiveData = resArchive.json();
    expect(archiveData.changed).toBe(true);
    expect(archiveData.visibility.archived).toBe(true);
    expect(archiveData.visibility.revision).toBe(1);

    // 4. GET /api/workflows?visibility=visible 仅包含 w1
    const resVisible = await app.inject({
      method: "GET",
      url: "/api/workflows?visibility=visible",
      headers,
    });
    expect(resVisible.statusCode).toBe(200);
    const visibleFlows = resVisible.json();
    expect(visibleFlows.some((f: any) => f.id === w1.id)).toBe(true);
    expect(visibleFlows.some((f: any) => f.id === w2.id)).toBe(false);

    // 5. GET /api/workflows?visibility=archived 仅包含 w2
    const resArchived = await app.inject({
      method: "GET",
      url: "/api/workflows?visibility=archived",
      headers,
    });
    expect(resArchived.statusCode).toBe(200);
    const archivedFlows = resArchived.json();
    expect(archivedFlows.some((f: any) => f.id === w1.id)).toBe(false);
    expect(archivedFlows.some((f: any) => f.id === w2.id)).toBe(true);

    // 6. GET /api/archives 包含 w2 的摘要并支持按 query 检索
    const resArchivesList = await app.inject({
      method: "GET",
      url: `/api/archives?q=${encodeURIComponent("待归档")}`,
      headers,
    });
    expect(resArchivesList.statusCode).toBe(200);
    const archivesJson = resArchivesList.json();
    expect(archivesJson.items.length).toBe(1);
    expect(archivesJson.items[0].workflow_id).toBe(w2.id);
    expect(archivesJson.items[0].title).toBe("任务二 (待归档)");

    // 7. 将 w2 恢复
    const resRestore = await app.inject({
      method: "PUT",
      url: `/api/workflows/${w2.id}/visibility`,
      headers,
      payload: {
        request_id: "req-vis-restore-1",
        expected_visibility_revision: 1,
        archived: false,
      },
    });
    expect(resRestore.statusCode).toBe(200);
    const restoreData = resRestore.json();
    expect(restoreData.changed).toBe(true);
    expect(restoreData.visibility.archived).toBe(false);
    expect(restoreData.visibility.revision).toBe(2);

    // 8. 恢复后 GET /api/workflows?visibility=visible 重新包含 w1 与 w2
    const resVisibleAfter = await app.inject({
      method: "GET",
      url: "/api/workflows?visibility=visible",
      headers,
    });
    expect(resVisibleAfter.statusCode).toBe(200);
    const visibleAfterFlows = resVisibleAfter.json();
    expect(visibleAfterFlows.some((f: any) => f.id === w1.id)).toBe(true);
    expect(visibleAfterFlows.some((f: any) => f.id === w2.id)).toBe(true);

    await app.close();
  });
});
