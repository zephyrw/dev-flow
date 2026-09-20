import { it, expect, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepared } from "../helpers.js";
import { LocalRuntime } from "../../packages/runtime/src/runtime.js";
import {
  startTask,
  reconcileImplementationProofs,
} from "../../packages/core/src/progress.js";
import { buildServer } from "../../apps/api/src/server.js";

async function fixture() {
  const s = await prepared();
  writeFileSync(join(s.repo, "other.txt"), "before\n");
  const p = s.engine.plan(s.workflow.id);
  Object.assign(p.plan, {
    task_model: "leaf-v1",
    modules: [{ id: "m", title: "文本" }],
  });
  p.plan.scope.allowed_paths.push("other.txt");
  p.plan.tasks[0]!.module_id = "m";
  p.plan.tasks[0]!.completion_checks = [
    { path: "app.txt", contains: "before" },
  ];
  p.plan.tasks.push({
    ...p.plan.tasks[0]!,
    id: "T02",
    paths: ["other.txt"],
    completion_checks: [{ path: "other.txt", contains: "before" }],
  });
  p.plan.tests[0]!.task_ids = ["T01", "T02"];
  p.plan.tests[0]!.expected_case_ids = ["test good", "test bad"];
  s.store.put("plan", p.id, s.workflow.id, p);
  for (const id of ["T01", "T02"]) {
    startTask(s.engine, s.principal, s.workflow.id, id);
    s.engine.claimTask(
      s.principal,
      s.workflow.id,
      id,
      "现有实现与完成条件已经记录并保留",
    );
  }
  const project = s.engine.project(s.project.id);
  Object.assign(project.commands[0]!, {
    parser: "junit",
    args: [
      "--test-reporter=junit",
      "--test-reporter-destination=${DEVFLOW_REPORT_PATH}",
      "-e",
      "require('node:test')('good',()=>{});require('node:test')('bad',()=>require('node:assert/strict').equal(1,2))",
    ],
  });
  s.store.put("project", project.id, project.id, project);
  return s;
}
it("a shared test failure preserves unchanged implementation and displays passed development cases", async () => {
  const s = await fixture(),
    runtime = new LocalRuntime(s.engine);
  try {
    const e = await runtime.check(
      s.engine.get(s.workflow.id),
      "UT01",
      s.principal,
    );
    expect(e).toMatchObject({
      status: "failed",
      passed: 1,
      failed: 1,
      phase: "development",
    });
    expect(s.engine.taskStatus(s.workflow.id).every((t) => t.completed)).toBe(
      true,
    );
    expect(
      s.store
        .entries<any>("task_proof", s.workflow.id)
        .every((p) => !p.value.stale),
    ).toBe(true);
    expect(s.engine.summary(s.workflow.id).test_progress).toMatchObject({
      passed: 1,
      failed: 1,
    });
    expect(
      s.engine
        .taskStatus(s.workflow.id)
        .every((t) => t.development_status === "check_failed"),
    ).toBe(true);
    expect(() => s.engine.verifyEvidence(s.workflow.id)).not.toThrow();
    const app = await buildServer(s.engine);
    try {
      const headers = {
        host: "localhost:14810",
        origin: "http://localhost:14810",
      };
      const report = await app.inject({
        url: `/api/workflows/${s.workflow.id}/evidence/${e.id}/files/0`,
        headers,
      });
      expect(report.statusCode).toBe(200);
      expect(report.body).toContain("testcase");
      expect(
        (
          await app.inject({
            url: `/api/workflows/wf-foreign/evidence/${e.id}/files/0`,
            headers,
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      await app.close();
    }
    s.engine.invalidate(s.workflow.id, "用户恢复执行，旧证据失效");
    expect(s.engine.summary(s.workflow.id).test_progress).toMatchObject({
      passed: 1,
      failed: 1,
    });
    s.store.put("development_evidence", e.id, s.workflow.id, {
      ...e,
      plan_revision: undefined,
    });
    s.engine.invalidate(s.workflow.id, "计划版本变化，旧验收与测试不能沿用");
    expect(s.engine.summary(s.workflow.id).test_progress).toMatchObject({
      passed: 0,
      stale: 2,
    });
    expect(() => s.engine.verifyEvidence(s.workflow.id)).not.toThrow();
  } finally {
    await runtime.close();
    s.store.close();
  }
}, 60000);
it("legacy invalidations reconcile only exact unchanged source and do not manufacture verification", async () => {
  const s = await fixture();
  try {
    for (const p of s.store.entries<any>("task_proof", s.workflow.id))
      s.store.put("task_proof", p.id, s.workflow.id, {
        ...p.value,
        stale: true,
        stale_reason: "本任务文件已修改，需要重新核验实现",
      });
    writeFileSync(join(s.repo, "other.txt"), "different\n");
    reconcileImplementationProofs(s.engine, s.workflow.id);
    const tasks = s.engine.taskStatus(s.workflow.id);
    expect(tasks[0]).toMatchObject({
      completed: true,
      development_status: "pending_check",
      validation_status: "not_run",
    });
    expect(tasks[1]).toMatchObject({
      completed: false,
      development_status: "needs_changes",
    });
    expect(s.store.list("evidence", s.workflow.id)).toHaveLength(0);
  } finally {
    s.store.close();
  }
});
it("repeated unchanged declarations do not emit additional completion events", async () => {
  const s = await fixture();
  try {
    const before = s.store
      .recentEvents(s.workflow.id, 1000)
      .filter((e) => e.type === "TaskCompleted").length;
    for (let i = 0; i < 5; i++) {
      startTask(s.engine, s.principal, s.workflow.id, "T01");
      expect(
        s.engine.claimTask(
          s.principal,
          s.workflow.id,
          "T01",
          "再次确认相同的实现无需重复完成事件",
        ).status,
      ).toBe("already_recorded");
    }
    expect(
      s.store
        .recentEvents(s.workflow.id, 1000)
        .filter((e) => e.type === "TaskCompleted"),
    ).toHaveLength(before);
  } finally {
    s.store.close();
  }
});
it("constant-only placeholder tests cannot be declared or executed as business evidence", async () => {
  const s = await fixture(),
    runtime = new LocalRuntime(s.engine);
  const start = vi.spyOn(runtime.processes, "start");
  try {
    const p = s.engine.plan(s.workflow.id);
    p.plan.scope.allowed_paths.push("ui.spec.ts");
    p.plan.tasks[0]!.paths.push("ui.spec.ts");
    p.plan.tests[0]!.layer = "e2e";
    s.store.put("plan", p.id, s.workflow.id, p);
    writeFileSync(
      join(s.repo, "ui.spec.ts"),
      "test('business',async ({page})=>{ expect(true).toBe(true); });",
    );
    startTask(s.engine, s.principal, s.workflow.id, "T01");
    expect(() =>
      s.engine.claimTask(
        s.principal,
        s.workflow.id,
        "T01",
        "试图将恒真占位用例作为业务完成证明",
      ),
    ).toThrow("恒真断言");
    await expect(
      runtime.check(s.engine.get(s.workflow.id), "UT01", s.principal),
    ).rejects.toMatchObject({ code: "TEST_PLACEHOLDER" });
    expect(start).not.toHaveBeenCalled();
  } finally {
    await runtime.close();
    s.store.close();
  }
});
