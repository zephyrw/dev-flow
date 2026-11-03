import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import {
  approvePlan, dismissFirstRun, fixtureState, openExecutionSidebar, setNativeFixture,
  waitForWorkflowState, workflowDetail,
} from "./native-helper.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(120000);

async function createExecutionWorkflow(page: Page, title: string) {
  const state = fixtureState();
  const profile = { id: "continuation-test", revision: 1, adapterId: "codex",
    executableRef: process.execPath, modelSelection: "explicit", modelId: "gpt-6-astra",
    reasoning: { mode: "explicit", value: "medium" }, selectionKind: "fixed",
    options: { prefixArgs: [resolve("tests/fixtures/native-cli.mjs")] } };
  const response = await page.request.post("/api/workflows", {
    headers: { Origin: state.humanOrigin },
    data: { request_id: crypto.randomUUID(), title, workspace_root: state.nativeRepo,
      request_text: title, workspace_mode: "new_worktree", planner_profile: profile, executor_profile: profile },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const id = (await response.json()).workflow.id;
  await waitForWorkflowState(page, id, "PLAN_PENDING");
  await dismissFirstRun(page);
  await page.goto(`/?workflow=${id}`);
  await expect(page.getByRole("button", { name: "批准当前计划", exact: true })).toBeVisible();
  return id;
}

test.afterEach(async ({ page }) => {
  await setNativeFixture(page, {});
});

test("partial execution resumes automatically in the original session without a user dialog", async ({ page }, testInfo) => {
  await setNativeFixture(page, { execution_rounds: [
    { result: { status: "incomplete", summary: "已完成第一部分，继续剩余实现", completed_items: ["T01.prepare"], unfinished_items: ["T01.verify"] } },
  ] });
  const id = await createExecutionWorkflow(page, "提前总结自动续执行");
  await approvePlan(page);
  await waitForWorkflowState(page, id, "HUMAN_PENDING");
  const detail = await workflowDetail(page, id);
  const runs = detail.runs.filter((run: { purpose?: string }) => run.purpose === "implement");
  expect(runs).toHaveLength(2);
  expect(runs[0].conversation_id).toBeTruthy();
  expect(runs[1].conversation_id).toBe(runs[0].conversation_id);
  expect(runs[1].profile).toEqual(runs[0].profile);
  expect(detail.user_interactions).toEqual([]);
  expect(detail.events.filter((event: { type: string }) => event.type === "ExecutionContinuationScheduled")).toHaveLength(1);
  await openExecutionSidebar(page);
  await expect(page.locator(".logs")).toContainText("正在继续剩余任务");
  await expect(page.locator(".user-interaction-message")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("automatic-continuation.png"), fullPage: true });
  await page.reload();
  await expect(page.locator(".user-interaction-pending-banner")).toHaveCount(0);
});

test("a summary without a result is clarified automatically and then continues", async ({ page }) => {
  await setNativeFixture(page, { execution_rounds: [
    { result: { summary: "当前完成了第一部分，整理阶段记录。" } },
    { result: { status: "incomplete", summary: "仍有验证工作，可继续执行", completed_items: ["T01.prepare"], unfinished_items: ["T01.verify"] } },
  ] });
  const id = await createExecutionWorkflow(page, "阶段总结自动核对后继续");
  await approvePlan(page);
  await waitForWorkflowState(page, id, "HUMAN_PENDING");
  const detail = await workflowDetail(page, id);
  const runs = detail.runs.filter((run: { purpose?: string }) => run.purpose === "implement");
  expect(runs).toHaveLength(3);
  expect(new Set(runs.map((run: { conversation_id?: string }) => run.conversation_id)).size).toBe(1);
  const scheduled = detail.events.filter((event: { type: string }) => event.type === "ExecutionContinuationScheduled");
  expect(scheduled.map((event: { payload: { mode: string } }) => event.payload.mode)).toEqual(["clarify", "continue"]);
  expect(detail.user_interactions).toEqual([]);
  await expect(page.locator(".user-interaction-message")).toHaveCount(0);
});

test("a real operation request opens a dialog and never auto-confirms it", async ({ page }, testInfo) => {
  await setNativeFixture(page, { execution_rounds: [
    { result: { status: "incomplete", summary: "完成可独立执行的准备工作", completed_items: ["T01.prepare"] } },
    { result: { status: "need_user", summary: "需要用户完成隔离测试服务登录", user_interaction: {
      kind: "action_required", title: "请登录隔离测试服务",
      message: "请在隔离测试服务中完成登录；看到个人主页后点击确认，模型将检查登录状态并继续验证。",
      action_label: "已登录，继续验证",
    } } },
  ] });
  const id = await createExecutionWorkflow(page, "真实操作保留用户弹窗");
  await approvePlan(page);
  await waitForWorkflowState(page, id, "WAITING_INPUT");
  await expect(page.locator(".app-dialog-title")).toHaveText("请登录隔离测试服务");
  await expect(page.locator(".btn-interaction-confirm")).toHaveText("已登录，继续验证");
  await page.screenshot({ path: testInfo.outputPath("real-user-request.png"), fullPage: true });
  const before = await workflowDetail(page, id);
  expect(before.runs.filter((run: { purpose?: string }) => run.purpose === "implement")).toHaveLength(2);
  expect(before.user_interactions).toHaveLength(1);
  expect(before.user_interactions[0].status).toBe("pending");
  await page.getByRole("button", { name: "稍后处理" }).click();
  await expect(page.locator(".user-interaction-pending-banner")).toBeVisible();
  await page.reload();
  await expect(page.locator(".app-dialog-title")).toHaveText("请登录隔离测试服务");
  const after = await workflowDetail(page, id);
  expect(after.workflow.state).toBe("WAITING_INPUT");
  expect(after.runs).toHaveLength(before.runs.length);
  expect(after.user_interactions[0].response).toBeUndefined();
});

test("pausing an automatically continued run prevents further execution", async ({ page }, testInfo) => {
  await setNativeFixture(page, { execution_rounds: [
    { result: { status: "incomplete", summary: "已完成准备", completed_items: ["T01.prepare"] } },
    { hold_ms: 30000, result: { status: "incomplete", summary: "还有剩余验证", completed_items: ["T01.prepare"] } },
  ] });
  const id = await createExecutionWorkflow(page, "自动续执行期间暂停");
  await approvePlan(page);
  await expect.poll(async () => {
    const detail = await workflowDetail(page, id);
    return detail.runs.filter((run: { purpose?: string; status: string }) => run.purpose === "implement").length;
  }).toBe(2);
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  await waitForWorkflowState(page, id, "STOPPED");
  await page.reload();
  await expect(page.getByRole("button", { name: "暂停", exact: true })).toHaveCount(0);
  const detail = await workflowDetail(page, id);
  expect(detail.runs.filter((run: { purpose?: string }) => run.purpose === "implement")).toHaveLength(2);
  expect(detail.user_interactions).toEqual([]);
  expect(detail.workflow.state).toBe("STOPPED");
  await page.screenshot({ path: testInfo.outputPath("paused-continuation.png"), fullPage: true });
});
