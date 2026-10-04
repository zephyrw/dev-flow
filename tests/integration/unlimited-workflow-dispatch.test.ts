import { describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "../../packages/contracts/src/config.js";
import type { Workflow } from "../../packages/contracts/src/index.js";
import { project, setup } from "../helpers.js";
import { AsideSessionService } from "../../packages/asides/src/service.js";

function fixture() {
  const s = setup();
  // Keep every dispatched Run in flight so later tasks cannot benefit from
  // released capacity. Test dispatch independently of model/Git execution.
  const pending = new Promise<void>(() => {});
  const run = vi.spyOn(s.engine as any, "run").mockReturnValue(pending);
  s.engine.runtime = {} as any;
  s.config.scheduler.executors = 3;
  s.config.scheduler.reviewers = 1;
  return { ...s, run };
}

function enqueue(
  s: ReturnType<typeof fixture>,
  projectId: string,
  state: "PLANNING" | "QUEUED" | "REVIEW_QUEUED",
  root?: string,
) {
  const p = { ...project(s.root), id: projectId };
  s.store.put("project", p.id, p.id, p);
  const created = s.engine.create({
    project_id: p.id,
    title: "并行任务",
    request: "独立任务",
    complexity: "simple",
    workspace_mode: "new_worktree",
  }, crypto.randomUUID());
  const w: Workflow = {
    ...created,
    state,
    stage: state === "PLANNING" ? "planning" : state === "REVIEW_QUEUED" ? "review" : "execute",
  };
  s.store.put("workflow", w.id, p.id, w);
  if (root) s.store.put("workspace", w.id + "-main", w.id, {
    id: w.id + "-main", workflow_id: w.id, repo_id: "main", root,
  });
  s.engine.scheduler.enqueue(w.id, p.id);
  return w;
}

describe("用户决定工作流并行数量", () => {
  it.each(["PLANNING", "QUEUED", "REVIEW_QUEUED"] as const)(
    "%s 派发同项目和跨项目任务时不受旧名额限制",
    async (state) => {
      const s = fixture();
      try {
        // Existing leases from an older service must not restore the limit.
        s.engine.scheduler.acquire("old-executor", "old-run", ["executor:0", "executor:1", "executor:2"]);
        s.engine.scheduler.acquire("old-reviewer", "old-review", ["reviewer:0"]);
        const workflows = Array.from({ length: 8 }, (_, i) =>
          enqueue(s, i < 5 ? "p1" : "p2", state),
        );
        await s.engine.dispatch();
        expect(s.run).toHaveBeenCalledTimes(8);
        expect(new Set(s.engine.getActiveWorkflowIds())).toEqual(new Set(workflows.map(w => w.id)));
        for (const w of workflows) {
          expect(s.store.get("queue", w.id)).toBeUndefined();
          expect(s.store.get<any>("queue_wait", w.id)?.kind).toBe("preparing");
          expect(s.store.list<any>("lease", w.id).every(l => l.id.startsWith(state === "REVIEW_QUEUED" ? "read:" : "write:"))).toBe(true);
        }
        await s.engine.dispatch();
        expect(s.run).toHaveBeenCalledTimes(8);
        // Even an entry re-enqueued while running cannot launch twice.
        s.engine.scheduler.enqueue(workflows[0]!.id, "p1");
        await s.engine.dispatch();
        expect(s.run).toHaveBeenCalledTimes(8);
      } finally {
        s.run.mockRestore();
        s.store.close();
      }
    },
  );

  it("共享工作目录只阻塞冲突任务，释放写锁后继续派发", async () => {
    const s = fixture();
    try {
      const sharedRoot = s.root + "/shared";
      const sharedKey = "write:" + sharedRoot.toLowerCase();
      s.engine.scheduler.acquire("owner", "owner-run", [sharedKey]);
      const blocked = enqueue(s, "p1", "QUEUED", sharedRoot);
      const independent = enqueue(s, "p1", "QUEUED");
      s.store.put("queue_wait", independent.id, independent.id, {
        kind: "capacity", message: "等待执行模型名额",
      });
      await s.engine.dispatch();
      expect(s.run).toHaveBeenCalledTimes(1);
      expect(s.run.mock.calls[0]?.[0]).toBe(independent.id);
      expect(s.store.get("queue", blocked.id)).toBeTruthy();
      expect(s.store.get<any>("queue_wait", blocked.id)).toMatchObject({ kind: "workspace", owners: ["owner"] });
      expect(s.store.get<any>("queue_wait", independent.id)?.kind).toBe("preparing");
      s.engine.scheduler.release("owner", "owner-run", [sharedKey], true);
      await s.engine.dispatch();
      expect(s.run).toHaveBeenCalledTimes(2);
      expect(s.run.mock.calls[1]?.[0]).toBe(blocked.id);
      expect(s.store.get("queue", blocked.id)).toBeUndefined();
    } finally {
      s.run.mockRestore();
      s.store.close();
    }
  });

  it("旧名额配置仍可读取，且不再校验执行和复核名额上限", () => {
    expect(ConfigSchema.parse({ scheduler: { executors: 3, reviewers: 1 } }).scheduler)
      .toMatchObject({ executors: 3, reviewers: 1 });
    expect(ConfigSchema.parse({ scheduler: { executors: 1000, reviewers: 1000 } }).scheduler)
      .toMatchObject({ executors: 1000, reviewers: 1000 });
  });

  it("同一工作流的独立提问分别派发，重复派发不会启动同一个提问", async () => {
    const s = fixture();
    const aside = vi.fn().mockReturnValue(new Promise(() => {}));
    s.engine.runtime = { aside } as any;
    try {
      const w = enqueue(s, "p1", "QUEUED");
      const service = new AsideSessionService(s.store);
      const sessions = Array.from({ length: 6 }, (_, i) => service.submitQuestion(w.id, "独立问题 " + i));
      await s.engine.dispatch();
      expect(aside).toHaveBeenCalledTimes(6);
      expect(new Set(aside.mock.calls.map(call => call[2].id))).toEqual(new Set(sessions.map(session => session.id)));
      await s.engine.dispatch();
      expect(aside).toHaveBeenCalledTimes(6);
    } finally { s.run.mockRestore(); s.store.close(); }
  });

  it("同一代码目录的多个只读复核可并行，写入等待所有复核退出", async () => {
    const s = fixture();
    try {
      const root = s.root + "/review-shared";
      const a = enqueue(s, "p1", "REVIEW_QUEUED", root);
      const b = enqueue(s, "p1", "REVIEW_QUEUED", root);
      const writer = enqueue(s, "p1", "QUEUED", root);
      await s.engine.dispatch();
      expect(s.run).toHaveBeenCalledTimes(2);
      expect(s.store.get("queue", writer.id)).toBeTruthy();
      for (const w of [a, b]) {
        const leases = s.store.list<any>("lease", w.id);
        expect(leases).toHaveLength(1);
        s.engine.scheduler.release(w.id, leases[0].run_id, leases.map(l => l.id), true);
        await s.engine.dispatch();
        expect(s.run).toHaveBeenCalledTimes(w === a ? 2 : 3);
      }
    } finally { s.run.mockRestore(); s.store.close(); }
  });
});
