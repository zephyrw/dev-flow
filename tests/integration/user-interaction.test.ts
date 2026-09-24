import { describe, it, expect } from "vitest";
import { fixture, cleanup } from "../fixtures/native-flow.js";
import { readWaitingContext } from "../../packages/core/src/waiting-context.js";
import { UserInteractionService } from "../../packages/core/src/user-interaction-service.js";

describe("I01 — 用户交互全链路闭环 (结果接收 → WAITING_INPUT → 回答 → 恢复)", () => {
  it("执行模型返回 need_user 与 user_interaction，系统挂起并生成 pending 交互，用户确认后恢复", async () => {
    const s = await fixture();
    try {
      const approved = s.engine.get(s.w.id);
      const runId = "run-interaction-1";

      s.engine.transition(s.w.id, [approved.state], "EXECUTING", "execute", {
        run_id: runId,
      });

      s.store.put("run", runId, s.w.id, {
        id: runId,
        workflow_id: s.w.id,
        plan_revision: approved.plan_revision,
        adapter: "codex",
        stage: "execute",
        status: "running",
        purpose: "implement",
        protocol: "lightweight",
        started_at: new Date().toISOString(),
        package_hash: "pkg-1",
      });

      // 1. 模型返回包含 user_interaction 的结果
      const delivered = await s.engine.deliver(s.w.id, {
        status: "need_user",
        summary: "需要用户完成手机验证码登录",
        user_interaction: {
          kind: "action_required",
          title: "请人工完成登录",
          message: "在浏览器中输入手机验证码完成登录",
          action_label: "已完成登录",
          target: {
            url: "http://127.0.0.1:5173/login",
          },
        },
      });

      expect(delivered.status).toBe("need_user");

      // 2. 验证工作流状态流转为 WAITING_INPUT
      const currentWorkflow = s.engine.get(s.w.id);
      expect(currentWorkflow.state).toBe("WAITING_INPUT");

      // 3. 验证 WaitingContext 记录了 interaction_id
      const waiting = readWaitingContext(s.store, s.w.id);
      expect(waiting).toBeDefined();
      expect(waiting?.role).toBe("executor");
      expect(waiting?.interaction_id).toBeDefined();

      const interactionService = new UserInteractionService(s.store);

      // 4. API 读取：获取当前待处理交互
      const currentInteraction = interactionService.getCurrentInteraction(s.w.id);
      expect(currentInteraction).toBeDefined();
      expect(currentInteraction?.id).toBe(waiting?.interaction_id);
      expect(currentInteraction?.status).toBe("pending");
      expect(currentInteraction?.request.kind).toBe("action_required");
      expect(currentInteraction?.request.title).toBe("请人工完成登录");

      // 5. 用户提交完成确认
      const responseResult = await interactionService.respondInteraction(
        s.w.id,
        currentInteraction!.id,
        {
          request_id: "req-user-resp-1",
          source_run_id: runId,
          action: "confirm",
          answer: "已在页面输入短信验证码并成功进入系统",
        },
        s.engine,
      );

      expect(responseResult.success).toBe(true);
      expect(responseResult.interaction.status).toBe("answered");

      // 6. 验证幂等性：客户端如果重试相同 request_id，应返回幂等
      const retryResult = await interactionService.respondInteraction(
        s.w.id,
        currentInteraction!.id,
        {
          request_id: "req-user-resp-1",
          source_run_id: runId,
          action: "confirm",
        },
        s.engine,
      );

      expect(retryResult.success).toBe(true);
    } finally {
      await cleanup(s);
    }
  });
});
