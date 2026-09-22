import { test, expect } from "@playwright/test";
import {
  approvePlan,
  createNative,
  openExecutionSidebar,
  setNativeFixture,
  waitForWorkflowState,
  workCard,
} from "./native-helper.js";

test.describe.configure({ mode: "serial" });

test("SA-E23 pause and resume keep planning and review purposes", async ({
  page,
}) => {
  test.setTimeout(180000);
  await setNativeFixture(page, { nested: true, hold_ms: 12000 });
  const id = await createNative(
    page,
    "E23 规划审查暂停继续",
    "new_worktree",
    false,
  );
  await openExecutionSidebar(page);
  await expect(workCard(page)).toBeVisible({ timeout: 30000 });
  const planning = await (await page.request.get(`/api/workflows/${id}`)).json();
  expect(planning.workflow.state).not.toBe("EXECUTING");
  await workCard(page)
    .getByRole("button", { name: "暂停当前主工作会话及全部子 Agent" })
    .click();
  await waitForWorkflowState(page, id, "STOPPED", 30000);
  await setNativeFixture(page, {});
  await page.getByRole("button", { name: "继续这个任务" }).click();
  await waitForWorkflowState(page, id, "PLAN_PENDING", 60000);
  const resumed = await (await page.request.get(`/api/workflows/${id}`)).json();
  expect(
    resumed.runs.every(
      (run: { purpose?: string }) => run.purpose !== "implement",
    ) || resumed.workflow.state === "PLAN_PENDING",
  ).toBe(true);
  await approvePlan(page);
  await waitForWorkflowState(page, id, "HUMAN_PENDING", 90000);
  await page.getByRole("button", { name: "验收通过，启动复核" }).click();
  await expect
    .poll(async () => {
      const detail = await (await page.request.get(`/api/workflows/${id}`)).json();
      const review = detail.runs.find(
        (run: { purpose?: string }) => run.purpose === "quality_review",
      );
      return review?.purpose ?? detail.workflow.state;
    }, { timeout: 60000 })
    .toBe("quality_review");
});
