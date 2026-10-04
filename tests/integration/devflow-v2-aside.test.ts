import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createIsolatedTestEnv,
  type IsolatedTestEnv,
} from "../fixtures/isolation.js";
import { AsideSessionService } from "../../packages/asides/src/service.js";
import { now } from "../../packages/core/src/util.js";

describe("IT-ASIDE: 提问并行、旧队列恢复、取消与正式反馈幂等", () => {
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

  it("TC-ASIDE-01: 同项目及跨项目提问不受全局数量限制", () => {
    const s1 = asideService.submitQuestion(
      wf1,
      "请问这段代码的架构设计依据是什么？",
    );
    expect(s1.status).toBe("active");

    const s2 = asideService.submitQuestion(
      wf2,
      "另外这个函数的性能瓶颈在哪里？",
    );
    expect(s2.status).toBe("active");

    const all = env.store.list<any>("aside_session");
    const activeList = all.filter((s) => s.status === "active");
    expect(activeList.length).toBe(2);
    expect(activeList[0].id).toBe(s1.id);
  });

  it("TC-ASIDE-02: 活跃会话取消后，一次恢复所有旧队列提问", () => {
    const s1 = asideService.submitQuestion(wf1, "问题 1");
    const s2 = asideService.submitQuestion(wf1, "问题 2");
    const s3 = asideService.submitQuestion(wf2, "问题 3");

    expect(s1.status).toBe("active");
    env.store.put("aside_session", s2.id, wf1, { ...s2, status: "queued" });
    env.store.put("aside_session", s3.id, wf2, { ...s3, status: "queued" });

    // 取消 s1 -> 自动唤醒最早排队的 s2
    asideService.cancelSession(wf1, s1.id);
    const s1Updated = env.store.get<any>("aside_session", s1.id);
    expect(s1Updated.status).toBe("cancelled");

    const s2Updated = env.store.get<any>("aside_session", s2.id);
    expect(s2Updated.status).toBe("active");

    expect(env.store.get<any>("aside_session", s3.id).status).toBe("active");
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

  it("TC-ASIDE-04: 运行失败写入可见原因，而不是静默取消", () => {
    const s = asideService.submitQuestion(wf1, "执行到哪了？");
    expect(s.status).toBe("active");
    asideService.settleRun(wf1, s.id, { error: new Error("TIMEOUT") });
    const updated = env.store.get<any>("aside_session", s.id);
    expect(updated.status).toBe("expired");
    expect(updated.answer).toContain("提问超时");
  });
});
