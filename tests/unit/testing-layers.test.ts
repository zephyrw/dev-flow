import { describe, expect, it } from "vitest";
import { validatePlan } from "../../packages/plans/src/validate.js";
import { PlanSchema } from "../../packages/contracts/src/index.js";
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
  it("rejects a new native fourth layer but can still parse and validate legacy browser records", () => {
    const p = threeLayers();
    p.tests.push({ ...p.tests[2]!, id: "browser", layer: "opentabs", scene_id: "historical-scene" });
    expect(() => validatePlan(p)).toThrow(/不再单列 OpenTabs/);
    p.task_model = "legacy";
    expect(PlanSchema.parse(p).tests[3]!.layer).toBe("opentabs");
    expect(() => validatePlan(p)).not.toThrow();
  });
  it("cannot mark a tested layer exempt to bypass its results", () => {
    const p = threeLayers();
    p.exemptions = [{ layer: "e2e", reason: "不能在要求 E2E 时同时豁免该层测试" }];
    expect(() => validatePlan(p)).toThrow(/同层不能同时/);
  });
});
