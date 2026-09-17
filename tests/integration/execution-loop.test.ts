import { it, expect, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepared } from "../helpers.js";
import {
  requestOperation,
  decideOperation,
} from "../../packages/core/src/interactions.js";
import { LocalRuntime } from "../../packages/runtime/src/runtime.js";
import { repairFailure } from "../../packages/core/src/repair.js";
import { FlowError } from "../../packages/contracts/src/index.js";
import { startTask } from "../../packages/core/src/progress.js";
import { buildServer } from "../../apps/api/src/server.js";
import { WorkspaceObserver } from "../../packages/runtime/src/workspace-observer.js";
import { reconcileProcesses } from "../../packages/runtime/src/recovery.js";

it.each([
  "NATIVE_PERMISSION_DENIED",
  "AUTHORIZATION_ROUTING_REQUIRED",
  "POLICY_FAILED",
])(
  "permission failure %s blocks without enqueuing repair or inventing authorization",
  async (code) => {
    const s = await prepared();
    const diagnose = vi.fn();
    s.engine.runtime = { diagnose } as any;
    try {
      const error = new FlowError(
        code,
        "replace_file_content: C:/work/app.txt 被拒绝",
      );
      expect(
        await repairFailure(s.engine, s.workflow.id, error, s.principal.run_id),
      ).toBeNull();
      s.engine.block(s.workflow.id, error);
      expect(s.engine.get(s.workflow.id)).toMatchObject({
        state: "BLOCKED",
        blocker: { code, message: error.message },
      });
      expect(s.store.get("repair_state", s.workflow.id)).toBeUndefined();
      expect(s.store.list("operation_request", s.workflow.id)).toEqual([]);
      expect(
        s.store.events(s.workflow.id).some((e) => e.type === "RepairScheduled"),
      ).toBe(false);
      expect(diagnose).not.toHaveBeenCalled();
    } finally {
      s.store.close();
    }
  },
);

it("operation authorization binds exact arguments and plan, survives restart, and executes at most once", async () => {
  const s = await prepared();
  const runtime = new LocalRuntime(s.engine);
  try {
    const request = requestOperation(s.engine, s.principal, s.workflow.id, {
      repo_id: "main",
      executable: process.execPath,
      args: ["-e", "require('node:fs').appendFileSync('once.txt','x')"],
      reason: "验证用户批准的单次命令执行",
    });
    expect(s.engine.get(s.workflow.id).state).toBe("WAITING_AUTHORIZATION");
    s.engine.recover();
    expect(s.engine.get(s.workflow.id).state).toBe("WAITING_AUTHORIZATION");
    expect(() =>
      decideOperation(s.engine, s.workflow.id, request.id, true, "wrong"),
    ).toThrow();
    decideOperation(
      s.engine,
      s.workflow.id,
      request.id,
      true,
      request.fingerprint,
    );
    expect(() =>
      decideOperation(
        s.engine,
        s.workflow.id,
        request.id,
        true,
        request.fingerprint,
      ),
    ).toThrow();
    s.engine.transition(
      s.workflow.id,
      ["WAITING_AUTHORIZATION"],
      "EXECUTING",
      "execute",
    );
    const first = (await runtime.operation(
      s.engine.get(s.workflow.id),
      request.id,
      s.principal,
    )) as any;
    expect(first.status).toBe("completed");
    await runtime.operation(
      s.engine.get(s.workflow.id),
      request.id,
      s.principal,
    );
    expect(readFileSync(join(s.repo, "once.txt"), "utf8")).toBe("x");
  } finally {
    await runtime.close();
    s.store.close();
  }
});

it("denied operations never execute and a changed plan invalidates prior approval", async () => {
  const s = await prepared();
  const runtime = new LocalRuntime(s.engine);
  const start = vi.spyOn(runtime.processes, "start");
  try {
    const r = requestOperation(s.engine, s.principal, s.workflow.id, {
      repo_id: "main",
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      reason: "验证拒绝操作不会执行",
    });
    decideOperation(
      s.engine,
      s.workflow.id,
      r.id,
      false,
      r.fingerprint,
      "请先检查现有依赖",
    );
    s.engine.transition(
      s.workflow.id,
      ["WAITING_AUTHORIZATION"],
      "EXECUTING",
      "execute",
    );
    expect(
      (
        (await runtime.operation(
          s.engine.get(s.workflow.id),
          r.id,
          s.principal,
        )) as any
      ).status,
    ).toBe("denied");
    expect(start).not.toHaveBeenCalled();
    const w = s.engine.get(s.workflow.id);
    s.store.put("workflow", w.id, w.project_id, {
      ...w,
      plan_revision: w.plan_revision + 1,
    });
    await expect(
      runtime.operation(s.engine.get(w.id), r.id, s.principal),
    ).rejects.toThrow("计划");
  } finally {
    await runtime.close();
    s.store.close();
  }
});

