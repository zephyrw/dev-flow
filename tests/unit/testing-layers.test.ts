import { describe, expect, it } from "vitest";
import { validatePlan } from "../../packages/plans/src/validate.js";
import { PlanSchema } from "../../packages/contracts/src/index.js";
import { AcceptanceCaseSchema } from "../../packages/contracts/src/quality.js";
import { plan } from "../helpers.js";

function threeLayers() {
  const p = plan("config", "a".repeat(40));
  p.task_model = "native-v2";
  p.exemptions = [];
  p.tests = (["unit", "integration", "e2e"] as const).map((layer) => ({
    ...p.tests[0]!, id: layer, layer,
    expected_case_ids: layer === "e2e" ? ["NEW-01", "REG-01"] : [layer],
  }));
  p.tasks[0]!.test_ids = p.tests.map((t) => t.id);
  return p;
}

describe("三层测试合同", () => {
  it.each(["native-v2", "legacy"] as const)("%s plans need only unit/integration/E2E, without an OpenTabs exemption", (mode) => {
    const p = threeLayers();
    p.task_model = mode;
    expect(validatePlan(p).plan.tests.map((t) => t.layer)).toEqual(["unit", "integration", "e2e"]);
  });
  it.each(["unit", "integration", "e2e"] as const)("missing %s still blocks submission unless explicitly exempted", (layer) => {
    const p = threeLayers();
    p.tests = p.tests.filter((t) => t.layer !== layer);
    p.tasks[0]!.test_ids = p.tests.map((t) => t.id);
    expect(() => validatePlan(p)).toThrow(`缺少 ${layer} 测试`);
    p.exemptions = [{ layer, reason: "基于项目运行入口与依赖边界确认本层不适用" }];
    expect(() => validatePlan(p)).not.toThrow();
  });
  it.each(["native-v2", "legacy"] as const)("%s preserves E2E and OpenTabs as independent planned layers", (mode) => {
    const p = threeLayers();
    p.task_model = mode;
    p.tests.push({ ...p.tests[2]!, id: "browser", layer: "opentabs", scene_id: "historical-scene" });
    expect(PlanSchema.parse(p).tests[3]!.layer).toBe("opentabs");
    expect(validatePlan(p).plan.tests.map(t => t.layer)).toEqual(["unit", "integration", "e2e", "opentabs"]);
    p.tests = p.tests.filter(t => t.layer !== "e2e");
    p.tasks[0]!.test_ids = p.tests.map(t => t.id);
    expect(() => validatePlan(p)).toThrow("缺少 e2e 测试");
  });
  it("normalizes compact native acceptance items without merging or relabeling browser verification", () => {
    const p = validatePlan({ task_model: "native-v2", design_ref: { summary: "自动回归与真实页面核验分别实施" },
      modules: [{ id: "M1", title: "界面" }], work_items: [{ id: "W1", module_id: "M1", repo_id: "main", title: "页面修改", paths: ["src/page.ts"], acceptance_ids: ["E1", "B1"] }],
      acceptance_items: [
        { id: "E1", work_item_ids: ["W1"], layer: "e2e", scenario: "运行自动化回归", expected_outcome: "断言通过" },
        { id: "B1", work_item_ids: ["W1"], layer: "opentabs", scenario: "真实页面操作与截图核对", expected_outcome: "可见数据与交互符合需求" },
      ], scope: { allowed_paths: ["src/page.ts"] }, baselines: { main: "a".repeat(40) }, project_config_hash: "fixture" }).plan;
    expect(p.acceptance_items?.map(t => [t.id, t.layer])).toEqual([["E1", "e2e"], ["B1", "opentabs"]]);
    expect(p.tests.map(t => [t.id, t.layer, t.expected_case_ids])).toEqual([["E1", "e2e", ["E1"]], ["B1", "opentabs", ["B1"]]]);
    expect(p.tasks[0]?.test_ids).toEqual(["E1", "B1"]);
  });
  it("keeps the declared OpenTabs layer in optional repair acceptance cases", () => {
    expect(AcceptanceCaseSchema.parse({ case_id: "B1", layer: "opentabs" }).layer).toBe("opentabs");
    expect(AcceptanceCaseSchema.parse({ case_id: "E1", layer: "e2e" }).layer).toBe("e2e");
  });
  it("cannot mark a tested layer exempt to bypass its results", () => {
    const p = threeLayers();
    p.exemptions = [{ layer: "e2e", reason: "不能在要求 E2E 时同时豁免该层测试" }];
    expect(() => validatePlan(p)).toThrow(/同层不能同时/);
  });
});
