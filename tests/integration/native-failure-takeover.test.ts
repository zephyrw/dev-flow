import { expect, it, vi } from "vitest";
import { fixture, runtime, until, cleanup } from "../fixtures/native-flow.js";
import { FlowError } from "../../packages/contracts/src/index.js";
import { rejectedDeliveryFeedback } from "../../packages/core/src/delivery-feedback.js";
import { resumeApproved } from "../../packages/runtime/src/recovery.js";

it.each(["feedback", "recover"])(
  "resuming an exhausted delivery through %s transfers ownership to the planner",
  async (entry) => {
    const s = await fixture();
    try {
      s.engine.block(
        s.w.id,
        new FlowError("REPAIR_EXHAUSTED", "旧版重试已耗尽"),
      );
      s.store.put("repair_state", s.w.id, s.w.id, {
        plan_revision: 1,
        consecutive: 6,
        code: "DELIVERY_REJECTED",
      });
      expect(s.store.get("repair_assignment", s.w.id)).toBeUndefined();
      if (entry === "recover") resumeApproved(s.engine, s.w.id);
      else s.engine.feedback(s.w.id, "继续自动修复", "within_plan");
      expect(s.store.get("repair_assignment", s.w.id)).toMatchObject({
        planner: true,
        source: "execution_failure",
      });
      expect(s.engine.get(s.w.id)).toMatchObject({
        state: "QUEUED",
        plan_revision: 1,
      });
    } finally {
      await cleanup(s);
    }
  },
);

it("three failed native execution rounds transfer actual execution to the planner without changing the approved plan", async () => {
  const s = await fixture();
  const base = runtime(s);
  const owners: string[] = [];
  const diagnose = vi.fn();
  s.engine.runtime = {
    ...base,
    diagnose,
    async execute(w, run, token) {
      if (run.purpose !== "plan_self_check") {
        owners.push(run.adapter);
        if (owners.length <= 3)
          throw new FlowError(
            "DELIVERY_REJECTED",
            `核验剩余 ${41 - owners.length} 个问题`,
          );
      }
      await base.execute(w, run, token);
    },
  };
  try {
    await until(s, ["HUMAN_PENDING", "BLOCKED"], 120000);
    expect(s.engine.get(s.w.id).blocker).toBeUndefined();
    expect(s.engine.get(s.w.id).state).toBe("HUMAN_PENDING");
    expect(s.engine.get(s.w.id).plan_revision).toBe(1);
    expect(owners).toEqual(["agy", "agy", "agy", "codex"]);
    expect(diagnose).not.toHaveBeenCalled();
    expect(
      s.store.events(s.w.id).some((e) => e.type === "PlannerRepairScheduled"),
    ).toBe(true);
  } finally {
    await cleanup(s);
  }
}, 150000);

it("planner repair is bounded and cannot silently return ownership to the executor", async () => {
  const s = await fixture();
  const owners: string[] = [];
  s.engine.runtime = {
    ...runtime(s),
    async execute(_w, run) {
      owners.push(run.adapter);
      throw new FlowError(
        "DELIVERY_REJECTED",
        `不同的失败细节 ${owners.length}`,
      );
    },
  };
  try {
    await until(s, ["BLOCKED"], 120000);
    expect(owners).toEqual(["agy", "agy", "agy", "codex", "codex", "codex"]);
    expect(s.engine.get(s.w.id).blocker?.message).toContain(
      "规划模型接手后连续三轮",
    );
  } finally {
    await cleanup(s);
  }
}, 150000);

it("repair feedback contains only the latest rejected delivery for the approved plan", async () => {
  const s = await fixture();
  try {
    const w = s.engine.get(s.w.id);
    for (const [id, revision] of [
      ["old", 1],
      ["current", 1],
      ["other-plan", 2],
    ] as const) {
      s.store.put("delivery", id, w.id, {
        id,
        plan_revision: revision,
        plan_hash: w.plan_hash,
        status: "rejected",
        run_id: id,
      });
      s.store.put("delivery_issue", id, w.id, {
        delivery_id: id,
        status: "open",
        code: id,
      });
    }
    expect(rejectedDeliveryFeedback(s.store, w)).toMatchObject({
      delivery_id: "current",
      issues: [{ code: "current" }],
    });
  } finally {
    await cleanup(s);
  }
});
