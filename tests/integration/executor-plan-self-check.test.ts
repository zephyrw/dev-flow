import { describe, it, expect } from "vitest";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FlowError,
  type Run,
  type DeliveryRevision,
} from "../../packages/contracts/src/index.js";
import { PLAN_SELF_CHECK_STAGE } from "../../packages/core/src/plan-self-check.js";
import { proof } from "../helpers.js";
import {
  fixture,
  runtime,
  until,
  cleanup,
  deliver,
} from "../fixtures/native-flow.js";

describe("真实调度入口的执行模型计划复核门禁", { timeout: 120000 }, () => {
  it("先普通执行，再独立自查，再规划质量审查，最后开放人工和终审提交", async () => {
    const s = await fixture();
    try {
      s.engine.runtime = runtime(s);
      await until(s, ["HUMAN_PENDING", "BLOCKED"]);
      expect(s.engine.get(s.w.id).blocker).toBeUndefined();
      expect(s.stages).toEqual([
        "execute",
        PLAN_SELF_CHECK_STAGE,
        "quality_before_human",
      ]);
      expect(s.engine.get(s.w.id).state).toBe("HUMAN_PENDING");
      expect(s.store.list("run", s.w.id)).toHaveLength(3);
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
  it("自查遗漏、旧报告、未解决问题均拒绝；同轮补齐和修复后才能进入规划审查", async () => {
    const s = await fixture();
    try {
      s.engine.runtime = runtime(s, async (run) => {
        await expect(
          deliver(s, run, (m) => delete m.plan_self_check),
        ).rejects.toMatchObject({ code: "PLAN_SELF_CHECK_REQUIRED" });
        await expect(
          deliver(s, run, (m) => m.plan_self_check.checks.pop()),
        ).rejects.toMatchObject({ code: "PLAN_SELF_CHECK_INCOMPLETE" });
        await expect(
          deliver(s, run, (m) => (m.plan_self_check.run_id = "old")),
        ).rejects.toMatchObject({ code: "PLAN_SELF_CHECK_STALE" });
        await expect(
          deliver(
            s,
            run,
            (m) =>
              (m.plan_self_check.findings = [
                {
                  id: "F1",
                  description: "漏改",
                  resolution: "待修",
                  status: "open",
                  evidence: ["app.txt"],
                },
              ]),
          ),
        ).rejects.toMatchObject({ code: "PLAN_SELF_CHECK_FINDINGS_OPEN" });
        expect(s.stages).toEqual(["execute", PLAN_SELF_CHECK_STAGE]);
        expect((await deliver(s, run)).status).toBe("accepted");
      });
      await until(s, ["HUMAN_PENDING", "BLOCKED"]);
      expect(s.engine.get(s.w.id).state).toBe("HUMAN_PENDING");
      expect(s.store.list("delivery_revision", s.w.id)).toHaveLength(2);
    } finally {
      await cleanup(s);
    }
  });
  it("普通开发轮次不能提交自查报告冒充程序调度；首轮成功只入自查队列", async () => {
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
      await expect(
        deliver(
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
        ),
      ).rejects.toMatchObject({ code: "PLAN_SELF_CHECK_WRONG_RUN" });
      await deliver(s, r);
      await expect(
        s.engine.finalizeNativeDelivery(s.w.id, r.id),
      ).rejects.toMatchObject({ code: "EXECUTION_NOT_FINISHED" });
      s.store.put("run", r.id, s.w.id, {
        ...r,
        status: "completed",
        exit_code: 0,
      });
      await s.engine.finalizeNativeDelivery(s.w.id, r.id);
      const req = s.engine.planSelfCheck.current(s.w.id);
      await s.engine.finalizeNativeDelivery(s.w.id, r.id);
      expect(s.engine.planSelfCheck.current(s.w.id)).toEqual(req);
      expect(s.engine.get(s.w.id).stage).toBe(PLAN_SELF_CHECK_STAGE);
      s.engine.recover();
      expect(s.engine.get(s.w.id).state).toBe("QUEUED");
      expect(s.engine.planSelfCheck.current(s.w.id)?.id).toBe(req?.id);
      await s.engine.stop(s.w.id);
      await expect(
        s.engine.finalizeNativeDelivery(s.w.id, r.id),
      ).rejects.toMatchObject({ code: "EXECUTION_NOT_FINISHED" });
      expect(s.engine.get(s.w.id).state).toBe("STOPPED");
      expect(s.store.list("delivery_revision", s.w.id)).toHaveLength(1);
      const p = proof(s.engine, s.w.id, "accept");
      await expect(
        s.engine.accept(s.w.id, p.proof, p.binding),
      ).rejects.toMatchObject({ code: "INVALID_STATE" });
    } finally {
      await cleanup(s);
    }
  });
  it("自查交付后进程失败，不能派发规划模型", async () => {
    const s = await fixture();
    try {
      s.engine.runtime = runtime(s, async (run) => {
        expect((await deliver(s, run)).status).toBe("accepted");
        throw new FlowError("MODEL_AUTH", "模拟进程失败");
      });
      await until(s, ["BLOCKED"]);
      expect(s.stages).toEqual(["execute", PLAN_SELF_CHECK_STAGE]);
      expect(s.engine.planSelfCheck.current(s.w.id)?.status).toBe("running");
      const rev = s.store
        .list<DeliveryRevision>("delivery_revision", s.w.id)
        .at(-1)!;
      expect(rev.execution_finished).toBe(false);
      expect(s.store.must<Run>("run", rev.run_id!).status).toBe("failed");
    } finally {
      await cleanup(s);
    }
  });
  it("反馈整改重新经历执行与计划自查；旧报告和计划版本变化均不能放行", async () => {
    const s = await fixture();
    try {
      s.engine.runtime = runtime(s);
      await until(s, ["HUMAN_PENDING", "BLOCKED"]);
      expect(s.engine.get(s.w.id).state).toBe("HUMAN_PENDING");
      const oldRequest = s.engine.planSelfCheck.current(s.w.id)!.id;
      s.engine.feedback(s.w.id, "按原计划复核文本保持行为", "within_plan");
      expect(() =>
        s.engine.planSelfCheck.assertPassed(s.engine.get(s.w.id)),
      ).toThrow();
      await until(s, ["HUMAN_PENDING", "BLOCKED"]);
      expect(s.engine.get(s.w.id).state).toBe("HUMAN_PENDING");
      expect(s.engine.planSelfCheck.current(s.w.id)!.id).not.toBe(oldRequest);
      expect(s.stages).toEqual([
        "execute",
        PLAN_SELF_CHECK_STAGE,
        "quality_before_human",
        "execute",
        PLAN_SELF_CHECK_STAGE,
        "quality_before_human",
      ]);
      const w = s.engine.get(s.w.id);
      s.store.put("workflow", w.id, w.id, {
        ...w,
        plan_revision: 2,
        plan_hash: "changed",
      });
      expect(() =>
        s.engine.planSelfCheck.assertPassed(s.engine.get(w.id)),
      ).toThrow();
    } finally {
      await cleanup(s);
    }
  });
});
