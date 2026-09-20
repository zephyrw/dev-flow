import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Engine } from "../../core/src/engine.js";
import type { Run, Workflow } from "../../contracts/src/index.js";
import { requireCondition } from "../../contracts/src/index.js";
import { reviewCompletionContext } from "../../core/src/review-completion.js";

export function reviewSkillResources() {
  const dir = dirname(fileURLToPath(import.meta.url));
  const root = [
    resolve(dir, "../../skills"),
    resolve(dir, "../../../../packages/skills"),
  ].find((candidate) =>
    existsSync(resolve(candidate, "devflow-review/SKILL.md")),
  );
  requireCondition(root, "SKILL_MISSING", "安装缺少 devflow-review Skill");
  return Object.fromEntries(
    [
      "devflow-review/SKILL.md",
      "devflow-review/references/repair-document-contract.md",
      "devflow-review/references/review-contract.md",
      "devflow/references/role-and-schedule.md",
    ].map((path) => [path, readFileSync(resolve(root, path), "utf8")]),
  );
}

export function reviewContractContext(engine: Engine, w: Workflow, run: Run) {
  const phase =
    w.stage === "quality_before_human" ? "before_human" : "after_human";
  return {
    workflow_id: w.id,
    review_request_id: w.review_request_id,
    run_id: run.id,
    phase,
    cycle: engine.quality.getOrCreateGate(w.id, phase).cycle,
    plan_revision: w.plan_revision,
    next_plan_revision: w.plan_revision + 1,
    snapshot_id: w.snapshot_id,
    feedback_cursor: Math.max(
      0,
      ...engine.store.list<any>("feedback_message", w.id).map((m) => m.seq),
    ),
    completion: reviewCompletionContext(engine, w),
  };
}

export function reviewDeliveryContext(engine: Engine, w: Workflow) {
  return engine.reviewDeliveryMaterials(w.id);
}

export const reviewInstructions =
  "将独立审查范围按模块、调用链或风险边界分配给多个只读子 Agent 并行检查；每个审查子 Agent 都只审代码质量，不核验测试声明或重复运行测试。主审汇总去重、处理结论差异并检查跨模块交互，完整汇总后统一给出审查结论及修复意见，不让每个子 Agent 重复全量审查，也不把并行分工变成平台放行条件。" +
  "你负责代码质量。依据原需求和正式设计检查当前实现有无遗漏、逻辑与边界错误，以及维护性问题。默认接受执行模型已完成自测的说明，不核验是否测试、测试覆盖表、原始报告、宿主调用或自查证明，不为这些材料提出补测整改。阅读测试源码以理解接口不等于开展测试审计。发现“需求规定的分支没有实现”属于代码质量问题；仅发现“没有该分支的测试报告”不属于本次审查问题。发现代码问题时一次性汇总位置、原因、影响和可执行修复意见；原范围内修复直接给出审查意见，不必重新生成全量 Plan。没有代码质量问题则给出通过结论。功能效果由用户实际确认。完整读取 skill_resources 中的审查规则与整改合同。保留原计划全部未关闭要求，禁止另写局部替代计划。确需用户决定的业务/范围/授权才列具体问题。";
