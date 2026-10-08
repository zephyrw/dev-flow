// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelEntry, ToolProfile } from "../../packages/contracts/src/index.js";
import { ModelProfileEditor } from "../../apps/web/src/components/ModelProfileEditor.js";

const api = vi.hoisted(() => ({ get: vi.fn(), refresh: vi.fn() }));
vi.mock("../../apps/web/src/components/model-api.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../apps/web/src/components/model-api.js")>(),
  getAdapterModels: api.get,
  refreshAdapterModels: api.refresh,
}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const profile: ToolProfile = {
  id: "planner", revision: 1, adapterId: "codex", modelSelection: "explicit",
  modelId: "gpt-6-astra", selectionKind: "fixed", reasoning: { mode: "native-default" }, options: {},
};
function entry(nativeId: string): ModelEntry {
  return {
    entryId: `codex/openai/${nativeId}`, adapterId: "codex", nativeId, label: nativeId,
    selectionKind: "fixed", effort: { status: "supported", transport: "config", values: ["high"] },
    source: "native-live", discoveredAt: "2026-09-30T00:00:00Z",
    hidden: false, availability: "listed", capabilityRevision: nativeId,
  };
}
const oldEntries = [entry("gpt-6-astra")];
const newEntries = [entry("gpt-6.1-sol"), ...oldEntries];

describe("model selector directory refresh", () => {
  let root: Root;
  let container: HTMLDivElement;
  const onChange = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    api.get.mockReset();
    api.refresh.mockReset();
    onChange.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });
  async function render() {
    await act(async () => root.render(
      <ModelProfileEditor profile={profile} onChange={onChange} autoVerify={false} />,
    ));
    await act(async () => container.querySelector<HTMLInputElement>("[role=combobox]")!.focus());
  }
  it.each(["stale", "refreshing", "failed"])("refreshes a %s directory and makes the new model selectable", async (status) => {
    let finish!: () => void;
    api.get.mockResolvedValueOnce({ entries: oldEntries, status, discoveryStatus: "complete" })
      .mockResolvedValueOnce({ entries: newEntries, status: "fresh", discoveryStatus: "complete" });
    api.refresh.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    await render();
    expect(document.querySelectorAll("[role=option]")).toHaveLength(1);
    expect(api.refresh).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => finish());
    const options = Array.from(document.querySelectorAll<HTMLElement>("[role=option]"));
    expect(options).toHaveLength(2);
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => options[0]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ modelId: "gpt-6.1-sol" }));
  });
  it("keeps cached models and displays the error when refresh fails", async () => {
    api.get.mockResolvedValue({ entries: oldEntries, status: "stale", discoveryStatus: "complete" });
    api.refresh.mockRejectedValue(new Error("目录刷新失败"));
    await render();
    expect(document.querySelectorAll("[role=option]")).toHaveLength(1);
    expect(container.textContent).toContain("目录刷新失败");
    expect(onChange).not.toHaveBeenCalled();
  });
  it("uses a fresh directory without making another discovery request", async () => {
    api.get.mockResolvedValue({ entries: oldEntries, status: "fresh", discoveryStatus: "complete" });
    await render();
    expect(api.refresh).not.toHaveBeenCalled();
    expect(document.querySelectorAll("[role=option]")).toHaveLength(1);
  });
  it("only offers Codex and AGY without changing the current profile", async () => {
    api.get.mockResolvedValue({ entries: oldEntries, status: "fresh", discoveryStatus: "complete" });
    await render();
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="工具"]')!;
    expect(Array.from(select.options, (option) => option.value)).toEqual(["codex", "agy"]);
    expect(onChange).not.toHaveBeenCalled();
  });
  it("preserves a historical tool without probing it or displaying it as Codex", async () => {
    await act(async () => root.render(
      <ModelProfileEditor profile={{ ...profile, adapterId: "mimo-code" }} onChange={onChange} />,
    ));
    await act(async () => vi.advanceTimersByTimeAsync(300));
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="工具"]')!;
    expect(select.value).toBe("mimo-code");
    expect(select.selectedOptions[0]!.textContent).toBe("历史工具（暂未开放）");
    expect(select.selectedOptions[0]!.disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>("[role=combobox]")!.disabled).toBe(true);
    expect(api.get).not.toHaveBeenCalled();
    expect(api.refresh).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });
});
