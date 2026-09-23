import { describe, expect, it } from "vitest";
import {
  migrateWorkflowQualityPolicy,
  migrationReceipt,
  readQualityFlow,
  usesPolicyV2,
} from "../../packages/core/src/quality-policy-migration.js";
import { usesQualityPolicyV2 } from "../../packages/core/src/quality-flow.js";

function memoryStore(seed: Record<string, Record<string, unknown>> = {}) {
  const data = new Map<string, unknown>();
  const outbox: {
    id: string;
    workflow_id: string;
    kind: string;
    data: string;
    status: string;
  }[] = [];
  let jobSeq = 0;
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
    list<T>(kind: string, _parent: string): T[] {
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
    enqueue(workflowId: string, kind: string, payload: unknown) {
      const id = "job-" + ++jobSeq;
      outbox.push({
        id,
        workflow_id: workflowId,
        kind,
        data: JSON.stringify(payload),
        status: "pending",
      });
      return id;
    },
    jobs() {
      return outbox
        .filter((job) => job.status === "pending")
        .map(({ id, workflow_id, kind, data }) => ({ id, workflow_id, kind, data }));
    },
    jobStatus(id: string, status: string) {
      const job = outbox.find((item) => item.id === id);
      if (job) job.status = status;
    },
  } as never;
}

const baseWorkflow = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  project_id: "p",
  title: "t",
  request: "r",
  complexity: "simple",
  workspace_mode: "existing_workspace",
  state: "QUEUED",
  stage: "execute",
  version: 1,
  plan_revision: 1,
  environment_revision: 1,
  created_at: "2026-09-22T00:00:00.000Z",
  updated_at: "2026-09-22T00:00:00.000Z",
  feedback: [],
  quality_policy_version: 1,
  ...extra,
});

