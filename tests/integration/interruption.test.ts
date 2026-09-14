import { it, expect } from "vitest";
import { setup, repository, project, plan, proof } from "../helpers.js";
import { objectHash } from "../../packages/core/src/util.js";
import type { Runtime } from "../../packages/core/src/engine.js";

for (const cancel of [true, false])
  it(`execution ${cancel ? "stop" : "crash"} keeps its real cause after process rejection`, async () => {
    const s = setup(),
      r = await repository(s.root),
      p = project(r.repo);
    await s.engine.registerProject(p);
    const w = s.engine.create(
      {
        project_id: p.id,
        title: "中断分类",
        request: "验证停止和异常",
        complexity: "simple",
        workspace_mode: "existing_workspace",
      },
      "stop-case",
    );
    s.engine.submitPlan(
      w.id,
      plan(objectHash(p), r.baseline),
      w.version,
      "plan",
    );
    const approval = proof(s.engine, w.id, "approve");
    s.engine.approve(w.id, approval.proof, approval.binding);
    let rejectRun: (e: Error) => void = () => {};
    s.engine.runtime = {
      execute: () =>
        new Promise<void>((_, reject) => {
          rejectRun = reject;
        }),
      stop: async () => {
        rejectRun(Error("process exited after termination"));
      },
      review: async () => ({}),
      check: async () => {
        throw Error("unused");
      },
      close: async () => {},
    } satisfies Runtime;
    try {
      await s.engine.dispatch();
      await expect
        .poll(() => s.engine.get(w.id).state, { timeout: 20000 })
        .toBe("EXECUTING");
      if (cancel) await s.engine.stop(w.id, "local_console");
      else rejectRun(Error("upstream connection failed"));
      await expect
        .poll(() => s.store.list<any>("run", w.id)[0]?.status)
        .toBe(cancel ? "stopped" : "failed");
      await expect.poll(() => (s.engine as any).running.size).toBe(0);
      const detail = s.engine.detail(w.id);
      expect(detail.workflow.state).toBe(cancel ? "STOPPED" : "BLOCKED");
      expect(detail.attention?.message).toContain(
        cancel ? "你在控制台暂停了执行" : "upstream connection failed",
      );
      expect(detail.attention?.interruption?.source).toBe(
        cancel ? "local_console" : "runtime",
      );
      if (cancel) expect(detail.runs[0]?.result).not.toHaveProperty("error");
    } finally {
      if ((s.engine as any).running.size) {
        await s.engine.stop(w.id);
        await expect
          .poll(() => (s.engine as any).running.size, { timeout: 20000 })
          .toBe(0);
      }
      s.store.close();
    }
  });

it("legacy stops never invent a human actor", async () => {
  const s = setup(),
    r = await repository(s.root),
    p = project(r.repo);
  s.store.put("project", p.id, p.id, p);
  const w = s.engine.create(
    {
      project_id: p.id,
      title: "历史状态",
      request: "历史停止无原因",
      complexity: "simple",
      workspace_mode: "existing_workspace",
    },
    "legacy",
  );
  s.engine.transition(w.id, ["RESEARCHING"], "STOPPING", "stop");
  s.engine.transition(w.id, ["STOPPING"], "STOPPED", "stopped");
  expect(s.engine.detail(w.id).attention?.message).toBe(
    "执行已暂停，等待处理",
  );
  expect(s.engine.detail(w.id).attention?.interruption?.source).not.toBe(
    "local_console",
  );
  s.store.close();
});

it("infers pause from legacy agent_stopped event and heals interruption entity", async () => {
  const s = setup(),
    r = await repository(s.root),
    p = project(r.repo);
  s.store.put("project", p.id, p.id, p);
  const w = s.engine.create(
    {
      project_id: p.id,
      title: "旧版历史暂停",
      request: "仅含agent_stopped事件",
      complexity: "simple",
      workspace_mode: "existing_workspace",
    },
    "legacy-agent-stop",
  );
  s.engine.transition(w.id, ["RESEARCHING"], "STOPPING", "stop");
  s.engine.transition(w.id, ["STOPPING"], "STOPPED", "stopped");
  s.store.event(w.id, p.id, "Stopped", {
    agent_stopped: true,
    services_retained: true,
  });
  const detail = s.engine.detail(w.id);
  expect(detail.attention?.message).toBe("你在控制台暂停了执行");
  expect(detail.attention?.interruption?.source).toBe("local_console");
  // Verify self-healing persisted into store
  expect(s.store.get<any>("interruption", w.id)?.message).toBe(
    "你在控制台暂停了执行",
  );
  s.store.close();
});
