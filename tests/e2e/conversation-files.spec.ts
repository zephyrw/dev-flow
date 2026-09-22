import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  composerInput,
  createNative,
  fixtureState,
  openExecutionSidebar,
  setNativeFixture,
} from "./native-helper.js";

test.describe.configure({ mode: "serial" });

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function tempUpload(name: string, content: string | Buffer) {
  const dir = join(tmpdir(), "devflow-e2e-files");
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, name);
  writeFileSync(filePath, content);
  return filePath;
}

async function waitReady(page: Parameters<typeof composerInput>[0], name: string) {
  await expect(
    page.locator(".conversation-attachment-chip").filter({ hasText: name }),
  ).toContainText("已就绪", { timeout: 20000 });
}

test("SA-E08 upload ready files, refresh keeps them, fixture reads bytes", async ({
  page,
}) => {
  test.setTimeout(180000);
  await setNativeFixture(page, { read_attachments: true });
  const id = await createNative(page, "E08 上传附件发送", "new_worktree");
  await openExecutionSidebar(page);
  const text = tempUpload("e08.txt", "fixture-attachment-bytes\n");
  await page.getByRole("button", { name: "添加附件或引用" }).click();
  await page.getByRole("menuitem", { name: "上传本地文件" }).click();
  await page
    .locator(".conversation-attachment-bar input[type=file]")
    .setInputFiles(text);
  await waitReady(page, "e08.txt");
  await composerInput(page).fill("请读取刚上传的附件");
  const sent = page.waitForResponse(
    (response) =>
      response.url().includes("/conversation-messages") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "发送", exact: true }).click();
  expect((await sent).ok()).toBe(true);
  await page.goto(`/?workflow=${id}`);
  await openExecutionSidebar(page);
  const messages = await (
    await page.request.get(`/api/workflows/${id}/messages`)
  ).json();
  expect(JSON.stringify(messages)).toContain("请读取刚上传的附件");
  await expect
    .poll(() => {
      const capture = join(fixtureState().nativeRepo, ".devflow-fixture-last-prompt.txt");
      return existsSync(capture) ? readFileSync(capture, "utf8") : "";
    }, { timeout: 45000 })
    .toMatch(/e08\.txt|attachment|附件/);
});

test("SA-E09 drag, paste, workspace cite, file-only send and /btw attachment", async ({
  page,
}) => {
  test.setTimeout(180000);
  await setNativeFixture(page, { read_attachments: true });
  const id = await createNative(page, "E09 拖放粘贴引用", "new_worktree");
  await openExecutionSidebar(page);
  const drag = tempUpload("e09-drag.txt", "drag-file-body");
  const composer = page.locator("[data-conversation-composer]");
  const dragBytes = readFileSync(drag);
  await composer.evaluate(async (node, payload) => {
    const bytes = Uint8Array.from(atob(payload), (char) => char.charCodeAt(0));
    const file = new File([bytes], "e09-drag.txt", { type: "text/plain" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    node.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
  }, dragBytes.toString("base64"));
  await waitReady(page, "e09-drag.txt");
  const input = composerInput(page);
  await page.getByRole("button", { name: "添加附件或引用" }).click();
  await page.getByRole("menuitem", { name: "引用工作区文件或目录" }).click();
  await expect(input).toHaveValue("@");
  await input.type("app.txt");
  const popup = page.locator(".reference-popup");
  await expect(popup).toBeVisible({ timeout: 10000 });
  await popup.getByText("app.txt", { exact: true }).click();
  const sent = page.waitForResponse(
    (response) =>
      response.url().includes("/conversation-messages") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "发送", exact: true }).click();
  expect((await sent).ok()).toBe(true);
  await expect
    .poll(
      async () => {
        const messages = await (
          await page.request.get(`/api/workflows/${id}/messages`)
        ).json();
        return JSON.stringify(messages);
      },
      { timeout: 20000 },
    )
    .toMatch(/app\.txt|e09-drag/);
  await composerInput(page).fill("/btw 附件里写了什么？");
  await page.getByRole("button", { name: "添加附件或引用" }).click();
  await page.getByRole("menuitem", { name: "上传本地文件" }).click();
  await page
    .locator(".conversation-attachment-bar input[type=file]")
    .setInputFiles(tempUpload("e09-btw.txt", "btw-only"));
  await waitReady(page, "e09-btw.txt");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator("[data-aside-popover]")).toBeVisible({ timeout: 20000 });
});

test("SA-E10 oversize, too many, failed upload, unsupported, delete retry and task switch", async ({
  page,
}) => {
  test.setTimeout(180000);
  await setNativeFixture(page, {});
  const first = await createNative(page, "E10 附件失败保留草稿", "new_worktree");
  await openExecutionSidebar(page);
  const draft = "不要因为附件失败而丢失这句草稿";
  await composerInput(page).fill(draft);
  await page.getByRole("button", { name: "添加附件或引用" }).click();
  await page.getByRole("menuitem", { name: "上传本地文件" }).click();
  const huge = tempUpload("e10-huge.bin", Buffer.alloc(20 * 1024 * 1024 + 64, 1));
  await page
    .locator(".conversation-attachment-bar input[type=file]")
    .setInputFiles(huge);
  await expect(page.locator(".conversation-attachment-limit")).toContainText(
    "单个附件超过 20 MiB",
  );
  await expect(composerInput(page)).toHaveValue(draft);
  const many = Array.from({ length: 11 }, (_, index) =>
    tempUpload(`e10-${index}.txt`, "x"),
  );
  await page.getByRole("button", { name: "添加附件或引用" }).click();
  await page.getByRole("menuitem", { name: "上传本地文件" }).click();
  await page
    .locator(".conversation-attachment-bar input[type=file]")
    .setInputFiles(many);
  await expect(page.locator(".conversation-attachment-limit")).toContainText(
    "每条消息最多 10 个附件",
  );
  await page.route("**/conversation-files/**/content", async (route) => {
    await route.fulfill({
      status: 500,
      json: { error: { message: "夹具上传失败" } },
    });
  });
  await page.getByRole("button", { name: "添加附件或引用" }).click();
  await page.getByRole("menuitem", { name: "上传本地文件" }).click();
  await page
    .locator(".conversation-attachment-bar input[type=file]")
    .setInputFiles(tempUpload("e10-fail.txt", "fail-upload"));
  await expect(
    page.locator(".conversation-attachment-chip").filter({ hasText: "e10-fail.txt" }),
  ).toContainText("上传失败", { timeout: 15000 });
  await page.unroute("**/conversation-files/**/content");
  await page.getByRole("button", { name: "重试" }).click();
  await expect(
    page.locator(".conversation-attachment-chip").filter({ hasText: "e10-fail.txt" }),
  ).toContainText("已就绪", { timeout: 20000 });
  await page.getByLabel("移除 e10-fail.txt").click();
  await page
    .locator(".conversation-attachment-bar input[type=file]")
    .setInputFiles(
      tempUpload("e10.exe", Buffer.from("MZ")),
    );
  await expect(
    page.locator(".conversation-attachment-chip").filter({ hasText: "e10.exe" }),
  ).toContainText("当前工具无法读取此附件类型");
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
  await expect(composerInput(page)).toHaveValue(draft);
  await setNativeFixture(page, {});
  const second = await createNative(page, "E10 另一个任务", "new_worktree");
  expect(second).not.toBe(first);
  await page.goto(`/?workflow=${first}`);
  await openExecutionSidebar(page);
  await expect(composerInput(page)).toHaveValue(draft);
});
