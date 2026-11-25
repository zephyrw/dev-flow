// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GroupChatPage } from "../../apps/web/src/group-chat.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;
const originalShowModal = HTMLDialogElement.prototype.showModal;
const originalClose = HTMLDialogElement.prototype.close;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  HTMLDialogElement.prototype.showModal = originalShowModal;
  HTMLDialogElement.prototype.close = originalClose;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const catalog = (
  adapterId: string,
  nativeId: string,
  label: string,
  effort: { status: "supported" | "unsupported"; transport: "flag" | "none"; values: string[] } = {
    status: "unsupported", transport: "none", values: [],
  },
) => ({
  adapterId,
  status: "fresh",
  discoveryStatus: "complete",
  entries: [{
    entryId: `${adapterId}/default/${nativeId}`,
    adapterId,
    nativeId,
    label,
    selectionKind: "fixed",
    effort,
    source: "native-live",
    discoveredAt: "2026-11-17T00:00:00Z",
    hidden: false,
    availability: "listed",
    capabilityRevision: "v1",
  }],
});

const setNativeValue = (el: HTMLInputElement | HTMLSelectElement, value: string) => {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
};

describe("群聊新增 CodeBuddy CLI 成员无需工作区", () => {
  it("选择 CodeBuddy CLI 时不展示工作区输入框，直接拉取默认目录并可保存成员与群聊", async () => {
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
    HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
    vi.useFakeTimers();

    const requests: { url: string; method: string; body?: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url: url.pathname + url.search, method, body });
      if (url.pathname === "/api/groups" && method === "GET") return Response.json([]);
      if (url.pathname === "/api/groups" && method === "POST") {
        return Response.json({ id: "g1", version: 1, ...body });
      }
      if (url.pathname === "/api/groups/g1/sessions") return Response.json({ items: [] });
      if (url.pathname === "/api/model-tools/codex/models") return Response.json(catalog("codex", "gpt-6-astra", "GPT-6 Astra", { status: "supported", transport: "flag", values: ["max", "high"] }));
      if (url.pathname === "/api/model-tools/agy/models") return Response.json(catalog("agy", "gemini-3.8-flash-high", "Gemini 3.8 Flash"));
      if (url.pathname === "/api/model-tools/codebuddy-code/models") return Response.json(catalog("codebuddy-code", "hy4std", "Hy4 Std"));
      throw new Error(`Unexpected request: ${method} ${url.pathname}${url.search}`);
    }));

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<GroupChatPage />));
    await act(async () => vi.advanceTimersByTimeAsync(150));

    const newGroupButton = Array.from(container.querySelectorAll("button"))
      .find(btn => btn.textContent?.includes("新建群聊"));
    expect(newGroupButton).toBeDefined();
    await act(async () => newGroupButton!.click());
    await act(async () => vi.advanceTimersByTimeAsync(250));

    // 移除默认成员，仅使用新增的 CodeBuddy CLI 成员建群
    for (let i = 0; i < 4; i++) {
      const removeButton = container.querySelector<HTMLButtonElement>('button[title="移除成员"]');
      await act(async () => removeButton!.click());
    }

    const addMemberButton = Array.from(container.querySelectorAll("button"))
      .find(btn => btn.textContent?.includes("新增成员"));
    expect(addMemberButton).toBeDefined();
    await act(async () => addMemberButton!.click());

    const dialogs = Array.from(container.querySelectorAll("dialog"));
    const memberDialog = dialogs.at(-1)!;
    expect(memberDialog.textContent).not.toContain("工作区");

    const selects = Array.from(memberDialog.querySelectorAll("select"));
    const toolSelect = selects[0]!;
    await act(async () => {
      setNativeValue(toolSelect, "codebuddy-code");
      toolSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => vi.advanceTimersByTimeAsync(250));

    expect(memberDialog.textContent).not.toContain("工作区");
    expect(memberDialog.textContent).not.toContain("请先填写 CodeBuddy 工作区");
    expect(requests.some(req => req.url === "/api/model-tools/codebuddy-code/models")).toBe(true);
    expect(requests.some(req => req.url.includes("scope_id="))).toBe(false);

    const modelSelect = Array.from(memberDialog.querySelectorAll("select"))[1]!;
    expect(modelSelect.disabled).toBe(false);
    await act(async () => {
      setNativeValue(modelSelect, "hy4std");
      modelSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const saveMemberBtn = Array.from(memberDialog.querySelectorAll("button"))
      .find(btn => btn.textContent?.includes("添加成员"))!;
    expect(saveMemberBtn.disabled).toBe(false);
    const memberForm = memberDialog.querySelector("form")!;
    await act(async () => {
      memberForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    const groupDialog = container.querySelector("dialog")!;
    expect(groupDialog.textContent).not.toContain("工作区");
    const titleInput = groupDialog.querySelector<HTMLInputElement>('input[name="title"]')!;
    await act(async () => {
      setNativeValue(titleInput, "无工作区群聊");
      titleInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const createGroupBtn = Array.from(groupDialog.querySelectorAll("button"))
      .find(btn => btn.textContent?.includes("创建群聊"))!;
    expect(createGroupBtn.disabled).toBe(false);
    const groupForm = groupDialog.querySelector("form")!;
    await act(async () => {
      groupForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    const createReq = requests.find(req => req.url === "/api/groups" && req.method === "POST");
    expect(createReq).toBeDefined();
    expect(createReq!.body).not.toHaveProperty("model_workspace");
    expect((createReq!.body as { members: Array<{ tool: string; model: string }> }).members)
      .toContainEqual(expect.objectContaining({ tool: "codebuddy-code", model: "hy4std" }));
  });
});
