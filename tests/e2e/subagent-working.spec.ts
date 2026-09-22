import { test, expect } from "@playwright/test";
import {
  approvePlan,
  createNative,
  openExecutionSidebar,
  setNativeFixture,
  waitForSubagents,
  waitForWorkflowState,
  workCard,
} from "./native-helper.js";

test.describe.configure({ mode: "serial" });

async function startNested(
  page: Parameters<typeof createNative>[0],
  title: string,
  options: Record<string, unknown>,
) {
  await setNativeFixture(page, options);
  const id = await createNative(page, title, "new_worktree", false);
  await openExecutionSidebar(page);
  const tree = await waitForSubagents(page, id, 1);
  return { id, tree };
}

test("SA-E01 planning, execute and both reviews show nested work cards and roles", async ({
  page,
}) => {
  test.setTimeout(180000);
  const { id } = await startNested(page, "E01 规划开发复核工作卡", {
    nested: true,
    hold_ms: 8000,
  });
  await expect(workCard(page)).toBeVisible({ timeout: 30000 });
  await expect(page.locator(".conversation-composer-work")).toContainText(
    "规划模型",
  );
  const planning = await (
    await page.request.get(`/api/workflows/${id}`)
  ).json();
  expect(
    planning.runs.some((run: { purpose?: string }) => run.purpose === "planning"),
  ).toBe(true);
  await waitForWorkflowState(page, id, "PLAN_PENDING");
  await approvePlan(page);
  await expect(workCard(page)).toBeVisible({ timeout: 30000 });
  await expect
    .poll(async () => {
      const detail = await (
        await page.request.get(`/api/workflows/${id}`)
      ).json();
      return detail.runs.some(
        (run: { purpose?: string; status?: string }) =>
          run.purpose === "implement" && run.status === "running",
      )
        ? "implement"
        : detail.workflow.state;
    })
    .not.toBe("PLAN_PENDING");
  await waitForWorkflowState(page, id, "HUMAN_PENDING", 90000);
  await page.getByRole("button", { name: "验收通过，启动复核" }).click();
  await expect
    .poll(async () => {
      const detail = await (
        await page.request.get(`/api/workflows/${id}`)
      ).json();
      const purposes = detail.runs.map((run: { purpose?: string }) => run.purpose);
      return purposes.includes("quality_review") ? "reviewing" : purposes.join(",");
    }, { timeout: 60000 })
    .toBe("reviewing");
  await openExecutionSidebar(page);
  await expect(
    workCard(page).or(page.locator(".subagent-work-card")),
  ).toBeVisible({ timeout: 30000 });
});

test("SA-E02 mixed running, waiting and failed names match API", async ({
  page,
}) => {
  test.setTimeout(90000);
  const { id } = await startNested(page, "E02 混合子 Agent 状态", {
    mixed: true,
    hold_ms: 20000,
  });
  await expect(workCard(page)).toBeVisible();
  await expect(workCard(page)).toContainText("running-agent");
  await expect(workCard(page)).toContainText("waiting-agent");
  await expect(workCard(page)).toContainText("failed-agent");
  await expect(workCard(page)).toContainText("正在工作");
  await expect(workCard(page)).toContainText("等待中");
  await expect(workCard(page)).toContainText("失败");
  const tree = await (
    await page.request.get(`/api/workflows/${id}/conversations`)
  ).json();
  const attempts = new Map<string, { status: string; activity_summary?: string }>();
  for (const attempt of tree.attempts ?? []) {
    attempts.set(attempt.conversation_id, attempt);
  }
  const named = (tree.nodes ?? []).filter(
    (node: { kind?: string }) => node.kind === "subagent",
  );
  const statuses = named.map(
    (node: { id: string; title?: string }) =>
      attempts.get(node.id)?.status,
  );
  expect(statuses).toEqual(expect.arrayContaining(["running", "waiting", "failed"]));
  await expect(workCard(page)).toContainText("持续核对接口");
  await expect(workCard(page)).toContainText("等待测试结果");
  await expect(workCard(page)).toContainText("复现失败用例");
});

test("SA-E03 collapse does not call control API and keeps preference", async ({
  page,
}) => {
  test.setTimeout(90000);
  const controlWrites: string[] = [];
  await page.route("**/conversation-controls**", async (route) => {
    if (route.request().method() !== "GET") {
      controlWrites.push(route.request().url());
    }
    await route.continue();
  });
  const { id } = await startNested(page, "E03 收起工作卡偏好", {
    mixed: true,
    hold_ms: 20000,
  });
  const card = workCard(page);
  await expect(card).toBeVisible();
  await expect(card).toContainText("Working 1");
  await page.getByLabel("收起子 Agent 工作卡").click();
  await expect(page.getByRole("button", { name: /Working 1/ })).toBeVisible();
  expect(controlWrites).toEqual([]);
  await page.getByRole("button", { name: /Working 1/ }).click();
  await expect(card).toContainText("running-agent");
  await page.getByLabel("收起子 Agent 工作卡").click();
  await page.reload();
  await openExecutionSidebar(page);
  await expect(page.getByRole("button", { name: /Working 1/ })).toBeVisible({
    timeout: 15000,
  });
  expect(controlWrites).toEqual([]);
  const stored = await page.evaluate(
    (workflowId) => {
      const keys = Object.keys(localStorage).filter((key) =>
        key.startsWith("devflow.subagent-work-card." + workflowId),
      );
      return keys.map((key) => localStorage.getItem(key));
    },
    id,
  );
  expect(stored).toContain("collapsed");
});
