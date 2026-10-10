import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { approvePlan, createNative, fixtureState, openFixtureWorkflow, testInstance, sendComposerText } from "./native-helper.js";
import { git } from "../../packages/git/src/git.js";
test.describe.configure({ mode: "serial" });
test("empty console explains the natural-language entry without manual registration", async ({
  page,
}) => {
  await page.route("**/api/projects", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/workflows", (route) => route.fulfill({ json: [] }));
  await page.goto("/");
  await page.getByRole("button", { name: "使用指南", exact: true }).click();
  await expect(page.locator(".guide-page")).toContainText(
    "用 DevFlow 帮我修复客户列表筛选的问题",
  );
  await page.reload();
  await expect(page.locator(".guide-page")).toBeVisible();
  await expect(page.locator(".guide-page textarea")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "如何开始新任务" }),
  ).toHaveCount(0);
});
test.afterAll(async ({ request }) => {
  const state = fixtureState();
  await request.post("/__fixture/shutdown", {
    headers: { Origin: testInstance().humanOrigin },
    data: { token: state.shutdownToken },
  });
});
test("E2E-01/05/06/08 local button approval, diagrams, evidence and accepted commit", async ({
  page,
  context,
}) => {
  // This scenario performs two actual test runs, local confirmations and a Git
  // commit. Keep per-assertion waits bounded without capping the whole flow at 45s.
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const state = fixtureState();
  await page.goto("/");
  await expect(page.getByLabel("配对码")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /登录|通行密钥/ })).toHaveCount(
    0,
  );
  await openFixtureWorkflow(page);
  await page.getByRole("button", { name: "开发计划", exact: true }).click();
  await expect(page.locator(".diagram svg")).toBeVisible();
  await page.screenshot({ path: ".cache/e2e-plan.png", fullPage: true });
  await approvePlan(page);
  await expect(page.locator(".header-title-wrapper .badge")).toContainText(
    "等待你的验收",
    {
      timeout: 60000,
    },
  );
  await page.getByRole("button", { name: "测试进度", exact: true }).click();
  await page.locator(".task-module > summary").first().click();
  await expect(page.locator(".test-case")).toContainText("已通过");
  await page.getByRole("button", { name: "任务进度", exact: true }).click();
  await expect(page.locator(".task .badge")).toHaveText("开发完成");
  await page.screenshot({ path: ".cache/e2e-evidence.png", fullPage: true });
  const before = await (
    await page.request.get("/api/workflows/" + state.workflow_id)
  ).json();
  if (!(await page.locator(".execution-sidebar").isVisible()))
    await page.getByRole("button", { name: "执行过程", exact: true }).click();
  await sendComposerText(page, "请在原批准范围内再次核对内容与末尾换行，并重新运行测试。");
  await expect
    .poll(async () => {
      const d = await (
        await page.request.get("/api/workflows/" + state.workflow_id)
      ).json();
      return d.runs.length;
    })
    .toBeGreaterThan(before.runs.length);
  await expect(page.locator(".header-title-wrapper .badge")).toContainText(
    "等待你的验收",
    {
      timeout: 60000,
    },
  );
  const after = await (
    await page.request.get("/api/workflows/" + state.workflow_id)
  ).json();
  // Guidance asks for a read-only content recheck and an actual test rerun.
  // Retain prior proof and require new passing evidence from the next Run.
  expect(before.development_evidence.length).toBeGreaterThan(0);
  for (const previous of before.development_evidence)
    expect(after.development_evidence.find((e: any) => e.id === previous.id)).toEqual(previous);
  const previousIds = new Set(before.development_evidence.map((e: any) => e.id));
  const freshEvidence = after.development_evidence.filter((e: any) => !previousIds.has(e.id));
  expect(freshEvidence.length).toBeGreaterThan(0);
  expect(freshEvidence.every((e: any) => e.status === "passed" && e.passed === 1 && e.exit_code === 0)).toBe(true);
  await page.reload();
  if (!(await page.locator(".execution-sidebar").isVisible()))
    await page.getByRole("button", { name: "执行过程", exact: true }).click();
  await expect(page.locator(".logs")).toContainText("开始开发与自测");
  await page.getByRole("button", { name: "验收通过，启动复核" }).click();
  await expect(page.locator(".header-title-wrapper .badge")).toContainText(
    "已提交",
    {
      timeout: 60000,
    },
  );
  await page.getByRole("button", { name: "代码复核", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "独立复核结果" }),
  ).toBeVisible();
  await expect(page.getByText("本轮复核", { exact: false })).toContainText(
    "通过",
  );
  await expect(page.getByText("main:app.txt", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "代码变更", exact: true }).click();
  await expect(page.locator(".changed-files")).toContainText("app.txt");
  await page.locator(".changed-files button").first().click();
  await expect(page.locator(".file-diff")).toContainText("+after");
  const lines = page.locator(".file-diff span");
  const firstLine = await lines.nth(0).boundingBox(),
    secondLine = await lines.nth(1).boundingBox();
  expect(secondLine!.y).toBeGreaterThan(firstLine!.y);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "文件差异" })).toHaveCount(0);
  await page.screenshot({ path: ".cache/e2e-complete.png", fullPage: true });
  expect(errors).toEqual([]);
});
test("E2E-05 a fresh browser opens the console and restores a deep link without login", async ({
  page,
}) => {
  const state = fixtureState();
  await page.goto("/?workflow=" + state.workflow_id);
  await expect(page.locator(".header-title-wrapper .badge")).toContainText(
    "已提交",
  );
  await page.reload();
  await expect(page.locator(".header-title-wrapper .badge")).toContainText(
    "已提交",
  );
  expect((await page.request.get("/api/workflows")).status()).toBe(200);
  await expect(page.getByRole("button", { name: /登录|通行密钥/ })).toHaveCount(
    0,
  );
});
test("quality policy 2 planner integration repair merges both histories after human acceptance", async ({ page }) => {
  test.setTimeout(900000);
  const id = await createNative(page, "冲突复测：将文本改为 after");
  const get = async () =>
    (await page.request.get("/api/workflows/" + id)).json();
  const nativeRepo = fixtureState().nativeRepo;
  await approvePlan(page);
  await expect(page.locator(".header-title-wrapper .badge")).toContainText(
    "等待你的验收",
    { timeout: 450000 },
  );
  writeFileSync(join(nativeRepo, "app.txt"), "upstream line\n");
  await git(nativeRepo, ["add", "app.txt"]);
  await git(nativeRepo, ["commit", "-m", "conflict upstream commit"]);
  const upstreamCommit = await git(nativeRepo, ["rev-parse", "HEAD"]);
  await page.getByRole("button", { name: "验收通过，启动复核" }).click();
  await expect
    .poll(
      async () => {
        const detail = await get();
        if (
          detail.workflow.state === "BLOCKED" ||
          detail.workflow.state === "COMMIT_PARTIAL" ||
          detail.workflow.state === "WAITING_INPUT"
        )
          throw new Error(
            JSON.stringify({
              state: detail.workflow.state,
              stage: detail.workflow.stage,
              blocker: detail.workflow.blocker,
              runs: detail.runs.map(
                (run: {
                  stage?: string;
                  purpose?: string;
                  status?: string;
                  result?: { error?: string };
                }) => ({
                  stage: run.stage,
                  purpose: run.purpose,
                  status: run.status,
                  error: run.result?.error,
                }),
              ),
            }),
          );
        return detail.workflow.state;
      },
      { timeout: 450000 },
    )
    .toMatch(/COMPLETED|COMMITTED/);
  const finalDetail = await get();
  expect(finalDetail.workflow.quality_policy_version).toBe(2);
  const commitRuns = finalDetail.runs.filter((run: { purpose: string }) => run.purpose === "planner_commit");
  expect(commitRuns).toHaveLength(2);
  expect(commitRuns.every((run: { stage: string; status: string }) => run.stage === "planner_commit" && run.status === "completed")).toBe(true);
  expect(commitRuns[1].dispatch_context.source_run_id).toBe(commitRuns[0].id);
  const workspace = finalDetail.workspaces.find((workspace: { repo_id: string; root: string }) => workspace.repo_id === "main");
  const taskCommit = await git(workspace.root, ["log", "--format=%H", "--grep=^test: native fixture$", "--max-count=2"]);
  const [mergedCommit, originalTaskCommit] = taskCommit.trim().split(/\r?\n/);
  expect(mergedCommit).toBeTruthy();
  expect(originalTaskCommit).toBeTruthy();
  await git(nativeRepo, ["merge-base", "--is-ancestor", upstreamCommit.trim(), "HEAD"]);
  await git(nativeRepo, ["merge-base", "--is-ancestor", originalTaskCommit!, "HEAD"]);
  expect(readFileSync(join(nativeRepo, "app.txt"), "utf8")).toBe("after\nupstream line\n");
  await expect(page.locator(".header-title-wrapper .badge")).toContainText(
    /已提交|已完成/,
  );
});
