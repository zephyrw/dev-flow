import { expect, it } from "vitest";
import { setup, project } from "../helpers.js";
import { humanAcceptanceSummary } from "../../packages/core/src/waiting-context.js";
import type { Workflow } from "../../packages/contracts/src/index.js";

it("shows the current executor handoff and real address without treating review output as startup evidence", () => {
  const s = setup();
  try {
    const p = project(s.root); s.store.put("project", p.id, "global", p);
    const initial = s.engine.create({ project_id: p.id, title: "验收入口", request: "启动服务", complexity: "simple", workspace_mode: "new_worktree" }, "create");
    const w = { ...initial, state: "HUMAN_PENDING", plan_revision: 2 } as Workflow;
    const add = (id: string, purpose: string, revision: number, status: string, summary: string, at: string) => {
      s.store.put("run", id, w.id, { id, workflow_id: w.id, purpose, plan_revision: revision, status });
      s.store.put("execution_completion", id, w.id, { run_id: id, workflow_id: w.id, intent: "completed", summary, recorded_at: at });
    };
    add("executor", "functional_fix", 2, "completed", "已启动：[打开验收页面](http://127.0.0.1:15321)。password=private", "2026-09-29T01:00:00Z");
    add("old", "executor_test", 1, "completed", "旧计划地址", "2026-09-29T02:00:00Z");
    add("review", "quality_review", 2, "completed", "代码复核通过", "2026-09-29T03:00:00Z");
    add("failed", "functional_fix", 2, "failed", "启动失败", "2026-09-29T04:00:00Z");
    const handoff = humanAcceptanceSummary(s.store, w);
    expect(handoff?.run_id).toBe("executor");
    expect(handoff?.summary).toContain("http://127.0.0.1:15321");
    expect(handoff?.summary).not.toContain("private");
    expect(humanAcceptanceSummary(s.store, { ...w, state: "EXECUTING" })).toBeNull();
  } finally { s.store.close(); }
});
