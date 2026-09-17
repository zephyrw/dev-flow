import { expect, it } from "vitest";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { setup } from "../helpers.js";
import { seedSourceChange } from "../fixtures/source-change.js";
import { SourceChangeService } from "../../packages/core/src/source-change.js";
import { buildServer } from "../../apps/api/src/server.js";
import { LocalRuntime } from "../../packages/runtime/src/runtime.js";
import { git } from "../../packages/git/src/git.js";
import { hash } from "../../packages/core/src/util.js";
import { changesFromInitialInput } from "../../packages/git/src/initial-state.js";

const headers = {
  host: "localhost:14810",
  origin: "http://localhost:14810",
  "content-type": "application/json",
};

it("保留已有未提交输入，但继续检测模型对这些文件的修改且不改动用户暂存区", async () => {
  const s = setup(),
    f = await seedSourceChange(s.engine, s.root);
  try {
    const service = new SourceChangeService(s.engine);
    const preview = await service.preview(f.id, s.engine.get(f.id).version);
    await service.resolve(f.id, {
      request_id: "input",
      preview_id: preview.id,
      choice: "continue",
    });
    const [ws] = await s.engine.git.prepare(
      f.project,
      f.id,
      "existing_workspace",
      { main: f.current },
    );
    const indexBefore = await git(f.repo, ["write-tree"]);
    expect(changesFromInitialInput(f.repo, ws!.initial_worktree_tree!)).toEqual(
      [],
    );
    writeFileSync(join(f.repo, "personal.txt"), "模型不应改动这份已有输入\n");
    expect(changesFromInitialInput(f.repo, ws!.initial_worktree_tree!)).toEqual(
      ["personal.txt"],
    );
    expect(await git(f.repo, ["write-tree"])).toBe(indexBefore);
  } finally {
    s.store.close();
  }
});

it("预览只读；使用当前代码保留计划、生成新批准记录并防止重复提交", async () => {
  const s = setup(),
    f = await seedSourceChange(s.engine, s.root),
    api = await buildServer(s.engine);
  try {
    const before = s.engine.get(f.id),
      original = s.engine.plan(f.id);
    const status = await git(f.repo, ["status", "--porcelain"]);
    const previewResult = await api.inject({
      method: "POST",
      url: `/api/workflows/${f.id}/source-change/preview`,
      headers,
      payload: { expected_version: before.version },
    });
    expect(previewResult.statusCode, previewResult.body).toBe(200);
    const preview = previewResult.json();
    expect(preview.repositories[0]).toMatchObject({
      previous_commit: f.old,
      current_commit: f.current,
    });
    expect(preview.repositories[0].commits[0]).toContain("补充项目说明");
    expect(preview.repositories[0].local_changes).toContain("personal.txt");
    expect(s.engine.get(f.id)).toEqual(before);
    const payload = {
      request_id: "choose-current",
      preview_id: preview.id,
      choice: "continue",
    };
    const send = () =>
      api.inject({
        method: "POST",
        url: `/api/workflows/${f.id}/source-change/resolve`,
        headers,
        payload,
      });
    const chosen = await send();
    expect(chosen.statusCode, chosen.body).toBe(200);
    expect(s.engine.get(f.id)).toMatchObject({
      state: "QUEUED",
      plan_revision: 2,
      workspace_mode: "existing_workspace",
    });
    const updated = s.engine.plan(f.id);
    expect(updated.plan.baselines.main).toBe(f.current);
    expect(updated.plan.scope).toEqual(original.plan.scope);
    expect(updated.plan.work_items).toEqual(original.plan.work_items);
    expect(updated.plan.acceptance_items).toEqual(
      original.plan.acceptance_items,
    );
    expect(updated.plan.design_ref!.content_hash).toBe(
      hash(updated.plan.markdown!),
    );
    expect(s.store.must<any>("approval", f.id + "-2").plan_hash).toBe(
      updated.hash,
    );
    expect(s.store.list("source_choice", f.id)).toHaveLength(1);
    expect(s.store.list("workspace", f.id)).toHaveLength(0);
    expect(s.store.list("run", f.id)).toHaveLength(0);
    expect((await send()).statusCode).toBe(200);
    expect(s.engine.get(f.id).plan_revision).toBe(2);
    expect(await git(f.repo, ["status", "--porcelain"])).toBe(status);
    expect(await git(f.repo, ["rev-parse", "HEAD"])).toBe(f.current);
    expect(readFileSync(join(f.repo, "personal.txt"), "utf8")).toBe(
      "用户未提交的内容\n",
    );
  } finally {
    await api.close();
    s.store.close();
  }
});

