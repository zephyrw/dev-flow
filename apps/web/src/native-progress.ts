import { useEffect, useMemo, useState } from "react";
import { nativeProgress } from "../../../packages/presentation/src/native-progress.js";

/** Read existing APIs only: no model tool call, workflow mutation or runner. */
export function useNativeProgress(detail: any) {
  const workflow = detail?.workflow;
  const native = detail?.plan?.plan?.task_model === "native-v2";
  const binding = native
    ? `${workflow.id}:${workflow.plan_revision}:${workflow.plan_hash ?? ""}`
    : "";
  const [snapshot, setSnapshot] = useState<{
    binding: string;
    changes: any[];
  }>();
  const [history, setHistory] = useState<{ binding: string; events: any[] }>();
  const firstRun = (detail?.runs ?? [])
    .filter((r: any) => r.plan_revision === workflow?.plan_revision)
    .map((r: any) => r.started_at)
    .filter(Boolean)
    .sort()[0];
  // Restore earlier observations without slowing the initial summary or
  // requesting any extra reporting from the execution model.
  useEffect(() => {
    if (!binding || detail.loading || !firstRun || !detail.history_cursor)
      return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let cursor = detail.history_cursor;
    const collected: any[] = [];
    const page = async () => {
      try {
        const response = await fetch(
          `/api/workflows/${encodeURIComponent(workflow.id)}/history?before=${cursor}&limit=200`,
          { signal: abort.signal },
        );
        if (!response.ok) return;
        const result = await response.json();
        if (abort.signal.aborted || !Array.isArray(result.events)) return;
        collected.push(
          ...result.events.filter((e: any) => {
            const step = e.payload?.step_update;
            return (
              e.created_at >= firstRun &&
              [
                "run_command",
                "terminal",
                "exec",
                "command_status",
                "manage_task",
              ].includes(step?.tool_name)
            );
          }),
        );
        setHistory({ binding, events: [...collected] });
        if (
          result.next_before &&
          result.next_before < cursor &&
          result.events[0]?.created_at >= firstRun
        ) {
          cursor = result.next_before;
          timer = setTimeout(() => void page(), 250);
        }
      } catch {
        /* Recent live observations remain available on read failure. */
      }
    };
    void page();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [binding, detail?.loading, firstRun]);
  useEffect(() => {
    if (!binding || detail.loading) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        if (document.visibilityState === "visible") {
          const response = await fetch(
            `/api/workflows/${encodeURIComponent(workflow.id)}/diff`,
            { signal: abort.signal },
          );
          if (response.ok) {
            const changes = await response.json();
            if (!abort.signal.aborted && Array.isArray(changes))
              setSnapshot({ binding, changes });
          }
        }
      } catch {
        /* Preserve the last observation during a transient disconnect. */
      }
      if (
        !abort.signal.aborted &&
        ["EXECUTING", "VERIFYING", "QUEUED"].includes(workflow.state)
      )
        timer = setTimeout(() => void refresh(), 15000);
    };
    void refresh();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [binding, workflow?.state, detail?.loading]);
  return useMemo(() => {
    const projection = nativeProgress(
      history?.binding === binding && detail
        ? { ...detail, events: [...history.events, ...(detail.events ?? [])] }
        : detail,
      snapshot?.binding === binding ? snapshot.changes : undefined,
    );
    return projection && projection !== detail
      ? { ...projection, events: detail.events }
      : projection;
  }, [detail, snapshot, history, binding]);
}
