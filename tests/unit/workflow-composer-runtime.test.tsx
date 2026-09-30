// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useWorkflowComposerRuntime } from "../../apps/web/src/components/ConversationStatusBar.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const read = vi.fn();
function View({ detail }: { detail?: any }) {
  const model = useWorkflowComposerRuntime("wf", detail);
  return <span>{model.workflowState}</span>;
}
beforeEach(() => {
  vi.useFakeTimers(); read.mockReset(); vi.stubGlobal("fetch", read);
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers();
});
it("shares the page snapshot, follows state changes, and never starts duplicate polling", async () => {
  await act(() => root.render(<View detail={{ workflow: { id: "wf", state: "STOPPED" } }} />));
  await act(() => vi.advanceTimersByTimeAsync(20000));
  window.dispatchEvent(new Event("devflow-activity"));
  expect(read).not.toHaveBeenCalled();
  expect(container.textContent).toBe("STOPPED");
  await act(() => root.render(<View detail={{ workflow: { id: "wf", state: "EXECUTING" } }} />));
  expect(container.textContent).toBe("EXECUTING");
});
it("uses only event-driven runtime reads for standalone composers", async () => {
  read.mockResolvedValue({ ok: true, json: async () => ({ workflow: { id: "wf", state: "STOPPED" } }) });
  await act(() => root.render(<View />));
  expect(read.mock.calls[0]![0]).toBe("/api/workflows/wf?view=runtime");
  await act(() => vi.advanceTimersByTimeAsync(20000));
  expect(read).toHaveBeenCalledTimes(1);
  await act(() => { window.dispatchEvent(new Event("devflow-activity")); });
  expect(read).toHaveBeenCalledTimes(2);
});
