import { failureSummary } from "./failure.js";
export interface LogEntry {
  key: string;
  sequence: number;
  created_at: string;
  title: string;
  text: string;
  raw: unknown[];
  kind?: "message" | "tool" | "event" | "diagnostic";
  status?: "active" | "done" | "error" | "interrupted";
}
/** Reconcile HTTP snapshots with live events without losing newer streamed output. */
export function mergeEvents(workflow: string, ...batches: any[][]): any[] {
  const events = new Map<number, any>();
  for (const batch of batches)
    for (const event of batch)
      if (event.workflow_id === workflow) events.set(event.event_seq, event);
  const all = [...events.values()].sort((a, b) => a.event_seq - b.event_seq);
  const important = all
    .filter(
      (e) =>
        ![
          "AgentEvent",
          "ServiceOutput",
          "FixtureOutput",
          "CheckOutput",
          "BuildOutput",
        ].includes(e.type),
    )
    .slice(-500);
  const keep = new Set(
    [...all.slice(-4500), ...important].map((e) => e.event_seq),
  );
  return all.filter((e) => keep.has(e.event_seq));
}
const pretty = (value: unknown): string => {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2) ?? "";
};
const object = (v: any): any => {
  if (typeof v !== "string") return v ?? {};
  try {
    return JSON.parse(v);
  } catch {
    return {};
  }
};
const toolLabels: Record<string, string> = {
  devflow_read_file: "读取文件",
  devflow_search: "搜索源码",
  devflow_list_files: "查看目录",
  devflow_apply_patch: "修改文件",
  devflow_claim_task: "提交任务结果",
  devflow_start_task: "开始细项任务",
  devflow_run_check: "运行测试",
  devflow_freeze: "冻结代码并准备测试",
  devflow_context: "读取任务上下文",
  devflow_browser: "浏览器验收",
  devflow_get_context: "读取任务上下文",
  devflow_search_files: "搜索源码",
  devflow_apply_files: "修改文件",
  devflow_execute_context: "读取已批准计划",
  devflow_finish: "提交执行结果",
};
export const stages = [
  "调研计划",
  "人工批准",
  "开发实施",
  "自动测试",
  "人工验收",
  "代码复核",
  "本地提交",
];
const stageIndex: Record<string, number> = {
  RESEARCHING: 0,
  PLANNING: 0,
  REPAIR_RESEARCH_REQUIRED: 0,
  PLAN_PENDING: 1,
  REPAIR_PLAN_PENDING: 1,
  QUEUED: 2,
  EXECUTING: 2,
  VERIFYING: 3,
  HUMAN_PENDING: 4,
  REVIEW_QUEUED: 5,
  REVIEWING: 5,
  COMMITTING: 6,
  COMMITTED: 6,
  INTEGRATING: 6,
  CLEANUP_PENDING: 6,
  COMPLETED: 6,
  COMMIT_PARTIAL: 6,
};
export function workflowProgress(w: any, events: any[]) {
  const completed = ["COMMITTED", "COMPLETED"].includes(w.state);
  const paused = [
    "BLOCKED",
    "STOPPED",
    "STOPPING",
    "RECOVERY_REQUIRED",
    "COMMIT_PARTIAL",
    "WAITING_AUTHORIZATION",
    "WAITING_INPUT",
  ].includes(w.state);
  const transitions = events
    .filter((e) => e.workflow_id === w.id && e.type === "StateChanged")
    .sort((a, b) => a.event_seq - b.event_seq);
  let state = w.state;
  if (stageIndex[state] === undefined) {
    for (const e of transitions.slice().reverse()) {
      const candidate = [e.payload?.to, e.payload?.from].find(
        (s) => stageIndex[s] !== undefined,
      );
      if (candidate) {
        state = candidate;
        break;
      }
    }
  }
  const index = stageIndex[state];
  const next: Record<string, string> = {
    RESEARCHING: "等待调研和计划完成",
    PLANNING: "规划模型正在读取需求和引用文件",
    INTEGRATING: "吸收主分支变更并验证新候选后合回",
    CLEANUP_PENDING: "提交整合已完成，等待清理自有工作树和临时分支",
    COMPLETED: "整合交付及清理完成，发布由你另行通知",
    PLAN_PENDING: "阅读计划后点击批准",
    REPAIR_PLAN_PENDING: "阅读修复计划后点击批准",
    QUEUED: "等待可用执行资源",
    EXECUTING: "执行模型正在实施，完成后自动进入测试",
    VERIFYING: "核验交付后进行原计划自查及质量审查",
    HUMAN_PENDING: "打开测试环境，实际操作后确认验收或反馈问题",
    REVIEW_QUEUED: "等待独立复核启动",
    REVIEWING: "复核通过后自动提交；发现问题会生成修复计划",
    COMMITTING: "等待本地提交完成",
    COMMITTED: "本次工作已提交，发布由你另行通知",
  };
  return {
    index,
    paused,
    completed,
    title: completed
      ? "已完成本地提交"
      : index === undefined
        ? "等待确认阶段"
        : stages[index],
    next: paused
      ? "处理下方问题后，点击“继续这个任务”；保留已有计划和修改，重新核验完成证据。"
      : (next[w.state] ?? "等待工作流更新"),
  };
}
/** The original events stay intact; this is only a readable, scoped projection. */
export function readableLogs(events: any[], workflow: string): LogEntry[] {
  const rows: LogEntry[] = [],
    steps = new Map<string, LogEntry>();
  const unique = new Map<number, any>();
  for (const e of events)
    if (e.workflow_id === workflow && !unique.has(e.event_seq))
      unique.set(e.event_seq, e);
  for (const e of [...unique.values()].sort(
    (a, b) => a.event_seq - b.event_seq,
  )) {
    const p = e.payload ?? {},
      step = p.step_update;
    const lifecycle: Record<string, string> = {
      AuthorizationRequested: "等待操作授权",
      AuthorizationDecided: "已收到授权决定",
      UserGuidance: "收到你的指导",
      RepairScheduled: "执行模型自动修复",
      DiagnosisStarted: "规划模型正在诊断",
      DiagnosisCompleted: "规划诊断完成",
      DiagnosisRetrying: "正在重新发起诊断",
      DiagnosisDeferred: "执行模型继续排查",
      PreparationStarted: "准备任务工作区",
      ServiceExited: "服务运行中退出",
      OperationCompleted: "授权操作已结束",
      ResourceWaiting: "等待共享资源",
      ModelRetryScheduled: "等待模型额度恢复",
      ModelRetryStarted: "额度恢复后继续执行",
      ImplementationReconciled: "已有实现已核对",
    };
    if (lifecycle[e.type]) {
      rows.push({
        key: `${workflow}:${e.event_seq}`,
        sequence: e.event_seq,
        created_at: e.created_at,
        title: lifecycle[e.type]!,
        text:
          e.type === "RepairScheduled"
            ? failureSummary(p.code, p.message ?? "")
            : e.type === "DiagnosisCompleted"
              ? "已获得故障原因和修复步骤，执行模型将继续处理。"
              : (p.message ??
                p.text ??
                p.instructions ??
                p.operation?.reason ??
                p.diagnosis ??
                (p.approved === true
                  ? "用户批准本次操作"
                  : p.approved === false
                    ? "用户拒绝本次操作"
                    : "")),
        raw: [e],
        kind: "message",
      });
      continue;
    }
    if (
      [
        "ServiceOutput",
        "FixtureOutput",
        "CheckOutput",
        "BuildOutput",
        "OperationOutput",
        "DiagnosisOutput",
      ].includes(e.type)
    ) {
      if (typeof p.text !== "string" || !p.text.trim()) continue;
      const key = [
        workflow,
        e.run_id ?? "legacy",
        e.type,
        p.process_id ?? p.service_id ?? p.test_id ?? "fixture",
      ].join(":");
      let row = steps.get(key);
      if (!row) {
        row = {
          key,
          sequence: e.event_seq,
          created_at: e.created_at,
          title:
            e.type === "ServiceOutput"
              ? `服务日志 · ${p.service_id ?? "服务"}`
              : e.type === "BuildOutput"
                ? "构建日志"
                : e.type === "FixtureOutput"
                  ? "测试数据日志"
                  : `测试日志 · ${p.test_id ?? "检查"}`,
          text: "",
          raw: [],
          kind: "diagnostic",
        };
        rows.push(row);
        steps.set(key, row);
      }
      row.text = (row.text + p.text).slice(-16000);
      row.raw.push(e);
      row.raw = row.raw.slice(-100);
      continue;
    }
    if (
      [
        "ServiceStarting",
        "ServiceReady",
        "FixtureStarted",
        "FixtureReady",
        "CheckStarted",
        "CheckCompleted",
      ].includes(e.type)
    ) {
      const key = [
        workflow,
        e.run_id,
        e.type.startsWith("Service")
          ? "service"
          : e.type.startsWith("Fixture")
            ? "fixture"
            : "check",
        p.process_id ?? p.service_id ?? p.test_id ?? "data",
      ].join(":");
      let row = steps.get(key);
      if (!row) {
        row = {
          key,
          sequence: e.event_seq,
          created_at: e.created_at,
          title: "",
          text: "",
          raw: [],
          kind: "event",
        };
        rows.push(row);
        steps.set(key, row);
      }
      row.raw.push(e);
      row.sequence = e.event_seq;
      row.created_at = e.created_at;
      row.status = e.type.endsWith("Ready")
        ? "done"
        : e.type === "CheckCompleted"
          ? p.status === "passed"
            ? "done"
            : "error"
          : "active";
      row.title = e.type.startsWith("Service")
        ? `${p.label ?? "服务"}${e.type === "ServiceReady" ? "已就绪" : "正在启动"}`
        : e.type.startsWith("Fixture")
          ? e.type === "FixtureReady"
            ? "数据准备脚本已结束"
            : "正在准备测试数据"
          : e.type === "CheckCompleted"
            ? p.status === "passed"
              ? "测试通过"
              : "测试失败"
            : "正在测试";
      row.text = p.test_id
        ? `${p.test_id}${p.discovered !== undefined ? ` · 通过 ${p.passed} / ${p.discovered}` : ""}`
        : (p.origin ?? "");
      continue;
    }
    if (e.type === "AgentEvent" && p.event === "step_update" && step) {
      if (!["tool", "agent_response"].includes(step.step_type)) continue;
      const key = [
        workflow,
        e.run_id ?? step.conversation_id,
        step.step_index,
      ].join(":");
      let row = steps.get(key);
      if (!row) {
        row = {
          key,
          sequence: e.event_seq,
          created_at: e.created_at,
          title: "Gemini 步骤",
          text: "",
          raw: [],
        };
        rows.push(row);
        steps.set(key, row);
      }
      row.raw.push(e);
      row.sequence = e.event_seq;
      row.created_at = e.created_at;
      const status = step.state === "DONE" ? "完成" : "进行中";
      row.status = step.state === "DONE" ? "done" : "active";
      if (step.step_type === "tool") {
        const tool = step.tool_info;
        const previous = row.raw
          .map((r: any) => r.payload?.step_update?.tool_info)
          .filter(Boolean);
        const parameters = Object.assign(
          {},
          ...previous.map((t: any) => object(t.parameters)),
          object(tool?.parameters),
        );
        const name = parameters.ToolName ?? step.tool_name;
        const args = object(parameters.Arguments ?? parameters);
        row.kind = "tool";
        row.title = toolLabels[name] ?? "执行工具操作";
        const target =
          args.path ?? args.test_id ?? args.task_id ?? args.section;
        row.text = typeof target === "string" ? target.slice(0, 240) : "";
        if (name === "devflow_search_files" || name === "devflow_search")
          row.text = "查找与当前任务相关的源码";
        if (Array.isArray(args.changes))
          row.text = args.changes
            .map((f: any) => f.path)
            .filter(Boolean)
            .join("、")
            .slice(0, 240);
        if (step.state === "ERROR" || object(tool?.output).isError === true)
          row.status = "error";
      } else {
        row.kind = "message";
        row.title =
          step.step_type === "agent_response"
            ? `Gemini 输出 · ${status}`
            : `收到任务 · ${status}`;
        if (typeof step.text_delta === "string") row.text += step.text_delta;
      }
      continue;
    }
    if (e.type === "AgentEvent" && !["init", "result"].includes(p.event))
      continue;
    let title = e.type,
      text = typeof p.text === "string" ? p.text : pretty(p);
    if (e.type === "AgentEvent" && p.event === "result") {
      title = "Gemini 执行结果";
      text = p.result?.response ?? pretty(p.result);
    }
    if (e.type === "AgentEvent" && p.event === "init") {
      title = "模型已启动";
      text = `执行模型：${p.init?.model}`;
    }
    if (e.type === "StateChanged") {
      if (p.to === "BLOCKED") {
        title = "执行暂停";
        text = p.blocker?.message ?? "执行已暂停，等待处理";
      } else if (p.to === "COMMITTED") {
        title = "本地提交完成";
        text = "已生成本地提交记录，所有交付检查与复核已全部通过";
      } else if (p.to === "COMMITTING") {
        title = "正在本地提交";
        text = "正在执行本地提交操作并生成 Git 提交记录";
      } else {
        title = "阶段更新";
        text =
          stageIndex[p.to] === undefined
            ? "执行已暂停，等待处理"
            : `进入${stages[stageIndex[p.to]!]}`;
      }
    }
    if (e.type === "TaskClaimed") {
      title = "实现结果已提交";
      text = p.summary ?? p.title ?? p.task_id ?? "";
    }
    if (e.type === "EvidenceInvalidated") continue;
    if (e.type === "CheckOutput") title = "测试输出";
    if (e.type === "FilesChanged") {
      title = "已修改文件";
      text = (p.paths ?? []).join("、");
    }
    if (e.type === "CheckCompleted") {
      title = p.status === "passed" ? "测试通过" : "测试未通过";
      text = p.test_id ?? "";
    }
    if (e.type === "TaskStarted" || e.type === "TaskCompleted") {
      title = e.type === "TaskStarted" ? "正在实施" : "实现检查已通过 · 待测试";
      text = p.summary ?? p.title ?? p.task_id;
    }
    if (e.type === "EnvironmentFailed") {
      title = "本机验证副本准备失败";
      text = failureSummary("ENVIRONMENT_FAILED", p.message);
    }
    if (["BuildStarted", "BuildReady", "BuildFailed"].includes(e.type)) {
      title =
        e.type === "BuildStarted"
          ? "正在构建"
          : e.type === "BuildReady"
            ? "构建通过"
            : "构建失败，需要修复";
      text =
        e.type === "BuildFailed"
          ? failureSummary("BUILD_FAILED", p.message)
          : p.message;
    }
    if (e.type === "Stopped") {
      title = "执行已暂停";
      text =
        p.message ??
        (p.agent_stopped || p.source === "local_console"
          ? "你在控制台暂停了执行"
          : "执行已暂停，等待处理");
    }
    if (e.type === "ProcessesReconciled") {
      title = "任务已恢复";
      text = "";
    }
    if (e.type === "AgentDiagnostic") {
      if (!text.trim()) continue;
      title = "执行器提示";
    }
    if (e.type === "WorkflowCreated") {
      title = "任务已创建";
      text = "开始调研与制定计划";
    }
    if (
      e.type !== "AgentEvent" &&
      ![
        "TaskStarted",
        "TaskCompleted",
        "EnvironmentFailed",
        "BuildStarted",
        "BuildReady",
        "BuildFailed",
        "Stopped",
        "ProcessesReconciled",
        "StateChanged",
        "TaskClaimed",
        "EvidenceInvalidated",
        "CheckOutput",
        "CheckCompleted",
        "FilesChanged",
        "AgentDiagnostic",
        "WorkflowCreated",
      ].includes(e.type)
    ) {
      continue;
    }
    rows.push({
      key: "event:" + e.event_seq,
      sequence: e.event_seq,
      created_at: e.created_at,
      title,
      text,
      raw: [e],
      kind: "event",
      status:
        e.type === "EnvironmentFailed" ||
        e.type === "BuildFailed" ||
        (e.type === "StateChanged" && p.to === "BLOCKED")
          ? "error"
          : e.type === "StateChanged" && p.to === "COMMITTED"
            ? "done"
            : undefined,
    });
  }
  // Old runs must not continue to look active after a stop/failure or a new run.
  const boundary =
    [...unique.values()]
      .filter(
        (e) =>
          e.type === "StateChanged" &&
          ["BLOCKED", "STOPPED", "STOPPING", "RECOVERY_REQUIRED"].includes(
            e.payload?.to,
          ),
      )
      .at(-1)?.event_seq ?? -1;
  for (const row of rows)
    if (row.status === "active" && row.sequence < boundary)
      row.status = "interrupted";
  return rows
    .filter((r) => r.kind !== "message" || r.text.trim())
    .sort((a, b) => a.sequence - b.sequence);
}
