import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setup } from "../helpers.js";
import { ProfileRuntime, invokePrompt } from "../../packages/runtime/src/profile-runtime.js";
import { HandoffBuilder, nativeLaunchInstruction } from "../../packages/adapters/agy/src/handoff.js";
import { reviewContractContext } from "../../packages/runtime/src/review-materials.js";
import { reviewOutputSchema, ReviewModelOutputSchema } from "../../packages/contracts/src/review-output.js";
import { normalizeExecutionIntent, INTENT_CLARIFICATION_INSTRUCTION } from "../../packages/core/src/round-intent.js";
import { seedReviewCompletion } from "../../packages/core/src/review-completion.js";
import { executionScopeInstructions, reviewScopeInstructions } from "../../packages/core/src/role-boundaries.js";
import { now } from "../../packages/core/src/util.js";
import type { Workflow, Plan, Run } from "../../packages/contracts/src/index.js";
import type { MergeConflictRequest } from "../../packages/contracts/src/merge-conflict.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";

describe("IT02 & IT03: 角色职责边界与交接完整性 (role-scope-handoff)", () => {
  let env: ReturnType<typeof setup>;
  let testDir: string;

  beforeEach(() => {
    env = setup();
    testDir = join(
      tmpdir(),
      "role-scope-handoff-test-" + Math.random().toString(36).slice(2),
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    env.store.close();
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  const mockPlan: Plan = {
    task_model: "native-v2",
    revision: 1,
    feedback_cursor: 0,
    modules: [{ id: "m1", title: "核心模块" }],
    markdown: "# 架构方案\n包含详细任务和测试要求...",
    complexity: "simple",
    reason: "初始实现",
    decisions: [],
    unresolved_decisions: [],
    scope: {
      repository_paths: {},
      allowed_paths: ["src/app.ts", "tests/app.test.ts"],
      protected_paths: [".git"],
      allow_dependency_changes: false,
      allow_public_api_changes: false,
    },
    tasks: [
      {
        id: "T1",
        title: "实现模块接口",
        module_id: "m1",
        requirements: ["REQ-1"],
        depends_on: [],
        paths: ["src/app.ts"],
        inputs: "输入参数",
        implementation: "核心逻辑",
        preserve: "无",
        completion: "自测通过",
        test_ids: ["TEST-1"],
        stop_conditions: "测试通过",
      },
    ],
    tests: [
      {
        id: "TEST-1",
        task_ids: ["T1"],
        layer: "unit",
        steps: ["运行单元测试"],
        assertions: ["断言正常"],
        expected_case_ids: ["case-1"],
        timeout_seconds: 30,
      },
    ],
    exemptions: [],
    baselines: {},
    project_config_hash: "hash-001",
  };

  const createWorkflow = (overrides: Partial<Workflow> = {}): Workflow => ({
    id: "wf-role-scope",
    project_id: "proj-1",
    title: "边界验证任务",
    request: "完成功能实现",
    complexity: "simple",
    workspace_mode: "existing_workspace",
    state: "EXECUTING",
    stage: "execute",
    version: 1,
    plan_revision: 1,
    environment_revision: 0,
    created_at: now(),
    updated_at: now(),
    feedback: ["历史反馈：请新增脚本验证测试确实执行"],
    ...overrides,
  });

  const createRun = (overrides: Partial<Run> = {}): Run => ({
    id: "run-role-scope",
    workflow_id: "wf-role-scope",
    plan_revision: 1,
    adapter: "codex",
    stage: "execute",
    status: "running",
    started_at: now(),
    package_hash: "pkg-1",
    ...overrides,
  });

  describe("IT02: ProfileRuntime 与 AGY Handoff 边界及 Schema 验证", () => {
    it("ProfileRuntime review 生成当前收敛后的 Schema，不含审计证明字段", () => {
      const schema = reviewOutputSchema(["main"]);
      // 验证收敛后的 schema
      expect(schema.properties.verdict).toBeDefined();
      expect(schema.properties.findings).toBeDefined();
      expect(schema.properties.repair_document).toBeDefined();

      // 验证旧越界核验字段已被彻底移除
      expect(schema.properties.coverage).toBeUndefined();
      expect(schema.properties.tests_validity_checked).toBeUndefined();
      expect(schema.properties.completion_evidence).toBeUndefined();
      expect(schema.properties.document_hash).toBeUndefined();
      expect(schema.properties.document_revision).toBeUndefined();
    });

    it("AGY full 与 resume 交接均包含自主补齐约束，且旧反馈不冲掉当前职责边界", () => {
      const workflowWithOldFeedback = createWorkflow({
        feedback: [
          "旧整改意见：编写测试执行审计工具并在 review 中核验",
        ],
      });

      const fullPkg = HandoffBuilder.buildFullHandoff({
        workflow: workflowWithOldFeedback,
        plan: mockPlan,
        runId: "run-full",
        packageHash: "hash-1",
        directory: testDir,
      });

      const resumePkg = HandoffBuilder.buildResumeHandoff({
        workflow: workflowWithOldFeedback,
        plan: mockPlan,
        runId: "run-resume",
        conversationId: "conv-1",
        packageHash: "hash-2",
        directory: testDir,
      });

      // 无论 full 还是 resume，instructions 必须明确包含主动识别并补齐约束
      expect(fullPkg.instructions).toContain("主动识别并补齐");
      expect(fullPkg.instructions).toContain("不为调用 ID、清单或 hash 重跑测试");
      expect(fullPkg.instructions).toContain("不得借必要补齐新增业务、改选架构、扩大接口或顺手重构");

      expect(resumePkg.instructions).toContain("按既定设计修复并主动补齐必要遗漏");
      expect(resumePkg.instructions).toContain("不为调用 ID、清单或 hash 重跑测试");

      const fullPrompt = nativeLaunchInstruction(testDir, "full");
      const resumePrompt = nativeLaunchInstruction(testDir, "resume");
      expect(fullPrompt).toContain("主动补齐");
      expect(resumePrompt).toContain("主动补齐");
    });

    it("reviewContractContext 投影过滤旧 completion 中的待办，且注入不核验真实性指令", () => {
      const workflow = createWorkflow({
        stage: "quality_before_human",
        plan_hash: "plan-hash-1",
        snapshot_id: "snap-1",
        environment_revision: 0,
        feedback: [],
      });
      const run = createRun({ stage: "quality_before_human" });

      seedReviewCompletion(
        env.engine,
        workflow,
        { verdict: "changes_required" },
        "missing document_hash",
      );
      // 模拟旧历史中保留了越界 instruction
      const stored = env.store.get<any>("review_completion", workflow.id)!;
      env.store.put("review_completion", workflow.id, workflow.id, {
        ...stored,
        instruction: "旧指令：必须提供 document_hash 与测试执行证明",
      });

      const context = reviewContractContext(env.engine, workflow, run);
      expect(context.completion).not.toBeNull();
      expect(context.completion?.instruction).not.toContain("document_hash");
      expect(context.completion?.instruction).toContain("不核验测试真实性");
      expect(context.completion?.instruction).toContain("不要求证明工具");
    });
  });

  describe("IT03: 各阶段交接与 intent_clarification 语义", () => {
    it("审核指导包含统一审核职责边界，不扩展无关历史问题", () => {
      expect(reviewScopeInstructions).toContain("不检查测试是否真实执行");
      expect(reviewScopeInstructions).toContain("不核验测试报告");
      expect(reviewScopeInstructions).toContain("这类证明工具及其问题不得成为本轮开发整改项");
      expect(reviewScopeInstructions).toContain("不得据此开展测试覆盖率、测试执行真实性或流程合规审计");
    });

    it("执行角色获得自主补齐指导，明确不得越界重构或变更公共契约", () => {
      expect(executionScopeInstructions).toContain("按用户当前需求及批准计划完成实现");
      expect(executionScopeInstructions).toContain("主动识别并补齐实现同一目标所必需的相关遗漏");
      expect(executionScopeInstructions).toContain("不得借必要补齐新增业务、改选架构、扩大接口或顺手重构");
      expect(executionScopeInstructions).toContain("代码质量整改中的测试真实性核验、证明脚本或审计工具要求，不因进入整改文档而取得执行权限");
    });

    it("intent_clarification 仅补充结论，不重新执行任务", () => {
      // 意图澄清指令只要求补充上一轮结果意图
      expect(INTENT_CLARIFICATION_INSTRUCTION).toBe("请补充刚才这轮的结果意图");

      // normalizeExecutionIntent 解析
      const result = normalizeExecutionIntent({
        status: "completed",
        summary: "仅补充上一轮完成结论",
      });
      expect(result.intent).toBe("completed");
      expect(result.summary).toBe("仅补充上一轮完成结论");
    });
  });

  describe("RT08 ~ RT10: 审核职责收敛、冲突解决执行边界与意图澄清 (CQ03, CQ04)", () => {
    it("RT08: ProfileRuntime 传给 adapter 的审核 prompt 不包含“必须阅读全部材料”要求", () => {
      const prompt = invokePrompt(
        "quality_review",
        "/path/to/handoff.json",
        "/path/to/schema.json",
      );
      // 1. 不包含强制阅读全部材料或引用文件词句
      expect(prompt).not.toContain("全部材料和引用文件");
      expect(prompt).not.toContain("必须先阅读全部材料");
      expect(prompt).not.toContain("阅读全部材料");

      // 2. 明确指示仅按必需范围查阅，禁止遍历全量测试报告或历史日志
      expect(prompt).toContain("引用材料仅按本次任务及当前角色判断所必需的范围读取");
      expect(prompt).toContain("不要求遍历测试报告、执行日志、证明附件");
      expect(prompt).toContain("这些缺失不触发代码整改");
      expect(prompt).toContain("历史材料只作为背景，不自动产生新的流程或证明任务");
    });

    it("RT09: resolveMergeConflict 的 instructions 包含 executionScopeInstructions 且无只读/非实现限制", async () => {
      const runtime = new ProfileRuntime(env.engine, {} as any);
      const workflow = createWorkflow();
      const run = createRun({ purpose: "implement" });
      env.store.put("workflow", workflow.id, workflow.project_id, workflow);
      env.store.put("plan", `${workflow.id}-${workflow.plan_revision}`, workflow.id, mockPlan);
      const conflictReq: MergeConflictRequest = {
        id: "mcr-1",
        workflow_id: workflow.id,
        run_id: run.id,
        plan_revision: 1,
        plan_hash: "hash-001",
        common_dir: testDir,
        repo_id: "repo-1",
        worktree_root: testDir,
        status: "pending",
        conflict_paths: ["src/app.ts"],
        source_commit: "commit-a",
        candidate_commit: "commit-b",
        created_at: now(),
        updated_at: now(),
      };

      let capturedMaterials: any = null;
      vi.spyOn(runtime as any, "invoke").mockImplementation(
        async (_w: any, _r: any, mat: any) => {
          capturedMaterials = mat;
          return {
            receipt: {
              request_id: conflictReq.id,
              workflow_id: workflow.id,
              run_id: run.id,
              status: "resolved",
              source_commit: conflictReq.source_commit,
              candidate_commit: conflictReq.candidate_commit,
              resolved_paths: ["src/app.ts"],
              unresolved_paths: [],
              conflict_paths: ["src/app.ts"],
              affected_modules: ["m1"],
              resolution_summary: "解决成功",
              reported_function_impact: "none",
            },
          };
        },
      );

      const receipt = await runtime.resolveMergeConflict(workflow, run, conflictReq);
      expect(receipt.status).toBe("resolved");
      expect(capturedMaterials).not.toBeNull();

      // 1. instructions 以共享执行边界开头
      expect(capturedMaterials.instructions.startsWith(executionScopeInstructions)).toBe(true);

      // 2. 明确允许且要求完成冲突解决所必需的代码实现
      expect(capturedMaterials.instructions).toContain("解决冲突所必需的接线与调整");
      expect(capturedMaterials.instructions).toContain("主动补齐");
      expect(capturedMaterials.instructions).toContain("严格在原批准计划和正式整改范围内解决冲突");

      // 3. 不包含审核阶段的只读/不编写实现代码要求
      expect(capturedMaterials.instructions).not.toContain("只读");
      expect(capturedMaterials.instructions).not.toContain("不编写实现代码");
      expect(capturedMaterials.instructions).not.toContain("仅查阅直接支撑结论的最小证据集");
    });

    it("RT10: intent_clarification 仅表示意图澄清，不包含实现边界侵入", () => {
      // 1. 意图澄清指令仅为补充意图，不包含实现或修改代码职责
      expect(INTENT_CLARIFICATION_INSTRUCTION).toBe("请补充刚才这轮的结果意图");
      expect(INTENT_CLARIFICATION_INSTRUCTION).not.toContain("修改代码");
      expect(INTENT_CLARIFICATION_INSTRUCTION).not.toContain("实现");
      expect(INTENT_CLARIFICATION_INSTRUCTION).not.toContain("测试");

      const clarificationPrompt = invokePrompt(
        "execute",
        "/path/to/handoff.json",
        "/path/to/schema.json",
        {
          kind: "intent_clarification",
          source_run_id: "run-1",
          purpose: "execute",
          role: "executor",
        },
      );
      expect(clarificationPrompt).toContain("请补充刚才这轮的结果意图");

      // 2. 执行分支的 prompt 明确说明不从意图澄清/历史材料继承任何“证明未完成”待办
      const execPrompt = invokePrompt(
        "execute",
        "/path/to/handoff.json",
        "/path/to/schema.json",
      );
      expect(execPrompt).toContain("不将历史证明要求自动继承为新待办");
      expect(execPrompt).toContain("历史材料只作为背景，不自动产生新的流程或证明任务");
      expect(executionScopeInstructions).toContain("不因进入整改文档而取得执行权限");
    });
  });
});
