// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { UserInteractionMessage, readableInteractionText } from "../../apps/web/src/components/UserInteractionMessage.js";
import { normalizeInteractionInput } from "../../packages/core/src/user-interaction-normalize.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const container = document.createElement("div");
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; });

it("renders headings, steps and code without executing HTML or loading remote images", async () => {
  root = createRoot(container);
  await act(async () => root!.render(<UserInteractionMessage text={'### 需要你操作\n\n1. 打开设置\n2. 选择 **此方法**\n\n```text\nopentabs/example\n```\n\n<script>alert(1)</script>\n\n![tracking](https://example.invalid/pixel)\n\n[unsafe](javascript:alert(1))'} />));
  expect(container.querySelector("h3")?.textContent).toBe("需要你操作");
  expect(container.querySelectorAll("ol li")).toHaveLength(2);
  expect(container.querySelector("pre code")?.textContent).toContain("opentabs/example");
  expect(container.querySelector("script,img,a[href^='javascript:']")).toBeNull();
});

it("adds paragraphs to old dense Chinese prose without changing its content", () => {
  const text = "当前进度已保存，等待处理浏览器权限。".repeat(12);
  const readable = readableInteractionText(text);
  expect(readable).toContain("。\n\n");
  expect(readable.replaceAll("\n", "")).toBe(text);
  const code = '`const value = "不改。代码"`' + text;
  expect(readableInteractionText(code)).toBe(code);
});

it("turns an old generic completion button into an explicit request for clarification", () => {
  const request = normalizeInteractionInput({ kind: "action_required", title: "请完成操作协助", message: "Service Worker 内部限制，需要授权", action_label: "我已完成，继续" });
  expect(request.kind).toBe("question");
  expect(request.message).not.toContain("Service Worker");
  expect(request.details).toContain("Service Worker");
  expect(request.choices?.[0]?.id).toBe("clarify_assistance");
  expect(request.action_label).not.toContain("已完成");
});
