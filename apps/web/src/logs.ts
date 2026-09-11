export interface LogEntry {
  key: string;
  sequence: number;
  created_at: string;
  title: string;
  text: string;
  raw: unknown[];
}
/** Reconcile HTTP snapshots with live events without losing newer streamed output. */
export function mergeEvents(workflow: string, ...batches: any[][]): any[] {
  const events = new Map<number, any>();
  for (const batch of batches)
    for (const event of batch)
      if (event.workflow_id === workflow) events.set(event.event_seq, event);
  return [...events.values()]
    .sort((a, b) => a.event_seq - b.event_seq)
    .slice(-5000);
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
    if (e.type === "AgentEvent" && p.event === "step_update" && step) {
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
      const status = step.state === "DONE" ? "完成" : "进行中";
      if (step.step_type === "tool") {
        const tool = step.tool_info;
        row.title = `${tool?.parameters?.ToolName ?? step.tool_name} (${step.tool_name}) · ${status}`;
        row.text =
          "参数：\n" +
          pretty(tool?.parameters?.Arguments ?? tool?.parameters ?? {}) +
          (tool?.output === undefined
            ? ""
            : "\n\n返回：\n" + pretty(tool.output));
      } else {
        row.title =
          step.step_type === "agent_response"
            ? `Gemini 输出 · ${status}`
            : `收到任务 · ${status}`;
        if (typeof step.text_delta === "string") row.text += step.text_delta;
      }
      continue;
    }
    let title = e.type,
      text = typeof p.text === "string" ? p.text : pretty(p);
    if (e.type === "AgentEvent" && p.event === "result") {
      title = "Gemini 执行结果";
      text = p.result?.response ?? pretty(p.result);
    }
    if (e.type === "AgentEvent" && p.event === "init") {
      title = "模型已启动";
      text = `模型：${p.init?.model}\n会话：${p.conversation_id}\n工作目录：${p.init?.cwd}`;
    }
    rows.push({
      key: "event:" + e.event_seq,
      sequence: e.event_seq,
      created_at: e.created_at,
      title,
      text,
      raw: [e],
    });
  }
  return rows;
}
