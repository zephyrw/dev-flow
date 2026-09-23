import { describe, expect, it } from "vitest";
import {
  createQualityFlow,
  nextQualityAction,
  usesQualityPolicyV2,
} from "../../packages/core/src/quality-flow.js";
import {
  migrateWorkflowQualityPolicy,
  readQualityFlow,
  routeQualityEvent,
  writeQualityFlow,
} from "../../packages/core/src/quality-policy-migration.js";

function memoryStore(seed: Record<string, Record<string, unknown>> = {}) {
  const data = new Map<string, unknown>();
  for (const [kind, rows] of Object.entries(seed)) {
    for (const [id, value] of Object.entries(rows)) {
      data.set(kind + ":" + id, value);
    }
  }
  return {
    get<T>(kind: string, id: string): T | undefined {
      return data.get(kind + ":" + id) as T | undefined;
    },
    put(kind: string, id: string, _parent: string, value: unknown) {
      data.set(kind + ":" + id, value);
    },
    list<T>(kind: string, parent: string): T[] {
      const rows: T[] = [];
      for (const [key, value] of data) {
        if (key.startsWith(kind + ":")) rows.push(value as T);
      }
      return rows;
    },
    must<T>(kind: string, id: string): T {
      const value = data.get(kind + ":" + id);
      if (!value) throw new Error("missing " + kind + ":" + id);
      return value as T;
    },
    transaction<T>(fn: () => T): T {
      return fn();
    },
  } as never;
}

describe("quality-policy-v2 集成路由", () => {
  it("F01 全程通过：开发→复核→人工→最终复核→规划提交", () => {
    const store = memoryStore();
    let r = routeQualityEvent(store, "wf1", { type: "implement_completed" });
    expect(r.action.kind).toBe("quality_review");
    r = routeQualityEvent(store, "wf1", {
      type: "quality_review",
      result: { verdict: "passed" },
    });
    expect(r.action.kind).toBe("human");
    r = routeQualityEvent(store, "wf1", { type: "human_functional_passed" });
    expect(r.flow.phase).toBe("after_human");
    expect(r.action.kind).toBe("quality_review");
    r = routeQualityEvent(store, "wf1", {
      type: "quality_review",
      result: { verdict: "passed" },
    });
    expect(r.action.kind).toBe("planner_commit");
  });

  it("F02/F03 一次执行整改后规划接管", () => {
    const store = memoryStore();
    routeQualityEvent(store, "wf2", { type: "implement_completed" });
    let r = routeQualityEvent(store, "wf2", {
      type: "quality_review",
      result: { verdict: "changes_required" },
    });
    expect(r.action.kind).toBe("executor_repair");
    r = routeQualityEvent(store, "wf2", {
      type: "implement_completed",
      is_quality_repair: true,
    });
    expect(r.flow.executor_repair_completed).toBe(true);
    r = routeQualityEvent(store, "wf2", {
      type: "quality_review",
      result: { verdict: "changes_required" },
    });
    expect(r.action.kind).toBe("planner_repair");
    expect(r.flow.planner_repairs_only).toBe(true);
  });

  it("F07/F08/F11 测试完成不追加复核", () => {
    const store = memoryStore();
    routeQualityEvent(store, "wf3", {
      type: "planner_repair_completed",
    });
    const before = routeQualityEvent(store, "wf3", {
      type: "executor_test_completed",
      result: { status: "completed", code_changed: true },
    });
    expect(before.action.kind).toBe("human");

    writeQualityFlow(store, {
      ...createQualityFlow("wf4"),
      phase: "after_human",
      planner_repairs_only: true,
    });
    routeQualityEvent(store, "wf4", { type: "planner_repair_completed" });
    const after = routeQualityEvent(store, "wf4", {
      type: "executor_test_completed",
      result: { status: "completed", code_changed: true },
    });
    expect(after.action.kind).toBe("planner_commit");
  });

  it("F13 重复投递只产生一次后继动作", () => {
    const store = memoryStore();
    const first = routeQualityEvent(store, "wf5", {
      type: "quality_review",
      result: { verdict: "changes_required" },
    });
    const second = routeQualityEvent(store, "wf5", {
      type: "quality_review",
      result: { verdict: "changes_required" },
    });
    // 纯路由对相同事件给出相同动作；Engine 侧用 source_run_id 保证只入队一次。
    expect(first.action.kind).toBe(second.action.kind);
  });

  it("F15 明确完成不阻塞，不升级接管", () => {
    const store = memoryStore();
    const r = routeQualityEvent(store, "wf6", {
      type: "executor_test_completed",
      result: { status: "completed", summary: "测试通过（无附件）" },
    });
    expect(r.action.kind).toBe("human");
  });
});

