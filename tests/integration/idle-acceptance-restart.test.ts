import { expect, it } from "vitest";
import { setup, project } from "../helpers.js";

it("preserves pending human acceptance on controller restart without accepting or rerunning it", () => {
  const s = setup();
  try {
    const p = project(s.root); s.store.put("project", p.id, "global", p);
    const created = s.engine.create({ project_id: p.id, title: "等待人工验收", request: "保持已完成工作", complexity: "simple", workspace_mode: "new_worktree" }, "create");
    const w = { ...created, state: "HUMAN_PENDING", stage: "accept", run_id: "finished-run", snapshot_id: "reviewed-snapshot" };
    s.store.put("workflow", w.id, p.id, w);
    s.engine.recover();
    expect(s.engine.get(w.id)).toEqual(w);
    expect(s.store.get("acceptance", w.id)).toBeUndefined();
    expect(s.store.list("run", w.id)).toEqual([]);
  } finally { s.store.close(); }
});

it("still reconciles an interrupted running invocation after restart", () => {
  const s = setup();
  try {
    const p = project(s.root); s.store.put("project", p.id, "global", p);
    const w = s.engine.create({ project_id: p.id, title: "执行任务", request: "继续执行", complexity: "simple", workspace_mode: "new_worktree" }, "create");
    s.store.put("workflow", w.id, p.id, { ...w, state: "EXECUTING", stage: "execute", run_id: "interrupted-run" });
    s.engine.recover();
    expect(s.engine.get(w.id).state).toBe("RECOVERY_REQUIRED");
    expect(s.engine.get(w.id).blocker?.code).toBe("CONTROLLER_RESTARTED");
  } finally { s.store.close(); }
});
