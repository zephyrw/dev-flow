import { test, expect } from "@playwright/test";
import { executionSpec, openFixtureWorkflow, openTaskModels } from "./native-helper.js";

for (const surface of ["settings", "workflow"] as const) {
  for (const outcome of ["loaded", "failed"] as const) {
    test(`AGY model name stays stable in ${surface} while catalog is pending then ${outcome}`, async ({ page }) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let requested = false;
      const catalogPath = "/api/model-tools/agy/models";
      await page.route("**" + catalogPath, async (route) => {
        requested = true;
        await gate;
        if (outcome === "failed") {
          await route.fulfill({ status: 503, json: { message: "目录加载失败" } });
        } else {
          await route.continue();
        }
      });
      try {
        const workflowId = surface === "workflow" ? await openFixtureWorkflow(page) : null;
        const before = workflowId
          ? (await executionSpec(page, workflowId)).spec.executorProfile
          : (await (await page.request.get("/api/settings/model-defaults")).json()).defaults.executorProfile;
        expect(before).toMatchObject({ adapterId: "agy", modelId: "gemini-3.8-flash-high" });
        const dialog = surface === "workflow"
          ? await openTaskModels(page, "执行")
          : await (async () => {
            await page.goto("/");
            await page.getByRole("button", { name: "设置", exact: true }).click();
            const settings = page.getByRole("dialog", { name: "设置", exact: true });
            await settings.getByRole("tab", { name: "执行", exact: true }).click();
            return settings;
          })();
        const input = dialog.getByRole("combobox", { name: "工具模型搜索", exact: true });
        await expect.poll(() => requested).toBe(true);
        await expect(input).toHaveValue("Gemini 3.8 Flash");
        const response = page.waitForResponse((r) => new URL(r.url()).pathname === catalogPath);
        release();
        expect((await response).status()).toBe(outcome === "loaded" ? 200 : 503);
        if (outcome === "failed") {
          await expect(dialog.locator(".ms-error")).toContainText("目录加载失败");
        } else {
          await expect(dialog.getByLabel("工具思考强度", { exact: true })).toBeVisible();
        }
        await expect(input).toHaveValue("Gemini 3.8 Flash");
        await dialog.getByRole("button", { name: "取消", exact: true }).click();
        const after = workflowId
          ? (await executionSpec(page, workflowId)).spec.executorProfile
          : (await (await page.request.get("/api/settings/model-defaults")).json()).defaults.executorProfile;
        expect(after).toEqual(before);
      } finally {
        release();
      }
    });
  }
}