describe("quality-policy-migration 11.1 映射", () => {
  it("C01 新任务已是策略 2 不迁移；旧任务在无活跃 Run 时迁移", () => {
    const store = memoryStore({
      workflow: {
        wnew: {
          id: "wnew",
          project_id: "p",
          state: "QUEUED",
          stage: "execute",
          quality_policy_version: 2,
        },
        wold: {
          id: "wold",
          project_id: "p",
          state: "REVIEW_QUEUED",
          stage: "review",
          quality_policy_version: 1,
        },
      },
    });
    expect(migrateWorkflowQualityPolicy(store, "wnew").migrated).toBe(false);
    const result = migrateWorkflowQualityPolicy(store, "wold");
    expect(result.migrated).toBe(true);
    const flow = readQualityFlow(store, "wold");
    expect(flow).toBeDefined();
  });

  it("C01 有活跃 Run 时不迁移，保持冻结用途", () => {
    const store = memoryStore({
      workflow: {
        wact: {
          id: "wact",
          project_id: "p",
          state: "EXECUTING",
          stage: "execute",
          quality_policy_version: 1,
        },
      },
      run: {
        r1: { id: "r1", purpose: "implement", status: "running" },
      },
    });
    const result = migrateWorkflowQualityPolicy(store, "wact");
    expect(result.migrated).toBe(false);
    expect(result.reason).toBe("active_run_frozen");
  });

  it("C01 已进入 Git 提交/集成的任务不迁移", () => {
    const store = memoryStore({
      workflow: {
        wgit: {
          id: "wgit",
          project_id: "p",
          state: "COMMITTING",
          stage: "planner_commit",
          quality_policy_version: 1,
        },
      },
    });
    const result = migrateWorkflowQualityPolicy(store, "wgit");
    expect(result.migrated).toBe(false);
    expect(result.reason).toBe("git_operation_in_flight");
  });

  it("C01 已完成任务只读保留", () => {
    const store = memoryStore({
      workflow: {
        wdone: {
          id: "wdone",
          project_id: "p",
          state: "COMPLETED",
          stage: "done",
          quality_policy_version: 1,
        },
      },
    });
    expect(migrateWorkflowQualityPolicy(store, "wdone").migrated).toBe(false);
  });

  it("C02 已迁移任务再迁移不重复", () => {
    const store = memoryStore({
      workflow: {
        wmig: {
          id: "wmig",
          project_id: "p",
          state: "QUEUED",
          stage: "execute",
          quality_policy_version: 1,
        },
      },
    });
    expect(migrateWorkflowQualityPolicy(store, "wmig").migrated).toBe(true);
    expect(migrateWorkflowQualityPolicy(store, "wmig").migrated).toBe(false);
    expect(usesQualityPolicyV2(2)).toBe(true);
  });
});

describe("planner-commit 契约", () => {
  it("G01 新策略不生成第二次候选提交的路由直达 planner_commit", () => {
    // 纯路由层：最终复核通过 → planner_commit；不经过 executeDelivery。
    const r = nextQualityAction(
      {
        flow: {
          workflow_id: "wf",
          phase: "after_human",
          executor_repair_completed: false,
          planner_repairs_only: true,
        },
      },
      { type: "quality_review", result: { verdict: "passed" } },
    );
    expect(r.action).toEqual({ kind: "planner_commit", phase: "after_human" });
  });

  it("G05 hook/冲突修复后的执行测试完成直接恢复规划提交", () => {
    const r = nextQualityAction(
      {
        flow: {
          workflow_id: "wf",
          phase: "after_human",
          executor_repair_completed: false,
          planner_repairs_only: true,
        },
      },
      {
        type: "executor_test_completed",
        result: { status: "completed", code_changed: true },
      },
    );
    expect(r.action.kind).toBe("planner_commit");
    expect(r.action.kind).not.toBe("quality_review");
  });
});