describe("quality-policy-migration 11.1 存量任务迁移", () => {
  it("C01 首次开发尚未完成 → before_human，未完成执行质量整改", () => {
    const store = memoryStore({
      workflow: { w: baseWorkflow("w", { state: "EXECUTING" }) },
      run: { r: { id: "r", purpose: "implement", status: "completed" } },
    });
    const result = migrateWorkflowQualityPolicy(store, "w");
    expect(result.migrated).toBe(true);
    const flow = readQualityFlow(store, "w");
    expect(flow.phase).toBe("before_human");
    expect(flow.executor_repair_completed).toBe(false);
    expect(flow.planner_repairs_only).toBe(false);
  });

  it("C01 有已完成执行质量整改，等待复核 → executor_repair_completed=true", () => {
    const store = memoryStore({
      workflow: { w: baseWorkflow("w", { state: "REVIEW_QUEUED" }) },
      run: {
        r1: { id: "r1", purpose: "implement", status: "completed" },
      },
      repair_assignment: {
        w: {
          planner: false,
          phase: "before_human",
          source: "quality_review",
        },
      },
    });
    migrateWorkflowQualityPolicy(store, "w");
    const flow = readQualityFlow(store, "w");
    expect(flow.executor_repair_completed).toBe(true);
  });

  it("D01 初次开发完成、首次整改待开始（QUEUED）→ 不消耗唯一一次整改机会", () => {
    const store = memoryStore({
      workflow: { w: baseWorkflow("w", { state: "QUEUED" }) },
      run: {
        r1: { id: "r1", purpose: "implement", status: "completed" },
      },
      repair_assignment: {
        w: {
          planner: false,
          phase: "before_human",
          source: "quality_review",
          assignment_id: "a1",
        },
      },
    });
    migrateWorkflowQualityPolicy(store, "w");
    const flow = readQualityFlow(store, "w");
    expect(flow.executor_repair_completed).toBe(false);
  });

  it("D01 绑定完成 Run 的整改消耗机会，无关 implement 完成不消耗", () => {
    const store = memoryStore({
      workflow: { w: baseWorkflow("w", { state: "REVIEW_QUEUED" }) },
      run: {
        r1: { id: "r1", purpose: "implement", status: "completed", assignment_id: "other" },
        r2: { id: "r2", purpose: "implement", status: "completed", assignment_id: "a1" },
      },
      repair_assignment: {
        w: {
          planner: false,
          phase: "before_human",
          source: "quality_review",
          assignment_id: "a1",
          consumed_completion_run_id: "r2",
        },
      },
    });
    migrateWorkflowQualityPolicy(store, "w");
    const flow = readQualityFlow(store, "w");
    expect(flow.executor_repair_completed).toBe(true);
  });

  it("D02 规划修复完成待续接 → planner_repairs_only 且派执行测试不重复派规划接管", () => {
    const store = memoryStore({
      workflow: { w: baseWorkflow("w", { state: "QUEUED" }) },
      run: {
        r1: { id: "r1", purpose: "planner_takeover", status: "completed" },
      },
      repair_assignment: {
        w: {
          planner: true,
          phase: "before_human",
          source: "quality_review",
          assignment_id: "a1",
        },
      },
    });
    migrateWorkflowQualityPolicy(store, "w");
    const flow = readQualityFlow(store, "w");
    expect(flow.planner_repairs_only).toBe(true);
    const readPending = store as unknown as {
      get<T>(kind: string, id: string): T | undefined;
    };
    const pending = readPending.get<{ purpose?: string }>(
      "pending_dispatch_purpose",
      "w",
    );
    expect(pending?.purpose).toBe("executor_test");
  });

  it("C01 已接管或接管 Run 刚完成 → planner_repairs_only=true", () => {
    const store = memoryStore({
      workflow: { w: baseWorkflow("w", { state: "PLANNER_TAKEOVER" }) },
      run: {
        r1: { id: "r1", purpose: "planner_takeover", status: "completed" },
      },
    });
    migrateWorkflowQualityPolicy(store, "w");
    const flow = readQualityFlow(store, "w");
    expect(flow.planner_repairs_only).toBe(true);
  });

  it("C01 功能修复已完成待人复测 → 回人工，不插入质量复核", () => {
    const store = memoryStore({
      workflow: { w: baseWorkflow("w", { state: "HUMAN_PENDING" }) },
      functional_issue: {
        i1: { status: "ready_for_retest" },
      },
    });
    const result = migrateWorkflowQualityPolicy(store, "w");
    expect(result.migrated).toBe(true);
    const flow = readQualityFlow(store, "w");
    // 保留人的问题状态和等待状态；人工通过后进入 after_human
    expect(flow.phase).toBe("before_human");
  });

  it("C01 after_human 质量整改阶段 → 质量修复直接规划", () => {
    const store = memoryStore({
      workflow: { w: baseWorkflow("w", { state: "REVIEW_QUEUED" }) },
      plan_check_review_intent: {
        w: { phase: "after_human" },
      },
    });
    migrateWorkflowQualityPolicy(store, "w");
    const flow = readQualityFlow(store, "w");
    expect(flow.phase).toBe("after_human");
    expect(flow.planner_repairs_only).toBe(true);
  });

  it("C01 活跃 Run 不迁移；完成后在下一派发边界迁移", () => {
    const store = memoryStore({
      workflow: { w: baseWorkflow("w", { state: "EXECUTING" }) },
      run: { r: { id: "r", purpose: "implement", status: "running" } },
    });
    const first = migrateWorkflowQualityPolicy(store, "w");
    expect(first.migrated).toBe(false);
    expect(first.reason).toBe("active_run_frozen");
  });

  it("C02 已迁移任务重启不重复迁移，保留 receipt", () => {
    const store = memoryStore({
      workflow: { w: baseWorkflow("w") },
    });
    expect(migrateWorkflowQualityPolicy(store, "w").migrated).toBe(true);
    const receipt = migrationReceipt(store, "w");
    expect(receipt).toBeDefined();
    expect((receipt as { to_policy?: number }).to_policy).toBe(2);
    const again = migrateWorkflowQualityPolicy(store, "w");
    expect(again.migrated).toBe(false);
    expect(again.reason).toBe("already_policy_2");
  });

  it("usesPolicyV2 / usesQualityPolicyV2 一致", () => {
    expect(usesPolicyV2({ quality_policy_version: 2 })).toBe(true);
    expect(usesPolicyV2({})).toBe(false);
    expect(usesQualityPolicyV2(2)).toBe(true);
  });
});
