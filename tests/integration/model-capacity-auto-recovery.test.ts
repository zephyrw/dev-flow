import { expect, it } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setup, repository, project, plan, seedCreateAccess } from "../helpers.js";
import {
  fixture as nativeFixture,
  runtime as fixtureRuntime,
  until,
  cleanup,
  passReview,
  deliver,
} from "../fixtures/native-flow.js";
import { FlowError, type Run, type Workflow } from "../../packages/contracts/src/index.js";
import type { AsideSession } from "../../packages/contracts/src/feedback.js";
import type { Runtime } from "../../packages/core/src/engine.js";
import { beginRunConversation, retainRunConversation } from "../../packages/core/src/conversation-lineage.js";
import { objectHash } from "../../packages/core/src/util.js";
import { AsideSessionService } from "../../packages/asides/src/service.js";

const capacityError = (model = "gemini-3.8-flash-high") =>
  `CLI 返回错误：${JSON.stringify({
    error: `API error (attempt 6): UNAVAILABLE (code 503): No capacity available for model ${model} on the server`,
  })}`;

it("执行模型遇到临时容量错误时保留原会话并隔 5 秒自动恢复执行", async () => {
  const s = await nativeFixture();
  const seen: Run[] = [];
  const callTimes: number[] = [];
  const resumed: Array<{ id: string } | undefined> = [];
  try {
    s.engine.runtime = fixtureRuntime(s, async (run) => {
      seen.push(run);
      callTimes.push(Date.now());
      resumed.push(beginRunConversation(s.store, run));
      if (seen.length === 1) {
        retainRunConversation(s.store, run, "exec-capacity-session");
        throw new FlowError("NATIVE_RUN_FAILED", capacityError("gemini-3.8-flash-high"), 422, { exit_code: 1 });
      }
      await s.engine.receiveRoundResult(s.w.id, run.id, {
        status: "need_user",
        summary: "容量恢复后继续",
        user_interaction: {
          kind: "question",
          title: "确认继续",
          message: "容量恢复后继续执行。",
          question: "请确认下一步？",
        },
      });
    });
    await until(s, ["WAITING_INPUT"]);
    expect(seen).toHaveLength(2);
    expect(callTimes[1]! - callTimes[0]!).toBeGreaterThanOrEqual(4500);
    expect(resumed).toEqual([undefined, { id: "exec-capacity-session" }]);
    expect(s.store.get("repair_state", s.w.id)).toBeUndefined();
    const events = s.store.events(s.w.id).filter((e) => e.type === "ModelRetryScheduled");
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      code: "MODEL_CAPACITY_UNAVAILABLE",
      attempt: 1,
      max_attempts: 10,
      delay_ms: 5000,
    });
  } finally {
    await cleanup(s);
  }
});

it("规划模型遇到临时容量错误时隔 5 秒自动恢复规划", async () => {
  const s = setup();
  try {
    const repo = await repository(s.root);
    const p = project(repo.repo);
    s.store.put("project", p.id, "global", p);
    seedCreateAccess(s.store);
    const created = s.engine.create(
      {
        project_id: p.id,
        title: "规划容量恢复测试",
        request: "生成简单计划",
        complexity: "simple",
        workspace_mode: "existing_workspace",
      },
      "capacity-plan-create",
    );
    s.engine.transition(created.id, [created.state], "PLANNING", "planning");
    s.engine.scheduler.enqueue(created.id, p.id);

    const seen: Run[] = [];
    const callTimes: number[] = [];
    const samplePlan = plan(objectHash(p), repo.baseline);
    s.engine.runtime = {
      async plan(_w: Workflow, run: Run) {
        seen.push(run);
        callTimes.push(Date.now());
        if (seen.length === 1) {
          retainRunConversation(s.store, run, "planner-capacity-session");
          throw new FlowError("NATIVE_RUN_FAILED", capacityError("claude-sonnet-4-6"), 422, { exit_code: 1 });
        }
        return {
          markdown: samplePlan.markdown,
          plan: {
            ...samplePlan,
            task_model: "native-v2",
            modules: [{ id: "M01", title: "Text" }],
          },
        };
      },
      async execute() {},
      async review() { return {}; },
      async stop() {},
      async check() { throw new Error("unused"); },
      async close() {},
    } as unknown as Runtime;

    await s.engine.dispatch();
    await expect
      .poll(async () => {
        await s.engine.dispatch();
        return s.engine.get(created.id).state;
      }, { timeout: 30000, interval: 200 })
      .toSatisfy((state) => ["PLAN_PENDING", "BLOCKED"].includes(state));
    expect(s.engine.get(created.id)).toMatchObject({ state: "PLAN_PENDING" });

    expect(seen).toHaveLength(2);
    expect(callTimes[1]! - callTimes[0]!).toBeGreaterThanOrEqual(4500);
    expect(s.store.get("transient_network_retry", created.id)).toBeUndefined();
    const events = s.store.events(created.id).filter((e) => e.type === "ModelRetryScheduled");
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      code: "MODEL_CAPACITY_UNAVAILABLE",
      attempt: 1,
      delay_ms: 5000,
    });
  } finally {
    s.engine.runtime = undefined;
    s.store.close();
    rmSync(s.root, { recursive: true, force: true });
  }
});

