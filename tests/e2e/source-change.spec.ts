import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureState } from "./native-helper.js";

for (const choice of ["continue", "replan"] as const) {
  test(`项目代码已更新：${choice === "continue" ? "明确确认后按原计划继续" : "重新规划后等待批准"}`, async ({
    page,
  }) => {
    test.setTimeout(120000);
    const seeded = await page.request.post("/__fixture/source-change", {
      headers: { Origin: "http://localhost:14811" },
      data: { token: fixtureState().shutdownToken },
    });
    expect(seeded.status()).toBe(200);
    const f = await seeded.json();
    const get = async () =>
      (await page.request.get(`/api/workflows/${f.id}`)).json();
    await page.goto(`/?workflow=${f.id}`);
    await expect(page.locator(".attention-message")).toContainText(
      "项目代码在计划制定后发生了更新",
    );
    await expect(page.locator(".attention-message")).not.toContainText("基线");
    await expect(
      page.getByRole("button", { name: "继续这个任务", exact: true }),
    ).not.toBeVisible();
    const open = () =>
      page
        .locator(".compact-summary-actions")
        .getByRole("button", { name: "处理代码更新", exact: true })
        .click();
    await open();
    let dialog = page.getByRole("dialog", {
      name: "项目代码已更新",
      exact: true,
    });
    await expect(dialog).toContainText("补充项目说明", { timeout: 45000 });
    await expect(dialog).toContainText(f.old.slice(0, 8));
    await expect(dialog).toContainText(f.current.slice(0, 8));
    await expect(dialog).toContainText("本地未提交的修改");
    const before = (await get()).workflow;
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    expect((await get()).workflow).toEqual(before);
    await open();
    dialog = page.getByRole("dialog", { name: "项目代码已更新", exact: true });
    await expect(
      dialog.getByRole("button", {
        name: "确认使用当前代码并继续",
        exact: true,
      }),
    ).toBeEnabled({ timeout: 45000 });
    await page.screenshot({
      path: `.cache/source-change-${choice}.png`,
      fullPage: true,
    });
    if (choice === "continue")
      await dialog
        .getByRole("button", { name: "确认使用当前代码并继续", exact: true })
        .click();
    else {
      await dialog
        .getByLabel("补充规划要求（可选）")
        .fill("结合新说明补充检查");
      await dialog
        .getByRole("button", { name: "按当前代码重新规划", exact: true })
        .click();
    }
    await expect(dialog).not.toBeVisible({ timeout: 45000 });
    await expect
      .poll(async () => (await get()).workflow.state, { timeout: 90000 })
      .toBe(choice === "continue" ? "HUMAN_PENDING" : "REPAIR_PLAN_PENDING");
    const after = await get();
    expect(after.workflow.workspace_mode).toBe("existing_workspace");
    expect(after.plan.plan.baselines.main).toBe(f.current);
    expect(after.workflow.plan_revision).toBe(2);
    expect(readFileSync(join(f.repo, "personal.txt"), "utf8")).toBe(
      "用户未提交的内容\n",
    );
    if (choice === "replan") {
      expect(after.runs.map((r: any) => r.stage)).toEqual(["planning"]);
      await expect(
        page.getByRole("button", { name: "批准当前计划", exact: true }),
      ).toBeVisible();
    } else
      expect(after.workspaces[0]).toMatchObject({ root: f.repo, owned: false });
  });
}