it("预览过期、代码再次改变、跨任务预览和模型令牌均不能触发执行", async () => {
  const s = setup(),
    f = await seedSourceChange(s.engine, s.root),
    service = new SourceChangeService(s.engine),
    api = await buildServer(s.engine);
  try {
    const before = s.engine.get(f.id),
      preview = await service.preview(f.id, before.version);
    const payload = {
      request_id: "stale-choice",
      preview_id: preview.id,
      choice: "continue",
    };
    expect(
      (
        await api.inject({
          method: "POST",
          url: `/api/workflows/${f.id}/source-change/resolve`,
          headers: { ...headers, authorization: "Bearer model" },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    writeFileSync(join(f.repo, "personal.txt"), "修改后的本地输入\n");
    await expect(service.resolve(f.id, payload)).rejects.toMatchObject({
      code: "SOURCE_CHANGED",
    });
    expect(s.engine.get(f.id)).toEqual(before);
    expect(s.store.list("source_choice", f.id)).toHaveLength(0);
    const refreshed = await service.preview(f.id, before.version);
    s.store.put("source_change_preview", refreshed.id, f.id, {
      ...refreshed,
      created_at: "2000-01-01T00:00:00Z",
    });
    await expect(
      service.resolve(f.id, { ...payload, preview_id: refreshed.id }),
    ).rejects.toMatchObject({ code: "PREVIEW_EXPIRED" });
    const other = await seedSourceChange(s.engine, s.root);
    await expect(service.resolve(other.id, payload)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      service.preview(f.id, before.version - 1),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  } finally {
    await api.close();
    s.store.close();
  }
});

it.each(["continue", "replan"] as const)(
  "选择 %s 后由真实规划或执行进程消费当前代码，保留主目录和本地修改",
  async (choice) => {
    const s = setup(),
      f = await seedSourceChange(s.engine, s.root),
      service = new SourceChangeService(s.engine),
      runtime = new LocalRuntime(s.engine);
    s.engine.runtime = runtime;
    try {
      const preview = await service.preview(f.id, s.engine.get(f.id).version);
      await service.resolve(f.id, {
        request_id: "real-choice",
        preview_id: preview.id,
        choice,
        instructions: "结合新说明检查原计划",
      });
      const expected =
        choice === "continue" ? "HUMAN_PENDING" : "REPAIR_PLAN_PENDING";
      const deadline = Date.now() + 90000;
      while (s.engine.get(f.id).state !== expected && Date.now() < deadline) {
        await s.engine.dispatch();
        if (s.engine.get(f.id).state === "BLOCKED")
          throw Error(JSON.stringify(s.engine.get(f.id).blocker));
        await new Promise((r) => setTimeout(r, 200));
      }
      await s.engine.waitForIdle(f.id);
      expect(s.engine.get(f.id).state).toBe(expected);
      expect(s.engine.plan(f.id).plan.baselines.main).toBe(f.current);
      expect(s.engine.get(f.id).workspace_mode).toBe("existing_workspace");
      const runs = s.store.list<any>("run", f.id);
      if (choice === "replan") {
        expect(runs.map((r) => r.stage)).toEqual(["planning"]);
        expect(s.store.get("approval", f.id + "-2")).toBeUndefined();
        expect(s.store.list("workspace", f.id)).toHaveLength(0);
        expect(readFileSync(join(f.repo, "app.txt"), "utf8")).toBe("before\n");
        const handoff = JSON.parse(
          readFileSync(
            join(
              s.config.storage_root,
              "native-runs",
              runs[0].id,
              "HANDOFF.json",
            ),
            "utf8",
          ),
        );
        expect(handoff.baselines.main).toBe(f.current);
        expect(handoff.selected_source.choice).toBe("replan");
        expect(handoff.feedback[0].text).toContain("结合新说明检查原计划");
      } else {
        expect(runs[0].stage).toBe("execute");
        expect(s.store.list<any>("workspace", f.id)[0]).toMatchObject({
          root: f.repo,
          owned: false,
          baseline: f.current,
        });
        expect(readFileSync(join(f.repo, "app.txt"), "utf8")).toBe("after\n");
      }
      expect(readFileSync(join(f.repo, "personal.txt"), "utf8")).toBe(
        "用户未提交的内容\n",
      );
      expect(await git(f.repo, ["rev-parse", "HEAD"])).toBe(f.current);
    } finally {
      await s.engine.waitForIdle(f.id);
      await runtime.close();
      s.store.close();
    }
  },
);

it("确认后、启动前文件再次改变时重新阻塞，不静默扩大已确认的输入", async () => {
  const s = setup(),
    f = await seedSourceChange(s.engine, s.root),
    service = new SourceChangeService(s.engine),
    runtime = new LocalRuntime(s.engine);
  s.engine.runtime = runtime;
  try {
    const preview = await service.preview(f.id, s.engine.get(f.id).version);
    await service.resolve(f.id, {
      request_id: "confirmed",
      preview_id: preview.id,
      choice: "continue",
    });
    writeFileSync(join(f.repo, "personal.txt"), "确认后再次变化\n");
    await s.engine.dispatch();
    await s.engine.waitForIdle(f.id);
    expect(s.engine.get(f.id)).toMatchObject({
      state: "BLOCKED",
      blocker: { code: "BASELINE_CHANGED" },
    });
    expect(s.store.list("run", f.id)).toHaveLength(0);
    expect(s.store.list("workspace", f.id)).toHaveLength(0);
  } finally {
    await runtime.close();
    s.store.close();
  }
});
