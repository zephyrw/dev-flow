// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CurrentRuntime } from "../../apps/web/src/components/CurrentRuntime.js";
import { QuotaPopover } from "../../apps/web/src/components/QuotaPopover.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("shows a confirmed zero as shared credits and removes it on logout", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.append(container);
  try {
    await act(async () => root.render(<QuotaPopover open creditQuota={{
      status: "available", value: { remaining: 0, packages: [] },
    }} />));
    expect(container.textContent).toContain("0 积分");
    expect(container.textContent).toContain("账号共享积分");
    expect(container.textContent).not.toContain("周额度");
    await act(async () => root.render(<QuotaPopover open creditQuota={{ status: "auth-required" }} />));
    expect(container.textContent).toContain("请登录 CodeBuddy CLI");
    expect(container.textContent).not.toContain("0 积分");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("drops old credits when the next quota request fails before confirming account scope", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.append(container);
  vi.useFakeTimers();
  const fetchQuota = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({
      adapter: "codebuddy-code",
      model: "auto",
      credit_status: "available",
      quota: { source: "account_api", observed_at: new Date().toISOString(), buckets: [], credits: { remaining: 17, packages: [] } },
    })))
    .mockResolvedValueOnce(new Response(null, { status: 503 }));
  vi.stubGlobal("fetch", fetchQuota);
  try {
    await act(async () => root.render(<CurrentRuntime connected detail={{
      workflow: { id: "quota-workflow", state: "PLAN_PENDING" },
      execution_spec: { spec: { plannerProfile: { adapterId: "codebuddy-code", modelId: "auto" } } },
    }} />));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="查看规划工具额度"]')!.click());
    expect(container.textContent).toContain("17 积分");
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(fetchQuota).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("暂时无法查询积分");
    expect(container.textContent).not.toContain("17 积分");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    vi.useRealTimers();
    container.remove();
  }
});
