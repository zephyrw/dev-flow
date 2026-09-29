import { publicDiagnostic } from "./secret-redactor.js";
import type { LogEntry } from "./activity.js";
import {
  CONVERSATION_EVENT,
  conversationActivityKey,
  type ConversationActivityPayload,
  type ConversationStatus,
} from "../../contracts/src/conversation.js";

function isAsideEvent(event: { run_id?: string | null }): boolean {
  return typeof event.run_id === "string" && event.run_id.startsWith("aside-run");
}

export function conversationActivityStatus(
  status?: ConversationStatus | string,
): LogEntry["status"] {
  if (
    status === "active" ||
    status === "done" ||
    status === "error" ||
    status === "interrupted"
  )
    return status;
  if (
    status === "starting" ||
    status === "running" ||
    status === "waiting" ||
    status === "pausing" ||
    status === "discovered"
  )
    return "active";
  if (status === "completed" || status === "cancelled") return "done";
  if (status === "failed") return "error";
  if (status === "paused") return "interrupted";
  return undefined;
}

export function isRootConversationActivity(
  payload: Pick<ConversationActivityPayload, "conversation_id" | "root_id">,
): boolean {
  return payload.conversation_id === payload.root_id;
}

// These are public workflow facts already projected by readableLogs, not generic
// provider activity states. Some intentionally have no additional body text.
const businessEventTypes = new Set([
  "AuthorizationRequested", "AuthorizationDecided", "UserGuidance",
  "RepairScheduled", "PlannerRepairScheduled", "DiagnosisStarted",
  "DiagnosisCompleted", "DiagnosisRetrying", "DiagnosisDeferred",
  "PreparationStarted", "SourceVersionSelected", "ServiceExited",
  "OperationCompleted", "ResourceWaiting", "ModelRetryScheduled",
  "ModelRetryStarted", "ImplementationReconciled", "ProcessesReconciled",
  "TaskStarted", "TaskCompleted", "TaskClaimed", "StateChanged",
  "EnvironmentFailed", "BuildStarted", "BuildReady", "BuildFailed",
  "Stopped", "ReviewCompletionQueued", "WorkflowCreated",
  "ServiceStarting", "ServiceReady", "FixtureStarted", "FixtureReady",
  "CheckStarted", "CheckCompleted",
]);

function hasSpecificActivityTitle(entry: Partial<LogEntry>): boolean {
  if (entry.kind !== "tool" && entry.kind !== "event") return false;
  const title = entry.title?.trim();
  if (!title) return false;
  // A message/tool/status label describes the card, not an actual operation.
  return !/^(会话活动|活动|模型输出|模型步骤|工具操作|执行命令|事件|执行中|执行完成|进行中|完成|工具\s*·\s*MCP|(?:工具\s*·\s*)?call_mcp_tool)(\s*·\s*(进行中|完成))?$/.test(title);
}

export function isMeaningfulLogEntry(entry: Partial<LogEntry> & { exitCode?: number; error?: string }): boolean {
  if (!entry) return false;
  if (typeof entry.command === "string" && entry.command.trim().length > 0) return true;
  if (typeof entry.text === "string" && entry.text.trim().length > 0) return true;
  if (typeof entry.resultText === "string" && entry.resultText.trim().length > 0) return true;
  if (typeof entry.output === "string" && entry.output.trim().length > 0) return true;
  if (typeof entry.cwd === "string" && entry.cwd.trim().length > 0) return true;
  if (typeof entry.exitCode === "number") return true;
  if (entry.status === "error" || (entry as any).status === "failed") return true;
  if (typeof entry.error === "string" && entry.error.trim().length > 0) return true;
  if (
    entry.raw &&
    Array.isArray(entry.raw) &&
    entry.raw.some(
      (e: any) =>
        e?.type === "ReviewDiagnostic" ||
        e?.type === "AgentDiagnostic" ||
        e?.type === "OperationOutput" ||
        businessEventTypes.has(e?.type),
    )
  ) {
    return true;
  }
  return hasSpecificActivityTitle(entry);
}