it("interrupted authorized commands retain unknown outcome and cannot consume approval twice", async () => {
  const s = await prepared();
  const runtime = new LocalRuntime(s.engine);
  try {
    const request = requestOperation(s.engine, s.principal, s.workflow.id, {
      repo_id: "main",
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      reason: "模拟授权操作执行时控制器中断",
    });
    decideOperation(
      s.engine,
      s.workflow.id,
      request.id,
      true,
      request.fingerprint,
    );
    s.store.put("operation_request", request.id, s.workflow.id, {
      ...request,
      status: "running",
    });
    reconcileProcesses(s.engine, s.workflow.id);
    expect(s.store.must<any>("operation_request", request.id)).toMatchObject({
      status: "failed",
      result: { outcome_unknown: true },
    });
    s.engine.transition(
      s.workflow.id,
      ["WAITING_AUTHORIZATION"],
      "EXECUTING",
      "execute",
    );
    const spawn = vi.spyOn(runtime.processes, "start");
    await runtime.operation(
      s.engine.get(s.workflow.id),
      request.id,
      s.principal,
    );
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    await runtime.close();
    s.store.close();
  }
});

it("HTTP authorization rejects foreign callers and resumes the original workflow with the exact decision", async () => {
  const s = await prepared();
  const app = await buildServer(s.engine);
  const dispatch = vi.spyOn(s.engine, "dispatch").mockResolvedValue(undefined);
  try {
    const request = requestOperation(s.engine, s.principal, s.workflow.id, {
      repo_id: "main",
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      reason: "验证工作台授权接口完整续接",
    });
    const url = `/api/workflows/${s.workflow.id}/operations/${request.id}/decision`;
    const payload = {
      approved: true,
      fingerprint: request.fingerprint,
      note: "只执行这一次",
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          payload,
          headers: {
            host: "localhost:14810",
            origin: "https://foreign.invalid",
          },
        })
      ).statusCode,
    ).toBe(403);
    const response = await app.inject({
      method: "POST",
      url,
      payload,
      headers: { host: "localhost:14810", origin: "http://localhost:14810" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: s.workflow.id,
      state: "QUEUED",
    });
    expect(s.engine.get(s.workflow.id).feedback.join("\n")).toContain(
      request.id,
    );
    expect(s.store.must<any>("operation_request", request.id).status).toBe(
      "approved",
    );
    expect(dispatch).toHaveBeenCalled();
    expect(s.engine.list()).toHaveLength(1);
  } finally {
    await app.close();
    s.store.close();
  }
});

it("a development test runs before any task claims, captures real failure, then passes without freezing delivery", async () => {
  const s = await prepared();
  const runtime = new LocalRuntime(s.engine);
  try {
    const p = s.engine.project(s.project.id);
    Object.assign(p.commands[0]!, {
      parser: "junit",
      args: [
        "--test-reporter=junit",
        "--test-reporter-destination=${DEVFLOW_REPORT_PATH}",
        "-e",
        "require('node:test')('updates content',()=>require('node:assert/strict').equal(require('node:fs').readFileSync('app.txt','utf8'),'after\\n'))",
      ],
    });
    s.store.put("project", p.id, p.id, p);
    const rec = s.engine.plan(s.workflow.id);
    rec.plan.tests[0]!.expected_case_ids = ["test updates content"];
    rec.plan.task_model = "leaf-v1";
    rec.plan.modules = [{ id: "M1", title: "文本" }];
    Object.assign(rec.plan.tasks[0]!, {
      module_id: "M1",
      completion_checks: [{ path: "app.txt", contains: "after" }],
    });
    s.store.put("plan", rec.id, s.workflow.id, rec);
    expect(s.store.list("task_claim", s.workflow.id)).toHaveLength(0);
    const failure = await runtime.check(
      s.engine.get(s.workflow.id),
      "UT01",
      s.principal,
    );
    expect(failure.status).toBe("failed");
    expect(s.engine.get(s.workflow.id).state).toBe("EXECUTING");
    expect(s.engine.get(s.workflow.id).snapshot_id).toBeUndefined();
    writeFileSync(join(s.repo, "app.txt"), "after\n");
    const passed = await runtime.check(
      s.engine.get(s.workflow.id),
      "UT01",
      s.principal,
    );
    expect(passed.status).toBe("passed");
    expect(passed.phase).toBe("development");
    startTask(s.engine, s.principal, s.workflow.id, "T01");
    s.engine.claimTask(
      s.principal,
      s.workflow.id,
      "T01",
      "文本修复已经通过本次真实单元测试",
    );
    expect(s.engine.taskStatus(s.workflow.id)[0]).toMatchObject({
      development_status: "completed",
      validation_status: "passed",
      status: "verified",
    });
    expect(s.store.list("evidence", s.workflow.id)).toHaveLength(0);
    expect(() => s.engine.verifyEvidence(s.workflow.id)).toThrow();
    s.engine.invalidate(s.workflow.id, "代码修改");
    expect(s.engine.taskStatus(s.workflow.id)[0]!.development_status).toBe(
      "pending_check",
    );
  } finally {
    await runtime.close();
    s.store.close();
  }
}, 60000);

