import { useEffect, useMemo, useRef, useState } from "react";
import { nativeProgress } from "../../../packages/presentation/src/native-progress.js";

/** Read existing APIs only: no model tool call, workflow mutation or runner. */
export function useNativeProgress(detail: any, observe = true) {
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
  const observations = useRef(new Map<string, any[]>());
  const differences = useRef(new Map<string, any[]>());
  const firstRun = (detail?.runs ?? [])
    .filter((r: any) => r.plan_revision === workflow?.plan_revision)
    .map((r: any) => r.started_at)
    .filter(Boolean)
    .sort()[0];
  // One filtered, bounded page restores recent observations on demand. Older
  // raw execution history remains available through the sidebar history button.
  useEffect(() => {
    if (!binding || detail.loading || !firstRun)
      return;
    const cacheKey = `${binding}:${workflow.run_id ?? ""}`;
    const cached = observations.current.get(cacheKey);
    if (cached) { setHistory({ binding, events: cached }); return; }
    const abort = new AbortController();
    const page = async () => {
      try {
        const response = await fetch(
          `/api/workflows/${encodeURIComponent(workflow.id)}/history?view=progress&since=${encodeURIComponent(firstRun)}&limit=200`,
          { signal: abort.signal },
        );
        if (!response.ok) return;
        const result = await response.json();
        if (abort.signal.aborted || !Array.isArray(result.events)) return;
        observations.current.set(cacheKey, result.events);
        if (observations.current.size > 8) observations.current.delete(observations.current.keys().next().value!);
        setHistory({ binding, events: result.events });
      } catch {
        /* Recent live observations remain available on read failure. */
      }
    };
    void page();
    return () => {
      abort.abort();
    };
  }, [binding, workflow?.run_id, detail?.loading, firstRun]);
  useEffect(() => {
    if (!binding || detail.loading) return;
    const cached = differences.current.get(binding);
    const polling = observe && ["EXECUTING", "VERIFYING", "QUEUED"].includes(workflow.state);
    if (cached) {
      setSnapshot({ binding, changes: cached });
      if (!polling) return;
    }
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
            if (!abort.signal.aborted && Array.isArray(changes)) {
              differences.current.set(binding, changes);
              if (differences.current.size > 8) differences.current.delete(differences.current.keys().next().value!);
              setSnapshot({ binding, changes });
            }
          }
        }
      } catch {
        /* Preserve the last observation during a transient disconnect. */
      }
      if (
        !abort.signal.aborted &&
        polling
      )
        timer = setTimeout(() => void refresh(), 15000);
    };
    void refresh();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [observe, binding, workflow?.state, detail?.loading]);
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
