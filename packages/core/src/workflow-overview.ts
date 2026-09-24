import { createHash } from "node:crypto";
import type { Store } from "../../store/src/store.js";
import {
  WorkflowOverviewViewSchema,
  type WorkflowOverviewView,
  type TextSection,
  type FindingView,
  type OverviewTaskView,
  type OverviewTestView,
  type ProgressView,
  type PlanApprovalRecordV2,
} from "../../contracts/src/index.js";

/**
 * 从 Markdown 文本中按二级/三级标题提取章节内容（确定性行级解析，不捏造内容）
 */
export function extractMarkdownSection(
  markdown: string | undefined | null,
  keywords: string[],
): { heading: string; body: string; bullets: string[] } | null {
  if (!markdown || !markdown.trim()) return null;
  const lines = markdown.split(/\r?\n/);
  let capturing = false;
  let currentLevel = 0;
  let matchedHeading = "";
  const bodyLines: string[] = [];

  for (const line of lines) {
    const headingMatch = /^(#{1,4})\s+(.+?)\s*$/.exec(line);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const title = headingMatch[2]!.trim();
      if (capturing) {
        if (level <= currentLevel) {
          break;
        }
      } else if (
        keywords.some((kw) => title.toLowerCase().includes(kw.toLowerCase()))
      ) {
        capturing = true;
        currentLevel = level;
        matchedHeading = title;
        continue;
      }
    }
    if (capturing) {
      bodyLines.push(line);
    }
  }

  if (!capturing) return null;
  const rawBody = bodyLines.join("\n").trim();
  if (!rawBody) return null;

  const bullets: string[] = [];
  for (const line of bodyLines) {
    const bulletMatch = /^\s*(?:[-*+]|\d+\.)\s+(.+)$/.exec(line);
    if (bulletMatch) {
      const item = bulletMatch[1]!.trim();
      if (item) bullets.push(item);
    }
  }

  return {
    heading: matchedHeading,
    body: rawBody,
    bullets,
  };
}

function truncateText(text: string, maxLen = 280): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen) + "…";
}

function buildGoalSection(workflow: any, planObj: any, markdown: string): TextSection {
  const designSummary = planObj?.design_ref?.summary?.trim();
  if (designSummary) {
    return {
      status: "available",
      summary: truncateText(designSummary, 320),
      items: [],
      source_ref: `plan:r${workflow.plan_revision ?? 0}:design_ref.summary`,
    };
  }

  const planSummary = planObj?.summary?.trim();
  if (planSummary) {
    return {
      status: "available",
      summary: truncateText(planSummary, 320),
      items: [],
      source_ref: `plan:r${workflow.plan_revision ?? 0}:summary`,
    };
  }

  const mdGoal = extractMarkdownSection(markdown, [
    "背景与目标",
    "任务目标",
    "核心目标",
    "目标",
    "概述",
    "Overview",
    "Goal",
  ]);
  if (mdGoal) {
    return {
      status: "available",
      summary: truncateText(mdGoal.body, 320),
      items: mdGoal.bullets.slice(0, 5),
      source_ref: `plan:r${workflow.plan_revision ?? 0}:section:${mdGoal.heading}`,
    };
  }

  const reqText = (workflow?.request ?? "").trim();
  if (reqText) {
    return {
      status: "unstructured",
      summary: truncateText(reqText, 280),
      items: [],
      source_ref: `workflow:${workflow.id}:request`,
    };
  }

  return {
    status: "missing",
    summary: "尚未提供任务目标说明",
    items: [],
  };
}

