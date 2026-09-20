import { test, expect } from "@playwright/test";
import {
  createNative,
  fixtureState,
  showInteraction,
} from "./native-helper.js";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
test(
  "原生真实 UI 到规划、质量审查、问题复测、终审及工作树交付",
  { tag: "@native" },
  async ({ page }) => {
    test.setTimeout(900000);
    const id = await createNative(page, "原生端到端：将文本改为 after");
    const get = async () =>
      (await page.request.get("/api/workflows/" + id)).json();
    const before = await get();
    const root = before.workspaces[0].root,
      branch = before.workspaces[0].branch;
    await page.getByRole("button", { name: "批准当前计划" }).click();
    await expect(page.locator(".header-title-wrapper .badge")).toContainText(
      "等待你的验收",
      { timeout: 450000 },
    );
    expect((await get()).runs.map((r: any) => r.stage)).toEqual([
      "planning",
      "execute",
      "quality_before_human",
    ]);
    await showInteraction(page);
    await page.locator(".guidance-form textarea").fill("核对原计划末尾换行 @");
    await expect(page.locator(".reference-popup")).toBeVisible();
    await page.getByText("app.txt", { exact: true }).last().click();
    await page.getByRole("button", { name: "发送指导并继续" }).click();
    await expect(
      page.getByRole("button", { name: "复测通过", exact: true }),
    ).toBeVisible({ timeout: 240000 });
    const unconfirmed = await page.request.post(
      "/api/workflows/" + id + "/confirm-function",
      {
        headers: { Origin: "http://localhost:14811" },
        data: {
          request_id: "premature",
          expected_version: (await get()).workflow.version,
          snapshot_id: (await get()).workflow.snapshot_id,
        },
      },
    );
    expect(unconfirmed.status()).toBe(422);
    await page.getByRole("button", { name: "复测通过", exact: true }).click();
    await expect(page.getByLabel("任务反馈记录")).toContainText("已确认");
    await page.getByRole("button", { name: "验收通过，启动复核" }).click();
    await expect
      .poll(async () => (await get()).workflow.state, { timeout: 240000 })
      .toBe("COMPLETED");
    const source = fixtureState().nativeRepo;
    expect(
      execFileSync("git", ["show", "HEAD:app.txt"], {
        cwd: source,
        encoding: "utf8",
      }),
    ).toBe("after\n");
    expect(existsSync(root)).toBe(false);
    expect(
      execFileSync("git", ["branch", "--list", branch], {
        cwd: source,
        encoding: "utf8",
      }).trim(),
    ).toBe("");
    const issues = await (
      await page.request.get("/api/workflows/" + id + "/functional-issues")
    ).json();
    expect(issues[0].status).toBe("confirmed");
  },
);
