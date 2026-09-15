import { expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { prepared } from "../helpers.js";
import { Environments } from "../../packages/runtime/src/environment.js";
import { LocalRuntime } from "../../packages/runtime/src/runtime.js";
import { FlowError } from "../../packages/contracts/src/index.js";

function previewProject(s: Awaited<ReturnType<typeof prepared>>) {
  const p = s.engine.project(s.project.id);
  p.commands.push({
    ...p.commands[0]!,
    id: "preview",
    lifecycle: "service",
    parser: "none",
    report_path: undefined,
  });
  p.services = [
    {
      id: "frontend",
      repo_id: "main",
      command_id: "preview",
      port_pool: "frontend",
      health_path: "/health",
      identity_header: "x-devflow-identity",
    },
  ];
  s.store.put("project", p.id, p.id, p);
  return p;
}
function exited(id: string, message: string, code = 2) {
  const proc = Object.assign(new EventEmitter(), {
    id,
    stop: vi.fn(async () => {}),
    completion: Promise.resolve({ code }),
  });
  proc.completion = new Promise((resolve) =>
    queueMicrotask(() => {
      proc.emit("stderr", Buffer.from(message));
      resolve({ code });
    }),
  );
  return proc;
}
it("compiler exit stops health polling immediately, starts once, releases leases and preserves its diagnostic", async () => {
  const s = await prepared();
  previewProject(s);
  const manager: any = {
    start: vi.fn((spec) =>
      exited(spec.id, "engine.ts(759,29): error TS1127: Invalid character."),
    ),
    stop: vi.fn(async () => {}),
  };
  const environments = new Environments(s.engine, manager);
  const health = vi.spyOn(environments, "waitHealth");
  const started = Date.now();
  try {
    await expect(
      environments.ensure(s.engine.get(s.workflow.id)),
    ).rejects.toThrow("TS1127");
    expect(Date.now() - started).toBeLessThan(3000);
    expect(manager.start).toHaveBeenCalledTimes(1);
    expect(health.mock.calls[0]?.[2]).toBe(300000);
    expect(s.store.list("lease", s.workflow.id)).toHaveLength(0);
    expect(s.store.get("environment", s.workflow.id)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("TS1127"),
    });
    await environments.stop(s.workflow.id);
    expect(s.store.get("environment", s.workflow.id)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("TS1127"),
    });
  } finally {
    s.store.close();
  }
});
it("only a confirmed port collision retries, using a different port", async () => {
  const s = await prepared();
  previewProject(s);
  const ports: number[] = [];
  const manager: any = {
    start: vi.fn((spec) => {
      ports.push(Number(spec.env.PORT));
      return ports.length === 1
        ? exited(spec.id, "Error: listen EADDRINUSE")
        : Object.assign(new EventEmitter(), {
            id: spec.id,
            completion: new Promise(() => {}),
            stop: async () => {},
          });
    }),
    stop: async () => {},
  };
  const environments = new Environments(s.engine, manager);
  vi.spyOn(environments, "waitHealth").mockImplementation(
    async (_s, _i, _m, _a, signal) => {
      if (ports.length === 1)
        await new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
    },
  );
  try {
    const env = await environments.ensure(s.engine.get(s.workflow.id));
    expect(env.status).toBe("ready");
    expect(ports).toHaveLength(2);
    expect(ports[0]).not.toBe(ports[1]);
  } finally {
    await environments.stop(s.workflow.id);
    s.store.close();
  }
});
it("failed build preserves the worker for repair and a corrected build can enter verification", async () => {
  const s = await prepared();
  const p = previewProject(s);
  p.commands.push({
    ...p.commands[0]!,
    id: "build",
    parser: "none",
    report_path: undefined,
  });
  s.store.put("project", p.id, p.id, p);
  const runtime = new LocalRuntime(s.engine);
  s.engine.runtime = runtime;
  const start = vi
    .spyOn(runtime.processes, "start")
    .mockImplementation((spec) =>
      exited(spec.id, "broken.ts: error TS1002: Unterminated string"),
    );
  const ensure = vi.spyOn(runtime.environments, "ensure");
  const stop = vi.spyOn(runtime, "stop");
  try {
    s.engine.claimTask(
      s.principal,
      s.workflow.id,
      "T01",
      "实现已提交但编译器必须拒绝错误代码",
    );
    await expect(s.engine.freeze(s.workflow.id, s.principal)).rejects.toThrow(
      "TS1002",
    );
    expect(s.engine.get(s.workflow.id).state).toBe("EXECUTING");
    expect(start).toHaveBeenCalledTimes(1);
    expect(ensure).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(() =>
      s.engine.files(s.principal, s.workflow.id, "main", true),
    ).not.toThrow();
    expect(s.store.list("snapshot", s.workflow.id)).toHaveLength(0);
    start.mockImplementation((spec) => exited(spec.id, "build fixed", 0));
    ensure.mockResolvedValue({ status: "ready" } as any);
    await s.engine.freeze(s.workflow.id, s.principal);
    expect(s.engine.get(s.workflow.id).state).toBe("VERIFYING");
    expect(start).toHaveBeenCalledTimes(2);
    expect(ensure).toHaveBeenCalledTimes(1);
  } finally {
    await runtime.close();
    s.store.close();
  }
});
it("manual stop while preparing stays stopped and is not relabeled as a build failure", async () => {
  const s = await prepared();
  s.engine.runtime = {
    prepareVerification: async () => {
      await s.engine.stop(s.workflow.id);
      throw new FlowError("RUN_REVOKED", "执行已暂停");
    },
    stop: async () => {},
  } as any;
  try {
    s.engine.claimTask(
      s.principal,
      s.workflow.id,
      "T01",
      "实现已提交，验证暂停与准备竞态处理",
    );
    await expect(s.engine.freeze(s.workflow.id, s.principal)).rejects.toThrow(
      "暂停",
    );
    expect(s.engine.get(s.workflow.id).state).toBe("STOPPED");
  } finally {
    s.store.close();
  }
});
