import { it, expect } from "vitest";
import { validatePlan } from "../../packages/plans/src/validate.js";
import { prepared } from "../helpers.js";
import {
  startTask,
  testProgress,
  invalidateTaskProofs,
} from "../../packages/core/src/progress.js";
import { hash } from "../../packages/core/src/util.js";
import { git } from "../../packages/git/src/git.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
it("keeps downstream submissions and timestamps across prerequisite repair without repeating claims or restoring test evidence", async () => {
  const s = await prepared();
  try {
    const rec = s.engine.plan(s.workflow.id),
      original = rec.plan.tasks[0]!;
    rec.plan.task_model = "leaf-v1";
    rec.plan.modules = [{ id: "M1", title: "依赖链" }];
    rec.plan.scope.allowed_paths = [
      "app.txt",
      "two.txt",
      "three.txt",
      "four.txt",
    ];
    rec.plan.tasks = rec.plan.scope.allowed_paths.map((path, i) => ({
      ...original,
      id: `T0${i + 1}`,
      module_id: "M1",
      paths: [path],
      depends_on: i ? [`T0${i}`] : [],
      completion_checks: [{ path, contains: "after" }],
    }));
    s.store.put("plan", rec.id, s.workflow.id, rec);
    for (const task of rec.plan.tasks) {
      writeFileSync(join(s.repo, task.paths[0]!), "after\n");
      startTask(s.engine, s.principal, s.workflow.id, task.id);
      s.engine.claimTask(
        s.principal,
        s.workflow.id,
        task.id,
        "已核对细项文件内容并提交本次实现记录",
      );
    }
    const before = s.engine.taskStatus(s.workflow.id);
    const f = s.engine.files(s.principal, s.workflow.id, "main", true);
    f.broker.apply(f.root, rec.plan.scope, [
      {
        path: "app.txt",
        expected_hash: hash("after\n"),
        content: "after changed\n",
      },
    ]);
    // A paused view must show prior submissions rather than "not started".
    s.store.remove("task_activity", s.workflow.id);
    const changed = s.engine.taskStatus(s.workflow.id);
    expect(changed.map((t) => t.implementation_status)).toEqual([
      "needs_changes",
      "needs_recheck",
      "needs_recheck",
      "needs_recheck",
    ]);
    expect(changed.every((t) => t.has_implementation)).toBe(true);
    expect(changed.map((t) => t.completed_at)).toEqual(
      before.map((t) => t.completed_at),
    );
    startTask(s.engine, s.principal, s.workflow.id, "T01");
    s.engine.claimTask(
      s.principal,
      s.workflow.id,
      "T01",
      "修复前置实现后重新核验，其他实现无需重复提交",
    );
    const after = s.engine.taskStatus(s.workflow.id);
    expect(after.every((t) => t.completed)).toBe(true);
    expect(after.slice(1).map((t) => t.completed_at)).toEqual(
      before.slice(1).map((t) => t.completed_at),
    );
    expect(after.every((t) => t.status === "claimed")).toBe(true);
    expect(s.store.list("evidence", s.workflow.id)).toHaveLength(0);
    // Direct edits to a downstream file still invalidate that implementation.
    writeFileSync(join(s.repo, "three.txt"), "changed elsewhere\n");
    expect(s.engine.taskStatus(s.workflow.id).map((t) => t.completed)).toEqual([
      true,
      true,
      false,
      false,
    ]);
  } finally {
    s.store.close();
  }
});
it("tracks a leaf task, refuses premature completion, invalidates changed implementation and lists per-file diffs from task branch baseline", async () => {
  const s = await prepared();
  try {
    const rec = s.engine.plan(s.workflow.id);
    rec.plan.task_model = "leaf-v1";
    rec.plan.modules = [{ id: "M1", title: "文本" }];
    Object.assign(rec.plan.tasks[0]!, {
      module_id: "M1",
      completion_checks: [{ path: "app.txt", contains: "after" }],
    });
    s.store.put("plan", rec.id, s.workflow.id, rec);
    expect(() =>
      s.engine.claimTask(
        s.principal,
        s.workflow.id,
        "T01",
        "没有完成实际实现不得宣称已完成",
      ),
    ).toThrow("先调用");
    startTask(s.engine, s.principal, s.workflow.id, "T01");
    expect(s.engine.taskStatus(s.workflow.id)[0]?.implementation_status).toBe(
      "active",
    );
    expect(() =>
      s.engine.claimTask(
        s.principal,
        s.workflow.id,
        "T01",
        "尚未修改文件应当拒绝此次完成",
      ),
    ).toThrow("完成检查");
    const f = s.engine.files(s.principal, s.workflow.id, "main", true);
    f.broker.apply(f.root, rec.plan.scope, [
      { path: "app.txt", expected_hash: hash("before\n"), content: "after\n" },
    ]);
    s.engine.claimTask(
      s.principal,
      s.workflow.id,
      "T01",
      "已经实现 after 内容并核验文件",
    );
    expect(s.engine.taskStatus(s.workflow.id)[0]?.completed).toBe(true);
    const changes = await s.engine.git.changes(s.workflow.id);
    expect(changes[0]?.branch).toBe("task/fixture");
    expect(changes[0]?.baseline).toBe(s.baseline);
    expect(changes[0]?.files).toEqual([{ path: "app.txt", status: "M" }]);
    expect(changes[0]).not.toHaveProperty("diff");
    writeFileSync(join(f.root, "[special].txt"), "literal name\n");
    expect(
      (await s.engine.git.fileDiff(s.workflow.id, "main", "[special].txt"))
        .diff,
    ).toContain("+literal name");
    expect(
      (await s.engine.git.fileDiff(s.workflow.id, "main", "app.txt")).diff,
    ).toContain("+after");
    await expect(
      s.engine.git.fileDiff(s.workflow.id, "main", "../outside"),
    ).rejects.toThrow();
    writeFileSync(join(f.root, "新增 文件.txt"), "new\n");
    expect(
      (await s.engine.git.fileDiff(s.workflow.id, "main", "新增 文件.txt"))
        .diff,
    ).toContain("+new");
    f.broker.apply(f.root, rec.plan.scope, [
      { path: "app.txt", expected_hash: hash("after\n"), content: "changed\n" },
    ]);
    expect(s.engine.taskStatus(s.workflow.id)[0]?.completed).toBe(false);
    // A failed later task must not prevent returning to a prerequisite.
    rec.plan.tasks.push({
      ...rec.plan.tasks[0]!,
      id: "T02",
      depends_on: ["T01"],
    });
    s.store.put("plan", rec.id, s.workflow.id, rec);
    writeFileSync(join(f.root, "app.txt"), "after\n");
    startTask(s.engine, s.principal, s.workflow.id, "T01");
    s.engine.claimTask(
      s.principal,
      s.workflow.id,
      "T01",
      "修复前置细项后核对完成条件",
    );
    startTask(s.engine, s.principal, s.workflow.id, "T02");
    invalidateTaskProofs(s.engine, s.workflow.id);
    expect(() =>
      startTask(s.engine, s.principal, s.workflow.id, "T01"),
    ).not.toThrow();
    expect(s.engine.taskStatus(s.workflow.id).every((t) => !t.completed)).toBe(
      true,
    );
  } finally {
    s.store.close();
  }
});
it("counts current planned cases once; latest failure, skipped and stale results never inflate passes", async () => {
  const s = await prepared();
  try {
    const p = s.engine.plan(s.workflow.id).plan;
    p.tests[0]!.expected_case_ids = ["a", "a"];
    expect(() => validatePlan(p)).toThrow("不能重复");
    p.tests[0]!.expected_case_ids = ["a", "b"];
    const w = { ...s.workflow, snapshot_id: "snap", environment_revision: 1 };
    const base: any = {
      id: "one",
      test_id: p.tests[0]!.id,
      snapshot_id: "snap",
      environment_revision: 1,
      plan_revision: w.plan_revision,
      status: "passed",
      case_ids: ["a", "b"],
      cases: [
        { id: "a", status: "passed" },
        { id: "b", status: "passed" },
      ],
      created_at: "2026-09-14T00:00:00Z",
    };
    expect(
      testProgress(
        p,
        [base, { ...base, id: "two", created_at: "2026-09-14T00:00:01Z" }],
        w,
      ),
    ).toMatchObject({ total: 2, passed: 2 });
    const failed = {
      ...base,
      id: "three",
      status: "failed",
      cases: [
        { id: "a", status: "failed" },
        { id: "b", status: "skipped" },
      ],
      created_at: "2026-09-14T00:00:02Z",
    };
    expect(testProgress(p, [base, failed], w)).toMatchObject({
      total: 2,
      passed: 0,
      failed: 1,
    });
    expect(
      testProgress(p, [base], { ...w, snapshot_id: "other" }),
    ).toMatchObject({ total: 2, passed: 0, stale: 2 });
  } finally {
    s.store.close();
  }
});