it("repeated identical failure escalates to the planner and exhausts without pretending user input is missing", async () => {
  const s = await prepared();
  const diagnose = vi.fn(async () => ({
    diagnosis: "启动脚本错误地把 Maven 命令当作已完成进程",
    instructions: "修复启动脚本并验证常驻服务及健康检查",
    requires_plan_change: false,
  }));
  s.engine.runtime = { diagnose } as any;
  try {
    for (let i = 0; i < 5; i++)
      expect(
        (
          await repairFailure(
            s.engine,
            s.workflow.id,
            new FlowError("SERVICE_EXITED", "后端提前退出"),
            s.principal.run_id,
          )
        )?.retry,
      ).toBe(true);
    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(
      (
        await repairFailure(
          s.engine,
          s.workflow.id,
          new FlowError("SERVICE_EXITED", "后端提前退出"),
          s.principal.run_id,
        )
      )?.retry,
    ).toBe(false);
    expect(s.engine.get(s.workflow.id).state).toBe("BLOCKED");
    expect(s.engine.get(s.workflow.id).blocker?.code).toBe("REPAIR_EXHAUSTED");
    s.engine.feedback(
      s.workflow.id,
      "请检查脚本中的 Maven 调用和启动方式",
      "within_plan",
    );
    expect(s.engine.get(s.workflow.id).state).toBe("QUEUED");
    expect(s.store.get("repair_state", s.workflow.id)).toBeUndefined();
  } finally {
    s.store.close();
  }
});

it("planner infrastructure failure keeps the executor repairing and new errors get their own retry budget", async () => {
  const s = await prepared();
  s.engine.runtime = {
    diagnose: async () => {
      throw new FlowError(
        "DIAGNOSIS_FAILED",
        "invalid_json_schema: propertyNames",
      );
    },
  } as any;
  try {
    for (let i = 0; i < 3; i++)
      expect(
        (
          await repairFailure(
            s.engine,
            s.workflow.id,
            new FlowError("SERVICE_EXITED", "backend提前退出"),
            s.principal.run_id,
          )
        )?.retry,
      ).toBe(true);
    expect(s.engine.get(s.workflow.id).state).toBe("EXECUTING");
    expect(
      s.store.get<any>("repair_state", s.workflow.id).diagnosis_error,
    ).toContain("invalid_json_schema");
    expect(s.engine.detail(s.workflow.id).attention).toBeNull();
    for (let i = 0; i < 4; i++)
      expect(
        (
          await repairFailure(
            s.engine,
            s.workflow.id,
            new FlowError("BUILD_FAILED", "新的编译错误"),
            s.principal.run_id,
          )
        )?.retry,
      ).toBe(true);
    expect(s.store.get<any>("repair_state", s.workflow.id).consecutive).toBe(4);
    expect(s.engine.get(s.workflow.id).state).toBe("EXECUTING");
  } finally {
    s.store.close();
  }
});

it("quota and revoked runs are not blindly retried", async () => {
  const s = await prepared();
  try {
    expect(
      await repairFailure(
        s.engine,
        s.workflow.id,
        new FlowError("MODEL_QUOTA", "额度不足"),
        s.principal.run_id,
      ),
    ).toBeNull();
    expect(s.store.get("repair_state", s.workflow.id)).toBeUndefined();
  } finally {
    s.store.close();
  }
});

