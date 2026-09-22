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

it("原生执行连续实施、测试导入与终局批量核验成功后必须排队规划模型审查", async () => {
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

  s.store.put("run", "run-exec-1", w.id, {
    ...s.store.must<any>("run", "run-exec-1"),
    status: "completed",
    exit_code: 0,
  });
  await s.engine.finalizeNativeDelivery(w.id, "run-exec-1");

  const currentW = s.engine.get(w.id);
  expect(currentW.state).toBe("REVIEW_QUEUED");
  expect(currentW.stage).toBe("quality_before_human");

  // 校验报告归档与任务状态批量更新
  const deliveries = s.store.list("delivery", w.id);
  expect(deliveries).toHaveLength(1);
  expect((deliveries[0] as any).status).toBe("passed");

  const taskProof = s.store.get("task_proof", `${w.id}-T-CORE`);
  expect(taskProof).toBeDefined();
  expect((taskProof as any).verified).toBe(true);

  s.store.close();
});

it("缺报告、未完成项或缺映射时仍正常交接，不拒绝交付", async () => {
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

  expect(result.status).toBe("accepted");
  const currentW = s.engine.get(w.id);
  expect(["VERIFYING", "REVIEW_QUEUED"]).toContain(currentW.state);
  s.store.close();
});

it("异步归档失败不影响交接，附件状态独立持久化", async () => {
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
      title: "异步归档失败交接",
      request: "归档失败仍交接",
      complexity: "simple",
      workspace_mode: "existing_workspace",
    },
    "create-key-archive-fail",
  );
  await s.engine.submitPlan(w.id, planObj, w.version, "key-archive-fail");
  const p = proof(s.engine, w.id, "approve");
  const approved = s.engine.approve(w.id, p.proof, p.binding);
  s.store.put("workspace", "ws-archive-fail", w.id, {
    id: "ws-archive-fail",
    workflow_id: w.id,
    repo_id: "main",
    root: repoInfo.repo,
    common_dir: repoInfo.repo,
    baseline: repoInfo.baseline,
    branch: "task/fixture",
    owned: true,
  });
  s.engine.transition(w.id, ["QUEUED"], "EXECUTING", "execute", {
    run_id: "run-archive-fail",
  });
  s.store.put("run", "run-archive-fail", w.id, {
    id: "run-archive-fail",
    workflow_id: w.id,
    plan_revision: approved.plan_revision,
    adapter: "agy",
    stage: "execute",
    status: "running",
    started_at: new Date().toISOString(),
    package_hash: "pkg-archive-fail",
  });
  mkdirSync(join(repoInfo.repo, ".reports"), { recursive: true });
  writeFileSync(join(repoInfo.repo, ".reports", "ok.json"), '{"ok":true}');
  const hostReader = new NativeRunRecordReader([
    {
      tool_call_id: "call-archive-fail",
      command: "pnpm test",
      cwd: repoInfo.repo,
      exit_code: 0,
    },
  ]);
  const manifest: DeliveryManifest = {
    implementations: [],
    test_executions: [
      {
        tool_call_id: "call-archive-fail",
        command: "pnpm test",
        cwd: repoInfo.repo,
        exit_code: 0,
        report_paths: [".reports/ok.json", ".reports/missing.json"],
      },
    ],
    acceptance_mappings: [],
    unfinished_items: [],
    plan_conflicts: [],
    artifacts: [
      { repo_id: "main", path: ".reports/ok.json" },
      { repo_id: "main", path: ".reports/missing.json" },
    ],
  };

  const result = await s.engine.deliver(w.id, manifest, hostReader);
  expect(result.status).toBe("accepted");
  const deliveries = s.store.list<any>("delivery", w.id);
  expect(deliveries).toHaveLength(1);
  const snapshot = { ...deliveries[0] };
  const { drainArchiveOutbox, listAttachmentRecords } = await import(
    "../../packages/evidence/src/archive-consumer.js"
  );
  await drainArchiveOutbox(s.store, { storageRoot: s.config.storage_root });
  const after = s.store.get<any>("delivery", snapshot.id);
  expect(after.status).toBe(snapshot.status);
  expect(after.manifest).toEqual(snapshot.manifest);
  expect(after.run_id).toBe(snapshot.run_id);
  const records = listAttachmentRecords(s.store, w.id, snapshot.id);
  expect(records.find((item) => item.path === ".reports/ok.json")?.state).toBe(
    "archived",
  );
  const missing = records.find((item) => item.path === ".reports/missing.json");
  expect(missing?.state).toBe("missing");
  expect(missing?.detail).toBe("文件不存在");
  s.store.close();
});

it("导入完成不读取附件正文，归档消费者按项落状态且不覆盖 Delivery", async () => {
  const { mkdirSync: mkdir, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { Store } = await import("../../packages/store/src/store.js");
  const base = join(
    process.env.TEMP || tmpdir(),
    "devflow-review3",
    "agent-c",
  );
  mkdir(base, { recursive: true });
  const isolated = mkdtempSync(join(base, "importer-index-"));
  const repoInfo = await repository(isolated);
  mkdir(join(repoInfo.repo, ".reports"), { recursive: true });
  writeFileSync(join(repoInfo.repo, ".reports", "unit.json"), '{"ok":true}');
  const store = new Store(join(isolated, "state", "devflow.sqlite"));
  store.put("workspace", "ws-1", "wf-archive", {
    id: "ws-1",
    workflow_id: "wf-archive",
    repo_id: "main",
    root: repoInfo.repo,
  });
  const { DeliveryImporter } = await import(
    "../../packages/evidence/src/delivery-importer.js"
  );
  const { drainArchiveOutbox, listAttachmentRecords } = await import(
    "../../packages/evidence/src/archive-consumer.js"
  );
  const importer = new DeliveryImporter(store, join(isolated, "state"));
  const imported = importer.importDelivery({
    workflowId: "wf-archive",
    runId: "run-1",
    planRevision: 1,
    workspaceRoot: repoInfo.repo,
    workspaces: [
      {
        id: "ws-1",
        workflow_id: "wf-archive",
        repo_id: "main",
        root: repoInfo.repo,
      } as any,
    ],
    manifest: {
      implementations: [],
      test_executions: [
        {
          tool_call_id: "call-1",
          command: "pnpm test",
          cwd: repoInfo.repo,
          report_paths: [".reports/unit.json", ".reports/missing.json"],
        },
      ],
      acceptance_mappings: [],
      unfinished_items: [],
      plan_conflicts: [],
    },
  });
  expect(imported.archivedReports.size).toBe(0);
  expect(
    imported.attachment_status?.every((item) => item.state === "pending"),
  ).toBe(true);
  const before = store.get<any>("delivery", imported.delivery.id);
  await drainArchiveOutbox(store, {
    storageRoot: join(isolated, "state"),
    workspaces: [
      {
        id: "ws-1",
        workflow_id: "wf-archive",
        repo_id: "main",
        root: repoInfo.repo,
      } as any,
    ],
  });
  const after = store.get<any>("delivery", imported.delivery.id);
  expect(after).toEqual(before);
  const records = listAttachmentRecords(
    store,
    "wf-archive",
    imported.delivery.id,
  );
  expect(records.find((item) => item.path === ".reports/unit.json")?.state).toBe(
    "archived",
  );
  expect(
    records.find((item) => item.path === ".reports/missing.json")?.state,
  ).toBe("missing");
  store.close();
});
