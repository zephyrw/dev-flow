import { expect, it, vi } from "vitest";
import {
  fixture,
  runtime,
  until,
  cleanup,
  seedPlannerTakeover,
} from "../fixtures/native-flow.js";
import { FlowError } from "../../packages/contracts/src/index.js";
import { rejectedDeliveryFeedback } from "../../packages/core/src/delivery-feedback.js";
import { resumeApproved } from "../../packages/runtime/src/recovery.js";

it.each(["feedback", "recover"])(
  "resuming an exhausted delivery through %s removes legacy execution-failure takeover",
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
      s.store.put("repair_assignment", s.w.id, s.w.id, {
        planner: true,
        source: "execution_failure",
        phase: "before_human",
        plan_revision: 1,
      });
      if (entry === "recover") resumeApproved(s.engine, s.w.id);
      else s.engine.feedback(s.w.id, "继续自动修复", "within_plan");
      expect(s.store.get("repair_assignment", s.w.id)).toBeUndefined();
      expect(s.store.get("repair_state", s.w.id)).toBeUndefined();
      expect(s.engine.get(s.w.id)).toMatchObject({
        state: "QUEUED",
        plan_revision: 1,
      });
    } finally {
      await cleanup(s);
    }
  },
);

it("three failed native execution rounds keep the executor and do not count as quality remediation", async () => {
  const s = await fixture();
  const base = runtime(s);
  const owners: string[] = [];
  const diagnose = vi.fn();
  s.engine.runtime = {
    ...base,
    diagnose,
    async execute(w, run, token) {
      owners.push(run.adapter);
      if (owners.length <= 3)
        throw new FlowError(
          "DELIVERY_REJECTED",
          `核验剩余 ${41 - owners.length} 个问题`,
        );
      await base.execute(w, run, token);
    },
  };
  try {
    await until(s, ["HUMAN_PENDING", "BLOCKED"], 120000);
    expect(s.engine.get(s.w.id).blocker).toBeUndefined();
    expect(s.engine.get(s.w.id).state).toBe("HUMAN_PENDING");
    expect(s.engine.get(s.w.id).plan_revision).toBe(1);
    expect(owners).toEqual(["agy", "agy", "agy", "agy"]);
    expect(s.engine.quality.getGate(s.w.id, "before_human")).toMatchObject({
      executor_rejections: 0,
      takeover: false,
    });
    expect(diagnose).not.toHaveBeenCalled();
    expect(
      s.store.events(s.w.id).some((e) => e.type === "PlannerRepairScheduled"),
    ).toBe(false);
  } finally {
    await cleanup(s);
  }
}, 150000);

it("execution recovery stops after six failed runs without switching to the planner", async () => {
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
    expect(owners).toEqual(Array(6).fill("agy"));
    expect(s.engine.get(s.w.id).blocker?.message).toContain(
      "执行模型执行恢复连续六轮",
    );
    expect(s.store.get("repair_assignment", s.w.id)).toBeUndefined();
    expect(s.store.list("quality_gate", s.w.id)).toHaveLength(0);
  } finally {
    await cleanup(s);
  }
}, 150000);

it("a legitimate quality takeover keeps planner ownership during bounded execution recovery", async () => {
  const s = await fixture();
  seedPlannerTakeover(s);
  const owners: string[] = [];
  s.engine.runtime = {
    ...runtime(s),
    async execute(_w, run) {
      owners.push(run.adapter);
      expect(run.purpose).toBe("planner_takeover");
      throw new FlowError("DELIVERY_REJECTED", "规划接管后的交付尚未完成");
    },
  };
  try {
    await until(s, ["BLOCKED"], 120000);
    expect(owners).toEqual(Array(3).fill("codex"));
    expect(s.engine.get(s.w.id).blocker?.code).toBe("REPAIR_EXHAUSTED");
    expect(s.engine.quality.getGate(s.w.id, "before_human")).toMatchObject({
      executor_rejections: 3,
      takeover: true,
    });
    expect(s.store.get("repair_assignment", s.w.id)).toMatchObject({
      planner: true,
      source: "quality_review",
    });
  } finally {
    await cleanup(s);
  }
}, 150000);

it("dispatch rejects a queued legacy takeover even without an explicit resume", async () => {
  const s = await fixture();
  const base = runtime(s);
  const owners: string[] = [];
  s.store.put("repair_assignment", s.w.id, s.w.id, {
    planner: true,
    phase: "before_human",
    source: "execution_failure",
    plan_revision: 1,
  });
  s.engine.runtime = {
    ...base,
    async execute(w, run, token) {
      owners.push(run.adapter);
      await base.execute(w, run, token);
    },
  };
  try {
    await until(s, ["HUMAN_PENDING", "BLOCKED"]);
    expect(s.engine.get(s.w.id).state).toBe("HUMAN_PENDING");
    expect(owners).toEqual(["agy"]);
    expect(s.store.get("repair_assignment", s.w.id)).toBeUndefined();
  } finally {
    await cleanup(s);
  }
});

it("执行交付后直接进入规划审查，不会把执行失败计为质量整改接管", async () => {
  const s = await fixture();
  const base = runtime(s);
  const owners: string[] = [];
  s.engine.runtime = {
    ...base,
    async execute(w, run, token) {
      owners.push(run.adapter);
      await base.execute(w, run, token);
    },
  };
  try {
    await until(s, ["HUMAN_PENDING", "BLOCKED"]);
    expect(s.engine.get(s.w.id).state).toBe("HUMAN_PENDING");
    expect(owners).toEqual(["agy"]);
    expect(s.engine.quality.getGate(s.w.id, "before_human")).toMatchObject({
      executor_rejections: 0,
      takeover: false,
    });
  } finally {
    await cleanup(s);
  }
});

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
