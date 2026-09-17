import { attestFixture } from "../native-fixture.js";
import { it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setup, repository, project, plan, proof } from "../helpers.js";
import { objectHash } from "../../packages/core/src/util.js";
import { NativeRunRecordReader } from "../../packages/evidence/src/native-run-records.js";
import type {
  Plan,
  DeliveryManifest,
} from "../../packages/contracts/src/index.js";

it("原生执行连续实施、测试导入与终局批量核验成功后必须排队执行计划自查", async () => {
  const s = setup();
  const repoInfo = await repository(s.root);
  const proj = project(repoInfo.repo);
  s.store.put("project", proj.id, proj.id, proj);

  // 基于标准合法 plan 构造 native-v2 计划
  const basePlan = plan(objectHash(proj), repoInfo.baseline);
  const planObj: Plan = {
    ...basePlan,
    task_model: "native-v2",
    modules: [{ id: "m1", title: "应用模块" }],
    tasks: [
      {
        id: "T-CORE",
        title: "核心特性开发",
        requirements: ["REQ-01"],
        depends_on: [],
        paths: ["app.txt"],
        inputs: "当前文本",
        implementation: "实现核心业务完整逻辑处理",
        preserve: "保留已有文件",
        completion: "完成所有核心测试",
        test_ids: ["TEST-01"],
        stop_conditions: "测试失败则停止",
        module_id: "m1",
      },
    ],
    tests: [
      {
        id: "TEST-01",
        task_ids: ["T-CORE"],
        layer: "unit",
        steps: ["运行单元测试"],
        assertions: ["核心特性返回正常"],
        expected_case_ids: ["Feature test should pass"],
        timeout_seconds: 60,
      },
    ],
  };

  const w = s.engine.create(
    {
      project_id: proj.id,
      title: "原生执行改造测试",
      request: "使用原生模式交付",
      complexity: "simple",
      workspace_mode: "existing_workspace",
    },
    "create-key-1",
  );

  await s.engine.submitPlan(w.id, planObj, w.version, "key-1");
  const p = proof(s.engine, w.id, "approve");
  const approved = s.engine.approve(w.id, p.proof, p.binding);

  // 模拟调度与激活
  const workspaces = [
    {
      id: "ws-1",
      workflow_id: w.id,
      repo_id: "main",
      root: repoInfo.repo,
      common_dir: repoInfo.repo,
      baseline: repoInfo.baseline,
      branch: "task/fixture",
      owned: true,
    },
  ];
  for (const ws of workspaces) s.store.put("workspace", ws.id, w.id, ws);

  s.engine.transition(w.id, ["QUEUED"], "EXECUTING", "execute", {
    run_id: "run-exec-1",
  });
  s.store.put("run", "run-exec-1", w.id, {
    id: "run-exec-1",
    workflow_id: w.id,
    plan_revision: approved.plan_revision,
    adapter: "agy",
    stage: "execute",
    status: "running",
    started_at: new Date().toISOString(),
    package_hash: "pkg-123",
  });

  // 在工作区创建业务代码与测试报告文件
  writeFileSync(join(repoInfo.repo, "app.txt"), "after\n");
  mkdirSync(join(repoInfo.repo, ".reports"), { recursive: true });
  writeFileSync(
    join(repoInfo.repo, ".reports", "unit.json"),
    JSON.stringify({
      testResults: [
        {
          assertionResults: [
            { title: "Feature test should pass", status: "passed" },
          ],
        },
      ],
    }),
  );

  // 构造宿主真实执行记录（退出码为 0）
  const hostReader = new NativeRunRecordReader([
    {
      tool_call_id: "call-run-vitest",
      command: "pnpm vitest run --reporter=json",
      cwd: repoInfo.repo,
      exit_code: 0,
    },
  ]);

  const manifest: DeliveryManifest = {
    implementations: [
      { task_id: "T-CORE", path: "app.txt", description: "完成核心功能" },
    ],
    test_executions: [
      {
        tool_call_id: "call-run-vitest",
        command: "pnpm vitest run --reporter=json",
        cwd: repoInfo.repo,
        exit_code: 0,
        report_paths: [".reports/unit.json"],
      },
    ],
    acceptance_mappings: [
      {
        requirement_id: "TEST-01",
        scene_id: "Feature test should pass",
        test_execution_id: "call-run-vitest",
        report_path: ".reports/unit.json",
        case_id: "Feature test should pass",
      },
    ],
    unfinished_items: [],
    plan_conflicts: [],
  };

  // 执行终局交付核验
  const deliveryResult = await s.engine.deliver(
    w.id,
    manifest,
    attestFixture(s.engine, w.id, manifest, hostReader),
  );

  expect(deliveryResult.status).toBe("accepted");
  expect((deliveryResult as any).acceptance_results).toHaveLength(1);

  // 完成开发仅能排队自查，不能跳过规划质量审查
  const currentW = s.engine.get(w.id);
  expect(currentW.state).toBe("QUEUED");
  expect(currentW.stage).toBe("executor_plan_self_check");

  // 校验报告归档与任务状态批量更新
  const deliveries = s.store.list("delivery", w.id);
  expect(deliveries).toHaveLength(1);
  expect((deliveries[0] as any).status).toBe("passed");

  const taskProof = s.store.get("task_proof", `${w.id}-T-CORE`);
  expect(taskProof).toBeDefined();
  expect((taskProof as any).verified).toBe(true);

  s.store.close();
});

