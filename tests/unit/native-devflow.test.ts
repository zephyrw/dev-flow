import { hash } from "../../packages/core/src/util.js";
import {
  reportKey,
  reportSourceKey,
} from "../../packages/evidence/src/native-execution-observer.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HandoffBuilder, nativeLaunchInstruction } from "../../packages/adapters/agy/src/handoff.js";
import { NativeRunRecordReader } from "../../packages/evidence/src/native-run-records.js";
import { WorkspaceFingerprintService } from "../../packages/workspace/src/fingerprint.js";
import { BufferedEventSink } from "../../packages/core/src/buffered-sink.js";
import { EvidenceValidator } from "../../packages/evidence/src/validator.js";
import { Store } from "../../packages/store/src/store.js";
import type {
  Workflow,
  Plan,
  Run,
  Delivery,
  InputManifest,
} from "../../packages/contracts/src/index.js";

describe("DevFlow 原生执行与终局核验单元测试", () => {
  let testDir: string;
  let store: Store;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      "devflow-native-test-" + Math.random().toString(36).slice(2),
    );
    mkdirSync(testDir, { recursive: true });
    store = new Store(join(testDir + ".state", "test.db"));
  });

  afterEach(() => {
    store.close();
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  describe("HandoffBuilder", () => {
    const mockWorkflow: Workflow = {
      id: "wf-1",
      project_id: "proj-1",
      title: "测试任务",
      request: "请完成原生测试",
      complexity: "simple",
      workspace_mode: "existing_workspace",
      state: "EXECUTING",
      stage: "execute",
      version: 1,
      plan_revision: 1,
      environment_revision: 1,
      feedback: ["初始需求说明"],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const mockPlan: Plan = {
      task_model: "native-v2",
      revision: 1,
      feedback_cursor: 0,
      modules: [{ id: "m1", title: "核心模块" }],
      markdown: "# 完整设计\n这是详细的架构与测试要求...",
      complexity: "simple",
      reason: "单模块实现",
      decisions: [],
      unresolved_decisions: [],
      scope: {
        repository_paths: {},
        allowed_paths: ["src/index.ts", "tests/index.test.ts"],
        protected_paths: [".git"],
        allow_dependency_changes: false,
        allow_public_api_changes: false,
      },
      tasks: [
        {
          id: "t1",
          title: "实现核心业务",
          module_id: "m1",
          requirements: ["REQ-1"],
          depends_on: [],
          paths: ["src/index.ts"],
          inputs: "业务输入",
          implementation: "核心业务逻辑",
          preserve: "已有逻辑",
          completion: "完成测试",
          test_ids: ["TEST-1"],
          stop_conditions: "测试通过",
        },
      ],
      tests: [
        {
          id: "TEST-1",
          task_ids: ["t1"],
          layer: "unit",
          steps: ["运行单元测试"],
          assertions: ["断言成功"],
          expected_case_ids: ["case-01"],
          timeout_seconds: 60,
        },
      ],
      exemptions: [],
      baselines: {},
      project_config_hash: "hash-123",
    };

    it("首次交接生成包含完整设计和索引的包", () => {
      const pkg = HandoffBuilder.buildFullHandoff({
        workflow: mockWorkflow,
        plan: mockPlan,
        runId: "run-1",
        packageHash: "pkg-hash",
        directory: testDir,
      });

      expect(pkg.mode).toBe("full");
      expect(pkg.workflow_id).toBe("wf-1");
      expect(pkg.design_file).toBe(join(testDir, "HANDOFF.md"));
      expect(pkg.instructions).toContain(join(testDir, "HANDOFF.md"));
      expect(pkg.index.modules).toHaveLength(1);
      expect(pkg.index.tasks).toHaveLength(1);
      expect(pkg.index.acceptance_items).toHaveLength(1);

      HandoffBuilder.writeHandoffFiles(testDir, pkg, mockPlan.markdown);
      expect(pkg.index.acceptance_items[0]!.expected_case_ids).toContain(
        "case-01",
      );
    });

    it("恢复交接包含增量反馈与终局核验失败 issues", () => {
      const pkg = HandoffBuilder.buildResumeHandoff({
        workflow: mockWorkflow,
        plan: mockPlan,
        runId: "run-2",
        conversationId: "conv-123",
        packageHash: "pkg-hash-2",
        directory: testDir,
        deliveryIssues: [
          {
            id: "iss-1",
            workflow_id: "wf-1",
            delivery_id: "del-1",
            code: "ACCEPTANCE_CASE_FAILED",
            message: "测试用例失败",
            status: "open",
            created_at: new Date().toISOString(),
          },
        ],
      });

      expect(pkg.mode).toBe("resume");
      expect(pkg.conversation_id).toBe("conv-123");
      expect(pkg.design_file).toBe(join(testDir, "HANDOFF.md"));
      expect(pkg.instructions).toContain(join(testDir, "handoff.json"));
      expect(pkg.delivery_issues).toHaveLength(1);
      expect(pkg.delivery_issues![0]!.code).toBe("ACCEPTANCE_CASE_FAILED");
    });

    it("启动提示使用容器绝对路径", () => {
      const files = {
        json: join(testDir, "handoff.json"),
        markdown: join(testDir, "HANDOFF.md"),
        plans: join(testDir, "AUTHORITATIVE_PLANS.json"),
        schema: join(testDir, "plan-self-check.schema.json"),
      };
      expect(nativeLaunchInstruction(testDir, "full")).toContain(files.markdown);
      expect(nativeLaunchInstruction(testDir, "full")).toContain(files.json);
      expect(nativeLaunchInstruction(testDir, "resume")).toContain(files.json);
      expect(nativeLaunchInstruction(testDir, "full")).toContain("直接交代码审查");
    });
  });

  describe("NativeRunRecordReader", () => {
    it("正确解析宿主日志并验证真实退出码", () => {
      const jsonl = [
        JSON.stringify({
          event: "tool_call",
          tool_call_id: "call_abc",
          name: "run_command",
          args: { CommandLine: "pnpm test", Cwd: testDir },
          timestamp: "2026-09-15T12:00:00Z",
        }),
        JSON.stringify({
          event: "tool_result",
          tool_call_id: "call_abc",
          exit_code: 0,
          output: "Tests passed",
          timestamp: "2026-09-15T12:00:05Z",
        }),
      ].join("\n");

      const reader = NativeRunRecordReader.fromString(jsonl);
      const fact = reader.getFact("call_abc");
      expect(fact).toBeDefined();
      expect(fact?.command).toBe("pnpm test");
      expect(fact?.exit_code).toBe(0);

      const verification = reader.verify({
        tool_call_id: "call_abc",
        command: "pnpm test",
      });
      expect(verification.valid).toBe(true);
    });

    it("严禁使用模型自报退出码，宿主失败时拒绝通过", () => {
      const jsonl = [
        JSON.stringify({
          type: "tool_call",
          tool_call_id: "call_fail",
          name: "run_command",
          args: { CommandLine: "pnpm test", Cwd: testDir },
        }),
        JSON.stringify({
          type: "tool_result",
          tool_call_id: "call_fail",
          exit_code: 1, // 宿主真实退出码为 1
          output: "AssertionError",
        }),
      ].join("\n");

      const reader = NativeRunRecordReader.fromString(jsonl);
      const verification = reader.verify({
        tool_call_id: "call_fail",
        command: "pnpm test",
      });
      expect(verification.valid).toBe(false);
      expect(verification.actualExitCode).toBe(1);
    });

    it("缺少宿主执行记录时判定证据不完整", () => {
      const reader = new NativeRunRecordReader([]);
      const verification = reader.verify({
        tool_call_id: "non_existent_call",
        command: "pnpm test",
      });
      expect(verification.valid).toBe(false);
      expect(verification.reason).toContain("未找到标识");
    });
  });

  describe("WorkspaceFingerprintService", () => {
    it("排除依赖目录与测试报告，源码变更时指纹更新", () => {
      // 创建业务源码与排除文件
      mkdirSync(join(testDir, "src"), { recursive: true });
      mkdirSync(join(testDir, "node_modules"), { recursive: true });
      mkdirSync(join(testDir, "dist"), { recursive: true });

      writeFileSync(join(testDir, "src", "index.ts"), "export const a = 1;");
      writeFileSync(join(testDir, "node_modules", "dep.js"), "var dep = 2;");
      writeFileSync(join(testDir, "dist", "bundle.js"), "var bundle = 3;");
      writeFileSync(join(testDir, "report.json"), "{ 'cases': [] }");

      const res1 = WorkspaceFingerprintService.compute(testDir);
      // 依赖和产物及报告不应计入输入文件
      const paths = res1.files.map((f) => f.path);
      expect(paths).toContain("src/index.ts");
      expect(paths).not.toContain("node_modules/dep.js");
      expect(paths).not.toContain("dist/bundle.js");
      expect(paths).not.toContain("report.json");

      // 修改业务源码
      writeFileSync(join(testDir, "src", "index.ts"), "export const a = 2;");
      const res2 = WorkspaceFingerprintService.compute(testDir);
      expect(res2.fingerprint).not.toBe(res1.fingerprint);

      // 核验证纹比对
      const check = WorkspaceFingerprintService.verifyFingerprint(testDir, {
        id: "man-1",
        workflow_id: "wf-1",
        fingerprint: res1.fingerprint,
        files: res1.files,
        created_at: res1.timestamp,
      });
      expect(check.matches).toBe(false);
      expect(check.changedFiles).toContain("src/index.ts");
    });
  });

  describe("BufferedEventSink", () => {
    it("达到阈值或超时触发 flush", async () => {
      const chunks: string[] = [];
      const sink = new BufferedEventSink({
        maxBytes: 20,
        flushIntervalMs: 50,
        onFlush: (c) => {
          chunks.push(c);
        },
      });

      sink.write("12345");
      sink.write("67890");
      expect(chunks).toHaveLength(0); // 10 字节未满 20

      sink.write("abcdefghijklmn"); // 超过 20 字节
      await sink.flush();
      expect(chunks.length).toBeGreaterThanOrEqual(1);

      // 测试定时清空
      sink.write("short");
      await new Promise((r) => setTimeout(r, 80));
      expect(chunks.length).toBeGreaterThanOrEqual(2);

      await sink.close();
    });
  });

  describe("EvidenceValidator", () => {
    const mockWorkflow: Workflow = {
      id: "wf-100",
      plan_hash: "fixture-plan-hash",
      project_id: "proj-1",
      title: "终局核验测试",
      request: "核验",
      complexity: "simple",
      workspace_mode: "existing_workspace",
      state: "EXECUTING",
      stage: "execute",
      version: 1,
      plan_revision: 1,
      environment_revision: 1,
      feedback: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const mockRun: Run = {
      id: "run-100",
      workflow_id: "wf-100",
      plan_revision: 1,
      adapter: "agy",
      stage: "execute",
      status: "running",
      started_at: new Date().toISOString(),
      package_hash: "hash-run",
    };

    const mockPlan: Plan = {
      task_model: "native-v2",
      revision: 1,
      modules: [],
      feedback_cursor: 0,
      markdown: "# 设计正文",
      complexity: "simple",
      reason: "测试",
      decisions: [],
      unresolved_decisions: [],
      scope: {
        repository_paths: {},
        allowed_paths: ["src/app.ts"],
        protected_paths: [".git"],
        allow_dependency_changes: false,
        allow_public_api_changes: false,
      },
      tasks: [
        {
          id: "T-01",
          title: "核心功能",
          requirements: ["R-01"],
          depends_on: [],
          paths: ["src/app.ts"],
          inputs: "输入",
          implementation: "实现说明",
          preserve: "保护内容",
          completion: "完成条件",
          test_ids: ["TEST-REQ-1"],
          stop_conditions: "通过",
        },
      ],
      tests: [
        {
          id: "TEST-REQ-1",
          task_ids: ["T-01"],
          layer: "unit",
          steps: ["运行测试"],
          assertions: ["预期通过"],
          expected_case_ids: ["User should login"],
          timeout_seconds: 60,
        },
      ],
      exemptions: [],
      baselines: {},
      project_config_hash: "cfg-123",
    };

    it("所有证据完整且宿主事实匹配时终局核验成功", () => {
      execFileSync("git", ["init"], { cwd: testDir });
      execFileSync("git", ["config", "user.name", "test"], { cwd: testDir });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: testDir,
      });
      mkdirSync(join(testDir, "src"), { recursive: true });
      writeFileSync(join(testDir, "src", "app.ts"), "export const ok = true;");

      const fp = WorkspaceFingerprintService.compute(testDir);
      const manifest: InputManifest = {
        id: "man-100",
        workflow_id: "wf-100",
        fingerprint: fp.fingerprint,
        files: fp.files,
        created_at: fp.timestamp,
      };

      const hostReader = new NativeRunRecordReader([
        {
          tool_call_id: "call-vitest-1",
          command: "pnpm vitest run --reporter=json",
          cwd: testDir,
          exit_code: 0,
        },
      ]);

      const delivery: Delivery = {
        id: "del-100",
        workflow_id: "wf-100",
        run_id: "run-100",
        plan_revision: 1,
        status: "pending",
        manifest: {
          implementations: [{ task_id: "T-01", path: "src/app.ts" }],
          test_executions: [
            {
              tool_call_id: "call-vitest-1",
              command: "pnpm vitest run --reporter=json",
              cwd: testDir,
              exit_code: 0,
              report_paths: ["vitest-report.json"],
            },
          ],
          acceptance_mappings: [
            {
              requirement_id: "TEST-REQ-1",
              scene_id: "User should login",
              test_execution_id: "call-vitest-1",
              report_path: "vitest-report.json",
              case_id: "User should login",
            },
          ],
          unfinished_items: [],
          plan_conflicts: [],
        },
        submitted_at: new Date().toISOString(),
      };

      const archivedReports = new Map([
        [
          "vitest-report.json",
          {
            path: join(testDir, "vitest-report.json"),
            hash: "report-hash",
            rawContent: JSON.stringify({
              testResults: [
                {
                  assertionResults: [
                    { title: "User should login", status: "passed" },
                  ],
                },
              ],
            }),
          },
        ],
      ]);

      const call = delivery.manifest.test_executions[0]!.tool_call_id;
      Object.assign(delivery.manifest, {
        schema_version: "v2",
        submission_id: "sub",
        workflow_id: mockWorkflow.id,
        run_id: mockRun.id,
        conversation_id: "conv",
        plan_revision: mockWorkflow.plan_revision,
        plan_hash: mockWorkflow.plan_hash,
      });
      store.put("conversation", mockWorkflow.id, mockWorkflow.id, {
        id: "conv",
      });
      const reportHashes: Record<string, string> = {};
      for (const [path, info] of [...archivedReports]) {
        info.hash = hash(info.rawContent);
        reportHashes[reportSourceKey("main", path)] = info.hash;
        archivedReports.delete(path);
        archivedReports.set(reportKey("main", call, path), info);
      }
      const boundReader = new NativeRunRecordReader(
        hostReader.getAllFacts().map((f) => ({
          ...f,
          workflow_id: mockWorkflow.id,
          run_id: mockRun.id,
          plan_hash: mockWorkflow.plan_hash,
          conversation_id: "conv",
          started_at: fp.timestamp,
          ended_at: fp.timestamp,
          input_fingerprints: { main: fp.fingerprint },
          report_hashes: reportHashes,
        })),
      );
      const validator = new EvidenceValidator(store);
      const result = validator.validate({
        workflow: mockWorkflow,
        run: mockRun,
        plan: mockPlan,
        delivery,
        archivedReports,
        hostRecordReader: boundReader,
        currentInputManifest: manifest,
        workspaceRoot: testDir,
      });

      expect(result.passed, JSON.stringify(result.issues)).toBe(true);
      expect(result.issues).toHaveLength(0);
      expect(result.acceptanceResults).toHaveLength(1);
      expect(result.acceptanceResults[0]!.status).toBe("passed");
    });

    it("缺报告、用例失败、伪报退出码时一次性汇总所有 issues", () => {
      mkdirSync(join(testDir, "src"), { recursive: true });
      writeFileSync(
        join(testDir, "src", "app.ts"),
        "export const broken = true;",
      );

      const fp = WorkspaceFingerprintService.compute(testDir);
      const manifest: InputManifest = {
        id: "man-100",
        workflow_id: "wf-100",
        fingerprint: fp.fingerprint,
        files: fp.files,
        created_at: fp.timestamp,
      };

      // 宿主记录退出码为 1
      const hostReader = new NativeRunRecordReader([
        {
          tool_call_id: "call-fail",
          command: "pnpm vitest run",
          cwd: testDir,
          exit_code: 1,
        },
      ]);

      const delivery: Delivery = {
        id: "del-err",
        workflow_id: "wf-100",
        run_id: "run-100",
        plan_revision: 1,
        status: "pending",
        manifest: {
          implementations: [],
          test_executions: [
            {
              tool_call_id: "call-fail",
              command: "pnpm vitest run",
              cwd: testDir,
              exit_code: 0, // 模型谎报退出码为 0
              report_paths: ["vitest-report.json", "missing-report.json"],
            },
          ],
          acceptance_mappings: [
            {
              requirement_id: "TEST-REQ-1",
              scene_id: "User should login",
              test_execution_id: "call-fail",
              report_path: "vitest-report.json",
              case_id: "User should login",
            },
          ],
          unfinished_items: [{ id: "EXTRA-1", reason: "未写完" }],
          plan_conflicts: [],
        },
        submitted_at: new Date().toISOString(),
      };

      const archivedReports = new Map([
        [
          "vitest-report.json",
          {
            path: join(testDir, "vitest-report.json"),
            hash: "report-hash",
            rawContent: JSON.stringify({
              testResults: [
                {
                  assertionResults: [
                    { title: "User should login", status: "failed" }, // 实际用例失败
                  ],
                },
              ],
            }),
          },
        ],
      ]);

      const call = delivery.manifest.test_executions[0]!.tool_call_id;
      Object.assign(delivery.manifest, {
        schema_version: "v2",
        submission_id: "sub",
        workflow_id: mockWorkflow.id,
        run_id: mockRun.id,
        conversation_id: "conv",
        plan_revision: mockWorkflow.plan_revision,
        plan_hash: mockWorkflow.plan_hash,
      });
      store.put("conversation", mockWorkflow.id, mockWorkflow.id, {
        id: "conv",
      });
      const reportHashes: Record<string, string> = {};
      for (const [path, info] of [...archivedReports]) {
        info.hash = hash(info.rawContent);
        reportHashes[reportSourceKey("main", path)] = info.hash;
        archivedReports.delete(path);
        archivedReports.set(reportKey("main", call, path), info);
      }
      const boundReader = new NativeRunRecordReader(
        hostReader.getAllFacts().map((f) => ({
          ...f,
          workflow_id: mockWorkflow.id,
          run_id: mockRun.id,
          plan_hash: mockWorkflow.plan_hash,
          conversation_id: "conv",
          started_at: fp.timestamp,
          ended_at: fp.timestamp,
          input_fingerprints: { main: fp.fingerprint },
          report_hashes: reportHashes,
        })),
      );
      const validator = new EvidenceValidator(store);
      const result = validator.validate({
        workflow: mockWorkflow,
        run: mockRun,
        plan: mockPlan,
        delivery,
        archivedReports,
        hostRecordReader: boundReader,
        currentInputManifest: manifest,
        workspaceRoot: testDir,
      });

      expect(result.passed).toBe(true);
      const issueCodes = result.issues.map((i) => i.code);
      expect(issueCodes).toContain("HOST_EXECUTION_INVALID");
      expect(issueCodes).toContain("REPORT_MISSING");
      expect(issueCodes).toContain("ACCEPTANCE_CASE_FAILED");
      expect(issueCodes).toContain("UNFINISHED_ITEM");
    });
  });
});