export function conversationActivityLogEntry(event: {
  event_seq: number;
  created_at: string;
  payload?: ConversationActivityPayload;
}): LogEntry | undefined {
  event = publicDiagnostic(event);
  const payload = event.payload;
  if (!payload?.conversation_id || !payload.attempt_id || !payload.activity_id)
    return undefined;
  // Ignore historical identity-only protocol envelopes on every read path.
  // Status-only increments still participate in merging a real operation.
  if (![payload.title, payload.public_text, payload.command, payload.cwd, payload.result_text, (payload as any).resultText]
    .some((value) => typeof value === "string" && !!value.trim()) && !payload.status) return undefined;
  const kind =
    payload.kind === "separator"
      ? "event"
      : payload.kind === "tool" ||
          payload.kind === "message" ||
          payload.kind === "event"
        ? payload.kind
        : "event";
  const resultText = payload.result_text ?? (payload as any).resultText;
  let title = payload.title;
  if (!title || title === "会话活动") {
    if (payload.command?.trim()) {
      title = "执行命令";
    } else if (payload.kind === "separator") {
      title = "新的运行尝试";
    } else if (payload.kind === "message" && typeof payload.public_text === "string" && payload.public_text.trim()) {
      title = "模型输出";
    } else if (conversationActivityStatus(payload.status) === "error") {
      title = "执行失败";
    } else if (typeof resultText === "string" && resultText.trim()) {
      title = "执行结果";
    } else if (typeof payload.cwd === "string" && payload.cwd.trim()) {
      title = "工作目录";
    } else {
      title = "会话活动";
    }
  }
  let text = payload.public_text ?? "";
  if (!text.trim()) {
    if (typeof resultText === "string" && resultText.trim() && !payload.command?.trim()) {
      text = resultText;
    } else if (typeof payload.cwd === "string" && payload.cwd.trim() && !payload.command?.trim()) {
      text = payload.cwd;
    }
  }
  return {
    key: conversationActivityKey(
      payload.conversation_id,
      payload.attempt_id,
      payload.activity_id,
    ),
    sequence: event.event_seq,
    created_at: event.created_at,
    title,
    text,
    raw: [event],
    kind,
    status: conversationActivityStatus(payload.status),
    command: payload.command,
    cwd: payload.cwd,
    resultText,
  };
}

export function conversationLogs(
  events: any[],
  conversationId: string,
): LogEntry[] {
  const rows = new Map<string, LogEntry>();
  const order: LogEntry[] = [];
  for (const event of [...events].sort((a, b) => a.event_seq - b.event_seq)) {
    if (event.type !== CONVERSATION_EVENT.activity) continue;
    if (isAsideEvent(event)) continue;
    const payload = event.payload as ConversationActivityPayload | undefined;
    if (!payload || payload.conversation_id !== conversationId) continue;
    const entry = conversationActivityLogEntry(event);
    if (!entry) continue;
    const existing = rows.get(entry.key);
    if (!existing) {
      rows.set(entry.key, entry);
      order.push(entry);
    } else {
      mergeConversationLogEntry(existing, entry);
    }
  }
  return order.filter(isMeaningfulLogEntry).sort((a, b) => a.sequence - b.sequence);
}

/** Completion events may omit the arguments sent with the start event. */
export function mergeConversationLogEntry(existing: LogEntry, incoming: LogEntry) {
  const isGeneric = (t?: string) =>
    !t ||
    t === "会话活动" ||
    t === "活动" ||
    t === "模型输出" ||
    t === "新的运行尝试";
  let title = existing.title;
  if (!isGeneric(incoming.title)) {
    title = incoming.title;
  } else if (isGeneric(existing.title)) {
    title = incoming.command || existing.command ? "执行命令" : incoming.title || existing.title;
  }
  const details = {
    title,
    text: incoming.text?.trim() ? incoming.text : existing.text,
    command: incoming.command?.trim() ? incoming.command : existing.command,
    cwd: incoming.cwd?.trim() ? incoming.cwd : existing.cwd,
    resultText: incoming.resultText?.trim() ? incoming.resultText : existing.resultText,
    status: incoming.status ?? existing.status,
  };
  Object.assign(existing, incoming, details);
  return existing;
}
