import { afterEach, expect, it } from "vitest";
import { plan, project, setup } from "../helpers.js";
import { objectHash } from "../../packages/core/src/util.js";
import { validatePlan } from "../../packages/plans/src/validate.js";

const stores: ReturnType<typeof setup>[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.store.close(); });

function native(projectHash: string, path: string) {
  return {
    task_model: "native-v2", revision: 1,
    design_ref: { summary: "继续工作台整改" },
    modules: [{ id: "ui", title: "工作台" }],
    work_items: [{ id: "W1", module_id: "ui", repo_id: "main", title: "更新交互", paths: [path], acceptance_ids: ["U1"] }],
    acceptance_items: [{ id: "U1", work_item_ids: ["W1"], layer: "unit", scenario: "显示交互", expected_outcome: "操作可用" }],
    scope: { allowed_paths: ["apps/web/src"] },
    baselines: { main: "a".repeat(40) }, project_config_hash: projectHash,
  };
}

it.each(["apps/web/src/main.tsx", "tests/unit/workbench.test.tsx"])(
  "submits native work item %s without a second path approval gate", (path) => {
    const s = setup(); stores.push(s);
    const p = project(s.root); s.store.put("project", p.id, "global", p);
    const w = s.engine.create({ project_id: p.id, title: "工作台整改", request: "按计划补齐交互", complexity: "simple", workspace_mode: "new_worktree" }, "create");
    const result = s.engine.submitPlan(w.id, native(objectHash(p), path), w.version, "plan");
    expect(result.state).toBe("PLAN_PENDING");
    expect(s.engine.plan(w.id).plan.work_items?.[0]?.paths).toEqual([path]);
    expect(s.engine.plan(w.id).plan.scope.allowed_paths).toEqual(["apps/web/src"]);
  },
);

it("allows older task paths to describe work without mirroring the scope list", () => {
  const input = plan("project-config", "a".repeat(40));
  input.scope.allowed_paths = ["src"];
  input.tasks[0]!.paths = ["src/app.ts", "tests/app.test.ts"];
  expect(validatePlan(input).plan.tasks[0]!.paths).toEqual(input.tasks[0]!.paths);
});

it("still rejects paths escaping the project and invalid task references", () => {
  expect(() => validatePlan(native("project-config", "../outside.ts"))).toThrow();
  const input = native("project-config", "apps/web/src/main.tsx");
  input.acceptance_items[0]!.work_item_ids = ["missing"];
  expect(() => validatePlan(input)).toThrow("引用的工作项不存在");
});
