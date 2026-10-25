import { test, expect } from "@playwright/test";
import { exactLabel, pickListedModel, waitAccessStatus } from "./native-helper.js";

test("Gemini occupancy permits selecting and saving Claude, and Claude occupancy permits Gemini and custom IDs", async ({ page }) => {
  test.setTimeout(90000);
  let category = "gemini";
  await page.addInitScript(() => localStorage.setItem("devflow.first_run_completed", "true"));
  await page.route("**/api/agy-accounts", route => route.fulfill({ json: { active_category: category } }));
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "执行", exact: true }).click();
  await exactLabel(dialog, "工具").selectOption("agy");
  await exactLabel(dialog, "工具模型搜索").click();
  await expect(page.getByRole("option", { name: /Claude Opus 5\.5 Thinking/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /Claude Sonnet 5\.5/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /Claude (Opus|Sonnet) 4\.6/ })).toHaveCount(0);
  await exactLabel(dialog, "工具模型搜索").fill("claude-sonnet-5-5");
  await page.getByRole("option", { name: /Claude Sonnet 5\.5/ }).click();
  await expect(dialog).not.toContainText("类别冲突");
  await waitAccessStatus(dialog.locator(".ms-editor"), "已验证可访问");
  await dialog.getByRole("button", { name: "保存配置" }).click();
  await expect(dialog).not.toBeVisible({ timeout: 20000 });
  const saved = await page.request.get("/api/settings/model-defaults");
  expect((await saved.json()).defaults.executorProfile.modelId).toBe("claude-sonnet-5-5");

  category = "other";
  await page.getByRole("button", { name: "设置", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "执行", exact: true }).click();
  await pickListedModel(dialog, "工具", "gemini-3.8-flash-high");
  await waitAccessStatus(dialog.locator(".ms-editor"), "已验证可访问");
  await dialog.getByRole("button", { name: "保存配置" }).click();
  await expect(dialog).not.toBeVisible({ timeout: 20000 });
  const gemini = await page.request.get("/api/settings/model-defaults");
  expect((await gemini.json()).defaults.executorProfile.modelId).toBe("gemini-3.8-flash-high");

  await page.getByRole("button", { name: "设置", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "执行", exact: true }).click();
  const input = exactLabel(dialog, "工具模型搜索");
  await input.fill("claude-mixed-custom");
  await page.getByRole("option", { name: /使用自定义模型: claude-mixed-custom/ }).click();
  await expect(dialog).not.toContainText("类别冲突");
  await expect(input).toHaveValue(/claude-mixed-custom|Claude Mixed Custom/i);
});
