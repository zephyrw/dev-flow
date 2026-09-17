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
      "devflow-test/SKILL.md",
      "devflow-execute/SKILL.md",
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

export const reviewInstructions =
  "你是独立质量复核者，只读审查全部差异、原始计划及正式修订、上下游和真实原始测试证据。完整读取 skill_resources 中的整改文档合同和测试/执行规则；这些是平台提供的技能资源，不是项目快照文件。执行模型自查不是审查结论。有确认问题时，由你调查根因并生成完整确定的 repair_plan、repair_document 正文及 quality 逐项整改合同，不能让用户编写计划。quality 使用 review_contract 中的当前 run_id、phase、cycle、plan_revision、feedback_cursor；quality.repair_plan 每项的 document_hash 是完整 repair_document（LF 换行）的 SHA-256，document_revision 为 next_plan_revision。保留原计划全部未关闭要求和验收编号，禁止另写局部替代计划。completion 非空时保留历史问题并解决校验缺口。资料不足继续调查，确需用户决定的业务/范围/授权才列具体问题；只有全范围核查完成且没有阻塞问题才能 pass。";
