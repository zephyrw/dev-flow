import type { NativeConversationEvent } from "../../adapters/sdk/src/interface.js";
import type {
  RunActivity,
  QuotaBucket,
} from "../../contracts/src/run-observation.js";
import {
  toolSummary,
  toolOutputSummary,
} from "../../presentation/src/tool-summary.js";

const CONVERSATION_KINDS = new Set<NativeConversationEvent["kind"]>([
  "discovered",
  "state",
  "activity",
  "model",
  "quota",
]);

const str = (v: unknown) =>
  typeof v === "string" && v.trim() ? v : undefined;
const object = (v: any) => {
  if (typeof v !== "string") return v ?? {};
  try {
    return JSON.parse(v);
  } catch {
    return {};
  }
};

/** Only public messages and named tool fields are projected, never reasoning or raw records. */
export function nativeActivities(raw: any): RunActivity[] {
  if (!raw || typeof raw !== "object") return [];
  if (/^item\.(started|updated|completed)$/.test(raw.type ?? "")) {
    const item = raw.item;
    if (!item || !str(item.id)) return [];
    const status =
      item.status === "failed" ||
      item.error ||
      (typeof item.exit_code === "number" && item.exit_code !== 0)
        ? "error"
        : raw.type === "item.completed"
          ? "done"
          : "active";
    const base = { id: item.id, status } as const;
    switch (item.type) {
      case "command_execution":
        return [
          {
            ...base,
            kind: "tool",
            title: "执行命令",
            text: str(item.command) ?? "执行命令",
            command: str(item.command),
            cwd: str(item.cwd),
            resultText:
              toolOutputSummary(item.aggregated_output, "run_command") ||
              (typeof item.exit_code === "number"
                ? `命令退出码：${item.exit_code}`
                : undefined),
          },
        ];
      case "file_change":
        return (Array.isArray(item.changes) ? item.changes : [])
          .filter((f: any) => str(f.path))
          .map((f: any, i: number) => ({
            ...base,
            id: item.id + ":file:" + i,
            kind: "tool",
            title: "修改文件",
            text: f.path,
          }));
      case "agent_message":
        return [
          {
            ...base,
            kind: "message",
            title: "模型输出",
            text: str(item.text) ?? "",
          },
        ];
      case "web_search":
        return [
          {
            ...base,
            kind: "tool",
            title: "搜索网页",
            text: str(item.query) ?? "搜索网页",
          },
        ];
      case "mcp_tool_call": {
        const summary = toolSummary(item.tool, object(item.arguments));
        return [
          {
            ...base,
            kind: "tool",
            title: summary.title ?? `工具 · ${item.tool ?? "MCP"}`,
            text: summary.text || item.tool || "MCP 工具",
            command: summary.command,
            cwd: summary.cwd,
          },
        ];
      }
      // Includes reasoning, todo lists and unknown protocol records.
    }
    return [];
  }
  if (
    ["tool_call", "tool_use", "tool_result"].includes(raw.type ?? raw.event)
  ) {
    const id = str(raw.tool_call_id ?? raw.id);
    if (!id) return [];
    const name = str(raw.name ?? raw.tool);
    const summary = toolSummary(
      name,
      object(raw.args ?? raw.parameters ?? raw.input),
    );
    const result = raw.type === "tool_result" || raw.event === "tool_result";
    const code = raw.exit_code ?? raw.result?.exit_code;
    return [
      {
        id,
        kind: "tool",
        title: summary.title ?? (name ? `工具 · ${name}` : "工具操作"),
        text: summary.text,
        command: summary.command,
        cwd: summary.cwd,
        status:
          raw.is_error || (typeof code === "number" && code !== 0)
            ? "error"
            : result
              ? "done"
              : "active",
        resultText:
          typeof code === "number" ? `命令退出码：${code}` : undefined,
      },
    ];
  }
  if (["error", "turn.failed"].includes(raw.type ?? raw.event)) {
    return [
      {
        id: "runtime-error",
        kind: "event",
        title: "模型运行失败",
        status: "error",
        text:
          str(raw.error?.message ?? raw.message) ??
          "执行工具报告错误，请查看运行问题处理方法。",
      },
    ];
  }
  return [];
}

export function quotaBuckets(raw: any): QuotaBucket[] {
  if (!raw || typeof raw !== "object") return [];
  const byId = raw.rateLimitsByLimitId;
  const values: [string, any][] =
    byId && typeof byId === "object"
      ? Object.entries(byId)
      : [[raw.limit_id ?? raw.limitId ?? "codex", raw.rateLimits ?? raw]];
  return values.flatMap(([id, value]) => {
    const windows = [value?.primary, value?.secondary].flatMap((w) => {
      const used = w?.used_percent ?? w?.usedPercent;
      const minutes = w?.window_minutes ?? w?.windowDurationMins;
      const resets = w?.resets_at ?? w?.resetsAt;
      if (
        typeof used !== "number" ||
        !Number.isFinite(used) ||
        used < 0 ||
        used > 100 ||
        typeof minutes !== "number" ||
        !Number.isFinite(minutes) ||
        minutes <= 0
      )
        return [];
      return [
        {
          used_percent: used,
          window_minutes: minutes,
          resets_at:
            typeof resets === "number" && Number.isFinite(resets) && resets > 0
              ? resets
              : undefined,
        },
      ];
    });
    return windows.length
      ? [{ id, label: str(value.limit_name ?? value.limitName), model: str(value.normalModelSlug), windows }]
      : [];
  });
}

