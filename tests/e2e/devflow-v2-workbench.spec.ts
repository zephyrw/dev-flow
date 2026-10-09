import { test, expect } from "@playwright/test";
import {
  createNative,
  fixtureState,
  showInteraction,
} from "./native-helper.js";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
test(
  "原生真实 UI 到规划、质量审查、指导续修、终审及工作树交付",
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
    await page.getByRole("dialog", { name: "批准执行计划", exact: true })
      .getByRole("button", { name: "批准并开始执行", exact: true }).click();
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
    await page.locator(".task-interaction textarea").fill("核对原计划 app.txt 的末尾换行并重新自测。");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(async () => (await get()).runs.length, { timeout: 45000 }).toBeGreaterThan(3);
    await expect.poll(async () => (await get()).workflow.state, { timeout: 240000 }).toBe("HUMAN_PENDING");
    expect((await get()).runs.at(-1).purpose).toBe("functional_fix");
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
    expect(existsSync(root)).toBe(true);
    expect(
      execFileSync("git", ["branch", "--list", branch], {
        cwd: source,
        encoding: "utf8",
      }).trim(),
    ).not.toBe("");
  },
);
