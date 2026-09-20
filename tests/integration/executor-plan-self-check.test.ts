import { describe, it, expect } from "vitest";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FlowError,
  type Run,
  type DeliveryRevision,
} from "../../packages/contracts/src/index.js";
import { proof } from "../helpers.js";
import {
  fixture,
  runtime,
  until,
  cleanup,
  deliver,
} from "../fixtures/native-flow.js";

describe("真实调度入口的执行模型计划复核门禁", { timeout: 360000 }, () => {
  it("先普通执行，再规划质量审查，最后开放人工和终审提交", async () => {
    const s = await fixture();
    try {
      s.engine.runtime = runtime(s);
      await until(s, ["HUMAN_PENDING", "BLOCKED"]);
      expect(s.engine.get(s.w.id).blocker).toBeUndefined();
      expect(s.stages).toEqual(["execute", "quality_before_human"]);
      expect(s.engine.get(s.w.id).state).toBe("HUMAN_PENDING");
      expect(s.store.list("run", s.w.id)).toHaveLength(2);
      expect(s.store.get("acceptance", s.w.id)).toBeUndefined();
      expect(readFileSync(join(s.repo, "app.txt"), "utf8")).toBe("after\n");
      const p = proof(s.engine, s.w.id, "accept");
      await s.engine.accept(s.w.id, p.proof, p.binding);
      await until(s, ["COMMITTED", "BLOCKED", "COMMIT_PARTIAL"]);
      expect(s.stages.at(-1)).toBe("review");
      expect(s.engine.get(s.w.id).state).toBe("COMMITTED");
    } finally {
      await cleanup(s);
    }
  });
  it("执行交付成功后不经计划自查即可进入规划审查", async () => {
    const s = await fixture();
    try {
      s.engine.runtime = runtime(s);
      await until(s, ["HUMAN_PENDING", "BLOCKED"]);
      expect(s.engine.get(s.w.id).state).toBe("HUMAN_PENDING");
      expect(s.engine.get(s.w.id).stage).toBe("manual_acceptance");
      expect(s.stages).toEqual(["execute", "quality_before_human"]);
      expect(s.engine.planSelfCheck.current(s.w.id)).toBeUndefined();
      expect(s.store.list("delivery_revision", s.w.id)).toHaveLength(1);
    } finally {
      await cleanup(s);
    }
  });
  it("普通开发轮次携带自查字段仍可交接，完成后进入规划审查", async () => {
    const s = await fixture();
    try {
      await s.engine.git.prepare(s.p, s.w.id, "existing_workspace", {
        main: s.baseline,
      });
      s.engine.transition(s.w.id, ["QUEUED"], "EXECUTING", "execute", {
        run_id: "ordinary",
      });
      const r: Run = {
        id: "ordinary",
        workflow_id: s.w.id,
        plan_revision: 1,
        adapter: "agy",
        stage: "execute",
        status: "running",
        started_at: new Date().toISOString(),
        package_hash: "fixture",
      };
      s.store.put("run", r.id, s.w.id, r);
      writeFileSync(join(s.repo, "app.txt"), "after\n");
      expect(
        (
          await deliver(
            s,
            r,
            (m) =>
              (m.plan_self_check = {
                request_id: "fake",
                source_delivery_revision_id: "fake",
                plan_revision: 1,
                plan_hash: s.engine.get(s.w.id).plan_hash,
                authority_hash: "fake",
                run_id: r.id,
                verdict: "passed",
                checks: [
                  { check_id: "fake", status: "passed", evidence: ["fake"] },
                ],
                findings: [],
              }),
          )
        ).status,
      ).toBe("accepted");
      await s.engine.finalizeNativeDelivery(s.w.id, r.id);
      expect(s.engine.get(s.w.id).state).toBe("VERIFYING");
      s.store.put("run", r.id, s.w.id, {
        ...r,
        status: "completed",
        exit_code: 0,
      });
      await s.engine.finalizeNativeDelivery(s.w.id, r.id);
      expect(s.engine.planSelfCheck.current(s.w.id)).toBeUndefined();
      expect(s.engine.get(s.w.id).stage).toBe("quality_before_human");
      expect(s.engine.get(s.w.id).state).toBe("REVIEW_QUEUED");
      await s.engine.stop(s.w.id);
      await s.engine.finalizeNativeDelivery(s.w.id, r.id);
      expect(s.engine.get(s.w.id).state).toBe("STOPPED");
      const p = proof(s.engine, s.w.id, "accept");
      await expect(
        s.engine.accept(s.w.id, p.proof, p.binding),
      ).rejects.toMatchObject({ code: "INVALID_STATE" });
    } finally {
      await cleanup(s);
    }
  });
  it("执行交付后进程失败，不能派发规划模型", async () => {
    const s = await fixture();
    try {
      s.engine.runtime = {
        ...runtime(s),
        async execute(_w, run) {
          s.stages.push(run.stage);
          writeFileSync(join(s.repo, "app.txt"), "after\n");
          expect((await deliver(s, run)).status).toBe("accepted");
          throw new FlowError("MODEL_AUTH", "模拟进程失败");
        },
      };
      await until(s, ["BLOCKED"]);
      expect(s.stages).toEqual(["execute"]);
      expect(s.engine.planSelfCheck.current(s.w.id)).toBeUndefined();
      const rev = s.store
        .list<DeliveryRevision>("delivery_revision", s.w.id)
        .at(-1)!;
      expect(rev.execution_finished).toBe(false);
      expect(s.store.must<Run>("run", rev.run_id!).status).toBe("failed");
    } finally {
      await cleanup(s);
    }
  });
  it("反馈整改重新经历执行后由规划模型审查；计划版本变化不能沿用旧质量指纹", async () => {
    const s = await fixture();
    try {
      s.engine.runtime = runtime(s);
      await until(s, ["HUMAN_PENDING", "BLOCKED"]);
      expect(s.engine.get(s.w.id).state).toBe("HUMAN_PENDING");
      const firstReviewRun = s.store
        .list<Run>("run", s.w.id)
        .find((run) => run.stage === "quality_before_human")!;
      s.engine.feedback(s.w.id, "按原计划复核文本保持行为", "within_plan");
      await until(s, ["HUMAN_PENDING", "BLOCKED"]);
      expect(s.engine.get(s.w.id).state).toBe("HUMAN_PENDING");
      const secondReviewRun = s.store
        .list<Run>("run", s.w.id)
        .find(
          (run) =>
            run.stage === "quality_before_human" && run.id !== firstReviewRun.id,
        );
      expect(secondReviewRun).toBeDefined();
      expect(s.stages).toEqual([
        "execute",
        "quality_before_human",
        "execute",
        "quality_before_human",
      ]);
      const w = s.engine.get(s.w.id);
      s.store.put("workflow", w.id, w.id, {
        ...w,
        plan_revision: 2,
        plan_hash: "changed",
      });
      expect(() =>
        s.engine.quality.assertPassed(s.engine.get(w.id).id, "before_human"),
      ).toThrow();
    } finally {
      await cleanup(s);
    }
  });
});
