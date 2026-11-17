// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelEntry, ToolProfile } from "../../packages/contracts/src/index.js";
import { ModelConfigTabs, type ConfigTabId } from "../../apps/web/src/components/ModelConfigTabs.js";
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
  it.each([
    ["agy", "gemini-3.8-flash-high", "Gemini 3.8 Flash"],
    ["agy", "gemini-3.8-flash-medium", "Gemini 3.8 Flash"],
    ["agy", "gemini-3.8-flash-low", "Gemini 3.8 Flash"],
    ["agy", "claude-opus-4-6-thinking", "Claude Opus 4.6 Thinking"],
    ["codex", "gpt-6-astra", "GPT-6 Astra"],
    ["agy", "custom-model-high", "custom-model-high"],
  ] as const)("keeps %s %s readable before and after the catalog loads", async (adapterId, modelId, label) => {
    let finish!: (result: { entries: ModelEntry[]; status: string; discoveryStatus: string }) => void;
    api.get.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const selected: ToolProfile = { ...profile, adapterId, modelId, reasoning: { mode: "explicit", value: "high" } };
    await act(async () => root.render(
      <ModelProfileEditor profile={selected} onChange={onChange} autoVerify={false} />,
    ));
    const input = container.querySelector<HTMLInputElement>("[role=combobox]")!;
    expect(input.value).toBe(label);
    const catalogEntry: ModelEntry = { ...entry(modelId), adapterId, entryId: `${adapterId}/${modelId}` };
    await act(async () => finish({ entries: [catalogEntry], status: "fresh", discoveryStatus: "complete" }));
    expect(input.value).toBe(label);
    expect(onChange).not.toHaveBeenCalled();
  });
  it("keeps the AGY name readable if the initial catalog request fails", async () => {
    let fail!: (error: Error) => void;
    api.get.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    await act(async () => root.render(
      <ModelProfileEditor profile={{ ...profile, adapterId: "agy", modelId: "gemini-3.8-flash-high" }}
        onChange={onChange} autoVerify={false} />,
    ));
    const input = container.querySelector<HTMLInputElement>("[role=combobox]")!;
    expect(input.value).toBe("Gemini 3.8 Flash");
    await act(async () => fail(new Error("目录加载失败")));
    expect(input.value).toBe("Gemini 3.8 Flash");
    expect(container.textContent).toContain("目录加载失败");
    expect(onChange).not.toHaveBeenCalled();
  });
  it("offers the four supported tools without changing the current profile", async () => {
    api.get.mockResolvedValue({ entries: oldEntries, status: "fresh", discoveryStatus: "complete" });
    await render();
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="工具"]')!;
    expect(Array.from(select.options, (option) => option.value)).toEqual(["codex", "agy", "claude-code", "opencode", "codebuddy-code"]);
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

  it("renders Gemini 4 Hydrogen four efforts (Low/Medium/High/Extra), defaults to High, and dispatches xhigh for Extra", async () => {
    const hydrogenEntries: ModelEntry[] = (["low", "medium", "high", "xhigh"] as const).map((tier) => ({
      entryId: `agy/gemini-4-hydrogen-${tier}`,
      adapterId: "agy",
      nativeId: `gemini-4-hydrogen-${tier}`,
      label: `Gemini 4 Hydrogen (${tier})`,
      familyId: "gemini-4-hydrogen",
      selectionKind: "fixed",
      effort: {
        status: "supported",
        transport: "variant-id",
        values: [tier],
        defaultValue: tier,
        fixedValue: tier,
        variants: { [tier]: `gemini-4-hydrogen-${tier}` },
      },
      source: "native-live",
      discoveredAt: "2026-11-13T00:00:00Z",
      hidden: false,
      availability: "listed",
      capabilityRevision: "rev-h",
    }));
    api.get.mockResolvedValue({
      entries: hydrogenEntries,
      status: "fresh",
      discoveryStatus: "complete",
      accountContextKey: "acc:supported",
    });
    const agyProfile: ToolProfile = {
      ...profile,
      adapterId: "agy",
      modelId: "gemini-3.8-flash-low",
      reasoning: { mode: "explicit", value: "low" },
    };
    await act(async () => root.render(
      <ModelProfileEditor profile={agyProfile} onChange={onChange} autoVerify={false} />,
    ));
    await act(async () => container.querySelector<HTMLInputElement>("[role=combobox]")!.focus());
    const options = Array.from(document.querySelectorAll<HTMLElement>("[role=option]"));
    expect(options).toHaveLength(1);
    expect(options[0]!.textContent).toContain("Gemini 4 Hydrogen");
    await act(async () => options[0]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      modelId: "gemini-4-hydrogen-high",
      reasoning: { mode: "explicit", value: "high" },
    }));

    const selectedHydrogen: ToolProfile = {
      ...agyProfile,
      modelId: "gemini-4-hydrogen-high",
      reasoning: { mode: "explicit", value: "high" },
    };
    onChange.mockReset();
    await act(async () => root.render(
      <ModelProfileEditor profile={selectedHydrogen} onChange={onChange} autoVerify={false} />,
    ));
    const effortSelect = container.querySelector<HTMLSelectElement>('select[aria-label="工具思考强度"]')!;
    expect(Array.from(effortSelect.options, (opt) => [opt.value, opt.textContent])).toEqual([
      ["default", "默认"],
      ["low", "Low"],
      ["medium", "Medium"],
      ["high", "High"],
      ["xhigh", "Extra"],
    ]);
    await act(async () => {
      effortSelect.value = "xhigh";
      effortSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      modelId: "gemini-4-hydrogen-xhigh",
      reasoning: { mode: "explicit", value: "xhigh" },
    }));
  });

  it("shows empty state and blocks manual Hydrogen entry or silent downgrade on unsupported account", async () => {
    api.get.mockResolvedValue({
      entries: [],
      status: "fresh",
      discoveryStatus: "complete",
      accountContextKey: "acc:empty",
    });
    const historicalHydrogen: ToolProfile = {
      ...profile,
      adapterId: "agy",
      modelId: "gemini-4-hydrogen-xhigh",
      reasoning: { mode: "explicit", value: "xhigh" },
    };
    await act(async () => root.render(
      <ModelProfileEditor profile={historicalHydrogen} onChange={onChange} autoVerify={false} />,
    ));
    expect(api.refresh).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(container.textContent).toContain("当前账号不支持模型 Gemini 4 Hydrogen");

    const input = container.querySelector<HTMLInputElement>("[role=combobox]")!;
    await act(async () => input.focus());
    expect(document.body.textContent).toContain("当前账号暂无可用模型");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "gemini-4-hydrogen-xhigh");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(document.querySelector(".ms-custom-option")).toBeNull();
  });

  it("ModelConfigTabs 切换职责页签时隔离编辑器状态并精确保持 executor 的 Hydrogen Extra 档位", async () => {
    const agyHydrogenEntries: ModelEntry[] = [
      "low", "medium", "high", "xhigh",
    ].map((effort) => ({
      entryId: `agy/google/gemini-4-hydrogen-${effort}`,
      adapterId: "agy",
      nativeId: `gemini-4-hydrogen-${effort}`,
      familyId: "gemini-4-hydrogen",
      label: `Gemini 4 Hydrogen (${effort === "xhigh" ? "Extra" : effort[0]!.toUpperCase() + effort.slice(1)})`,
      selectionKind: "fixed",
      effort: {
        status: "supported",
        transport: "variant-id",
        values: ["low", "medium", "high", "xhigh"],
        defaultValue: "high",
        variants: {
          low: "gemini-4-hydrogen-low",
          medium: "gemini-4-hydrogen-medium",
          high: "gemini-4-hydrogen-high",
          xhigh: "gemini-4-hydrogen-xhigh",
        },
      },
      source: "native-live",
      discoveredAt: "2026-11-13T00:00:00Z",
      hidden: false,
      availability: "listed",
      capabilityRevision: `gemini-4-hydrogen-${effort}`,
    }));
    api.get.mockImplementation(async (adapter: string) => ({
      entries: adapter === "agy" ? agyHydrogenEntries : oldEntries,
      status: "fresh",
      discoveryStatus: "complete",
    }));

    const plannerProfile: ToolProfile = {
      id: "planner",
      revision: 1,
      adapterId: "codex",
      modelSelection: "explicit",
      modelId: "gpt-6-astra",
      selectionKind: "fixed",
      reasoning: { mode: "native-default" },
      options: {},
    };
    const executorProfile: ToolProfile = {
      id: "executor",
      revision: 1,
      adapterId: "agy",
      modelSelection: "explicit",
      modelId: "gemini-4-hydrogen-xhigh",
      selectionKind: "fixed",
      reasoning: { mode: "explicit", value: "xhigh" },
      options: {},
    };
    const onPlannerChange = vi.fn();
    const onExecutorChange = vi.fn();

    function TabsHarness() {
      const [activeTab, setActiveTab] = React.useState<ConfigTabId>("planner");
      return (
        <ModelConfigTabs
          tabs={[
            { id: "planner", label: "规划" },
            { id: "executor", label: "执行" },
          ]}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          plannerProfile={plannerProfile}
          executorProfile={executorProfile}
          onPlannerChange={onPlannerChange}
          onExecutorChange={onExecutorChange}
        />
      );
    }

    await act(async () => root.render(<TabsHarness />));
    const plannerCombo = container.querySelector<HTMLInputElement>("[role=combobox]")!;
    await act(async () => {
      plannerCombo.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(plannerCombo, "astra-filter");
      plannerCombo.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const execTab = Array.from(container.querySelectorAll<HTMLButtonElement>("[role=tab]"))
      .find((btn) => btn.textContent?.includes("执行"))!;
    await act(async () => execTab.click());
    await act(async () => {});

    const execCombo = container.querySelector<HTMLInputElement>("[role=combobox]")!;
    expect(execCombo.value).toContain("Gemini 4 Hydrogen");
    const effortSelect = container.querySelector<HTMLSelectElement>('select[aria-label="工具思考强度"]')!;
    expect(effortSelect.value).toBe("xhigh");
    expect(onExecutorChange).not.toHaveBeenCalled();
  });

  it("UI-01/UI-02: 收到账号变更通知立即作废旧 Hydrogen 选项、支持 WS 重连重核与页面聚焦重核，且加载/失败保留列表外 Extra 摘要", async () => {
    const sockets: any[] = [];
    const OriginalWS = (globalThis as any).WebSocket;
    class MockWebSocket {
      onopen: (() => void) | null = null;
      onmessage: (() => void) | null = null;
      onclose: (() => void) | null = null;
      close = vi.fn();
      constructor(_url: string) {
        sockets.push(this);
      }
    }
    (globalThis as any).WebSocket = MockWebSocket;
    try {
      const hydrogenEntries: ModelEntry[] = [
        "low", "medium", "high", "xhigh",
      ].map((effort) => ({
        entryId: `agy/google/gemini-4-hydrogen-${effort}`,
        adapterId: "agy",
        nativeId: `gemini-4-hydrogen-${effort}`,
        familyId: "gemini-4-hydrogen",
        label: `Gemini 4 Hydrogen (${effort === "xhigh" ? "Extra" : effort[0]!.toUpperCase() + effort.slice(1)})`,
        selectionKind: "fixed",
        effort: {
          status: "supported",
          transport: "variant-id",
          values: ["low", "medium", "high", "xhigh"],
          defaultValue: "high",
          variants: {
            low: "gemini-4-hydrogen-low",
            medium: "gemini-4-hydrogen-medium",
            high: "gemini-4-hydrogen-high",
            xhigh: "gemini-4-hydrogen-xhigh",
          },
        },
        source: "native-live",
        discoveredAt: "2026-11-13T00:00:00Z",
        hidden: false,
        availability: "listed",
        capabilityRevision: `gemini-4-hydrogen-${effort}`,
      }));

      let phase: "a" | "empty_fail" | "b" = "a";
      api.get.mockImplementation(async () => {
        if (phase === "a") {
          return {
            entries: hydrogenEntries,
            status: "fresh",
            discoveryStatus: "complete",
            accountContextKey: "agy:default:a:e1:c1",
          };
        }
        if (phase === "empty_fail") {
          return { entries: [], status: "failed", discoveryStatus: "missing" };
        }
        return {
          entries: [
            {
              entryId: "agy/google/gemini-3.8-flash-high",
              adapterId: "agy",
              nativeId: "gemini-3.8-flash-high",
              familyId: "gemini-3.8-flash",
              label: "Gemini 3.8 Flash",
              selectionKind: "fixed",
              effort: { status: "supported", transport: "variant-id", values: ["high"], defaultValue: "high" },
              source: "native-live",
              discoveredAt: "2026-11-13T00:00:00Z",
              hidden: false,
              availability: "listed",
              capabilityRevision: "gemini-3.8-flash-high",
            },
          ],
          status: "fresh",
          discoveryStatus: "complete",
          accountContextKey: "agy:default:b:e2:c1",
        };
      });
      api.refresh.mockRejectedValue(new Error("目录刷新失败"));

      const agyExtraProfile: ToolProfile = {
        id: "executor",
        revision: 1,
        adapterId: "agy",
        modelSelection: "explicit",
        modelId: "gemini-4-hydrogen-xhigh",
        selectionKind: "fixed",
        reasoning: { mode: "explicit", value: "xhigh" },
        options: {},
      };

      await act(async () => root.render(
        <ModelProfileEditor profile={agyExtraProfile} onChange={onChange} autoVerify={false} />,
      ));
      await act(async () => {});

      const combo = container.querySelector<HTMLInputElement>("[role=combobox]")!;
      await act(async () => combo.focus());
      expect(document.body.textContent).toContain("Gemini 4 Hydrogen");
      expect(sockets.length).toBeGreaterThan(0);

      // 已就绪的目录在断线回调内失效，原配置保留到重连核对之后。
      expect(container.querySelector('[aria-label="工具思考强度"]')).not.toBeNull();
      expect(document.querySelectorAll("[role=option]").length).toBeGreaterThan(0);
      await act(async () => sockets.at(-1).onclose?.());
      expect(document.querySelectorAll("[role=option]")).toHaveLength(0);
      expect(container.querySelector('[aria-label="工具思考强度"]')).toBeNull();
      expect(container.textContent).toContain("Extra");
      expect(onChange).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
        sockets.at(-1).onopen?.();
      });
      expect(container.querySelector<HTMLSelectElement>('[aria-label="工具思考强度"]')?.value).toBe("xhigh");

      // 断线立即清除可选能力，并拒绝不响应取消的旧账号迟到目录。
      let pendingSignal: AbortSignal | undefined;
      let finishOldRead!: (result: Awaited<ReturnType<typeof import("../../apps/web/src/components/model-api.js").getAdapterModels>>) => void;
      api.get.mockImplementationOnce((_adapter: string, signal?: AbortSignal) => {
        pendingSignal = signal;
        return new Promise(resolve => { finishOldRead = resolve; });
      });
      await act(async () => { window.dispatchEvent(new Event("focus")); });
      expect(pendingSignal?.aborted).toBe(false);
      await act(async () => sockets.at(-1).onclose?.());
      expect(pendingSignal?.aborted).toBe(true);
      expect(container.querySelector('[aria-label="工具思考强度"]')).toBeNull();
      expect(container.textContent).toContain("Extra");
      await act(async () => finishOldRead({
        entries: hydrogenEntries,
        status: "fresh",
        discoveryStatus: "complete",
        accountContextKey: "agy:default:a:e1:c1",
      }));
      await act(async () => combo.click());
      expect(document.querySelectorAll("[role=option]")).toHaveLength(0);
      expect(container.querySelector('[aria-label="工具思考强度"]')).toBeNull();
      expect(onChange).not.toHaveBeenCalled();

      // 重试尚未连接成功期间持续隐藏；连接恢复后才重核并恢复原 Extra。
      const callsBeforeOpen = api.get.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(api.get.mock.calls.length).toBe(callsBeforeOpen);
      expect(container.querySelector('[aria-label="工具思考强度"]')).toBeNull();
      await act(async () => sockets.at(-1).onopen?.());
      expect(container.querySelector<HTMLSelectElement>('[aria-label="工具思考强度"]')?.value).toBe("xhigh");
      expect(onChange).not.toHaveBeenCalled();

      // 1. 收到 WS 账号变更通知：立即作废旧 Hydrogen 选项与展开列表，并保留 Extra 摘要
      phase = "empty_fail";
      await act(async () => {
        sockets.at(-1).onmessage?.();
      });
      expect(document.querySelectorAll("[role=option]")).toHaveLength(0);
      expect(container.textContent).toContain("Extra");

      // 防抖到期后重查失败：AGY 不保留旧账号选项，但保留列表外 Extra 摘要
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(container.textContent).toContain("目录刷新失败");
      expect(container.textContent).toContain("Extra");
      await act(async () => combo.focus());
      expect(document.querySelectorAll("[role=option]")).toHaveLength(0);
      await act(async () => combo.blur());

      // 2. WS 重连恢复 (onclose -> onopen) 触发重核并恢复新账号目录
      phase = "b";
      const callsBeforeReconnect = api.get.mock.calls.length;
      await act(async () => {
        sockets.at(-1).onclose?.();
        await vi.advanceTimersByTimeAsync(5000);
        sockets[sockets.length - 1].onopen?.();
      });
      await act(async () => {});
      expect(api.get.mock.calls.length).toBeGreaterThan(callsBeforeReconnect);
      await act(async () => combo.focus());
      expect(document.body.textContent).toContain("Gemini 3.8 Flash");
      expect(document.body.textContent).not.toContain("Gemini 4 Hydrogen (High)");

      // 3. 页面获得焦点 (window focus) 再次触发目录重核
      const callsBeforeFocus = api.get.mock.calls.length;
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      expect(api.get.mock.calls.length).toBeGreaterThan(callsBeforeFocus);

      // 断线还应取消尚未触发的通知防抖，避免重连失败时自行重新开放旧目录。
      const callsBeforeDisconnect = api.get.mock.calls.length;
      await act(async () => {
        sockets.at(-1).onmessage?.();
        sockets.at(-1).onclose?.();
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(api.get.mock.calls.length).toBe(callsBeforeDisconnect);
      expect(container.querySelector('[aria-label="工具思考强度"]')).toBeNull();
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      (globalThis as any).WebSocket = OriginalWS;
    }
  });
});
