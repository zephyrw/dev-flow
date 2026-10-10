import { mockProject } from "./mock-workflow.js";
import { test, expect } from "@playwright/test";

test("active planning can pause and task/header indicators distinguish pauses, waits, and errors", async ({ page }) => {
  const flows = [
    { id: "planning", state: "PLANNING" }, { id: "waiting", state: "BLOCKED", blocker: { code: "NEED_USER" } },
    { id: "failed", state: "BLOCKED", blocker: { code: "MODEL_CONNECTION_FAILED" } },
  ].map(f => ({ ...f, project_id: "p", title: `任务 ${f.id}`, version: 1, plan_revision: 0 }));
  const detail = (id: string) => ({ workflow: flows.find(f => f.id === id), project: { ...mockProject(), data: { mode: "directory" }, id: "p", name: "暂停展示" },
    plan: null, tasks: [], runs: [], events: [], evidence: [], test_progress: { total: 0, cases: [] },
    attention: id === "waiting" ? { category: "error", message: "等待输入", action: "查看执行过程" } : null });
  const writes: string[] = [], errors: Error[] = [];
  let notifications: { send(data: string): void } | undefined;
  page.on("pageerror", e => errors.push(e));
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "POST") {
      writes.push(path);
      if (path === "/api/workflows/planning/stop") {
        flows[0]!.state = "STOPPED"; flows[0]!.version++;
        notifications?.send(JSON.stringify({ workflow_id: "planning", type: "StateChanged" }));
      }
      return route.fulfill({ json: { ok: true } });
    }
    if (/\/(functional-issues|asides)$/.test(path)) return route.fulfill({ json: [] });
    if (path.endsWith("/projects")) return route.fulfill({ json: [{ id: "p", name: "暂停展示" }] });
    if (path.endsWith("/workflows")) return route.fulfill({ json: flows });
    return route.fulfill({ json: detail(path.split("/").at(-1)!) });
  });
  await page.routeWebSocket("**/api/notifications", ws => { notifications = ws; });
  await page.routeWebSocket("**/api/events?*", () => {});
  await page.goto("/?workflow=planning");
  const pause = page.getByRole("button", { name: "暂停", exact: true });
  await expect(pause).toBeEnabled();
  await expect(pause).toHaveClass("warning");
  await pause.click();
  await expect(page.locator(".header-title-wrapper .badge")).toHaveClass(/workflow-tone-warning/);
  await expect(page.locator(".flow-nav-item", { hasText: "任务 planning" }).locator(".dot")).toHaveClass(/workflow-tone-warning/);
  await expect(pause).toHaveCount(0);
  await page.getByRole("button", { name: "任务 waiting", exact: true }).click();
  await expect(page.locator(".header-title-wrapper .badge")).toHaveClass(/workflow-tone-warning/);
  await expect(page.locator(".flow-nav-item", { hasText: "任务 waiting" }).locator(".dot")).toHaveClass(/workflow-tone-warning/);
  await expect(page.locator(".attention-strip.error")).toHaveCount(0);
  await page.getByRole("button", { name: "任务 failed", exact: true }).click();
  await expect(page.locator(".header-title-wrapper .badge")).toHaveClass(/workflow-tone-error/);
  await expect(page.locator(".flow-nav-item", { hasText: "任务 failed" }).locator(".dot")).toHaveClass(/workflow-tone-error/);
  expect(writes).toEqual(["/api/workflows/planning/stop"]);
  expect(errors).toEqual([]);
});
