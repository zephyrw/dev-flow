// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlanMaterialNotice } from "../../apps/web/src/components/PlanMaterialNotice.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it("shows the actual material error and refreshes the reader without approving or restarting a task", async () => {
  const onRetry = vi.fn(async () => {});
  act(() => root.render(<PlanMaterialNotice error={{ code: "PLAN_MATERIAL_CONFLICT",
    message: "计划原件引用与登记路径不一致" }} onRetry={onRetry} />));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("计划原件引用与登记路径不一致");
  await act(async () => container.querySelector("button")!.click());
  expect(onRetry).toHaveBeenCalledOnce();
  expect(container.querySelector("button")!.disabled).toBe(false);
});

it("keeps a failed retry visible instead of leaving the plan blank", async () => {
  act(() => root.render(<PlanMaterialNotice error={{ code: "PLAN_MATERIAL_LOST",
    message: "已登记的项目计划原件已丢失" }} onRetry={async () => { throw new Error("network"); }} />));
  await act(async () => container.querySelector("button")!.click());
  expect(container.textContent).toContain("重新读取失败");
  expect(container.textContent).toContain("已登记的项目计划原件已丢失");
});
