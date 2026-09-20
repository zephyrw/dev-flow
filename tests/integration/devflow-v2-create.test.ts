import { describe, it, expect } from "vitest";
import { setup, repository, project, proof } from "../helpers.js";
import { CreateWorkflowService } from "../../packages/core/src/create-workflow.js";
import { LocalRuntime } from "../../packages/runtime/src/runtime.js";
import { buildServer } from "../../apps/api/src/server.js";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { git } from "../../packages/git/src/git.js";
const headers = {
  host: "localhost:14810",
  origin: "http://localhost:14810",
  "content-type": "application/json",
};
describe("新任务真实 API/原生 CLI 进程/SQLite/Git", { timeout: 120000 }, () => {
  it("创建派发规划，批准后开发与程序自查，人工确认触发终审和真实提交", async () => {
    const s = setup(),
      repo = await repository(s.root),
      p = project(repo.repo);
    s.store.put("project", p.id, "global", p);
    s.store.put("tool_profile", "profile-codex", "global", {
      id: "profile-codex",
      revision: 1,
      adapterId: "codex",
      executableRef: process.execPath,
      modelSelection: "explicit",
      modelId: "fixture-only",
      options: { prefixArgs: [resolve("tests/fixtures/native-cli.mjs")] },
    });
    const runtime = new LocalRuntime(s.engine);
    s.engine.runtime = runtime;
    const app = await buildServer(s.engine);
    let id: string | undefined;
    const wait = async (state: string) => {
      const end = Date.now() + 90000;
      while (Date.now() < end) {
        await s.engine.dispatch();
        const w = s.engine.get(id!);
        if (w.state === "BLOCKED") throw new Error(JSON.stringify(w.blocker));
        if (w.state === state) {
          await s.engine.waitForIdle(id!);
          return;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error("Timed out waiting for " + state);
    };
    try {
      const payload = {
        request_id: "req-real",
        workspace_root: repo.repo,
        request_text: "按唯一原计划修改 app.txt",
        workspace_mode: "existing_workspace",
        planner_profile_id: "profile-codex",
        executor_profile_id: "profile-codex",
      };
      const created = await app.inject({
        method: "POST",
        url: "/api/workflows",
        headers,
        payload,
      });
      expect(created.statusCode, created.body).toBe(200);
      id = created.json().workflow.id;
      await wait("PLAN_PENDING");
      expect(s.store.list<any>("run", id)).toHaveLength(1);
      expect(s.store.list<any>("run", id)[0]).toMatchObject({
        status: "completed",
        adapter: "codex",
        profile: { modelId: "fixture-only" },
      });
      const duplicate = await app.inject({
        method: "POST",
        url: "/api/workflows",
        headers,
        payload,
      });
      expect(duplicate.json().workflow.id).toBe(id);
      const conflict = await app.inject({
        method: "POST",
        url: "/api/workflows",
        headers,
        payload: { ...payload, request_text: "不同需求" },
      });
      expect(conflict.statusCode).toBe(409);
      const early = await app.inject({
        method: "POST",
        url: "/api/workflows/" + id + "/cleanup/retry",
        headers,
        payload: {},
      });
      expect(early.statusCode).toBe(409);
      expect(await git(repo.repo, ["rev-parse", "HEAD"])).toBe(repo.baseline);
      const approval = proof(s.engine, id!, "approve");
      s.engine.approve(id!, approval.proof, approval.binding);
      await wait("HUMAN_PENDING");
      expect(readFileSync(join(repo.repo, "app.txt"), "utf8")).toBe("after\n");
      const runs = s.store.list<any>("run", id);
      expect(runs.map((r) => r.stage)).toEqual([
        "planning",
        "execute",
        "quality_before_human",
      ]);
      expect(
        runs.every(
          (r) => r.profile.modelId === "fixture-only" && r.exit_code === 0,
        ),
      ).toBe(true);
      expect(
        s.store.list("native_execution", runs[1].id).length,
      ).toBeGreaterThan(0);
      const w = s.engine.get(id!);
      const confirm = await app.inject({
        method: "POST",
        url: "/api/workflows/" + id + "/confirm-function",
        headers,
        payload: {
          request_id: "confirmed",
          expected_version: w.version,
          snapshot_id: w.snapshot_id,
        },
      });
      expect(confirm.statusCode, confirm.body).toBe(200);
      await wait("COMMITTED");
      expect(await git(repo.repo, ["show", "HEAD:app.txt"])).toBe("after");
      expect(s.store.get("acceptance", id!)).toBeDefined();
    } finally {
      if (id && !["COMMITTED", "COMPLETED"].includes(s.engine.get(id).state))
        await s.engine.stop(id);
      if (id) await s.engine.waitForIdle(id);
      await runtime.close();
      await app.close();
      s.store.close();
    }
  });
  it("无效工具或非 Git 目录拒绝创建，不能持久化假 Project/Run", async () => {
    const s = setup();
    try {
      const service = new CreateWorkflowService(s.store);
      expect(() =>
        service.execute({
          request_id: "bad",
          workspace_root: s.root,
          request_text: "需求",
          planner_profile_id: "codegemma",
        }),
      ).toThrow();
      expect(() =>
        service.execute({
          request_id: "bad2",
          workspace_root: s.root,
          request_text: "需求",
        }),
      ).toThrow();
      expect(s.store.list("project")).toHaveLength(0);
      expect(s.store.list("run")).toHaveLength(0);
    } finally {
      s.store.close();
    }
  });
});
