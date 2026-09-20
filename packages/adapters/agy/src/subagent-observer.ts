export interface SubagentEvent {
  event_type: "spawn" | "complete" | "cancel" | "error";
  subagent_id: string;
  parent_id?: string;
  role?: string;
  prompt?: string;
  native_session_id?: string;
  timestamp: string;
}

export class AgySubagentObserver {
  private listeners: ((e: SubagentEvent) => void)[] = [];

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
        const status = {
          completed: "complete",
          cancelled: "cancel",
          error: "error",
          running: "spawn",
          spawned: "spawn",
        } as const;
        const eventType = status[data.status as keyof typeof status];
        if (!eventType) return;
        const ev: SubagentEvent = {
          event_type: eventType,
          subagent_id: data.id,
          parent_id:
            typeof data.parent_id === "string" ? data.parent_id : undefined,
          role: typeof data.role === "string" ? data.role : undefined,
          prompt: typeof data.prompt === "string" ? data.prompt : undefined,
          native_session_id:
            typeof data.conversation_id === "string"
              ? data.conversation_id
              : undefined,
          timestamp: new Date().toISOString(),
        };
        for (const l of this.listeners) l(ev);
      }
    } catch {}
  }
}
