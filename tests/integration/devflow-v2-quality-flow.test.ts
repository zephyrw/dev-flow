import { describe, it, expect } from "vitest";
import {
  fixture,
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
function failReview(s: Fixture, w: Workflow) {
  const body =
    (s.engine.plan(s.w.id).plan.markdown ?? "") +
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
    const base = runtime(s);
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
      expect(s.engine.quality.getGate(s.w.id, "before_human")).toMatchObject({
        executor_rejections: 0,
        takeover: false,
        status: "passed",
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

  it("两关首次发现问题均不计数，三次完整整改仍被拒绝才接管，通过后清零并真实提交", async () => {
    const s = await fixture();
    const counts = { before_human: 0, after_human: 0 };
    const base = runtime(s);
    const ownership: Array<[string, string, string]> = [];
    s.engine.runtime = {
      ...base,
      async execute(w, r, t) {
        ownership.push([r.stage, r.adapter, r.purpose!]);
        if (r.purpose === "planner_takeover") {
          const phase = s.store.must<any>("repair_assignment", w.id).phase as
            | "before_human"
            | "after_human";
          expect(counts[phase]).toBe(4); // Initial finding plus three completed repairs.
          expect(s.engine.quality.canTakeOver(w.id, phase)).toBe(true);
        }
        await base.execute(w, r, t);
      },
      async review(w, r) {
        s.stages.push(r.stage);
        const phase =
          w.stage === "quality_before_human" ? "before_human" : "after_human";
        counts[phase]++;
        expect(
          s.engine.quality.getOrCreateGate(w.id, phase).executor_rejections,
        ).toBe(Math.max(0, Math.min(3, counts[phase] - 2)));
        return counts[phase] <= 4 ? failReview(s, w) : passReview(w);
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
      expect(counts.before_human).toBe(5);
      expect(s.engine.quality.getGate(s.w.id, "before_human")).toMatchObject({
        executor_rejections: 0,
        takeover: false,
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
      expect(counts.after_human).toBe(5);
      expect(s.engine.quality.getGate(s.w.id, "after_human")).toMatchObject({
        executor_rejections: 0,
        takeover: false,
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
      for (const phase of ["before_human", "after_human"])
        expect(
          s.store
            .list<any>("quality_review", s.w.id)
            .filter(
              (review) =>
                review.phase === phase && review.executor_repair_run_id,
            ),
        ).toHaveLength(3);
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
