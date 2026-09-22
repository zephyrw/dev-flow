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

export function conversationActivityLogEntry(event: {
  event_seq: number;
  created_at: string;
  payload?: ConversationActivityPayload;
}): LogEntry | undefined {
  const payload = event.payload;
  if (!payload?.conversation_id || !payload.attempt_id || !payload.activity_id)
    return undefined;
  const kind =
    payload.kind === "separator"
      ? "event"
      : payload.kind === "tool" ||
          payload.kind === "message" ||
          payload.kind === "event"
        ? payload.kind
        : "event";
  return {
    key: conversationActivityKey(
      payload.conversation_id,
      payload.attempt_id,
      payload.activity_id,
    ),
    sequence: event.event_seq,
    created_at: event.created_at,
    title:
      payload.title ??
      (payload.kind === "separator" ? "新的运行尝试" : "会话活动"),
    text: payload.public_text ?? "",
    raw: [event],
    kind,
    status: conversationActivityStatus(payload.status),
    command: payload.command,
  };
}

export function conversationLogs(
  events: any[],
  conversationId: string,
): LogEntry[] {
  const rows = new Map<string, LogEntry>();
  const order: LogEntry[] = [];
  for (const event of events) {
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
      Object.assign(existing, entry);
    }
  }
  return order.sort((a, b) => a.sequence - b.sequence);
}
