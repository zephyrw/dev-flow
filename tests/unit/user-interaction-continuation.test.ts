import { describe, it, expect, vi } from "vitest";
import { Store } from "../../packages/store/src/store.js";
import { UserInteractionService } from "../../packages/core/src/user-interaction-service.js";
import {
  saveWaitingContext,
  readWaitingContext,
  clearWaitingContext,
  type WaitingContext,
} from "../../packages/core/src/waiting-context.js";
import {
  applyContinuationMaterials,
  normalizeExecutionIntent,
} from "../../packages/core/src/round-intent.js";
import type { RunContinuation } from "../../packages/contracts/src/tr-handoff.js";

describe("U02 — 用户交互延续性与 WaitingContext 集成", () => {
  it("来源角色、轮次与计划修订版本在创建交互时完整保留", () => {
    const store = new Store(":memory:");
    const service = new UserInteractionService(store);

    const interaction = service.createInteraction({
      workflowId: "wf-100",
      sourceRunId: "run-exec-1",
      sourcePlanRevision: 3,
      rootConversationId: "conv-root-1",
      purpose: "execute",
      role: "executor",
      rawInput: {
        kind: "action_required",
        title: "请人工完成登录",
        message: "登录后点确认",
      },
    });

    expect(interaction.workflow_id).toBe("wf-100");
    expect(interaction.source_run_id).toBe("run-exec-1");
    expect(interaction.source_plan_revision).toBe(3);
    expect(interaction.root_conversation_id).toBe("conv-root-1");
    expect(interaction.purpose).toBe("execute");
    expect(interaction.role).toBe("executor");
    expect(interaction.status).toBe("pending");

    // 保存到 WaitingContext
    saveWaitingContext(store, "wf-100", {
      purpose: "execute",
      role: "executor",
      intent: "need_user",
      run_id: "run-exec-1",
      conversation_id: "conv-root-1",
      interaction_id: interaction.id,
    });

    const waiting = readWaitingContext(store, "wf-100");
    expect(waiting?.interaction_id).toBe(interaction.id);
    expect(waiting?.run_id).toBe("run-exec-1");
  });

  it("用户提交响应后，答案组装并形成合法的 RunContinuation", async () => {
    const store = new Store(":memory:");
    const service = new UserInteractionService(store);

    const interaction = service.createInteraction({
      workflowId: "wf-101",
      sourceRunId: "run-exec-2",
      sourcePlanRevision: 1,
      purpose: "execute",
      role: "executor",
      rawInput: {
        kind: "question",
        title: "选择数据库配置",
        message: "请选择要初始化的数据库模式",
        question: "请选择要初始化的数据库模式：",
        choices: [
          { id: "opt-sqlite", label: "SQLite 内存模式" },
          { id: "opt-pg", label: "PostgreSQL 模式" },
        ],
      },
    });

    let resumedAnswer = "";
    const mockEngine = {
      resumeFromWaiting: vi.fn((_wfId, answer) => {
        resumedAnswer = answer;
      }),
      feedback: vi.fn(),
    } as any;

    store.put("workflow", "wf-101", "wf-101", {
      id: "wf-101",
      state: "WAITING_INPUT",
      plan_revision: 1,
    });

    saveWaitingContext(store, "wf-101", {
      purpose: "execute",
      role: "executor",
      intent: "need_user",
      run_id: "run-exec-2",
      interaction_id: interaction.id,
    });

    // 提交响应
    const result = await service.respondInteraction(
      "wf-101",
      interaction.id,
      {
        request_id: "req-submit-1",
        source_run_id: "run-exec-2",
        action: "answer",
        choice_id: "opt-sqlite",
        answer: "使用临时文件",
      },
      mockEngine,
    );

    expect(result.success).toBe(true);
    expect(result.interaction.status).toBe("answered");
    expect(mockEngine.resumeFromWaiting).toHaveBeenCalled();
    expect(resumedAnswer).toContain("SQLite 内存模式");
    expect(resumedAnswer).toContain("使用临时文件");

    // 组装 RunContinuation 材料验证
    const continuation: RunContinuation = {
      kind: "user_answer",
      source_run_id: "run-exec-2",
      purpose: "execute",
      role: "executor",
      original_text: "请选择要初始化的数据库模式",
      questions: ["请选择要初始化的数据库模式："],
      answer: resumedAnswer,
    };

    const materials = applyContinuationMaterials(
      { instructions: "开发并测试" },
      continuation,
    );

    expect(materials.questions).toEqual(continuation.questions);
    expect(materials.answer).toContain("SQLite 内存模式");
  });

  it("兼容旧版 WaitingContext（无 interaction_id 字段）正常读写与清理", () => {
    const store = new Store(":memory:");
    const legacyWaiting: WaitingContext = {
      purpose: "execute",
      role: "executor",
      intent: "need_user",
      run_id: "legacy-run-1",
      conversation_id: "legacy-conv-1",
      created_at: new Date().toISOString(),
    };

    saveWaitingContext(store, "wf-legacy", legacyWaiting);
    const read = readWaitingContext(store, "wf-legacy");
    expect(read).toBeDefined();
    expect(read?.interaction_id).toBeUndefined();
    expect(read?.run_id).toBe("legacy-run-1");

    clearWaitingContext(store, "wf-legacy");
    expect(readWaitingContext(store, "wf-legacy")).toBeUndefined();
  });

  it("当 status 为 completed 时，即使附带 user_interaction 也按 completed 交付，不影响正常完成", () => {
    const delivered = {
      status: "completed",
      summary: "所有实现与核验已完成",
      user_interaction: {
        kind: "action_required",
        title: "残留历史交互",
        message: "忽略",
      },
      delivery: {
        summary: "交付摘要",
      },
    };

    const normalized = normalizeExecutionIntent(delivered);
    expect(normalized.intent).toBe("completed");
    expect(normalized.summary).toBe("所有实现与核验已完成");
  });
});
