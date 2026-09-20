import { it, expect } from "vitest";
import { join } from "node:path";
import { setup, project, plan } from "../helpers.js";
import { objectHash } from "../../packages/core/src/util.js";
import { HandoffBuilder } from "../../packages/adapters/agy/src/handoff.js";

it("native plan submission and both handoffs preserve new and regression E2E cases without browser scenes", async () => {
  const s = setup();
  try {
    const proj = project(s.root);
    proj.commands = [];
    s.store.put("project", proj.id, proj.id, proj);
    const p = plan(objectHash(proj), "a".repeat(40));
    p.task_model = "native-v2";
    p.exemptions = [];
    p.tests = (["unit", "integration", "e2e"] as const).map((layer) => ({
      ...p.tests[0]!, id: layer, layer, command_id: undefined,
      expected_case_ids: layer === "e2e" ? ["NEW-01", "REG-01"] : [layer],
      steps: layer === "e2e" ? ["完成新需求流程", "重走共享模块影响的旧流程"] : ["执行目标行为"],
    }));
    p.tasks[0]!.test_ids = p.tests.map((t) => t.id);
    const w = s.engine.create({
      project_id: proj.id, title: "三层测试提交", request: "覆盖新旧业务流程",
      complexity: "simple", workspace_mode: "existing_workspace",
    }, "three-layers-create");
    await s.engine.submitPlan(w.id, p, w.version, "three-layers-plan");
    expect(s.engine.get(w.id).state).toBe("PLAN_PENDING");
    expect(proj.browser_scenes).toEqual([]);
    const stored = s.engine.plan(w.id).plan;
    const args = {
      workflow: s.engine.get(w.id),
      plan: stored,
      runId: "run-test",
      packageHash: "pkg-test",
      directory: join(s.root, "container"),
    };
    for (const pkg of [HandoffBuilder.buildFullHandoff(args), HandoffBuilder.buildResumeHandoff({ ...args, conversationId: "conv-test" })]) {
      expect(pkg.index.acceptance_items.find((t) => t.layer === "e2e")?.expected_case_ids).toEqual(["NEW-01", "REG-01"]);
      expect(pkg.test_exemptions).toEqual([]);
      expect(pkg.instructions).toContain("新需求全部业务流程");
      expect(pkg.instructions).toContain("旧功能回归");
      expect(pkg.instructions).toContain("真实浏览器连接真实应用");
      expect(pkg.instructions).toContain("仍保留用户功能确认");
    }
    stored.exemptions = [{ layer: "integration", reason: "无集成边界的任务须保留明确批准的豁免依据" }];
    const pkg = HandoffBuilder.buildResumeHandoff({ ...args, plan: stored, conversationId: "conv-test" });
    expect(pkg.test_exemptions).toEqual(stored.exemptions);
  } finally {
    s.store.close();
  }
});
