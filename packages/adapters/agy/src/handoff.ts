import { atomicWrite } from "../../../core/src/util.js";
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
}

export class HandoffBuilder {
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
        "在工作区使用客户端原生工具（编辑、终端、运行测试等）连续完成实现并调试；" +
        "所有必需验收场景自测通过后，组装交付清单并提交终局核验。" +
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
        "会话恢复：本轮续接历史执行会话，重点根据核验反馈与 delivery_issues 进行针对性修复；" +
        "补齐失效或未通过的测试后重新提交交付清单。" +
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