function buildBackgroundSection(
  workflow: any,
  planObj: any,
  markdown: string,
): TextSection {
  const items: string[] = [];

  if (planObj?.scope) {
    const scope = planObj.scope;
    if (Array.isArray(scope.allowed_paths) && scope.allowed_paths.length > 0) {
      items.push(
        `允许修改路径范围：${scope.allowed_paths.slice(0, 4).join(", ")}${scope.allowed_paths.length > 4 ? ` 等 ${scope.allowed_paths.length} 处` : ""}`,
      );
    }
    if (scope.allow_dependency_changes === false) {
      items.push("约束：不允许变更外部依赖包");
    }
    if (scope.allow_public_api_changes === false) {
      items.push("约束：保持外部公共 API 兼容");
    }
  }

  const mdBg = extractMarkdownSection(markdown, [
    "背景与约束",
    "背景",
    "边界与约束",
    "约束",
    "限制",
    "范围",
    "Background",
    "Constraints",
  ]);

  if (mdBg) {
    for (const b of mdBg.bullets.slice(0, 5)) {
      if (!items.includes(b)) items.push(b);
    }
    return {
      status: "available",
      summary: truncateText(mdBg.body, 260),
      items: items.slice(0, 6),
      source_ref: `plan:r${workflow.plan_revision ?? 0}:section:${mdBg.heading}`,
    };
  }

  if (items.length > 0) {
    return {
      status: "available",
      summary: items.join("；"),
      items,
      source_ref: `plan:r${workflow.plan_revision ?? 0}:scope`,
    };
  }

  const reqText = (workflow?.request ?? "").trim();
  if (reqText) {
    return {
      status: "unstructured",
      summary: truncateText(reqText, 220),
      items: [],
      source_ref: `workflow:${workflow.id}:request`,
    };
  }

  return {
    status: "missing",
    summary: "当前尚未记录结构化背景与边界约束",
    items: [],
  };
}

function buildFindingsAndUnresolved(
  planObj: any,
  markdown: string,
): { findings: FindingView[]; unresolved: string[] } {
  const findings: FindingView[] = [];
  const unresolved: string[] = [];

  if (Array.isArray(planObj?.unresolved_decisions)) {
    for (const u of planObj.unresolved_decisions) {
      const text = typeof u === "string" ? u : u?.question ?? u?.title ?? "";
      if (text.trim()) unresolved.push(text.trim());
    }
  }

  if (Array.isArray(planObj?.decisions)) {
    planObj.decisions.forEach((d: any, idx: number) => {
      const title =
        typeof d === "string"
          ? d
          : d?.decision ?? d?.title ?? d?.summary ?? "";
      const desc = typeof d === "object" ? d?.rationale ?? d?.reason : undefined;
      if (title.trim()) {
        findings.push({
          id: `decision-${idx + 1}`,
          title: title.trim(),
          status: "confirmed",
          description: desc ? truncateText(String(desc), 160) : undefined,
        });
      }
    });
  }

  const mdResearch = extractMarkdownSection(markdown, [
    "调研结论",
    "调研结果",
    "关键发现",
    "技术方案",
    "技术决策",
    "Research",
    "Findings",
  ]);
  if (mdResearch) {
    const sourceBullets =
      mdResearch.bullets.length > 0
        ? mdResearch.bullets
        : [truncateText(mdResearch.body, 200)];
    sourceBullets.slice(0, 6).forEach((item, idx) => {
      if (!findings.some((f) => f.title === item)) {
        findings.push({
          id: `finding-${idx + 1}`,
          title: item,
          status: "confirmed",
        });
      }
    });
  }

  return { findings, unresolved };
}

function normalizeTaskStatus(
  rawStatus?: string,
): "pending" | "in_progress" | "completed" | "blocked" {
  if (!rawStatus) return "pending";
  const s = rawStatus.toLowerCase();
  if (
    s === "completed" ||
    s === "done" ||
    s === "passed" ||
    s === "verified" ||
    s === "delivered"
  ) {
    return "completed";
  }
  if (s === "blocked" || s === "failed" || s === "error") {
    return "blocked";
  }
  if (
    s === "in_progress" ||
    s === "running" ||
    s === "active" ||
    s === "started" ||
    s === "implementing"
  ) {
    return "in_progress";
  }
  return "pending";
}

const TASK_SORT_WEIGHT: Record<OverviewTaskView["status"], number> = {
  blocked: 0,
  in_progress: 1,
  pending: 2,
  completed: 3,
};

