import { test, expect } from "@playwright/test";

test("continuous WebSocket output becomes visible before the stream ends and survives an older HTTP response", async ({
  page,
}) => {
  const workflow = {
    id: "wf-stream",
    title: "连续日志验收",
    project_id: "p1",
    state: "EXECUTING",
    version: 1,
    plan_revision: 1,
    environment_revision: 0,
    feedback: [],
  };
  const detail = {
    workflow,
    plan: null,
    tasks: [],
    evidence: [],
    runs: [],
    events: [],
    review: null,
    environment: null,
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const data =
      path === "/api/projects"
        ? [{ id: "p1", name: "日志测试" }]
        : path === "/api/workflows"
          ? [workflow]
          : detail;
    await route.fulfill({ json: data });
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  let sent = 0;
  await page.routeWebSocket("**/api/notifications", () => {});
  await page.routeWebSocket("**/api/events?*", (socket) => {
    timer = setInterval(() => {
      sent++;
      socket.send(
        JSON.stringify({
          workflow_id: workflow.id,
          project_id: "p1",
          event_seq: sent,
          created_at: new Date().toISOString(),
          type: sent % 10 === 0 ? "StateChanged" : "CheckOutput",
          payload: { text: `流式日志-${sent}` },
        }),
      );
    }, 30);
    socket.onClose(() => clearInterval(timer));
  });
  try {
    await page.goto("/");
    await page
      .getByRole("button")
      .filter({ has: page.getByRole("heading", { name: workflow.title }) })
      .click();
    await page.getByRole("button", { name: "实时输出", exact: true }).click();
    await expect(page.locator(".logs")).toContainText("流式日志-1", {
      timeout: 2000,
    });
    expect(timer).toBeDefined();
    await expect.poll(() => sent).toBeGreaterThan(20);
    // State events trigger HTTP snapshots with no events. Previously streamed
    // text must remain visible while the socket keeps sending every 30ms.
    await expect(page.locator(".logs")).toContainText("流式日志-1");
    await page.screenshot({ path: ".cache/e2e-log-stream.png" });
  } finally {
    clearInterval(timer);
  }
});