it("审查模型遇到临时容量错误时隔 5 秒自动恢复审查", async () => {
  const s = await nativeFixture();
  try {
    let reviewCalls = 0;
    const callTimes: number[] = [];
    const base = fixtureRuntime(s);
    s.engine.runtime = {
      ...base,
      async execute(_w, run) {
        writeFileSync(join(s.repo, "app.txt"), "after\n");
        expect((await deliver(s, run)).status).toBe("accepted");
      },
      async review(w) {
        reviewCalls++;
        callTimes.push(Date.now());
        if (reviewCalls === 1) {
          throw new FlowError("NATIVE_RUN_FAILED", capacityError("gpt-5"), 422, { exit_code: 1 });
        }
        return passReview(w);
      },
    };
    await until(s, ["HUMAN_PENDING"]);
    expect(reviewCalls).toBe(2);
    expect(callTimes[1]! - callTimes[0]!).toBeGreaterThanOrEqual(4500);
    expect(s.store.get("transient_network_retry", s.w.id)).toBeUndefined();
    const events = s.store.events(s.w.id).filter((e) => e.type === "ModelRetryScheduled");
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      code: "MODEL_CAPACITY_UNAVAILABLE",
      attempt: 1,
      delay_ms: 5000,
    });
  } finally {
    await cleanup(s);
  }
});

it("提交模型(planner_commit)遇到临时容量错误时不误转人工，隔 5 秒自动恢复完成提交", async () => {
  const s = await nativeFixture();
  try {
    s.engine.transition(s.w.id, ["QUEUED"], "QUEUED", "planner_commit");
    s.store.put("pending_dispatch_purpose", s.w.id, s.w.id, { purpose: "planner_commit" });
    let commitCalls = 0;
    const callTimes: number[] = [];
    s.engine.runtime = fixtureRuntime(s, async (run) => {
      commitCalls++;
      callTimes.push(Date.now());
      expect(run.purpose).toBe("planner_commit");
      if (commitCalls === 1) {
        throw new FlowError("NATIVE_RUN_FAILED", capacityError("gemini-3.5-pro"), 422, { exit_code: 1 });
      }
      await s.engine.receiveRoundResult(s.w.id, run.id, {
        status: "need_user",
        summary: "容量恢复后提交模型正常执行",
        user_interaction: {
          kind: "action_required",
          title: "确认提交收尾",
          message: "提交模型已恢复运行。",
          action_label: "确认",
        },
      });
    });
    await until(s, ["WAITING_INPUT"]);
    expect(commitCalls).toBe(2);
    expect(callTimes[1]! - callTimes[0]!).toBeGreaterThanOrEqual(4500);
    const events = s.store.events(s.w.id).filter((e) => e.type === "ModelRetryScheduled");
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      code: "MODEL_CAPACITY_UNAVAILABLE",
      attempt: 1,
      delay_ms: 5000,
    });
  } finally {
    await cleanup(s);
  }
});

it("临时提问模型(aside)遇到临时容量错误时隔 5 秒自动恢复并完成回答", async () => {
  const s = await nativeFixture();
  try {
    s.store.remove("queue", s.w.id);
    s.engine.transition(s.w.id, ["QUEUED"], "STOPPED", "stopped");
    let asideCalls = 0;
    const callTimes: number[] = [];
    s.engine.runtime = {
      ...fixtureRuntime(s),
      async aside() {
        asideCalls++;
        callTimes.push(Date.now());
        if (asideCalls === 1) {
          throw new FlowError("NATIVE_RUN_FAILED", capacityError("gemini-3.8-flash-high"), 422, { exit_code: 1 });
        }
        return "容量恢复后的真实回答";
      },
    };
    const aside = new AsideSessionService(s.store).submitQuestion(s.w.id, "当前模块如何运行？");
    await (s.engine as any).consumeOutbox();
    await expect
      .poll(() => s.store.get<AsideSession>("aside_session", aside.id)?.status, {
        timeout: 30000,
        interval: 200,
      })
      .toBe("completed");
    expect(asideCalls).toBe(2);
    expect(callTimes[1]! - callTimes[0]!).toBeGreaterThanOrEqual(4500);
    expect(s.store.get<AsideSession>("aside_session", aside.id)?.answer).toBe("容量恢复后的真实回答");
    expect(s.store.get("transient_network_retry", `aside:${aside.id}`)).toBeUndefined();
  } finally {
    await cleanup(s);
  }
});

it("临时容量错误达到最大重试次数(10次)后停止自动重试并准确阻塞", async () => {
  const s = await nativeFixture();
  try {
    s.store.put("transient_network_retry", s.w.id, s.w.id, { count: 10, last_at: Date.now() });
    let calls = 0;
    s.engine.runtime = fixtureRuntime(s, async () => {
      calls++;
      throw new FlowError("NATIVE_RUN_FAILED", capacityError("gemini-3.8-flash-high"), 422, { exit_code: 1 });
    });
    await until(s, ["BLOCKED"]);
    expect(calls).toBe(1);
    expect(s.engine.get(s.w.id).blocker?.code).toBe("MODEL_CAPACITY_UNAVAILABLE");
    expect(s.store.get("repair_state", s.w.id)).toBeUndefined();
  } finally {
    await cleanup(s);
  }
});
