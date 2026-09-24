import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../../packages/store/src/store.js";
import { ConfigSchema } from "../../packages/contracts/src/config.js";
import {
  CONVERSATION_ENTITY,
  type Workflow,
} from "../../packages/contracts/src/index.js";
import { Engine } from "../../packages/core/src/engine.js";
import {
  UserInteractionService,
  interactionConversationContext,
} from "../../packages/core/src/user-interaction-service.js";
import { saveWaitingContext } from "../../packages/core/src/waiting-context.js";
import { normalizeInteractionInput } from "../../packages/core/src/user-interaction-normalize.js";

describe("人工交互复查回归", () => {
  const stores: Store[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const store of stores.splice(0)) store.close();
  });
  function setup() {
    const store = new Store(":memory:");
    stores.push(store);
    const engine = new Engine(store, ConfigSchema.parse({}));
    const service = new UserInteractionService(store);
    const workflow: Workflow = {
      id: "wf-regression",
      project_id: "project-regression",
      title: "交互",
      request: "问题",
      complexity: "simple",
      workspace_mode: "existing_workspace",
      state: "WAITING_INPUT",
      stage: "execute",
      version: 1,
      plan_revision: 2,
      environment_revision: 1,
      run_id: "run-source",
      feedback: [],
      created_at: "2026-09-24",
      updated_at: "2026-09-24",
    };
    store.put("workflow", workflow.id, workflow.project_id, workflow);
    store.put("run", "run-source", workflow.id, {
      id: "run-source",
      workflow_id: workflow.id,
      plan_revision: 2,
      purpose: "executor_test",
      stage: "executor_test",
      status: "completed",
      conversation_id: "native-source",
    });
    const record = service.createInteraction({
      workflowId: workflow.id,
      sourceRunId: "run-source",
      sourcePlanRevision: 2,
      nativeSessionId: "native-source",
      purpose: "execute",
      role: "executor",
      rawInput: {
        kind: "question",
        title: "选择环境",
        message: "请选择目标环境",
        question: "使用哪套环境？",
        choices: [{ id: "local", label: "本地" }],
        resume_note: "回答后检查页面状态",
      },
    });
    saveWaitingContext(store, workflow.id, {
      purpose: "execute",
      role: "executor",
      intent: "need_user",
      run_id: "run-source",
      conversation_id: "native-source",
      interaction_id: record.id,
    });
    const response = {
      request_id: "request-regression",
      source_run_id: "run-source",
      source_plan_revision: 2,
      action: "answer" as const,
      choice_id: "local",
    };
    return { store, engine, service, workflow, record, response };
  }

  it("取消后保留等待且不能通过 current 重建兼容请求", async () => {
    const s = setup();
    await s.service.respondInteraction(
      s.workflow.id,
      s.record.id,
      { ...s.response, action: "cancel" },
      s.engine,
    );
    expect(s.service.getCurrentInteraction(s.workflow.id)).toBeUndefined();
    expect(s.engine.get(s.workflow.id).state).toBe("WAITING_INPUT");
    expect(s.store.jobs()).toHaveLength(0);
  });

  it("真实 Engine 续接保持 executor_test 职责并在重放时只入队一次", async () => {
    const s = setup();
    await s.service.respondInteraction(
      s.workflow.id,
      s.record.id,
      s.response,
      s.engine,
    );
    await s.service.respondInteraction(
      s.workflow.id,
      s.record.id,
      s.response,
      s.engine,
    );
    expect(s.engine.get(s.workflow.id).state).toBe("QUEUED");
    expect(
      s.store.get<{ purpose: string }>(
        "pending_dispatch_purpose",
        s.workflow.id,
      )?.purpose,
    ).toBe("executor_test");
    expect(s.store.jobs()).toHaveLength(1);
    const continuation = s.store.get<{ answer: string }>(
      "run_continuation",
      s.workflow.id,
    );
    expect(continuation?.answer).toContain("请选择目标环境");
    expect(continuation?.answer).toContain("本地");
    expect(continuation?.answer).toContain("回答后检查页面状态");
    expect(s.service.getCurrentInteraction(s.workflow.id)).toBeUndefined();
  });

  it("outbox 写入失败回滚决定、回执、continuation 与工作流状态", async () => {
    const s = setup();
    const fail = vi.spyOn(s.store, "enqueue").mockImplementationOnce(() => {
      throw new Error("injected write failure");
    });
    await expect(
      s.service.respondInteraction(
        s.workflow.id,
        s.record.id,
        s.response,
        s.engine,
      ),
    ).rejects.toThrow("injected write failure");
    expect(s.service.getInteraction(s.record.id)?.status).toBe("pending");
    expect(
      s.store.list("user_interaction_receipt", s.workflow.id),
    ).toHaveLength(0);
    expect(s.store.get("run_continuation", s.workflow.id)).toBeUndefined();
    expect(s.store.get("queue", s.workflow.id)).toBeUndefined();
    expect(s.engine.get(s.workflow.id).state).toBe("WAITING_INPUT");
    fail.mockRestore();
    await s.service.respondInteraction(
      s.workflow.id,
      s.record.id,
      s.response,
      s.engine,
    );
    expect(s.store.jobs()).toHaveLength(1);
  });

  it("当前计划变化时即使客户端和旧记录仍匹配也拒绝回答", async () => {
    const s = setup();
    s.store.put("workflow", s.workflow.id, s.workflow.project_id, {
      ...s.workflow,
      plan_revision: 3,
    });
    await expect(
      s.service.respondInteraction(
        s.workflow.id,
        s.record.id,
        s.response,
        s.engine,
      ),
    ).rejects.toMatchObject({ code: "INTERACTION_STALE" });
    expect(s.store.jobs()).toHaveLength(0);
    expect(s.service.getInteraction(s.record.id)?.status).toBe("pending");
  });

  it("匹配原生会话与来源 Run，不使用第一棵 UI 会话树", () => {
    const s = setup();
    for (const [id, native, run] of [
      ["root-old", "native-old", "run-old"],
      ["root-current", "native-source", "run-source"],
    ]) {
      s.store.put(CONVERSATION_ENTITY.node, id!, s.workflow.id, {
        id,
        root_id: id,
        workflow_id: s.workflow.id,
        native_session_id: native,
      });
      s.store.put(CONVERSATION_ENTITY.attempt, `${id}-attempt`, s.workflow.id, {
        id: `${id}-attempt`,
        conversation_id: id,
        root_id: id,
        run_id: run,
        generation: 3,
      });
    }
    expect(
      interactionConversationContext(
        s.store,
        s.workflow.id,
        "run-source",
        "native-source",
      ),
    ).toMatchObject({
      rootConversationId: "root-current",
      sourceGeneration: 3,
    });
    expect(
      interactionConversationContext(
        s.store,
        s.workflow.id,
        "unknown",
        "native-source",
      ).rootConversationId,
    ).toBeUndefined();
  });

  it("旧记录 URL 的读取投影移除认证内容，损坏问题保留正文并允许回答", () => {
    const s = setup();
    s.store.put("user_interaction", s.record.id, s.workflow.id, {
      ...s.record,
      request: {
        ...s.record.request,
        target: {
          url: "https://name:secret@example.com/login?code=secret#token",
        },
      },
    });
    expect(
      s.service.getCurrentInteraction(s.workflow.id)?.request.target?.url,
    ).toBe("https://example.com/login");
    const request = normalizeInteractionInput({
      kind: "question",
      title: "  ",
      message: "原始说明",
      question: "保留哪套数据？",
      allow_free_text: false,
    });
    expect(request).toMatchObject({
      kind: "question",
      message: "原始说明",
      question: "保留哪套数据？",
      allow_free_text: true,
    });
  });
});
