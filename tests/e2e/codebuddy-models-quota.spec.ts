import { expect, test } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  approvePlan, exactLabel, fixtureState, setNativeFixture,
  waitForWorkflowState, workflowDetail,
} from "./native-helper.js";

test("从 CodeBuddy 原生目录选模型并持久化规划工具", async ({ page }) => {
  await page.goto("/");
  const initial = await page.request.get("/api/settings/model-defaults");
  expect(initial.ok()).toBeTruthy();
  const before = (await initial.json()).defaults.revision;
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.getByRole("tab", { name: "规划", exact: true }).click();
  await exactLabel(settings, "工具").selectOption("codebuddy-code");
  const model = exactLabel(settings, "工具模型搜索");
  await expect(model).not.toHaveValue("", { timeout: 20_000 });
  await expect(settings.getByText("版本 2.182.0 · 当前 CLI 登录账号 · 用户模型目录")).toBeVisible();
  await model.click();
  const options = page.getByRole("listbox", { name: "模型选项列表" });
  await model.fill("项目模型");
  await expect(options.getByRole("option", { name: /^项目模型/ })).toBeVisible();
  await model.fill("Hy4");
  await expect(options.getByRole("option", { name: /^Hy4 free/ })).toBeVisible();
  await options.getByRole("option", { name: /^Hy4 std/ }).click();
  await settings.getByRole("button", { name: "保存配置" }).click();
  await expect(settings).not.toBeVisible();
  const result = await page.request.get("/api/settings/model-defaults");
  expect(result.ok()).toBeTruthy();
  expect((await result.json()).defaults).toMatchObject({
    revision: before + 1,
    plannerProfile: { adapterId: "codebuddy-code", modelId: "hy4std" },
  });
  await page.getByRole("button", { name: "+ 新建", exact: true }).click();
  const create = page.locator(".modal-backdrop").last();
  await create.getByRole("tab", { name: "规划", exact: true }).click();
  await expect(exactLabel(create, "工具")).toHaveValue("codebuddy-code");
});

test("暂停并恢复项目专属 CodeBuddy 会话，执行计划并显示积分登录状态", async ({ page }) => {
  test.setTimeout(150_000);
  const repo: string = fixtureState().nativeRepo;
  await setNativeFixture(page, { hold_ms: 40_000 });
  const directory = join(repo, ".codebuddy");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "models.json"), JSON.stringify({
    models: [{ id: "fixture-project/e2e", name: "项目专属测试模型" }],
  }));
  await page.goto("/");
  await page.getByRole("button", { name: "+ 新建", exact: true }).click();
  const create = page.locator(".modal-backdrop").last();
  await create.getByLabel("任务名称", { exact: true }).fill("CodeBuddy 项目工作流");
  await create.getByLabel("工作区真实路径").fill(repo);
  for (const role of ["规划", "执行"]) {
    await create.getByRole("tab", { name: role, exact: true }).click();
    await exactLabel(create, "工具").selectOption("codebuddy-code");
    const search = exactLabel(create, "工具模型搜索");
    await expect(search).not.toHaveValue("", { timeout: 45_000 });
    await expect(create.getByText("版本 2.182.0 · 当前 CLI 登录账号 · 项目模型目录")).toBeVisible();
    await search.click();
    await search.fill("项目专属测试模型");
    await page.getByRole("listbox", { name: "模型选项列表" })
      .getByRole("option", { name: /^项目专属测试模型/ }).click();
  }
  await create.locator('input[name="workspaceMode"][value="existing_workspace"]').check();
  await create.locator("textarea").fill("修改测试仓库 app.txt 并完成自测");
  const posted = page.waitForResponse(r => r.url().endsWith("/api/workflows") && r.request().method() === "POST");
  await create.getByRole("button", { name: "创建并开始规划" }).click();
  const result = await posted;
  expect(result.status(), await result.text()).toBe(200);
  const workflowId: string = (await result.json()).workflow.id;
  const planningRuns = async (): Promise<Array<{ id: string; status: string; conversation_id?: string }>> =>
    (await workflowDetail(page, workflowId)).runs.filter((run: { purpose?: string }) => run.purpose === "planning");
  await expect.poll(async () => (await planningRuns())[0]?.conversation_id, { timeout: 20_000 }).toMatch(/^[\da-f-]{36}$/i);
  const [first] = await planningRuns();
  const sessionId = first!.conversation_id!;
  const sidecar = join(repo, `.devflow-fixture-${sessionId}.json`);
  expect(JSON.parse(readFileSync(sidecar, "utf8"))).toMatchObject({ runId: first!.id, sessionId });

  await page.getByRole("button", { name: "暂停", exact: true }).click();
  await waitForWorkflowState(page, workflowId, "STOPPED", 30_000);
  await setNativeFixture(page, {});
  await page.getByRole("button", { name: "继续规划", exact: true }).click();
  await waitForWorkflowState(page, workflowId, "PLAN_PENDING", 45_000);
  const resumed = await planningRuns();
  expect(resumed.find(run => run.id === first!.id)?.status).toBe("stopped");
  const completed = resumed.filter(run => run.status === "completed");
  expect(completed).toHaveLength(1);
  expect(completed[0]?.id).not.toBe(first!.id);
  expect(completed[0]?.conversation_id).toBe(sessionId);
  expect(JSON.parse(readFileSync(sidecar, "utf8"))).toMatchObject({ runId: completed[0]?.id, sessionId });
  await page.getByRole("button", { name: "查看规划工具额度" }).click();
  await expect(page.getByText("请登录 CodeBuddy CLI 后重试")).toBeVisible();
  const quotaUrl = `**/api/workflows/${workflowId}/quota?role=planner`;
  await page.route(quotaUrl, route => route.fulfill({ json: {
    adapter: "codebuddy-code", model: "fixture-project/e2e", credit_status: "available",
    quota: {
      source: "account_api", observed_at: new Date().toISOString(), buckets: [],
      credits: { remaining: 0, total: 20, used: 20, packages: [] },
    },
  } }));
  await page.reload();
  await page.getByRole("button", { name: "查看规划工具额度" }).click();
  const credits = page.getByRole("tooltip");
  await expect(credits.getByText("0 积分", { exact: true })).toBeVisible();
  await expect(credits.getByText("账号共享积分", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(credits).not.toBeVisible();
  await approvePlan(page);
  await expect.poll(() => readFileSync(join(repo, "app.txt"), "utf8"), { timeout: 45_000 }).toContain("after");
  const metadataDirectories = readFileSync(join(fixtureState().probeLogDir, "codebuddy-metadata-cwd.jsonl"), "utf8")
    .trim().split(/\r?\n/).map(line => JSON.parse(line));
  expect(metadataDirectories).toContain(repo);
  expect(metadataDirectories).not.toContain(process.cwd());
});
