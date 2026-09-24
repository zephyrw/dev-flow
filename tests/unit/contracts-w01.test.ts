import { describe, expect, it } from "vitest";
import {
  WorkflowVisibilitySchema,
  WorkflowVisibilityUpdateRequestSchema,
  PlanApprovalRecordV2Schema,
  RunApprovalRefSchema,
  WorkflowOverviewViewSchema,
  ModelDefaultsSchema,
  ModelDefaultsV1Schema,
  ModelDefaultsV2Schema,
  ToolProfileSchema,
} from "../../packages/contracts/src/index.js";

describe("W01 共享合同与迁移测试", () => {
  it("WorkflowVisibilitySchema 支持规范字段与默认值", () => {
    const parsed = WorkflowVisibilitySchema.parse({
      workflow_id: "wf-1",
      revision: 1,
      archived: true,
      archived_at: "2026-09-24T10:00:00.000Z",
      restored_at: null,
      updated_at: "2026-09-24T10:00:00.000Z",
    });
    expect(parsed.schema_version).toBe(1);
    expect(parsed.archived).toBe(true);

    const updateReq = WorkflowVisibilityUpdateRequestSchema.parse({
      request_id: "req-123",
      expected_visibility_revision: 1,
      archived: false,
    });
    expect(updateReq.expected_visibility_revision).toBe(1);
  });

  it("PlanApprovalRecordV2Schema 与 RunApprovalRefSchema 正确校验", () => {
    const record = PlanApprovalRecordV2Schema.parse({
      workflow_id: "wf-1",
      plan_revision: 3,
      revision: 3,
      plan_hash: "phash-abc",
      request_id: "req-app-1",
      approved_at: "2026-09-24T10:00:00.000Z",
      execution_instructions: {
        text: "请尽量复用已有组件",
        text_hash: "thash-xyz",
        scope: "approved-plan",
      },
    });
    expect(record.schema_version).toBe(2);
    expect(record.execution_instructions.text).toBe("请尽量复用已有组件");

    const ref = RunApprovalRefSchema.parse({
      approval_id: "wf-1:3",
      plan_revision: 3,
      plan_hash: "phash-abc",
      instructions_hash: "thash-xyz",
    });
    expect(ref.approval_id).toBe("wf-1:3");
  });

  it("WorkflowOverviewViewSchema 正确解析概览投影结构", () => {
    const overview = WorkflowOverviewViewSchema.parse({
      workflow_id: "wf-1",
      plan_revision: 2,
      plan_hash: "phash",
      view_revision: "v-rev-1",
      goal: { status: "available", summary: "实现归档功能", items: [] },
      background: { status: "missing", summary: "", items: [] },
      findings: [{ id: "f-1", title: "CLI 未找到", status: "confirmed" }],
      unresolved: ["待确定命令版本"],
      tasks: [{ id: "t-1", title: "开发服务", status: "in_progress", source: "native_work_item" }],
      tests: [{ id: "ts-1", scenario: "归档测试", status: "passed", source: "native_acceptance" }],
      progress: {
        tasks: { total: 2, completed: 1, percentage: 50 },
        tests: null,
      },
      execution_constraints: {
        approval_id: "wf-1:2",
        text: "测试必须通过",
        text_hash: "hash-123",
      },
    });
    expect(overview.goal.status).toBe("available");
    expect(overview.progress.tasks?.percentage).toBe(50);
  });

  it("ModelDefaultsSchema v1 与 v2 兼容解析并默认 inherit", () => {
    const planner = ToolProfileSchema.parse({
      id: "p1",
      adapterId: "codex",
      modelSelection: "explicit",
      modelId: "gpt-6-astra",
    });
    const executor = ToolProfileSchema.parse({
      id: "e1",
      adapterId: "agy",
      modelSelection: "explicit",
      modelId: "gemini-3.8-flash-high",
    });

    // v1 数据结构
    const v1Data = {
      schema_version: 1,
      revision: 1,
      plannerProfile: planner,
      executorProfile: executor,
      updated_at: "2026-09-24T10:00:00.000Z",
      source: "legacy-import",
    };
    const parsedV1AsGeneral = ModelDefaultsSchema.parse(v1Data);
    expect(parsedV1AsGeneral.reviewerBinding).toEqual({ mode: "inherit" });

    // v2 数据结构
    const v2Data = {
      schema_version: 2,
      revision: 2,
      plannerProfile: planner,
      executorProfile: executor,
      reviewerBinding: {
        mode: "explicit",
        profile: planner,
      },
      updated_at: "2026-09-24T10:00:00.000Z",
      source: "user",
    };
    const parsedV2 = ModelDefaultsSchema.parse(v2Data);
    expect(parsedV2.reviewerBinding.mode).toBe("explicit");
  });
});
