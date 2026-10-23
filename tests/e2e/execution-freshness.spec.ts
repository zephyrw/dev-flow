import { test, expect } from "@playwright/test";
import { openExecutionSidebar } from "./native-helper.js";

test("execution distinguishes quiet and disconnected streams and keeps the send icon legible", async ({ page }) => {
  const workflow = { id: "wf-freshness", title: "执行进度刷新", project_id: "p1", state: "EXECUTING", version: 1, plan_revision: 1, environment_revision: 0, feedback: [] };
  const event = (seq: number, text: string, time: string) => ({
    workflow_id: workflow.id, project_id: "p1", event_seq: seq, run_id: "r", created_at: time,
    type: "NativeActivity", payload: { activity: { id: `message-${seq}`, kind: "message", title: "模型回复", text, status: "done" } },
  });
  // Use the same native event contract as the production projection.
  const message = (seq: number, text: string, time: string) => ({
    ...event(seq, text, time), type: "AgentEvent", payload: {
      event: "step_update", step_update: { step_index: seq, step_type: "agent_response", state: "DONE", text_delta: text },
    },
  });
  const detail = { workflow, plan: null, tasks: [], evidence: [], runs: [], runtime: null,
    events: [message(1, "旧进展", new Date(Date.now() - 120000).toISOString())], review: null, environment: null };
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ json: path === "/api/projects" ? [{ id: "p1", name: "测试" }]
      : path === "/api/workflows" ? [workflow]
      : /\/(functional-issues|asides)$/.test(path) ? [] : detail });
  });
  let stream: { send: (data: string) => void; close: () => void } | undefined;
  await page.routeWebSocket("**/api/notifications", () => {});
  await page.routeWebSocket("**/api/events?*", socket => { stream = socket; });
  await page.goto("/?workflow=" + workflow.id);
  await openExecutionSidebar(page);
  await expect(page.locator(".execution-stream-status")).toContainText("暂无新进展");
  const send = page.getByRole("button", { name: "发送", exact: true });
  await expect(send).toBeDisabled();
  const geometry = await send.evaluate(button => {
    const icon = button.querySelector("svg")!.getBoundingClientRect();
    const box = button.getBoundingClientRect();
    return { width: icon.width, offset: Math.abs(icon.x + icon.width / 2 - box.x - box.width / 2), color: getComputedStyle(button).color };
  });
  expect(geometry.width).toBe(15);
  expect(geometry.offset).toBeLessThan(1);
  expect(geometry.color).toBe("rgb(255, 255, 255)");
  await expect(send).toHaveCSS("background-color", "rgb(0, 0, 0)");
  await page.locator(".conversation-composer-input").fill("待发送内容");
  await expect(send).toBeEnabled();
  await send.hover();
  await expect(send).toHaveCSS("background-color", "rgb(0, 0, 0)");
  await expect(send).toHaveCSS("color", "rgb(255, 255, 255)");
  stream!.send(JSON.stringify(message(2, "新进展", new Date().toISOString())));
  await expect(page.locator(".logs")).toContainText("新进展");
  await expect(page.locator(".execution-stream-status")).toHaveCount(0);
  stream!.close();
  await expect(page.locator(".execution-stream-status")).toContainText("连接已断开");
});

for (const adapter of ["codex", "agy"] as const) {
  test(`each model row owns its quota button and isolates ${adapter} quotas`, async ({ page }) => {
    const model = adapter === "codex" ? "gpt-5" : "gemini-2.5-pro";
    const profile = (adapterId: string, modelId: string) => ({ adapterId, modelId });
    const workflow = { id: "wf-row-quota", title: "分行额度", state: "PLANNING", project_id: "p1", run_id: "r" };
    const timestamp = new Date().toISOString();
    const detail = { workflow, plan: null, tasks: [], evidence: [], events: [],
      execution_spec: { plannerProfile: profile(adapter, model), executorProfile: profile("agy", "claude-sonnet-4-5") },
      runs: [{ id: "r", purpose: "planning", status: "running", profile: profile(adapter, model) }],
      runtime: { run_id: "r", adapter, purpose: "planning", requested_model: model,
        status: "working", started_at: timestamp, updated_at: timestamp, active_tools: 0,
        quota: { source: "native_event", observed_at: timestamp, buckets: adapter === "codex"
          ? [{ id: "codex", windows: [{ window_minutes: 10080, used_percent: 20 }] }]
          : [
            { id: "Gemini Models", windows: [{ window_minutes: 10080, used_percent: 25 }] },
            { id: "Claude and GPT models", windows: [{ window_minutes: 10080, used_percent: 60 }] },
          ] } },
    };
    await page.route("**/api/**", route => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ json: path === "/api/projects" ? [{ id: "p1", name: "测试" }]
        : path === "/api/workflows" ? [workflow]
        : /\/(functional-issues|asides)$/.test(path) ? [] : detail });
    });
    await page.routeWebSocket("**/api/notifications", () => {});
    await page.routeWebSocket("**/api/events?*", () => {});
    await page.goto("/?workflow=" + workflow.id);
    const planner = page.locator('.runtime-model-row[data-role="planner"]');
    const executor = page.locator('.runtime-model-row[data-role="executor"]');
    await expect(page.locator(".current-runtime .quota-trigger-btn")).toHaveCount(2);
    for (const row of [planner, executor]) {
      const offset = await row.evaluate(el => {
        const model = el.querySelector(".runtime-row-btn")!.getBoundingClientRect();
        const quota = el.querySelector(".quota-trigger-btn")!.getBoundingClientRect();
        return Math.abs(model.y + model.height / 2 - quota.y - quota.height / 2);
      });
      expect(offset).toBeLessThan(1);
    }
    await planner.getByRole("button", { name: "查看规划工具额度" }).click();
    await expect(planner.getByRole("tooltip")).toContainText(adapter === "codex" ? "80%" : "75%");
    await executor.getByRole("button", { name: "查看执行工具额度" }).click();
    const quota = executor.getByRole("tooltip");
    await expect(quota).toContainText("Claude / GPT 额度");
    await expect(quota).toContainText(adapter === "codex" ? "未知" : "40%");
    await expect(quota).not.toContainText(adapter === "codex" ? "80%" : "75%");
    await expect(planner.getByRole("tooltip")).toHaveCount(0);
  });
}
