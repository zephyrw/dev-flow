import { describe, it, expect } from "vitest";
import {
  fixture as nativeFixture,
  runtime,
  until,
  cleanup,
  passReview,
  type Fixture,
} from "../fixtures/native-flow.js";
import { proof, setup } from "../helpers.js";
import { now } from "../../packages/core/src/util.js";
import type { Workflow } from "../../packages/contracts/src/index.js";
import { reviewContractContext } from "../../packages/runtime/src/review-materials.js";
import { readQualityFlow } from "../../packages/core/src/quality-policy-migration.js";
import { readPlanMaterial } from "../../packages/core/src/plan-review.js";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { git } from "../../packages/git/src/git.js";

async function fixture() {
  const s = await nativeFixture();
  const w = s.engine.get(s.w.id);
  s.store.put("workflow", w.id, w.project_id, { ...w, quality_policy_version: 2 });
  return s;
}
function qualityRuntime(s: Fixture) {
  const base = runtime(s);
  const complete = (w: Workflow, run: Parameters<typeof base.execute>[1], payload: { summary: string; repositories?: Array<{ repo_id: string; commit: string }> }) =>
    s.engine.receiveRoundResult(w.id, run.id, {
      schema_version: "v2", workflow_id: w.id, run_id: run.id,
      plan_revision: w.plan_revision, plan_hash: w.plan_hash,
      status: "completed", ...payload,
    });
  return {
    ...base,
    async execute(w: Workflow, run: Parameters<typeof base.execute>[1], token: string) {
      if (run.purpose === "planner_takeover") {
        s.stages.push(run.stage);
        writeFileSync(join(s.repo, "app.txt"), "after\n");
        await complete(w, run, { summary: "原问题已修复并阅读代码自查" });
        return;
      }
      if (run.purpose === "executor_test") {
        s.stages.push(run.stage);
        execFileSync(process.execPath, [".reports/check.cjs"], { cwd: s.repo });
        await complete(w, run, { summary: "执行阶段完成原测试" });
        return;
      }
      if (run.purpose === "planner_commit") {
        s.stages.push(run.stage);
        const snapshot = await s.engine.git.snapshot(w.id, w.environment_revision);
        const commits = await s.engine.git.commit(snapshot, s.p, "fix: update fixture");
        await complete(w, run, { summary: "规划已实际提交", repositories: commits.map(item => ({ repo_id: item.repo_id, commit: item.commit })) });
        return;
      }
      return base.execute(w, run, token);
    },
  };
}
function failReview(s: Fixture, w: Workflow) {
  const body =
    readPlanMaterial(s.store, s.w.id, w.plan_revision).markdown +
    "\n## R1\n核对 app.txt 为 after 并运行原始单元测试，保留换行及其他文件。不得另建计划。\n";
  return {
    ...passReview(w),
    verdict: "findings",
    repair_plan: null,
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
        reason: "测试夹具强制拒绝，验证正式整改后的调度",
      },
    ],
  };
}
describe("质量审查生产调度闭环", { timeout: 1500000 }, () => {
  it("首次代码质量不通过只派发整改且计数为 0，通过后进入人工", async () => {
    const s = await fixture();
    const base = qualityRuntime(s);
    let reviews = 0;
    s.engine.runtime = {
      ...base,
      async review(w, r) {
        reviews++;
        const context = reviewContractContext(s.engine, w, r);
        expect(context.run_id).toBe(r.id);
        expect(
          s.engine.quality.getGate(w.id, "before_human")?.executor_rejections ??
            0,
        ).toBe(0);
        return reviews === 1 ? failReview(s, w) : passReview(w);
      },
    };
    try {
      await until(s, ["HUMAN_PENDING", "BLOCKED", "WAITING_INPUT"]);
      expect(s.engine.get(s.w.id).blocker).toBeUndefined();
      expect(s.engine.get(s.w.id).state).toBe("HUMAN_PENDING");
      expect(reviews).toBe(2);
      expect(readQualityFlow(s.store, s.w.id)).toMatchObject({
        phase: "before_human", executor_repair_completed: true, planner_repairs_only: false,
      });
      expect(s.store.list("acceptance", s.w.id)).toHaveLength(0);
    } finally {
      await cleanup(s);
    }
  });

  it("审查需要用户输入时进入等待，不自动补全材料", async () => {
    const s = await fixture();
    s.engine.runtime = {
      ...runtime(s),
      async review(w) {
        return {
          ...passReview(w),
          unresolved_questions: ["需要用户确认接口约定"],
        };
      },
    };
    try {
      await until(s, ["WAITING_INPUT", "BLOCKED"]);
      expect(s.engine.get(s.w.id).state).toBe("WAITING_INPUT");
      expect(s.engine.get(s.w.id).blocker?.code).toBe("REVIEW_NEEDS_USER");
      expect(
        s.engine.quality.getGate(s.w.id, "before_human")?.executor_rejections ??
          0,
      ).toBe(0);
    } finally {
      await cleanup(s);
    }
  });

  it("用户在等待输入时暂停，不再次调用复核模型", async () => {
    const s = await fixture();
    let reviews = 0;
    s.engine.runtime = {
      ...runtime(s),
      async review(w) {
        reviews++;
        return {
          ...passReview(w),
          unresolved_questions: ["需要用户确认"],
        };
      },
      async stop() {
        return { status: "confirmed_exited" };
      },
    };
    try {
      await until(s, ["WAITING_INPUT", "BLOCKED"]);
      await s.engine.stop(s.w.id);
      expect(s.engine.get(s.w.id).state).toBe("STOPPED");
      expect(reviews).toBe(1);
    } finally {
      await cleanup(s);
    }
  });

  it("人工前一次执行整改后交规划修复，人工后直接规划修复，两次均由执行测试后真实提交", async () => {
    const s = await fixture();
    const counts = { before_human: 0, after_human: 0 };
    const base = qualityRuntime(s);
    const ownership: Array<[string, string, string]> = [];
    s.engine.runtime = {
      ...base,
      async execute(w, r, t) {
        ownership.push([r.stage, r.adapter, r.purpose!]);
        if (r.purpose === "planner_takeover") {
          const phase = s.store.must<any>("repair_assignment", w.id).phase as
            | "before_human"
            | "after_human";
          expect(counts[phase]).toBe(phase === "before_human" ? 2 : 1);
          expect(readQualityFlow(s.store, w.id).planner_repairs_only).toBe(true);
        }
        await base.execute(w, r, t);
      },
      async review(w, r) {
        s.stages.push(r.stage);
        const phase =
          w.stage === "quality_before_human" ? "before_human" : "after_human";
        counts[phase]++;
        expect(s.engine.quality.getGate(w.id, phase)?.executor_rejections ?? 0).toBe(0);
        return failReview(s, w);
      },
    };
    try {
      await until(
        s,
        ["HUMAN_PENDING", "BLOCKED", "REPAIR_PLAN_PENDING", "WAITING_INPUT"],
        660000,
      );
      expect(s.engine.get(s.w.id).blocker).toBeUndefined();
      expect(s.engine.get(s.w.id).state).toBe("HUMAN_PENDING");
      expect(counts.before_human).toBe(2);
      expect(readQualityFlow(s.store, s.w.id)).toMatchObject({
        phase: "before_human", executor_repair_completed: true, planner_repairs_only: true,
      });
      expect(ownership.map(([, , purpose]) => purpose)).toEqual([
        "implement", "implement", "planner_takeover", "executor_test",
      ]);
      const p = proof(s.engine, s.w.id, "accept");
      await s.engine.accept(s.w.id, p.proof, p.binding);
      await until(
        s,
        [
          "COMMITTED",
          "BLOCKED",
          "REPAIR_PLAN_PENDING",
          "COMMIT_PARTIAL",
          "WAITING_INPUT",
        ],
        660000,
      );
      expect(s.engine.get(s.w.id).blocker).toBeUndefined();
      expect(s.engine.get(s.w.id).state).toBe("COMMITTED");
      expect(counts.after_human).toBe(1);
      expect(readQualityFlow(s.store, s.w.id)).toMatchObject({ phase: "after_human", planner_repairs_only: true });
      expect(
        ownership.filter(([stage]) => stage === "planner_takeover"),
      ).toHaveLength(2);
      expect(
        ownership
          .filter(([stage]) => stage === "planner_takeover")
          .every(([, adapter]) => adapter === "codex"),
      ).toBe(true);
      expect(ownership.filter(([, , purpose]) => purpose === "executor_test")).toHaveLength(2);
      expect(ownership.map(([, , purpose]) => purpose)).toEqual([
        "implement", "implement", "planner_takeover", "executor_test",
        "planner_takeover", "executor_test", "planner_commit",
      ]);
      expect(await git(s.repo, ["show", "HEAD:app.txt"])).toBe("after");
      expect(await git(s.repo, ["rev-parse", "HEAD"])).not.toBe(s.baseline);
      expect(s.store.events(s.w.id).filter(e => e.type === "PlannerCommitIntegrated")).toHaveLength(1);
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

  it("事务提交前中断没有新决定，提交后重放补齐同一派发", () => {
    const opened = setup();
    const q = opened.engine.quality;
    opened.store.put("workflow", "wf", "p", {
      id: "wf",
      project_id: "p",
      state: "REVIEWING",
      stage: "quality_before_human",
      plan_revision: 1,
      plan_hash: "plan",
      run_id: "run",
      version: 1,
    });
    opened.store.put("run", "run", "wf", {
      id: "run",
      workflow_id: "wf",
      plan_revision: 1,
      purpose: "review",
      status: "completed",
      exit_code: 0,
    });
    const input = {
      workflow_id: "wf",
      run_id: "run",
      phase: "before_human",
      cycle: 1,
      verdict: "changes_required",
      plan_revision: 1,
      findings: [
        {
          finding_id: "F1",
          evidence: "仍有问题",
          impact: "错误",
          cause: "遗漏",
        },
      ],
    };
    try {
      const prepared = q.prepareQualityTransfer("wf", input);
      expect(prepared.write).toBe("full");
      expect(q.getGate("wf", "before_human")).toBeUndefined();
      expect(opened.store.get("repair_assignment", "wf")).toBeUndefined();
      opened.store.transaction(() => q.applyQualityTransfer(prepared));
      expect(q.getGate("wf", "before_human")?.current_review_id).toBe("run");
      expect(
        opened.store.get<any>("repair_assignment", "wf")?.assignment_id,
      ).toBe(prepared.next_assignment_id);
      opened.store.remove("repair_assignment", "wf");
      opened.store.put("quality_eval_dedup", "wf:run", "wf", {
        ...opened.store.must<any>("quality_eval_dedup", "wf:run"),
        assignment_applied: false,
      });
      const recovered = q.recoverQualityDispatch("wf", "before_human");
      expect(recovered?.write).toBe("backfill");
      opened.store.transaction(() => q.applyQualityTransfer(recovered!));
      expect(q.getGate("wf", "before_human")?.executor_rejections).toBe(0);
      expect(
        opened.store.get<any>("repair_assignment", "wf")?.source_review_id,
      ).toBe("run");
      expect(
        opened.store.get<any>("repair_assignment", "wf")?.assignment_id,
      ).toBe(prepared.next_assignment_id);
      const replay = q.prepareQualityTransfer("wf", input);
      expect(replay.write).toBe("none");
      expect(replay.next_assignment_id).toBe(prepared.next_assignment_id);
    } finally {
      opened.store.close();
    }
  });
});
