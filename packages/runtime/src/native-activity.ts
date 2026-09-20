import type {
  RunActivity,
  QuotaBucket,
} from "../../contracts/src/run-observation.js";
import {
  toolSummary,
  toolOutputSummary,
} from "../../presentation/src/tool-summary.js";

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
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
