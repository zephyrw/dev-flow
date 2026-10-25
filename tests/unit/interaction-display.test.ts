import { expect, it } from "vitest";
import { displayInteractionRequest } from "../../packages/presentation/src/interaction-display.js";
import { displayResultEnvelope } from "../../packages/presentation/src/result-display.js";

it("projects only the historical platform recovery contract and preserves its diagnostic", () => {
  const request = { kind: "action_required" as const, title: "模型请求仍被拒绝，需要协助", action_label: "已处理，继续原任务",
    message: "上次模型请求被服务端拒绝，尚未完成当前任务。请在原阶段检查并处理这个输入问题：\n输入编码错误\n请自行检查相关输入和保存格式后继续原任务；不要重复已经完成的开发和测试。无法自行解决时，通过 need_user 和 user_interaction 说明具体问题并请求协助。" };
  const display = displayInteractionRequest(request);
  expect(display.message).not.toContain("need_user"); expect(display.details).toBe("输入编码错误");
  expect(displayInteractionRequest({ ...request, title: "请说明这个接口" }).message).toBe(request.message);
  expect(request.message).toContain("user_interaction");
});

it("keeps authored JSON while presenting validated implementations and actual test results", () => {
  const ordinary = '{"summary":"业务字段","delivery":{"value":1}}';
  expect(displayResultEnvelope(ordinary)).toBe(ordinary);
  const result = displayResultEnvelope(JSON.stringify({ summary: "实现完成", delivery: {
    implementations: [{ path: "src/index.ts", description: "修复读取" }],
    test_executions: [{ tool_call_id: "call", command: "pnpm typecheck", exit_code: 0 }], acceptance_mappings: [],
    test_results: [{ test_id: "T01", status: "failed", summary: "仍需修复" }],
  } }));
  expect(result).toContain("src/index.ts：修复读取"); expect(result).toContain("pnpm typecheck：通过");
  expect(result).toContain("T01：失败，仍需修复"); expect(result).not.toContain("acceptance_mappings");
});

it("renders the known review envelope without protocol fields and retains meaningful findings", () => {
  const review = { verdict: "passed", summary: "代码复核通过", findings: [], unresolved_questions: [], repair_document: null,
    notes: "本轮未重新执行测试。", quality: { function_impact: "changed", summary: "修复读取行为", notes: "仍需人工确认体验" } };
  const output = displayResultEnvelope(JSON.stringify(review));
  expect(output).toContain("结论：通过"); expect(output).toContain("本轮未重新执行测试。");
  expect(output).toContain("仍需人工确认体验"); expect(output).not.toContain("repair_document");
  expect(output).not.toContain("待确认问题");
  const authored = JSON.stringify({ summary: "业务数据", verdict: "passed" });
  expect(displayResultEnvelope(authored)).toBe(authored);
  const future = JSON.stringify({ ...review, quality: { new_evidence: "不能丢失" } });
  expect(displayResultEnvelope(future)).toBe(future);
});
