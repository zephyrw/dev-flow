import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createIsolatedTestEnv,
  type IsolatedTestEnv,
} from "../fixtures/isolation.js";
import { AsideSessionService } from "../../packages/asides/src/service.js";
import { now } from "../../packages/core/src/util.js";

describe("IT-ASIDE: 全局单槽位控制、队列流转、取消与正式反馈幂等 (LF-17, LF-18, RQ-09, RQ-23)", () => {
  let env: IsolatedTestEnv;
  let asideService: AsideSessionService;
  const wf1 = "wf_aside_1";
  const wf2 = "wf_aside_2";

  beforeEach(() => {
    env = createIsolatedTestEnv();
    asideService = new AsideSessionService(env.store);

    env.store.put("workflow", wf1, "proj_aside", {
      id: wf1,
      project_id: "proj_aside",
      title: "Aside 测试任务 1",
      state: "EXECUTING",
      version: 1,
      plan_revision: 1,
      created_at: now(),
      updated_at: now(),
    });

    env.store.put("workflow", wf2, "proj_aside", {
      id: wf2,
      project_id: "proj_aside",
      title: "Aside 测试任务 2",
      state: "EXECUTING",
      version: 1,
      plan_revision: 1,
      created_at: now(),
      updated_at: now(),
    });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("TC-ASIDE-01: 全局严格只允许 1 个 active 提问，后发提问进入排队 (LF-17, RQ-09)", () => {
    // 1. 第一个提问：获得唯一的全局执行槽位 (active)
    const s1 = asideService.submitQuestion(
      wf1,
      "请问这段代码的架构设计依据是什么？",
    );
    expect(s1.status).toBe("active");

    // 2. 第二个提问（即使来自另一个工作流）：必须排队等待 (queued)
    const s2 = asideService.submitQuestion(
      wf2,
      "另外这个函数的性能瓶颈在哪里？",
    );
    expect(s2.status).toBe("queued");

    // 检查全局仅有 1 个 active
    const all = env.store.list<any>("aside_session");
    const activeList = all.filter((s) => s.status === "active");
    expect(activeList.length).toBe(1);
    expect(activeList[0].id).toBe(s1.id);
  });

  it("TC-ASIDE-02: 活跃会话完成或取消后，自动唤醒队列中的下一个提问 (LF-18)", () => {
    const s1 = asideService.submitQuestion(wf1, "问题 1");
    const s2 = asideService.submitQuestion(wf1, "问题 2");
    const s3 = asideService.submitQuestion(wf2, "问题 3");

    expect(s1.status).toBe("active");
    expect(s2.status).toBe("queued");
    expect(s3.status).toBe("queued");

    // 取消 s1 -> 自动唤醒最早排队的 s2
    asideService.cancelSession(wf1, s1.id);
    const s1Updated = env.store.get<any>("aside_session", s1.id);
    expect(s1Updated.status).toBe("cancelled");

    const s2Updated = env.store.get<any>("aside_session", s2.id);
    expect(s2Updated.status).toBe("active");

    // 完成 s2 -> 自动唤醒 s3
    asideService.completeSession(wf1, s2.id, "这是问题 2 的详细回答");
    const s3Updated = env.store.get<any>("aside_session", s3.id);
    expect(s3Updated.status).toBe("active");
  });

  it("TC-ASIDE-03: 提问与回答转化为正式迭代反馈必须严格幂等 (RQ-09)", () => {
    const s = asideService.submitQuestion(wf1, "需要增加防刷限流机制");
    asideService.completeSession(wf1, s.id, "建议使用令牌桶算法");

    // 第一次转为正式反馈
    const promoted1 = asideService.promoteToFormalFeedback(
      wf1,
      s.id,
      "确认按建议实施令牌桶限流",
      1,
    );
    expect(promoted1.message_id).toBeDefined();
    expect(promoted1.text).toBe("确认按建议实施令牌桶限流");
    expect(promoted1.client_request_id).toBe(`promoted_${s.id}`);

    // 重复点击转为正式反馈 -> 必须幂等返回已有反馈，严禁生成重复消息
    const promoted2 = asideService.promoteToFormalFeedback(
      wf1,
      s.id,
      "确认按建议实施令牌桶限流",
      1,
    );
    expect(promoted2.message_id).toBe(promoted1.message_id);

    const msgs = env.store.list<any>("feedback_message", wf1);
    const matched = msgs.filter(
      (m) => m.client_request_id === `promoted_${s.id}`,
    );
    expect(matched.length).toBe(1);
  });
});
