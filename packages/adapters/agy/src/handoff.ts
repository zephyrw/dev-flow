import type { PlanSelfCheckRequest } from "../../../contracts/src/plan-self-check.js";
import { atomicWrite } from "../../../core/src/util.js";
import { batchExecutionInstructions } from "../../../core/src/execution-guidance.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveTaskModel,
  type Workflow,
  type Plan,
  type DeliveryIssue,
  type Workspace,
} from "../../../contracts/src/index.js";

const nativeTestingInstructions =
  batchExecutionInstructions +
  "测试采用单元、集成、E2E 三层，仅 test_exemptions 中已批准的不适用项可豁免。" +
  "E2E 覆盖新需求全部业务流程，以及真实差异、上下游和共享依赖影响的旧功能回归；" +
  "将需求/受影响旧功能、影响依据、场景 ID、步骤、断言和实际用例逐项映射。" +
  "Web E2E 必须用真实浏览器连接真实应用、后端和测试数据；仅 API、jsdom、截图或整链路 mock 不算完整 E2E。" +
  "浏览器操作已包含在 E2E，不另设 OpenTabs/真实浏览器验收层，仍保留用户功能确认。" +
  "用户反馈修复需补缺陷回归，并按代码和环境变化重跑失效测试；交付保留真实执行记录、原始报告及 acceptance_mappings，跳过、零用例、恒真断言和旧报告不能算通过。";

export interface HandoffWorkspaceInfo {
  repo_id: string;
  root: string;
  baseline?: string;
  allowed_paths?: string[];
}

export interface HandoffPackage {
  mode: "full" | "resume";
  workflow_id: string;
  run_id: string;
  conversation_id?: string;
  plan_revision: number;
  plan_hash?: string;
  package_hash: string;
  workspaces: HandoffWorkspaceInfo[];
  workflow: {
    id: string;
    project_id: string;
    title: string;
    request: string;
    state: string;
    stage: string;
  };
  index: {
    task_model: string;
    modules: { id: string; title: string }[];
    tasks: {
      id: string;
      title: string;
      module_id?: string;
      requirements: string[];
      depends_on: string[];
      paths: string[];
    }[];
    acceptance_items: {
      id: string;
      layer: string;
      steps: string[];
      assertions: string[];
      expected_case_ids: string[];
    }[];
  };
  test_exemptions: Plan["exemptions"];
  design_file: string;
  design_changed?: boolean;
  feedback?: string[];
  delivery_issues?: DeliveryIssue[];
  instructions: string;
  self_check?: PlanSelfCheckRequest;
  authoritative_plans_file?: string;
  self_check_schema_file?: string;
}

export class HandoffBuilder {
  static buildPlanSelfCheckHandoff(
    options: Parameters<typeof HandoffBuilder.buildFullHandoff>[0] & {
      conversationId?: string;
      request: PlanSelfCheckRequest;
    },
  ): HandoffPackage {
    const pkg = this.buildFullHandoff(options);
    return {
      ...pkg,
      mode: options.conversationId ? "resume" : "full",
      conversation_id: options.conversationId,
      self_check: options.request,
      authoritative_plans_file: "AUTHORITATIVE_PLANS.json",
      self_check_schema_file: "plan-self-check.schema.json",
      instructions:
        "这是程序单独调度的计划逐项复核。必须重新读取 AUTHORITATIVE_PLANS.json 内全部原始计划和正式整改计划，" +
        "先按 self_check.check_ids 完整核对正文、实际代码、所有验收项及受影响旧功能，汇总全部问题及根因，完成整批修复后统一测试；正式变更须引用对应批准修订。" +
        "在当前交付清单的 plan_self_check 内逐项记录真实文件/测试报告/用例定位与整改结果（这是执行记录，不是新计划）。" +
        "禁止创建、改写或采用 implementation_plan.md 等替代计划，禁止把本轮任务缩减为局部补丁。所有问题解决且本轮测试与交付证据通过后才提交。" +
        nativeTestingInstructions,
    };
  }
  static buildFullHandoff(options: {
    workflow: Workflow;
    plan: Plan;
    runId: string;
    packageHash: string;
    workspaces?: (Workspace | HandoffWorkspaceInfo)[];
  }): HandoffPackage {
    const { workflow, plan, runId, packageHash, workspaces = [] } = options;
    const taskModel = resolveTaskModel(plan);
    return {
      mode: "full",
      workflow_id: workflow.id,
      run_id: runId,
      plan_revision: workflow.plan_revision,
      plan_hash: workflow.plan_hash,
      package_hash: packageHash,
      workspaces: workspaces.map((w) => ({
        repo_id: w.repo_id,
        root: w.root,
        baseline: "baseline" in w ? w.baseline : undefined,
        allowed_paths:
          plan.scope?.repository_paths?.[w.repo_id] ??
          plan.scope?.allowed_paths,
      })),
      workflow: {
        id: workflow.id,
        project_id: workflow.project_id,
        title: workflow.title,
        request: workflow.request,
        state: workflow.state,
        stage: workflow.stage,
      },
      index: {
        task_model: taskModel,
        modules: plan.modules ?? [],
        tasks: plan.tasks.map((t) => ({
          id: t.id,
          title: t.title,
          module_id: t.module_id,
          requirements: t.requirements,
          depends_on: t.depends_on,
          paths: t.paths,
        })),
        acceptance_items: plan.tests.map((t) => ({
          id: t.id,
          layer: t.layer,
          steps: t.steps,
          assertions: t.assertions,
          expected_case_ids: t.expected_case_ids,
        })),
      },
      test_exemptions: plan.exemptions,
      design_file: "HANDOFF.md",
      feedback: workflow.feedback,
      instructions:
        "原生开发模式：请使用原生文件查看工具阅读 HANDOFF.md 完整设计与验收要求；" +
        "在工作区使用客户端原生工具完成批准范围内全部实现和测试代码，再统一运行测试；" +
        "所有必需验收场景自测通过后，组装交付清单并提交终局核验。" +
        "只能执行规划模型正式批准的计划，禁止另建 implementation_plan.md 或工具内计划作为替代执行依据。" +
        nativeTestingInstructions,
    };
  }

