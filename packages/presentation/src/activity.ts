import { failureSummary } from "./failure.js";
import { ReviewActivityStream } from "./review-activity.js";
import { runtimeFailureResolution } from "../../contracts/src/runtime-failure.js";
import { toolSummary, toolOutputSummary } from "./tool-summary.js";
import { conversationActivityLogEntry } from "./conversation-activity.js";
import { CONVERSATION_EVENT } from "../../contracts/src/conversation.js";
export interface LogEntry {
  key: string;
  sequence: number;
  created_at: string;
  title: string;
  text: string;
  raw: unknown[];
  kind?: "message" | "tool" | "event" | "diagnostic";
  status?: "active" | "done" | "error" | "interrupted";
  output?: string;
  resultText?: string;
  command?: string;
  cwd?: string;
}
/** Reconcile HTTP snapshots with live events without losing newer streamed output. */
export function mergeEvents(workflow: string, ...batches: any[][]): any[] {
  const events = new Map<number, any>();
  for (const batch of batches)
    for (const event of batch)
      if (event.workflow_id === workflow && !isAsideRun(event.run_id))
        events.set(event.event_seq, event);
  const all = [...events.values()].sort((a, b) => a.event_seq - b.event_seq);
  const important = all
    .filter(
      (e) =>
        ![
          "AgentEvent",
          "NativeActivity",
          "RunObserved",
          "ConversationActivity",
          "ConversationDiscovered",
          "ConversationUpdated",
          "ConversationControlUpdated",
          "AsideUpdated",
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
export function isAsideRun(runId?: string | null) {
  return typeof runId === "string" && runId.startsWith("aside-run");
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
export function workflowProgress(
  w: any,
  events: any[],
  display: { native?: boolean; humanAccepted?: boolean } = {},
) {
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
  const phase = stageIndex[w.state] === undefined
    ? transitions.slice().reverse().find((e) => e.payload?.to === state)?.payload?.stage ?? w.stage
    : w.stage;
  // These are existing workflow phases, not new transitions or gates.
  const labels = display.native
    ? [...stages.slice(0, 4), "验收前质量审查", "人工验收", "验收后代码复核", "本地提交"]
    : stages;
  const index = display.native
    ? state === "HUMAN_PENDING" ? 5
      : ["REVIEW_QUEUED", "REVIEWING"].includes(state)
        ? phase === "quality_before_human" ? 4 : 6
        : stageIndex[state] === 6 ? 7 : stageIndex[state]
    : stageIndex[state];
  const next: Record<string, string> = {
    RESEARCHING: "等待调研和计划完成",
    PLANNING: "规划模型正在读取需求和引用文件",
    INTEGRATING: "吸收主分支变更并验证新候选后合回",
    CLEANUP_PENDING: "提交整合已完成，等待清理自有工作树和临时分支",
    COMPLETED: "整合交付及清理完成，发布由你另行通知",
    PLAN_PENDING: "阅读计划，可批准、驳回修正或向规划模型提问",
    REPAIR_PLAN_PENDING: "阅读修复计划，可批准、驳回修正或向规划模型提问",
    QUEUED: "等待可用执行资源",
    EXECUTING: "执行模型正在自主开发与自测，完成后进入代码质量审查",
    VERIFYING: "本轮执行已结束，正在交接规划模型审查",
    HUMAN_PENDING: "打开测试环境，实际操作后确认功能或反馈问题",
    REVIEW_QUEUED: "等待代码质量审查启动",
    REVIEWING: "规划模型正在审查代码质量；通过后进入下一阶段",
    COMMITTING: "等待本地提交完成",
    COMMITTED: "本次工作已提交，发布由你另行通知",
  };
  return {
    index,
    stages: labels,
    done: labels.map((label, i) => label === "人工验收"
      ? display.humanAccepted === true
      : completed || i < (index ?? -1)),
    paused,
    completed,
    title: completed
      ? "已完成本地提交"
      : index === undefined
        ? "等待确认阶段"
        : labels[index],
    next: paused
      ? "处理下方问题后，点击“继续这个任务”；保留已有计划和修改，重新核验完成证据。"
      : phase === "quality_before_human" && ["REVIEWING", "REVIEW_QUEUED"].includes(state)
        ? "规划模型审查代码质量与测试结果，通过后进入人工验收"
        : (next[w.state] ?? "等待工作流更新"),
  };
}
/** The original events stay intact; this is only a readable, scoped projection. */
export function readableLogs(events: any[], workflow: string): LogEntry[] {
  const rows: LogEntry[] = [],
    steps = new Map<string, LogEntry>();
  let repairPending = false;
  const reviewStreams = new Map<string, ReviewActivityStream>();
  const unique = new Map<number, any>();
  for (const e of events)
    if (e.workflow_id === workflow && !unique.has(e.event_seq))
      unique.set(e.event_seq, e);
  for (const e of [...unique.values()].sort(
    (a, b) => a.event_seq - b.event_seq,
  )) {
    const p = e.payload ?? {},
      step = p.step_update;
    if (e.type === "RunObserved") continue;
    if (isAsideRun(e.run_id)) continue;
    if (e.type === "NativeActivity") {
      if (!p.id || !["tool", "message", "event"].includes(p.kind)) continue;
      const key = `${workflow}:${e.run_id}:native:${p.id}`;
      let row = steps.get(key);
      if (!row) {
        row = { key, sequence: e.event_seq, created_at: e.created_at, title: p.title, text: "", raw: [] };
        rows.push(row);
        steps.set(key, row);
      }
      Object.assign(row, { sequence: e.event_seq, created_at: e.created_at, title: p.title,
        text: p.text ?? "", kind: p.kind, status: p.status, command: p.command, cwd: p.cwd, resultText: p.resultText, raw: [e] });
      continue;
    }
    if (e.type === CONVERSATION_EVENT.activity) {
      if (isAsideRun(e.run_id)) continue;
      if (p.root_id && p.conversation_id && p.conversation_id !== p.root_id)
        continue;
      const mapped = conversationActivityLogEntry(e);
      if (!mapped) continue;
      let row = steps.get(mapped.key);
      if (!row) {
        rows.push(mapped);
        steps.set(mapped.key, mapped);
      } else {
        Object.assign(row, mapped);
      }
      continue;
    }
    if (
      e.type === CONVERSATION_EVENT.discovered ||
      e.type === CONVERSATION_EVENT.updated ||
      e.type === CONVERSATION_EVENT.controlUpdated ||
      e.type === CONVERSATION_EVENT.asideUpdated
    )
      continue;
    if (e.type === "ReviewDiagnostic") {
      const run = String(e.run_id ?? "unknown");
      const stream = reviewStreams.get(run) ?? new ReviewActivityStream();
      reviewStreams.set(run, stream);
      for (const item of stream.push(String(p.text ?? ""))) {
        const key = `${workflow}:${run}:legacy:${item.id}`;
        let row = steps.get(key);
        if (!row) {
          row = { key, sequence: e.event_seq, created_at: e.created_at, title: item.title, text: "", raw: [] };
          rows.push(row);
          steps.set(key, row);
        }
        Object.assign(row, item, { key, sequence: e.event_seq, created_at: e.created_at, raw: [e] });
      }
      continue;
    }
    const lifecycle: Record<string, string> = {
      AuthorizationRequested: "等待操作授权",
      AuthorizationDecided: "已收到授权决定",
      UserGuidance: "收到你的指导",
      RepairScheduled: "执行模型自动修复",
      PlannerRepairScheduled: "规划模型接手修复",
      DiagnosisStarted: "规划模型正在诊断",
      DiagnosisCompleted: "规划诊断完成",
      DiagnosisRetrying: "正在重新发起诊断",
      DiagnosisDeferred: "执行模型继续排查",
      PreparationStarted: "检查任务运行环境",
      SourceVersionSelected: "已选择执行使用的代码",
      ServiceExited: "服务运行中退出",
      OperationCompleted: "授权操作已结束",
      ResourceWaiting: "等待共享资源",
      ModelRetryScheduled: "等待模型额度恢复",
      ModelRetryStarted: "额度恢复后继续执行",
      ImplementationReconciled: "已有实现已核对",
    };
    if (lifecycle[e.type]) {
      if (["RepairScheduled", "PlannerRepairScheduled"].includes(e.type))
        repairPending = true;
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
          title: "模型步骤",
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
        const name =
          parameters.ToolName ??
          step.tool_name ??
          tool?.name ??
          previous.at(-1)?.name;
        const args = object(parameters.Arguments ?? parameters);
        const summary = toolSummary(name, args);
        row.kind = "tool";
        row.title =
          toolLabels[name] ??
          summary.title ??
          (name ? `工具 · ${name}` : "工具操作");
        row.text = summary.text;
        row.command = summary.command;
        row.cwd = summary.cwd;
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
        if (tool?.output !== undefined) {
          row.output = pretty(tool.output);
          row.resultText = toolOutputSummary(row.output, name);
        }
        const result = object(tool?.output);
        const exitCode = result.exit_code ?? result.exitCode;
        if (typeof exitCode === "number" && exitCode !== 0)
          row.status = "error";
        if (row.status === "error" && !row.resultText)
          row.resultText = "本次操作未完成，具体原因尚未确认。";
      } else {
        row.kind = "message";
        row.title =
          step.step_type === "agent_response"
            ? `模型输出 · ${status}`
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
      title = "模型执行结果";
      text = p.result?.response ?? pretty(p.result);
    }
    if (e.type === "AgentEvent" && p.event === "init") {
      title = "模型已启动";
      text = `执行模型：${p.init?.model ?? p.model ?? "实际模型未确认"}`;
    }
    if (e.type === "StateChanged") {
      if (p.to === "QUEUED") {
        title =
          p.stage === "planner_takeover"
            ? "规划模型接手已排队"
            : p.stage === "auto_repair"
              ? "修复已排队"
              : "等待执行";
        text =
          p.stage === "planner_takeover"
            ? "保留已有修改，等待规划模型接手实际修复与自测。"
            : p.stage === "auto_repair"
              ? "保留已有修改和原会话，等待执行模型继续修复。"
              : "等待可用执行资源。";
      } else if (p.to === "EXECUTING" && p.from === "QUEUED") {
        title =
          p.stage === "planner_takeover"
            ? "规划模型开始修复"
            : repairPending
              ? "继续开发与自测"
              : "开始开发与自测";
        repairPending = false;
        text =
          p.stage === "planner_takeover"
            ? "正在启动规划模型；收到真实工具事件后展示修改、自测与完成说明。"
            : "执行模型自主安排本轮开发与自测，完成后交代码质量审查。";
      } else if (p.to === "REVIEW_QUEUED") {
        title = "等待规划模型审查";
        text =
          p.stage === "quality_before_human"
            ? "本轮执行已完成，由规划模型审查代码质量。"
            : "等待规划模型进行人工后代码质量审查。";
      } else if (p.to === "REVIEWING") {
        title = "规划模型开始审查";
        text =
          p.stage === "quality_before_human"
            ? "正在审查代码质量，通过后进入人工功能确认。"
            : "正在进行人工后代码质量审查，通过后进入本地提交。";
      } else if (p.to === "BLOCKED") {
        title =
          runtimeFailureResolution(p.blocker?.code, p.blocker?.message)
            ?.title ?? "执行暂停";
        text = failureSummary(
          p.blocker?.code,
          p.blocker?.message ?? "执行已暂停，等待处理",
        );
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
    if (e.type === "ReviewCompletionQueued") {
      title = "规划模型补齐整改计划";
      text = p.message;
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
        "ReviewCompletionQueued",
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
    .filter((r) => r.kind !== "tool" || r.text.trim() || r.resultText?.trim() || r.raw.some((e: any) => e.type === "ReviewDiagnostic"))
    .sort((a, b) => a.sequence - b.sequence);
}

/** Keep diagnostics available for progress parsing without putting raw logs in the UI. */
export function userFacingLogs(entries: LogEntry[], currentRun?: string) {
  return entries.filter(
    (entry) =>
      entry.kind !== "diagnostic" &&
      !entry.raw.some(
        (e: any) => e.type === "AgentDiagnostic" || isAsideRun(e.run_id),
      ) &&
      !(
        entry.kind === "message" &&
        entry.status !== "done" &&
        entry.raw.some(
          (e: any) =>
            e.type === "AgentEvent" &&
            e.payload?.step_update?.step_type === "agent_response" &&
            (entry.status === "interrupted" ||
              (!!currentRun && !!e.run_id && e.run_id !== currentRun)),
        )
      ),
  );
}
