// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "../../apps/web/src/components/SettingsDialog.js";

// Mock 子组件以聚焦于 SettingsDialog Tab 导航行为与结构
vi.mock("../../apps/web/src/components/DefaultModelsPanel.js", () => ({
  DefaultModelsPanel: () => <div data-testid="default-models-panel">默认模型面板内容</div>,
}));

vi.mock("../../apps/web/src/components/ArchivedWorkflowsPanel.js", () => ({
  ArchivedWorkflowsPanel: () => <div data-testid="archived-workflows-panel">归档面板内容</div>,
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("SettingsDialog Tab 导航交互与状态", () => {
  let root: Root;
  let container: HTMLDivElement;
  const onClose = vi.fn();

  beforeEach(() => {
    onClose.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("默认打开激活'默认模型'Tab，高亮并展示模型配置内容", async () => {
    await act(async () => {
      root.render(<SettingsDialog isOpen={true} onClose={onClose} />);
    });

    const modelsTab = document.body.querySelector<HTMLButtonElement>(
      'button.settings-tab-btn[role="tab"]:nth-of-type(1)',
    );
    const archivesTab = document.body.querySelector<HTMLButtonElement>(
      'button.settings-tab-btn[role="tab"]:nth-of-type(2)',
    );

    expect(modelsTab).not.toBeNull();
    expect(archivesTab).not.toBeNull();

    expect(modelsTab?.textContent?.trim()).toBe("默认模型");
    expect(archivesTab?.textContent?.trim()).toBe("归档");

    // 状态断言：默认模型高亮激活，归档未激活
    expect(modelsTab?.getAttribute("aria-selected")).toBe("true");
    expect(modelsTab?.classList.contains("is-active")).toBe(true);

    expect(archivesTab?.getAttribute("aria-selected")).toBe("false");
    expect(archivesTab?.classList.contains("is-active")).toBe(false);

    // 内容区显示状态
    const modelsPanel = document.body.querySelector('[data-testid="default-models-panel"]');
    const archivesPanel = document.body.querySelector('[data-testid="archived-workflows-panel"]');

    expect(modelsPanel?.parentElement?.style.display).toBe("block");
    expect(archivesPanel?.parentElement?.style.display).toBe("none");
  });

  it("点击'归档'Tab切换到归档面板，对应Tab获得高亮", async () => {
    await act(async () => {
      root.render(<SettingsDialog isOpen={true} onClose={onClose} />);
    });

    const modelsTab = document.body.querySelector<HTMLButtonElement>(
      'button.settings-tab-btn[role="tab"]:nth-of-type(1)',
    );
    const archivesTab = document.body.querySelector<HTMLButtonElement>(
      'button.settings-tab-btn[role="tab"]:nth-of-type(2)',
    );

    await act(async () => {
      archivesTab?.click();
    });

    // 状态切换断言：归档高亮，默认模型取消高亮
    expect(archivesTab?.getAttribute("aria-selected")).toBe("true");
    expect(archivesTab?.classList.contains("is-active")).toBe(true);

    expect(modelsTab?.getAttribute("aria-selected")).toBe("false");
    expect(modelsTab?.classList.contains("is-active")).toBe(false);

    const modelsPanel = document.body.querySelector('[data-testid="default-models-panel"]');
    const archivesPanel = document.body.querySelector('[data-testid="archived-workflows-panel"]');

    expect(modelsPanel?.parentElement?.style.display).toBe("none");
    expect(archivesPanel?.parentElement?.style.display).toBe("block");
  });

  it("传入 initialTab='archives' 时初始激活归档 Tab", async () => {
    await act(async () => {
      root.render(<SettingsDialog isOpen={true} onClose={onClose} initialTab="archives" />);
    });

    const modelsTab = document.body.querySelector<HTMLButtonElement>(
      'button.settings-tab-btn[role="tab"]:nth-of-type(1)',
    );
    const archivesTab = document.body.querySelector<HTMLButtonElement>(
      'button.settings-tab-btn[role="tab"]:nth-of-type(2)',
    );

    expect(archivesTab?.getAttribute("aria-selected")).toBe("true");
    expect(archivesTab?.classList.contains("is-active")).toBe(true);

    expect(modelsTab?.getAttribute("aria-selected")).toBe("false");
    expect(modelsTab?.classList.contains("is-active")).toBe(false);
  });
});
