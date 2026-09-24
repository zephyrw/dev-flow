import { describe, it, expect, vi } from "vitest";
import { fixture, cleanup } from "../fixtures/native-flow.js";
import { UserInteractionService } from "../../packages/core/src/user-interaction-service.js";
import { Store } from "../../packages/store/src/store.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

describe("I02 — 用户交互恢复与异常边界", () => {
  it("数据库持久化与服务重启恢复：持久化 SQLite 重新打开后 pending 交互完整保留", async () => {
    const dbDir = join(
      tmpdir(),
      `devflow-recovery-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const dbPath = join(dbDir, "test.sqlite");

    try {
      // 1. 在第一个 Store 实例中创建交互
      const store1 = new Store(dbPath);
      const service1 = new UserInteractionService(store1);

      const created = service1.createInteraction({
        workflowId: "wf-restart-1",
        sourceRunId: "run-persist-1",
        sourcePlanRevision: 2,
        purpose: "execute",
        role: "executor",
        rawInput: {
          kind: "question",
          title: "是否跳过数据迁移？",
          message: "发现已有旧数据库，请选择是否迁移",
          question: "发现已有旧数据库，请选择是否迁移：",
          choices: [
            { id: "opt-migrate", label: "执行迁移" },
            { id: "opt-clean", label: "全新重置" },
          ],
        },
      });

      expect(created.status).toBe("pending");
      store1.close();

      // 2. 模拟服务重启：重新打开同一个 SQLite 文件
      const store2 = new Store(dbPath);
      const service2 = new UserInteractionService(store2);

      const recovered = service2.getCurrentInteraction("wf-restart-1");
      expect(recovered).toBeDefined();
      expect(recovered?.id).toBe(created.id);
      expect(recovered?.status).toBe("pending");
      expect(recovered?.request.title).toBe("是否跳过数据迁移？");
      expect(recovered?.request.choices).toHaveLength(2);

      // 3. 重启后能正常提交响应
      const mockEngine = {
        resumeFromWaiting: vi.fn(),
        feedback: vi.fn(),
      } as any;

      const responseResult = await service2.respondInteraction(
        "wf-restart-1",
        recovered!.id,
        {
          request_id: "req-post-restart",
          source_run_id: "run-persist-1",
          action: "answer",
          choice_id: "opt-migrate",
        },
        mockEngine,
      );

      expect(responseResult.success).toBe(true);
      expect(responseResult.interaction.status).toBe("answered");

      store2.close();
    } finally {
      try {
        rmSync(dbDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("已取消或已解决的交互不能被重复回答，返回异常", async () => {
    const s = await fixture();
    try {
      const service = new UserInteractionService(s.store);

      const interaction = service.createInteraction({
        workflowId: s.w.id,
        sourceRunId: "run-dup-1",
        sourcePlanRevision: 1,
        purpose: "execute",
        role: "executor",
        rawInput: {
          kind: "action_required",
          title: "请人工操作",
          message: "点击完成",
        },
      });

      // 主动取消交互
      await service.respondInteraction(
        s.w.id,
        interaction.id,
        {
          request_id: "req-cancel-1",
          source_run_id: "run-dup-1",
          action: "cancel",
        },
        s.engine,
      );

      const canceled = service.getInteraction(interaction.id);
      expect(canceled?.status).toBe("cancelled");

      // 对已取消的交互提交新回答，应当抛出 409 CONFLICT 异常
      await expect(
        service.respondInteraction(
          s.w.id,
          interaction.id,
          {
            request_id: "req-on-canceled",
            source_run_id: "run-dup-1",
            action: "confirm",
          },
          s.engine,
        ),
      ).rejects.toThrow(/该交互请求已被处理或失效/);
    } finally {
      await cleanup(s);
    }
  });
});
