// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useNativeProgress } from "../../apps/web/src/native-progress.js";

it("keeps observed progress across tabs without background history traversal or paused polling", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  const read = vi.fn(async (url: string) => ({
    ok: true,
    json: async () => url.includes("/history")
      ? { events: [], next_before: 100 }
      : [{ repo_id: "main", files: [{ path: "src/a.ts", status: "M" }] }],
  }));
  vi.stubGlobal("fetch", read);
  const detail = {
    workflow: { id: "w", run_id: "r", plan_revision: 1, state: "STOPPED" },
    plan: { plan: { task_model: "native-v2", tasks: [{ id: "a", repo_id: "main", paths: ["src/a.ts"] }] } },
    runs: [{ id: "r", plan_revision: 1, started_at: "2026-09-30T00:00:00Z", status: "stopped" }],
    tasks: [{ id: "a", completed: false, development_status: "pending" }],
    events: [], workspaces: [{ repo_id: "main", root: "C:/work" }],
  };
  function View({ observe }: { observe: boolean }) {
    const projected = useNativeProgress(detail, observe);
    return <span>{projected.task_counts?.started ?? 0}</span>;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() => root.render(<View observe={false} />));
    expect(container.textContent).toBe("1");
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[0]![0]).toContain("history?view=progress");
    await act(() => root.render(<View observe />));
    await act(() => vi.advanceTimersByTimeAsync(30000));
    await act(() => root.render(<View observe={false} />));
    expect(container.textContent).toBe("1");
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    await act(() => root.unmount());
    container.remove(); vi.unstubAllGlobals(); vi.useRealTimers();
  }
});
