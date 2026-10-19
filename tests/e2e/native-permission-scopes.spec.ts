import { test, expect } from "@playwright/test";
import { mcpPermissionInput } from "../../packages/core/src/native-permission.js";
import { normalizeInteractionInput } from "../../packages/core/src/user-interaction-normalize.js";

test("MCP permission presents five scopes, selection details and source-bound submission", async ({ page }) => {
  const workflow = { id: "wf-mcp-scopes", project_id: "p1", title: "MCP 授权范围", state: "WAITING_INPUT", plan_revision: 1 };
  const project = { id: "p1", name: "隔离回归项目", data: { mode: "directory" }, repositories: [], commands: [] };
  const interaction = { id: "int-mcp-scopes", workflow_id: workflow.id, source_run_id: "run-mcp", source_plan_revision: 1,
    purpose: "execute", role: "executor", status: "pending", created_at: new Date().toISOString(),
    request: mcpPermissionInput({ server: "opentabs", method: "browser_intercept_requests" }) };
  let response: Record<string, unknown> | undefined;
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/user-interactions/current")) return route.fulfill({ json: { interaction: response ? null : interaction } });
    if (path.endsWith(`/user-interactions/${interaction.id}/respond`)) {
      response = route.request().postDataJSON();
      return route.fulfill({ json: { success: true, interaction: { ...interaction, status: "answered" } } });
    }
    if (path.endsWith("/projects")) return route.fulfill({ json: [project] });
    if (path.endsWith("/workflows")) return route.fulfill({ json: [workflow] });
    if (path.endsWith(`/workflows/${workflow.id}`)) return route.fulfill({ json: { workflow, project, tasks: [], events: [], runs: [], evidence: [], attention: null } });
    return route.fulfill({ json: [] });
  });
  await page.routeWebSocket("**/api/notifications", () => {});
  await page.routeWebSocket("**/api/events?*", () => {});
  await page.goto(`/?workflow=${workflow.id}`);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("radio")).toHaveCount(5);
  await expect(dialog.locator("input:checked")).toHaveCount(0);
  await expect(dialog).not.toContainText(/tabId|Arguments|urlPatterns|参数与目标/);
  const submit = dialog.getByRole("button", { name: "提交授权决定" });
  await expect(submit).toBeDisabled();
  for (const choice of interaction.request.choices!) {
    await dialog.locator(`input[value="${choice.id}"]`).check();
    await expect(dialog.getByRole("status")).toHaveText(choice.description!);
  }
  await dialog.locator('input[value="allow_method_once"]').check();
  await submit.click();
  await expect(dialog).not.toBeVisible();
  expect(response).toMatchObject({ source_run_id: "run-mcp", action: "answer", choice_id: "allow_method_once" });
});

test("assistance uses readable steps and collapsed technical details on desktop and mobile", async ({ page }) => {
  const workflow = { id: "wf-readable-help", project_id: "p1", title: "协助排版", state: "WAITING_INPUT", plan_revision: 1 };
  const project = { id: "p1", name: "隔离项目", data: { mode: "directory" }, repositories: [], commands: [] };
  const interaction = { id: "int-readable-help", workflow_id: workflow.id, source_run_id: "run-help", source_plan_revision: 1,
    purpose: "execute", role: "executor", status: "pending", created_at: new Date().toISOString(),
    request: normalizeInteractionInput({ kind: "action_required", title: "请完成操作协助", message: "Service Worker 内部状态已保存，需要授权。".repeat(12) }) };
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/user-interactions/current")) return route.fulfill({ json: { interaction } });
    if (path.endsWith("/projects")) return route.fulfill({ json: [project] });
    if (path.endsWith("/workflows")) return route.fulfill({ json: [workflow] });
    if (path.endsWith(`/workflows/${workflow.id}`)) return route.fulfill({ json: { workflow, project, tasks: [], events: [], runs: [], evidence: [], attention: null } });
    return route.fulfill({ json: [] });
  });
  await page.routeWebSocket("**/api/notifications", () => {});
  await page.routeWebSocket("**/api/events?*", () => {});
  await page.goto(`/?workflow=${workflow.id}`);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "我已完成，继续" })).toHaveCount(0);
  await expect(dialog.locator(".user-interaction-message p")).toHaveCount(2);
  await expect(dialog.locator("details")).not.toHaveAttribute("open", "");
  await dialog.getByText("查看技术说明", { exact: true }).click();
  expect(await dialog.locator("details p").count()).toBeGreaterThan(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(390);
  const overflow = await dialog.evaluate(element => element.scrollWidth > element.clientWidth);
  expect(overflow).toBe(false);
});
