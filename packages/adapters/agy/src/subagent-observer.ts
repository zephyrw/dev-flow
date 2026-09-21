export interface SubagentEvent {
  event_type: "spawn" | "complete" | "cancel" | "error";
  subagent_id: string;
  parent_id?: string;
  role?: string;
  prompt?: string;
  native_session_id?: string;
  timestamp: string;
  generation?: number;
  cursor?: number;
  workspace_dir?: string;
  is_terminal?: boolean;
  completeness?: "complete" | "incomplete";
}

export class AgySubagentObserver {
  private listeners: ((e: SubagentEvent) => void)[] = [];
  private subagentState = new Map<string, { terminal: boolean; generation: number; cursor: number }>();

  subscribe(fn: (e: SubagentEvent) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  observeStreamLine(line: string): void {
    if (!line.includes("subagent") && !line.includes("manage_subagents")) {
      return;
    }
    try {
      const data = JSON.parse(line);
      if (
        data.event === "subagent_info" &&
        typeof data.id === "string" &&
        data.id.trim()
      ) {
        const subId = data.id.trim();
        const status = {
          completed: "complete",
          cancelled: "cancel",
          error: "error",
          running: "spawn",
          spawned: "spawn",
        } as const;
        const eventType = status[data.status as keyof typeof status];
        if (!eventType) return;

        const generation = typeof data.generation === "number" ? data.generation : 0;
        const cursor = typeof data.cursor === "number" ? data.cursor : 0;
        const prev = this.subagentState.get(subId);

        // 代次与游标保护 (CR23)：过时事件不覆盖新结果，合法新代次不被拒绝
        if (prev) {
          if (generation < prev.generation) return;
          if (generation === prev.generation && cursor < prev.cursor) return;
          if (prev.terminal && generation === prev.generation && eventType === "spawn") return;
        }

        const isTerminal = eventType === "complete" || eventType === "cancel" || eventType === "error";
        this.subagentState.set(subId, {
          terminal: isTerminal,
          generation,
          cursor,
        });

        const ev: SubagentEvent = {
          event_type: eventType,
          subagent_id: subId,
          parent_id:
            typeof data.parent_id === "string" ? data.parent_id : undefined,
          role: typeof data.role === "string" ? data.role : undefined,
          prompt: typeof data.prompt === "string" ? data.prompt : undefined,
          native_session_id:
            typeof data.conversation_id === "string"
              ? data.conversation_id
              : undefined,
          generation:
            typeof data.generation === "number" ? data.generation : undefined,
          cursor: typeof data.cursor === "number" ? data.cursor : undefined,
          workspace_dir:
            typeof data.workspace === "string" ? data.workspace : undefined,
          is_terminal: eventType === "complete" || eventType === "cancel",
          completeness: "complete",
          timestamp: new Date().toISOString(),
        };
        for (const l of this.listeners) l(ev);
      }
    } catch {}
  }
}