it("终局核验在宿主失败、缺报告或未完成项时拒绝并一次性返回全部问题", async () => {
  const s = setup();
  const repoInfo = await repository(s.root);
  const proj = project(repoInfo.repo);
  s.store.put("project", proj.id, proj.id, proj);

  const basePlan = plan(objectHash(proj), repoInfo.baseline);
  const planObj: Plan = {
    ...basePlan,
    task_model: "native-v2",
    modules: [{ id: "m1", title: "模块" }],
    tasks: [
      {
        id: "T-01",
        title: "任务 1",
        requirements: ["REQ-01"],
        depends_on: [],
        paths: ["app.txt"],
        inputs: "当前文本",
        implementation: "实现核心业务完整逻辑处理",
        preserve: "保留已有文本",
        completion: "完成所有核心测试",
        test_ids: ["TEST-REQ"],
        stop_conditions: "测试失败则停止",
        module_id: "m1",
      },
    ],
    tests: [
      {
        id: "TEST-REQ",
        task_ids: ["T-01"],
        layer: "unit",
        steps: ["测试"],
        assertions: ["断言"],
        expected_case_ids: ["Required case"],
        timeout_seconds: 60,
      },
    ],
  };

  const w = s.engine.create(
    {
      project_id: proj.id,
      title: "核验失败测试",
      request: "触发核验失败",
      complexity: "simple",
      workspace_mode: "existing_workspace",
    },
    "create-key-2",
  );

  await s.engine.submitPlan(w.id, planObj, w.version, "key-fail-1");
  const p = proof(s.engine, w.id, "approve");
  const approved = s.engine.approve(w.id, p.proof, p.binding);

  s.store.put("workspace", "ws-fail", w.id, {
    id: "ws-fail",
    workflow_id: w.id,
    repo_id: "main",
    root: repoInfo.repo,
    common_dir: repoInfo.repo,
    baseline: repoInfo.baseline,
    branch: "task/fixture",
    owned: true,
  });

  s.engine.transition(w.id, ["QUEUED"], "EXECUTING", "execute", {
    run_id: "run-fail-1",
  });
  s.store.put("run", "run-fail-1", w.id, {
    id: "run-fail-1",
    workflow_id: w.id,
    plan_revision: approved.plan_revision,
    adapter: "agy",
    stage: "execute",
    status: "running",
    started_at: new Date().toISOString(),
    package_hash: "pkg-fail",
  });

  // 宿主退出码为 1
  const hostReader = new NativeRunRecordReader([
    {
      tool_call_id: "call-fail",
      command: "pnpm test",
      cwd: repoInfo.repo,
      exit_code: 1,
    },
  ]);

  const manifest: DeliveryManifest = {
    implementations: [],
    test_executions: [
      {
        tool_call_id: "call-fail",
        command: "pnpm test",
        cwd: repoInfo.repo,
        exit_code: 0, // 伪报为 0
        report_paths: [".reports/non_existent.json"], // 缺失报告
      },
    ],
    acceptance_mappings: [
      {
        requirement_id: "TEST-REQ",
        scene_id: "Required case",
        test_execution_id: "call-fail",
        report_path: ".reports/non_existent.json",
        case_id: "Required case",
      },
    ],
    unfinished_items: [{ id: "UNFINISHED-TASK", reason: "未完全交付" }],
    plan_conflicts: [],
  };

  const result = await s.engine.deliver(w.id, manifest, hostReader);

  expect(result.status).toBe("rejected");
  expect((result as any).issues.length).toBeGreaterThanOrEqual(3);

  // 状态依然保持在 EXECUTING，现场与实现未被清除
  const currentW = s.engine.get(w.id);
  expect(currentW.state).toBe("EXECUTING");

  const issues = s.store.list("delivery_issue", w.id);
  expect(issues.length).toBeGreaterThanOrEqual(3);
  const codes = issues.map((i: any) => i.code);
  expect(codes).toContain("HOST_EXECUTION_INVALID");
  expect(codes).toContain("REPORT_MISSING");
  expect(codes).toContain("UNFINISHED_ITEM");

  s.store.close();
});
