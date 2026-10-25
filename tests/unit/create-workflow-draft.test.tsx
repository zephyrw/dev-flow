// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CreateWorkflowModal } from "../../apps/web/src/components/CreateWorkflowModal.js";
import { blankProfile, getModelDefaults } from "../../apps/web/src/components/model-api.js";
import type { ModelConfigTabsProps } from "../../apps/web/src/components/ModelConfigTabs.js";

vi.mock("../../apps/web/src/components/model-api.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../apps/web/src/components/model-api.js")>(),
  getModelDefaults: vi.fn(),
}));
vi.mock("../../apps/web/src/components/ModelConfigTabs.js", () => ({
  ModelConfigTabs: ({ plannerProfile, onPlannerChange }: ModelConfigTabsProps) =>
    <button data-testid="model" onClick={() => onPlannerChange({ ...plannerProfile, modelId: "chosen-model" })}>{plannerProfile.modelId}</button>,
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("preserves an open draft across background project changes and uses the latest default on reopen", async () => {
  vi.mocked(getModelDefaults).mockResolvedValue({
    revision: 1,
    plannerProfile: { ...blankProfile("planner", "codex"), modelId: "default-model" },
    executorProfile: blankProfile("executor", "agy"),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (isOpen: boolean, path: string) => act(async () => { root.render(
    <CreateWorkflowModal isOpen={isOpen} defaultWorkspaceRoot={path} onClose={() => {}} onCreated={() => {}} />,
  ); });
  const path = () => container.querySelector<HTMLInputElement>("#create-workspace-root")!;
  const mode = () => container.querySelector<HTMLInputElement>('input[value="existing_workspace"]')!;
  try {
    await render(true, "initial-project");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(path(), "chosen-project");
      path().dispatchEvent(new Event("input", { bubbles: true }));
      mode().click();
      container.querySelector<HTMLButtonElement>('[data-testid="model"]')!.click();
      const textarea = container.querySelector("textarea")!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "保留完整需求");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await render(true, "late-project");
    expect(path().value).toBe("chosen-project");
    expect(mode().checked).toBe(true);
    expect(container.querySelector('[data-testid="model"]')!.textContent).toBe("chosen-model");
    expect(container.querySelector("textarea")!.value).toBe("保留完整需求");
    expect(getModelDefaults).toHaveBeenCalledTimes(1);

    await render(false, "late-project");
    await render(true, "latest-project");
    expect(path().value).toBe("latest-project");
    expect(container.querySelector('[data-testid="model"]')!.textContent).toBe("default-model");
    expect(container.querySelector("textarea")!.value).toBe("");
    expect(getModelDefaults).toHaveBeenCalledTimes(2);
  } finally {
    await act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  }
});
