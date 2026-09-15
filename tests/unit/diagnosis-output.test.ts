import { it, expect } from "vitest";
import {
  diagnosisOutputSchema,
  parseDiagnosisOutput,
} from "../../packages/contracts/src/diagnosis-output.js";
import { plan } from "../helpers.js";
import { failureSummary } from "../../packages/presentation/src/failure.js";

it("diagnosis wire format closes repository maps and makes optional fields nullable", () => {
  const schema = diagnosisOutputSchema(["main"]);
  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    expect(node).not.toHaveProperty("propertyNames");
    expect(node).not.toHaveProperty("default");
    if (node.type === "object") {
      expect(node.additionalProperties).toBe(false);
      expect(node.required).toEqual(Object.keys(node.properties ?? {}));
    }
    Object.values(node).forEach((child) =>
      Array.isArray(child) ? child.forEach(walk) : walk(child),
    );
  };
  walk(schema);
  expect(
    schema.properties.repair_plan.anyOf[0].properties.baselines.required,
  ).toEqual(["main"]);
});
it("nullable wire optionals decode while invalid repair plans still fail validation", () => {
  const p: any = plan("fixture-hash", "a".repeat(40));
  p.task_model = null;
  p.modules = null;
  Object.assign(p.tasks[0], {
    repo_id: null,
    module_id: null,
    completion_checks: null,
  });
  p.tests[0].scene_id = null;
  const output = {
    diagnosis: "诊断确认启动环境缺少必需变量",
    instructions: "修复环境变量后重启并运行检查",
    requires_plan_change: true,
    repair_plan: p,
  };
  expect(parseDiagnosisOutput(output).repair_plan?.tasks[0]).not.toHaveProperty(
    "repo_id",
  );
  p.tasks[0].implementation = null;
  expect(() => parseDiagnosisOutput(output)).toThrow();
});
it("user failure summaries do not expose internal commands or stack traces", () => {
  const raw =
    "SERVICE_EXITED backend C:\\internal\\mvn.cmd FlowError: devflow_request_operation";
  expect(failureSummary("SERVICE_EXITED", raw)).toBe(
    "后端服务启动后提前退出，还未达到可测试状态。",
  );
  expect(failureSummary("DIAGNOSIS_FAILED", raw)).not.toContain("FlowError");
});
