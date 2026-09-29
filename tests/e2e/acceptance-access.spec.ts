import { test, expect } from "@playwright/test";

test("removed local-copy tab falls back to overview and acceptance keeps real links and controls", async ({ page }) => {
  const workflow = { id: "wf-acceptance-access", project_id: "p1", title: "人工验收入口", state: "HUMAN_PENDING", plan_revision: 1, version: 4 };
  const detail = { workflow, project: { id: "p1", name: "隔离验收展示", services: [{ id: "web", port_pool: "frontend" }] },
    plan: { plan: { task_model: "leaf-v1", modules: [], tasks: [], tests: [] } }, tasks: [], evidence: [], runs: [], events: [],
    test_progress: { total: 0, cases: [] }, attention: { category: "acceptance", message: "等待你实际操作验收", action: "查看本机验证副本" },
    environment: { status: "ready", services: [{ id: "web", status: "ready", origin: "http://127.0.0.1:15321" }] } };
  const writes: string[] = [], errors: Error[] = [];
  page.on("pageerror", error => errors.push(error));
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "POST") { writes.push(path); return route.fulfill({ json: { ok: true } }); }
    if (/\/(functional-issues|asides)$/.test(path)) return route.fulfill({ json: [] });
    if (path.endsWith("/projects")) return route.fulfill({ json: [detail.project] });
    if (path.endsWith("/workflows")) return route.fulfill({ json: [workflow] });
    return route.fulfill({ json: detail });
  });
  await page.routeWebSocket("**/api/notifications", () => {});
  await page.routeWebSocket("**/api/events?*", () => {});
  await page.addInitScript(() => sessionStorage.setItem("devflow.tab.wf-acceptance-access", "environment"));
  await page.goto(`/?workflow=${workflow.id}`);
  await expect(page.locator(".tabs .active")).toHaveText("概览");
  await expect(page.locator(".tabs")).not.toContainText("本机验证副本");
  await expect(page.locator(".environment-summary")).toHaveCount(0);
  await page.getByRole("button", { name: "查看人工验收", exact: true }).click();
  const acceptance = page.getByRole("region", { name: "人工验收", exact: true });
  await expect(acceptance).toBeFocused();
  await expect(acceptance.getByRole("link", { name: "打开验收页面 ↗" })).toHaveAttribute("href", "http://127.0.0.1:15321");
  await acceptance.getByRole("button", { name: "占用人工核验浏览器", exact: true }).click();
  await acceptance.getByRole("button", { name: "释放人工核验浏览器", exact: true }).click();
  await acceptance.getByRole("button", { name: "释放环境", exact: true }).click();
  await expect.poll(() => writes).toEqual([`/api/workflows/${workflow.id}/browser/lock`, `/api/workflows/${workflow.id}/browser/release`, `/api/workflows/${workflow.id}/environment/stop`]);
  expect(errors).toEqual([]);
});