function buildTasks(detail: any, planObj: any): OverviewTaskView[] {
  const result: OverviewTaskView[] = [];
  const rawTasks = Array.isArray(detail?.tasks) ? detail.tasks : [];

  if (rawTasks.length > 0) {
    rawTasks.forEach((t: any, idx: number) => {
      const id = String(t.id ?? t.work_item_id ?? `task-${idx + 1}`);
      const title = String(t.title ?? t.name ?? t.description ?? id).trim();
      const status = normalizeTaskStatus(
        t.status ?? (t.completed ? "completed" : t.started ? "in_progress" : "pending"),
      );
      result.push({
        id,
        title,
        status,
        source:
          planObj?.task_model === "native-v2" ? "native_work_item" : "plan_task",
      });
    });
  } else if (Array.isArray(planObj?.work_items) && planObj.work_items.length > 0) {
    planObj.work_items.forEach((w: any, idx: number) => {
      result.push({
        id: String(w.id ?? `wi-${idx + 1}`),
        title: String(w.title ?? w.name ?? w.goal ?? `任务 ${idx + 1}`).trim(),
        status: normalizeTaskStatus(w.status),
        source: "native_work_item",
      });
    });
  } else if (Array.isArray(planObj?.tasks) && planObj.tasks.length > 0) {
    planObj.tasks.forEach((t: any, idx: number) => {
      result.push({
        id: String(t.id ?? `pt-${idx + 1}`),
        title: String(t.title ?? t.name ?? `任务 ${idx + 1}`).trim(),
        status: normalizeTaskStatus(t.status),
        source: "plan_task",
      });
    });
  }

  // 排序：blocked -> in_progress -> pending -> completed，保持原顺序稳定
  return result
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const diff =
        TASK_SORT_WEIGHT[a.item.status] - TASK_SORT_WEIGHT[b.item.status];
      return diff !== 0 ? diff : a.index - b.index;
    })
    .map((entry) => entry.item);
}

const TEST_SORT_WEIGHT: Record<OverviewTestView["status"], number> = {
  failed: 0,
  stale: 1,
  pending: 2,
  passed: 3,
};

function buildTests(
  detail: any,
  planObj: any,
  workflow: any,
): OverviewTestView[] {
  const result: OverviewTestView[] = [];
  const currentRev = workflow?.plan_revision ?? 0;
  const evidences = Array.isArray(detail?.evidence) ? detail.evidence : [];

  const resolveItemStatus = (itemId: string): OverviewTestView["status"] => {
    const matching = evidences.filter(
      (e: any) =>
        e.acceptance_item_id === itemId ||
        e.test_id === itemId ||
        e.item_id === itemId,
    );
    if (matching.length === 0) return "pending";
    const sameRev = matching.filter(
      (e: any) =>
        e.plan_revision === undefined || e.plan_revision === currentRev,
    );
    if (sameRev.length === 0) {
      return matching.some((e: any) => e.passed || e.status === "passed")
        ? "stale"
        : "pending";
    }
    const latest = sameRev[sameRev.length - 1];
    if (latest.passed === false || latest.status === "failed") return "failed";
    if (latest.passed === true || latest.status === "passed") return "passed";
    return "pending";
  };

  if (
    Array.isArray(planObj?.acceptance_items) &&
    planObj.acceptance_items.length > 0
  ) {
    planObj.acceptance_items.forEach((acc: any, idx: number) => {
      const id = String(acc.id ?? `acc-${idx + 1}`);
      const scenario = String(
        acc.scenario ?? acc.title ?? acc.description ?? `验收项 ${idx + 1}`,
      ).trim();
      const expected = acc.expected ?? acc.expected_outcome;
      result.push({
        id,
        scenario,
        expected: expected ? String(expected).trim() : undefined,
        status: resolveItemStatus(id),
        source: "native_acceptance",
      });
    });
  } else if (Array.isArray(planObj?.tests) && planObj.tests.length > 0) {
    planObj.tests.forEach((tst: any, idx: number) => {
      const id = String(tst.id ?? `test-${idx + 1}`);
      const scenario = String(
        tst.scenario ?? tst.title ?? tst.name ?? `测试项 ${idx + 1}`,
      ).trim();
      result.push({
        id,
        scenario,
        expected: tst.expected ? String(tst.expected).trim() : undefined,
        status: resolveItemStatus(id),
        source: "plan_test",
      });
    });
  }

  return result
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const diff =
        TEST_SORT_WEIGHT[a.item.status] - TEST_SORT_WEIGHT[b.item.status];
      return diff !== 0 ? diff : a.index - b.index;
    })
    .map((entry) => entry.item);
}

