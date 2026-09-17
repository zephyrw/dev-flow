import { describe, it, expect } from "vitest";
import {
  fixture,
  runtime,
  until,
  cleanup,
  passReview,
  type Fixture,
} from "../fixtures/native-flow.js";
import { proof } from "../helpers.js";
import { hash, now } from "../../packages/core/src/util.js";
import type { Workflow, Run } from "../../packages/contracts/src/index.js";
function failReview(s: Fixture, w: Workflow, run: Run) {
  const phase =
    w.stage === "quality_before_human" ? "before_human" : "after_human";
  const body =
    (s.engine.plan(s.w.id).plan.markdown ?? "") +
    "\n## R1\n核对 app.txt 为 after 并运行原始单元测试，保留换行及其他文件。不得另建计划。\n";
  const repair = structuredClone(s.engine.plan(w.id).plan);
  repair.markdown = body;
  return {
    ...passReview(w),
    verdict: "findings",
    repair_plan: repair,
    repair_document: body,
    findings: [
      {
        id: "F1",
        severity: "P2",
        repo_id: "main",
        path: "app.txt",
        line: 1,
        trigger: "复核文本输出",
        evidence: "受控质量检查未满足",
        consequence: "输出不符",
        relation_to_change: "in_scope",
        disposition: "confirmed",
        reason: "测试夹具强制前三轮拒绝，验证调度",
      },
    ],
    quality: {
      workflow_id: w.id,
      run_id: run.id,
      phase,
      cycle: s.engine.quality.getOrCreateGate(w.id, phase).cycle,
      verdict: "changes_required",
      function_impact: "none",
      plan_revision: w.plan_revision,
      feedback_cursor: 0,
      reviewed_at: now(),
      findings: [
        {
          finding_id: "F1",
          severity: "major",
          repo_id: "main",
          evidence_locations: ["app.txt:1"],
          evidence: "文本质量检查失败",
          impact: "不满足计划",
          cause: "遗漏核验",
          verification_type: "statically_confirmed",
        },
      ],
      repair_plan: [
        {
          repair_item_id: "R1",
          finding_ids: ["F1"],
          design_section: "R1",
          evidence_locations: ["app.txt:1"],
          reproduction: "读取 app.txt",
          expected_actual: "期望完整匹配",
          root_cause: "遗漏核验",
          allowed_changes: [
            {
              repo_id: "main",
              path: "app.txt",
              symbol: "content",
              action: "modify",
              purpose: "满足原计划",
            },
          ],
          forbidden_changes: ["其他文件"],
          preserved_behaviors: ["保留换行"],
          implementation_steps: [
            {
              sequence: 1,
              depends_on: [],
              action: "核对文本",
              input: "app.txt",
              output: "after 加换行",
              algorithm: "完整匹配",
              pre_conditions: "原计划已批准",
              post_conditions: "内容符合",
              interfaces: "无接口变化",
              state_and_transaction_rules: "单文件原子写",
              idempotency_and_recovery: "重复执行结果一致",
            },
          ],
          acceptance_cases: [
            {
              case_id: "UT01",
              layer: "unit",
              fixtures: "app.txt",
              steps: ["运行原始文本检查"],
              expected_assertions: ["after 加换行"],
              pre_fix_failure: "不匹配",
            },
          ],
          regression_cases: ["其余文件保持不变"],
          regression_impact_rationale: "局部纯文本变更",
          completion_evidence: ["真实原始报告"],
          stop_conditions: ["范围冲突即停止"],
          function_impact: "none",
          function_impact_explanation: "实现既有计划，无新增行为",
          document_revision: w.plan_revision + 1,
          document_hash: hash(body),
          document_anchor: "#r1",
        },
      ],
    },
  };
}
describe("质量审查生产调度闭环", { timeout: 1500000 }, () => {
  it("两关各拒绝三次后分别由规划模型接管，逐轮自查后复核，最终真实提交", async () => {
    const s = await fixture();
    const counts = { before_human: 0, after_human: 0 };
    const base = runtime(s);
    const ownership: Array<[string, string, string]> = [];
    s.engine.runtime = {
      ...base,
      async execute(w, r, t) {
        ownership.push([r.stage, r.adapter, r.purpose!]);
        await base.execute(w, r, t);
      },
      async review(w, r) {
        s.stages.push(r.stage);
        const phase =
          w.stage === "quality_before_human" ? "before_human" : "after_human";
        counts[phase]++;
        return counts[phase] <= 3 ? failReview(s, w, r) : passReview(w);
      },
    };
    try {
      await until(
        s,
        ["HUMAN_PENDING", "BLOCKED", "REPAIR_PLAN_PENDING"],
        660000,
      );
      expect(s.engine.get(s.w.id).blocker).toBeUndefined();
      expect(s.engine.get(s.w.id).state).toBe("HUMAN_PENDING");
      expect(counts.before_human).toBe(4);
      expect(s.engine.quality.getGate(s.w.id, "before_human")).toMatchObject({
        executor_rejections: 3,
        takeover: true,
        status: "passed",
      });
      expect(
        s.engine.quality.getOrCreateGate(s.w.id, "after_human")
          .executor_rejections,
      ).toBe(0);
      const p = proof(s.engine, s.w.id, "accept");
      await s.engine.accept(s.w.id, p.proof, p.binding);
      await until(
        s,
        ["COMMITTED", "BLOCKED", "REPAIR_PLAN_PENDING", "COMMIT_PARTIAL"],
        660000,
      );
      expect(s.engine.get(s.w.id).blocker).toBeUndefined();
      expect(s.engine.get(s.w.id).state).toBe("COMMITTED");
      expect(counts.after_human).toBe(4);
      expect(s.engine.quality.getGate(s.w.id, "after_human")).toMatchObject({
        executor_rejections: 3,
        takeover: true,
        status: "passed",
      });
      expect(
        ownership.filter(([stage]) => stage === "planner_takeover"),
      ).toHaveLength(2);
      expect(
        ownership
          .filter(([stage]) => stage === "planner_takeover")
          .every(([, adapter]) => adapter === "codex"),
      ).toBe(true);
      expect(s.store.list("commit_result", s.w.id)).toHaveLength(1);
    } finally {
      await cleanup(s);
    }
  });
  it("伪造通过、旧轮次和 incomplete 不得增加计数或进入人工", async () => {
    const s = await fixture();
    try {
      const invalid = {
        workflow_id: s.w.id,
        run_id: "fake",
        phase: "before_human",
        cycle: 1,
        verdict: "passed",
        plan_revision: 1,
        reviewed_at: now(),
      };
      expect(
        s.engine.quality.evaluateReviewResult(s.w.id, invalid).action,
      ).toBe("retry_incomplete");
      expect(
        s.engine.quality.evaluateReviewResult(s.w.id, {
          ...invalid,
          verdict: "incomplete",
        }).action,
      ).toBe("retry_incomplete");
      expect(s.engine.quality.getGate(s.w.id, "before_human")).toBeUndefined();
      expect(s.engine.get(s.w.id).state).toBe("QUEUED");
    } finally {
      await cleanup(s);
    }
  });
});
