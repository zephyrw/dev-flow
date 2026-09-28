import { test, expect } from "@playwright/test";

test("follows the current root after a role handoff and keeps test progress separate from command activity", async ({ page }) => {
  const workflow = { id: "wf-current-session", project_id: "p1", title: "当前主会话与测试进度",
    state: "EXECUTING", stage: "execute", plan_revision: 1, run_id: "review-run", version: 1 };
  const node = (id: string, adapter: string) => ({ id, root_id: id, workflow_id: workflow.id,
    kind: "main", title: "主会话", adapter_id: adapter, purpose: adapter === "agy" ? "implement" : "quality_review" });
  const attempt = (id: string, conversation: string, status: string) => ({ id, conversation_id: conversation,
    root_id: conversation, workflow_id: workflow.id, run_id: id, generation: 0, status,
    observed_at: "2026-09-28T08:00:00Z", requested_model: conversation === "agy-root" ? "gemini-fixture" : "codex-fixture" });
  const tree = { active_root_id: "review-root", nodes: [node("review-root", "codex"), node("agy-root", "agy")],
    attempts: [attempt("review-run", "review-root", "waiting"), attempt("agy-run", "agy-root", "running")], cursor: 1 };
  const detail = { workflow, project: { id: "p1", name: "隔离展示" },
    plan: { plan: { task_model: "native-v2", modules: [], tasks: [], tests: [] } }, tasks: [], runs: [],
    workspaces: [], evidence: [], attention: null, events: [] as unknown[],
    test_progress: { total: 3, passed: 1, failed: 0, cases: [
      { id: "U1", test_id: "U", layer: "unit", status: "passed", task_ids: [] },
      { id: "I1", test_id: "I", layer: "integration", status: "not_run", task_ids: [] },
      { id: "B1", test_id: "B", layer: "e2e", status: "unreported", task_ids: [] },
    ] },
    execution_test_report: { test_executions: [{ command: "old-reported-command", exit_code: 0 }] },
  };
  const writes: string[] = [], errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  await page.route("**/api/**", (route) => {
    if (route.request().method() !== "GET") writes.push(route.request().url());
    const path = new URL(route.request().url()).pathname;
    if (/\/(functional-issues|asides|diff)$/.test(path)) return route.fulfill({ json: [] });
    if (path.endsWith("/projects")) return route.fulfill({ json: [detail.project] });
    if (path.endsWith("/workflows")) return route.fulfill({ json: [workflow] });
    if (path.endsWith("/conversations")) return route.fulfill({ json: tree });
    if (path.endsWith("/activities")) return route.fulfill({ json: { items: [], has_more: false } });
    return route.fulfill({ json: detail });
  });
  let socket: { send(data: string): void } | undefined;
  await page.routeWebSocket("**/api/notifications", () => {});
  await page.routeWebSocket("**/api/events?*", (ws) => { socket = ws; });
  await page.goto(`/?workflow=${workflow.id}`);
  await expect(page.locator(".execution-sidebar")).toBeVisible();
  await expect(page.locator(".conversation-view-runtime")).toContainText("Codex");
  await expect.poll(() => !!socket).toBe(true);
  workflow.run_id = "agy-run"; workflow.version++; tree.active_root_id = "agy-root"; tree.cursor++;
  const command = { workflow_id: workflow.id, run_id: "agy-run", event_seq: 3,
    created_at: "2026-09-28T08:00:03Z", type: "AgentEvent", payload: { event: "step_update", step_update: {
      step_type: "tool", tool_name: "run_command", step_index: 1, state: "ACTIVE",
      tool_info: { parameters: { CommandLine: "pnpm vitest run current-target.test.ts" } },
    } } };
  detail.events = [command];
  socket!.send(JSON.stringify({ workflow_id: workflow.id, event_seq: 2, run_id: "agy-run",
    created_at: "2026-09-28T08:00:02Z", type: "StateChanged", payload: { from: "QUEUED", to: "EXECUTING", resumed: true } }));
  socket!.send(JSON.stringify(command));
  await expect(page.locator(".conversation-view-runtime")).toContainText("Antigravity");
  await expect(page.locator(".conversation-view-runtime")).toContainText("正在工作");
  await expect(page.locator(".logs")).toContainText("current-target.test.ts");
  const strip = page.getByLabel("交付进度");
  await expect(strip).not.toContainText(/已执行自测|自测运行中|最近自测/);
  await page.getByRole("button", { name: "测试进度", exact: true }).click();
  const tests = page.locator(".test-results-container");
  await expect(tests).toContainText("单元测试");
  await expect(tests).toContainText("集成测试");
  await expect(tests).toContainText("浏览器自动测试");
  await expect(tests.locator(".module-badge")).toHaveText(["1 / 1 报告通过", "0 / 1 报告通过", "尚未收到测试结果"]);
  await expect(tests).not.toContainText("current-target.test.ts");
  await expect(tests).not.toContainText("old-reported-command");
  await expect(tests.locator(".command-preview")).toHaveCount(0);

  // Explicitly requested history remains history, even though AGY is active.
  await page.goto(`/?workflow=${workflow.id}&conversation=review-root`);
  await expect(page.locator(".conversation-view-runtime")).toContainText("Codex");
  await expect(page).toHaveURL(/conversation=review-root/);
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
});