function buildTaskProgress(tasks: OverviewTaskView[]): ProgressView | null {
  if (tasks.length === 0) return null;
  const total = tasks.length;
  const completed = tasks.filter((t) => t.status === "completed").length;
  const inProgress = tasks.filter((t) => t.status === "in_progress").length;
  const blocked = tasks.filter((t) => t.status === "blocked").length;
  const percentage = Math.min(100, Math.max(0, Math.round((completed / total) * 100)));
  return {
    total,
    completed,
    in_progress: inProgress,
    failed_or_blocked: blocked,
    percentage,
  };
}

function buildTestProgress(tests: OverviewTestView[]): ProgressView | null {
  if (tests.length === 0) return null;
  const total = tests.length;
  const passed = tests.filter((t) => t.status === "passed").length;
  const failed = tests.filter((t) => t.status === "failed").length;
  const percentage = Math.min(100, Math.max(0, Math.round((passed / total) * 100)));
  return {
    total,
    completed: passed,
    failed_or_blocked: failed,
    percentage,
  };
}

function resolveExecutionConstraints(
  workflow: any,
  store?: Store,
): WorkflowOverviewView["execution_constraints"] {
  if (!workflow?.id || !workflow?.plan_revision) return null;
  if (!store) return null;

  const key = `${workflow.id}:${workflow.plan_revision}`;
  const approval = store.get<PlanApprovalRecordV2>("plan_approval", key);
  if (
    approval &&
    approval.workflow_id === workflow.id &&
    approval.plan_revision === workflow.plan_revision &&
    approval.execution_instructions &&
    approval.execution_instructions.text.trim().length > 0
  ) {
    return {
      approval_id: key,
      text: approval.execution_instructions.text,
      text_hash: approval.execution_instructions.text_hash,
    };
  }
  return null;
}

export function projectWorkflowOverview(
  detail: any,
  store?: Store,
): WorkflowOverviewView {
  const workflow = detail?.workflow ?? {};
  const workflowId = String(workflow.id ?? "unknown");
  const planRevision = Number(workflow.plan_revision ?? 0);
  const planHash = workflow.plan_hash ?? null;

  const planObj = detail?.plan?.plan ?? detail?.plan ?? null;
  const markdown = String(planObj?.markdown ?? "");

  const goal = buildGoalSection(workflow, planObj, markdown);
  const background = buildBackgroundSection(workflow, planObj, markdown);
  const { findings, unresolved } = buildFindingsAndUnresolved(
    planObj,
    markdown,
  );
  const tasks = buildTasks(detail, planObj);
  const tests = buildTests(detail, planObj, workflow);

  const taskProgress = buildTaskProgress(tasks);
  const testProgress = buildTestProgress(tests);
  const executionConstraints = resolveExecutionConstraints(workflow, store);

  const revDigest = createHash("sha1")
    .update(
      JSON.stringify({
        v: workflow.version,
        pr: planRevision,
        ph: planHash,
        tp: taskProgress,
        tep: testProgress,
        ec: executionConstraints?.text_hash ?? null,
      }),
    )
    .digest("hex")
    .slice(0, 12);

  const view: WorkflowOverviewView = {
    schema_version: 1,
    workflow_id: workflowId,
    plan_revision: planRevision,
    plan_hash: planHash,
    view_revision: `ov-${planRevision}-${revDigest}`,
    goal,
    background,
    findings,
    unresolved,
    tasks,
    tests,
    progress: {
      tasks: taskProgress,
      tests: testProgress,
    },
    execution_constraints: executionConstraints,
  };

  return WorkflowOverviewViewSchema.parse(view);
}
