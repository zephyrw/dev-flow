// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { QuotaPopover } from "../../apps/web/src/components/QuotaPopover.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

it("AGY keeps both window labels when one or both observations are unknown, without changing other tools", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<QuotaPopover categoryLabel="其他模型额度（Claude / GPT）" showUnknownWindows
      weeklyData={{ windowMinutes: 10080, remainingPercent: 80 }} />));
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(container.textContent).toContain("周额度剩余");
    expect(container.textContent).toContain("80%");
    expect(container.textContent).toContain("5小时额度剩余");
    expect(container.textContent).toContain("待实测 / 暂不可用");
    await act(async () => root.render(<QuotaPopover categoryLabel="其他模型额度（Claude / GPT）" showUnknownWindows />));
    expect(container.querySelectorAll(".quota-row")).toHaveLength(2);
    expect(container.querySelectorAll(".quota-percent-text")[0]?.textContent).toBe("未知");
    await act(async () => root.render(<QuotaPopover weeklyData={{ windowMinutes: 10080, remainingPercent: 80 }} />));
    expect(container.textContent).toContain("周额度剩余");
    expect(container.textContent).not.toContain("5小时额度剩余");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