export function isNativeConversationEvent(
  raw: unknown,
): raw is NativeConversationEvent {
  if (!raw || typeof raw !== "object") return false;
  const event = raw as NativeConversationEvent;
  return (
    typeof event.root_native_id === "string" &&
    event.root_native_id.length > 0 &&
    typeof event.source_id === "string" &&
    event.source_id.length > 0 &&
    typeof event.source_seq === "string" &&
    event.source_seq.length > 0 &&
    CONVERSATION_KINDS.has(event.kind)
  );
}

export type NativeEventScopeIdentity = {
  rootNativeId?: string;
  sessionNativeId?: string;
  agentNativeId?: string;
  parentNativeId?: string;
  structured: boolean;
};

export function nativeEventIdentity(raw: any): NativeEventScopeIdentity {
  if (isNativeConversationEvent(raw)) {
    return {
      rootNativeId: raw.root_native_id,
      sessionNativeId: raw.session_native_id,
      agentNativeId: raw.agent_native_id,
      parentNativeId: raw.parent_native_id,
      structured: true,
    };
  }
  if (!raw || typeof raw !== "object") return { structured: false };
  const stepConversation = str(raw.step_update?.conversation_id);
  const eventConversation =
    str(raw.session_native_id) ??
    str(raw.thread_id) ??
    str(raw.session_id) ??
    str(raw.sessionId) ??
    str(raw.conversation_id) ??
    str(raw.init?.conversation_id);
  const parentFromStep =
    stepConversation &&
    eventConversation &&
    stepConversation !== eventConversation
      ? eventConversation
      : undefined;
  const parentNativeId =
    str(raw.parent_native_id) ??
    str(raw.parent_session_id) ??
    str(raw.parent_agent_id) ??
    parentFromStep;
  return {
    rootNativeId: str(raw.root_native_id),
    sessionNativeId: stepConversation ?? eventConversation,
    agentNativeId: str(raw.agent_native_id) ?? str(raw.agent_id),
    parentNativeId,
    structured: Boolean(
      parentNativeId ||
        str(raw.agent_native_id) ||
        (str(raw.session_native_id) && str(raw.root_native_id)),
    ),
  };
}

export function inferConversationEventKind(
  raw: any,
): NativeConversationEvent["kind"] {
  if (isNativeConversationEvent(raw)) return raw.kind;
  if (raw?.rate_limits || raw?.rateLimits) return "quota";
  if (
    raw?.init?.model ||
    ((raw?.event === "init" ||
      raw?.type === "system" ||
      raw?.type === "session.started") &&
      raw?.model)
  )
    return "model";
  if (
    raw?.event === "init" ||
    raw?.type === "turn.started" ||
    raw?.type === "thread.started" ||
    raw?.type === "session.started"
  )
    return "state";
  return "activity";
}

export function agyStepActivity(step: any): RunActivity | undefined {
  if (!step || !["tool", "agent_response"].includes(step.step_type))
    return undefined;
  const summary = toolSummary(
    step.tool_name ?? step.tool_info?.name,
    step.tool_info?.parameters ?? {},
  );
  return {
    id: String(step.step_index),
    kind: step.step_type === "tool" ? "tool" : "message",
    title: summary.title ?? "工具操作",
    text: summary.text,
    command: summary.command,
    cwd: summary.cwd,
    status:
      step.state === "ERROR"
        ? "error"
        : step.state === "DONE"
          ? "done"
          : "active",
  };
}

function activityStatusFromPayload(status: unknown): RunActivity["status"] {
  if (status === "error" || status === "failed") return "error";
  if (status === "done" || status === "completed") return "done";
  if (status === "interrupted") return "interrupted";
  return "active";
}

export function conversationEventActivities(
  event: NativeConversationEvent,
): RunActivity[] {
  if (event.kind !== "activity") return [];
  const payload = event.payload as any;
  if (
    payload &&
    typeof payload === "object" &&
    str(payload.id) &&
    (payload.kind === "tool" ||
      payload.kind === "message" ||
      payload.kind === "event")
  )
    return [
      {
        id: payload.id,
        kind: payload.kind,
        title: str(payload.title) ?? "会话活动",
        text: str(payload.public_text ?? payload.text) ?? "",
        status: activityStatusFromPayload(payload.status),
        command: str(payload.command),
        cwd: str(payload.cwd),
        resultText: str(payload.resultText),
      },
    ];
  return nativeActivities(payload);
}
