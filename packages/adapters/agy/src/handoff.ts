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
  "E2E 覆盖新需求全部业务流程，以及真实差异、上下游和共享依赖影响的旧功能回归。" +
  "Web E2E 必须用真实浏览器连接真实应用、后端和测试数据；仅 API、jsdom、截图或整链路 mock 不算完整 E2E。" +
  "仍保留用户功能确认。诚实报告真实测试情况；跳过、零用例、恒真断言和旧报告不能算通过。平台不核验测试证明。";

export function containerHandoffFiles(directory: string) {
  return {
    json: join(directory, "handoff.json"),
    markdown: join(directory, "HANDOFF.md"),
    plans: join(directory, "AUTHORITATIVE_PLANS.json"),
  };
}

export function nativeLaunchInstruction(
  directory: string,
  kind: "full" | "resume" = "full",
) {
  const files = containerHandoffFiles(directory);
  if (kind === "resume")
    return (
      "会话恢复：请完整查看 " +
      files.json +
      " 中的全部反馈与未完成说明。" +
      "定位当前失败目标及受影响代码，修复后先重跑该目标，再由负责的子 Agent 并行运行独立的受影响回归目标并说明结果。"
    );
  return (
    "原生开发模式：请先阅读工作包 " +
    files.markdown +
    " 与 " +
    files.json +
    "。使用客户端原生工具完成批准范围内全部实现和测试代码，再逐个运行明确指定的测试目标。完成后说明本轮结果，直接交代码审查。"
  );
}

function fullHandoffInstructions(directory: string) {
  const files = containerHandoffFiles(directory);
  return (
    "原生开发模式：请使用原生文件查看工具阅读 " +
    files.markdown +
    " 完整设计与验收要求；" +
    "在工作区使用客户端原生工具完成批准范围内全部实现和测试代码，再逐个运行明确指定的测试目标；" +
    "完成后说明本轮结果，直接交代码审查。报告可附，不为调用 ID、清单或 hash 重跑测试。" +
    "只能执行规划模型正式批准的计划，禁止另建 implementation_plan.md 或工具内计划作为替代执行依据。" +
    nativeTestingInstructions
  );
}

function resumeHandoffInstructions(directory: string) {
  const files = containerHandoffFiles(directory);
  return (
    "会话恢复：本轮续接历史执行会话，先完整核查 " +
    files.json +
    " 中全部反馈与未完成说明的根因及影响。" +
    "定位当前失败目标及受影响代码，修复后先重跑该目标，再由负责的子 Agent 并行运行独立的受影响回归目标并说明结果。" +
    "原始计划和正式整改计划是唯一依据，禁止另建或改写替代执行计划；发现设计冲突应上报规划模型。" +
    nativeTestingInstructions
  );
}

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
  authoritative_plans_file?: string;
}

function workspaceInfos(
  plan: Plan,
  workspaces: (Workspace | HandoffWorkspaceInfo)[],
): HandoffWorkspaceInfo[] {
  return workspaces.map((w) => ({
    repo_id: w.repo_id,
    root: w.root,
    baseline: "baseline" in w ? w.baseline : undefined,
    allowed_paths:
      plan.scope?.repository_paths?.[w.repo_id] ?? plan.scope?.allowed_paths,
  }));
}

function workflowSummary(workflow: Workflow) {
  return {
    id: workflow.id,
    project_id: workflow.project_id,
    title: workflow.title,
    request: workflow.request,
    state: workflow.state,
    stage: workflow.stage,
  };
}

function planIndex(plan: Plan) {
  return {
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
  };
}

export class HandoffBuilder {
  static buildFullHandoff(options: {
    workflow: Workflow;
    plan: Plan;
    runId: string;
    packageHash: string;
    directory: string;
    workspaces?: (Workspace | HandoffWorkspaceInfo)[];
  }): HandoffPackage {
    const { workflow, plan, runId, packageHash, workspaces = [] } = options;
    const files = containerHandoffFiles(options.directory);
    return {
      mode: "full",
      workflow_id: workflow.id,
      run_id: runId,
      plan_revision: workflow.plan_revision,
      plan_hash: workflow.plan_hash,
      package_hash: packageHash,
      workspaces: workspaceInfos(plan, workspaces),
      workflow: workflowSummary(workflow),
      index: planIndex(plan),
      test_exemptions: plan.exemptions,
      design_file: files.markdown,
      feedback: workflow.feedback,
      instructions: fullHandoffInstructions(options.directory),
    };
  }

  static buildResumeHandoff(options: {
    workflow: Workflow;
    plan: Plan;
    runId: string;
    conversationId: string;
    packageHash: string;
    directory: string;
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
    const files = containerHandoffFiles(options.directory);
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
      workspaces: workspaceInfos(plan, workspaces),
      workflow: workflowSummary(workflow),
      index: planIndex(plan),
      test_exemptions: plan.exemptions,
      design_file: files.markdown,
      feedback: workflow.feedback,
      delivery_issues: openIssues,
      instructions: resumeHandoffInstructions(options.directory),
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