it("resource waiting names the owner, resumes on release and can be cancelled", async () => {
  const s = await prepared();
  try {
    s.engine.scheduler.acquire("other-workflow", "other-run", ["test:0"]);
    let active = true;
    const pending = s.engine.scheduler.waitForCapacity(
      "test",
      1,
      s.workflow.id,
      s.principal.run_id,
      () => {
        if (!active) throw new Error("cancelled");
      },
    );
    expect(s.store.get<any>("resource_wait", s.workflow.id)?.owners).toEqual([
      "other-workflow",
    ]);
    s.engine.scheduler.release("other-workflow", "other-run", ["test:0"], true);
    expect(await pending).toBe("test:0");
    expect(s.store.get("resource_wait", s.workflow.id)).toBeUndefined();
    const waiting = expect(
      s.engine.scheduler.waitForCapacity("test", 1, "another", "run", () => {
        if (!active) throw new Error("cancelled");
      }),
    ).rejects.toThrow("cancelled");
    active = false;
    await waiting;
  } finally {
    s.store.close();
  }
});

it("an external source edit invalidates a recorded implementation without a page-triggered file scan", async () => {
  const s = await prepared();
  let observer: WorkspaceObserver | undefined;
  try {
    const rec = s.engine.plan(s.workflow.id);
    rec.plan.task_model = "leaf-v1";
    rec.plan.modules = [{ id: "M1", title: "文本" }];
    Object.assign(rec.plan.tasks[0]!, {
      module_id: "M1",
      completion_checks: [{ path: "app.txt", contains: "after" }],
    });
    s.store.put("plan", rec.id, s.workflow.id, rec);
    writeFileSync(join(s.repo, "app.txt"), "after\n");
    startTask(s.engine, s.principal, s.workflow.id, "T01");
    s.engine.claimTask(
      s.principal,
      s.workflow.id,
      "T01",
      "已经记录原始实现，等待代码变更检测",
    );
    observer = new WorkspaceObserver(s.engine);
    writeFileSync(join(s.repo, "app.txt"), "externally changed\n");
    await observer.changed(
      s.store.list<any>("workspace", s.workflow.id)[0],
      "app.txt",
    );
    expect(s.engine.taskStatus(s.workflow.id, false)[0]!.completed).toBe(false);
    expect(s.store.get<any>("task_proof", `${s.workflow.id}-1-T01`).stale).toBe(
      true,
    );
  } finally {
    observer?.close();
    s.store.close();
  }
});

it("missing reviewer executable cannot synthesize a passing review", async () => {
  const s = await prepared();
  const runtime = new LocalRuntime(s.engine);
  try {
    s.engine.claimTask(
      s.principal,
      s.workflow.id,
      "T01",
      "声明已提交用于核验复核程序不可用场景",
    );
    await s.engine.freeze(s.workflow.id, s.principal);
    s.engine.transition(s.workflow.id, ["VERIFYING"], "REVIEWING", "review", {
      review_request_id: "review-missing",
    });
    s.config.models.codex_executable = "Z:/missing-devflow-reviewer.exe";
    await expect(
      runtime.review(s.engine.get(s.workflow.id), {
        id: s.principal.run_id,
      } as any),
    ).rejects.toMatchObject({ code: "REVIEWER_UNAVAILABLE" });
    expect(s.store.list("review", s.workflow.id)).toHaveLength(0);
  } finally {
    await runtime.close();
    s.store.close();
  }
});

it("HTTP summary and detail use read projections; history has a bounded backwards cursor", async () => {
  const s = await prepared();
  const app = await buildServer(s.engine);
  const projection = vi.spyOn(s.engine, "taskStatus");
  try {
    for (let i = 0; i < 220; i++)
      s.store.event(s.workflow.id, s.project.id, "AgentDiagnostic", {
        text: "ordinary output " + i,
      });
    const headers = { host: "localhost:14810" };
    const summary = await app.inject({
      url: `/api/workflows/${s.workflow.id}?view=summary`,
      headers,
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().loading).toBe(true);
    expect(projection).toHaveBeenCalledWith(s.workflow.id, false);
    expect(summary.json().events.length).toBeLessThanOrEqual(30);
    const latest = (
      await app.inject({
        url: `/api/workflows/${s.workflow.id}/history?limit=50`,
        headers,
      })
    ).json();
    const older = (
      await app.inject({
        url: `/api/workflows/${s.workflow.id}/history?limit=50&before=${latest.next_before}`,
        headers,
      })
    ).json();
    expect(latest.events).toHaveLength(50);
    expect(older.events.at(-1).event_seq).toBeLessThan(
      latest.events[0].event_seq,
    );
  } finally {
    await app.close();
    s.store.close();
  }
});
