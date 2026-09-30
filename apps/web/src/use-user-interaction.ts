import { useCallback, useEffect, useRef, useState } from "react";
import {
  getCurrentUserInteraction,
  InteractionQueryError,
} from "./components/user-interaction-api.js";
import type { UserInteractionRecord } from "../../../packages/contracts/src/user-interaction.js";

const retryDelays = [1000, 2000, 4000];
const queryTimeout = 10000;

export function useCurrentUserInteraction(workflowId: string, state: string) {
  const [interaction, setInteraction] = useState<UserInteractionRecord | null>(
    null,
  );
  const [fetchError, setFetchError] = useState("");
  const refreshRef = useRef<() => void>(() => {});
  const fetchInteraction = useCallback(() => refreshRef.current(), []);

  useEffect(() => {
    let stopped = false;
    let controller: AbortController | undefined;
    let requestTimeout: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryCount = 0;
    let failed = false;
    let refreshQueued = false;
    setInteraction(null);
    setFetchError("");

    const clearRetry = () => {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    };
    const query = async () => {
      if (stopped || controller) return;
      clearRetry();
      const request = new AbortController();
      controller = request;
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        request.abort();
      }, queryTimeout);
      requestTimeout = timeout;
      try {
        const item = await getCurrentUserInteraction(
          workflowId,
          request.signal,
        );
        if (stopped || request.signal.aborted) return;
        failed = false;
        retryCount = 0;
        setFetchError("");
        setInteraction(item);
      } catch (error) {
        if (stopped || (request.signal.aborted && !timedOut)) return;
        const failure = timedOut
          ? new InteractionQueryError(
              "交互查询超时，请稍后重试",
              "network",
              true,
            )
          : error;
        failed = true;
        setFetchError(
          failure instanceof Error ? failure.message : "交互查询失败，请重试",
        );
        if (failure instanceof InteractionQueryError) {
          // Keep diagnostics without logging response bodies or interaction contents.
          console.warn("交互查询失败", {
            workflowId,
            category: failure.category,
            status: failure.status,
            code: failure.code,
            requestId: failure.requestId,
          });
          const delay = retryDelays[retryCount];
          if (failure.retryable && delay !== undefined) {
            retryCount++;
            retryTimer = setTimeout(() => void query(), delay);
          }
        }
      } finally {
        clearTimeout(timeout);
        requestTimeout = undefined;
        controller = undefined;
        if (!stopped && refreshQueued) {
          refreshQueued = false;
          void query();
        }
      }
    };
    const refresh = () => {
      if (stopped) return;
      retryCount = 0;
      clearRetry();
      if (controller) refreshQueued = true;
      else void query();
    };
    const handleScopedRefresh = (event: Event) => {
      if (
        (event as CustomEvent<{ workflowId: string }>).detail?.workflowId ===
        workflowId
      )
        refresh();
    };
    refreshRef.current = refresh;
    void query();
    window.addEventListener("devflow-activity", refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    window.addEventListener("devflow-detail-refreshed", handleScopedRefresh);
    window.addEventListener("devflow-reconnected", handleScopedRefresh);
    // Poll successful WAITING_INPUT queries for decisions from another window.
    // Failures use bounded retries, so polling cannot bypass their limit.
    const poll =
      state === "WAITING_INPUT"
        ? setInterval(() => {
            if (!failed) void query();
          }, 3000)
        : undefined;
    return () => {
      stopped = true;
      refreshRef.current = () => {};
      controller?.abort();
      clearTimeout(requestTimeout);
      clearRetry();
      clearInterval(poll);
      window.removeEventListener("devflow-activity", refresh);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      window.removeEventListener(
        "devflow-detail-refreshed",
        handleScopedRefresh,
      );
      window.removeEventListener("devflow-reconnected", handleScopedRefresh);
    };
  }, [workflowId, state]);

  return {
    interaction: interaction?.workflow_id === workflowId ? interaction : null,
    setInteraction,
    fetchError,
    fetchInteraction,
  };
}