  static buildResumeHandoff(options: {
    workflow: Workflow;
    plan: Plan;
    runId: string;
    conversationId: string;
    packageHash: string;
    workspaces?: (Workspace | HandoffWorkspaceInfo)[];
    deliveryIssues?: DeliveryIssue[];
  }): HandoffPackage {
    const {
      workflow,
      plan,
      runId,
      conversationId,
      packageHash,
      workspaces = [],
      deliveryIssues,
    } = options;
    // 仅保留 open 状态的未解决问题
    const openIssues = (deliveryIssues ?? []).filter(
      (iss) => iss.status === "open",
    );
    return {
      mode: "resume",
      workflow_id: workflow.id,
      run_id: runId,
      conversation_id: conversationId,
      plan_revision: workflow.plan_revision,
      plan_hash: workflow.plan_hash,
      package_hash: packageHash,
      workspaces: workspaces.map((w) => ({
        repo_id: w.repo_id,
        root: w.root,
        baseline: "baseline" in w ? w.baseline : undefined,
        allowed_paths:
          plan.scope?.repository_paths?.[w.repo_id] ??
          plan.scope?.allowed_paths,
      })),
      workflow: {
        id: workflow.id,
        project_id: workflow.project_id,
        title: workflow.title,
        request: workflow.request,
        state: workflow.state,
        stage: workflow.stage,
      },
      index: {
        task_model: resolveTaskModel(plan),
        modules: plan.modules ?? [],
        tasks: plan.tasks.map((t) => ({
          id: t.id,
          title: t.title,
          module_id: t.module_id,
          requirements: t.requirements,
          depends_on: t.depends_on,
          paths: t.paths,
        })),
        acceptance_items: plan.tests.map((t) => ({
          id: t.id,
          layer: t.layer,
          steps: t.steps,
          assertions: t.assertions,
          expected_case_ids: t.expected_case_ids,
        })),
      },
      test_exemptions: plan.exemptions,
      design_file: "HANDOFF.md",
      feedback: workflow.feedback,
      delivery_issues: openIssues,
      instructions:
        "会话恢复：本轮续接历史执行会话，先完整核查全部核验反馈与 delivery_issues 的根因及影响，再完成整批修复；" +
        "统一运行失效、未通过及必需的回归测试后重新提交交付清单。" +
        "原始计划和正式整改计划是唯一依据，禁止另建或改写替代执行计划；发现设计冲突应上报规划模型。" +
        nativeTestingInstructions,
    };
  }

  static writeHandoffFiles(
    directory: string,
    pkg: HandoffPackage,
    markdown?: string,
  ) {
    atomicWrite(join(directory, "handoff.json"), JSON.stringify(pkg, null, 2));
    if (
      markdown &&
      (!existsSync(join(directory, "HANDOFF.md")) ||
        readFileSync(join(directory, "HANDOFF.md"), "utf8") !== markdown)
    ) {
      atomicWrite(join(directory, "HANDOFF.md"), markdown);
    }
  }
}
