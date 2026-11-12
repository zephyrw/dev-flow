// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CreateWorkflowModal,
  checkPlannerImageSupport,
} from "../../apps/web/src/components/CreateWorkflowModal.js";
import { RequirementComposer } from "../../apps/web/src/components/RequirementComposer.js";
import { blankProfile, getModelDefaults } from "../../apps/web/src/components/model-api.js";

vi.mock("../../apps/web/src/components/model-api.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../apps/web/src/components/model-api.js")>(),
  getModelDefaults: vi.fn(),
  verifyModelAccess: vi.fn().mockResolvedValue({ status: "verified" }),
}));
vi.mock("../../apps/web/src/components/ModelConfigTabs.js", () => ({
  ModelConfigTabs: () => <div />,
}));

afterEach(() => vi.unstubAllGlobals());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function pasteImage(container: HTMLElement) {
  const file = new File(["image"], "pasted.png", { type: "image/png" });
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: {
    items: [{ kind: "file", type: file.type, getAsFile: () => file }],
    getData: () => "",
  } });
  container.querySelector("textarea")!.dispatchEvent(event);
}

async function mountAttachmentModal(fetchMock: typeof fetch) {
  vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) === "/api/workspaces/preview") {
      return Promise.resolve(Response.json({ preview_digest: "preview", repositories: [] }));
    }
    return fetchMock(input, init);
  });
  class PreviewUrl extends URL {
    static createObjectURL = vi.fn(() => "blob:draft-preview");
    static revokeObjectURL = vi.fn();
  }
  vi.stubGlobal("URL", PreviewUrl);
  vi.mocked(getModelDefaults).mockResolvedValue({
    revision: 1,
    plannerProfile: { ...blankProfile("planner", "codex"), modelId: "test-model" },
    executorProfile: blankProfile("executor", "agy"),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onClose = vi.fn();
  const onCreated = vi.fn();
  const render = async (isOpen: boolean) => act(async () => {
    root.render(<CreateWorkflowModal isOpen={isOpen} defaultWorkspaceRoot="C:\\test"
      onClose={onClose} onCreated={onCreated} />);
  });
  await render(true);
  return {
    container, onClose, onCreated, render,
    dispose: async () => {
      await act(() => root.unmount());
      container.remove();
    },
  };
}

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("A-paste-unit: 手动创建任务粘贴图片与剪贴板能力单元测试", () => {
  it("checkPlannerImageSupport 正确判断不同模型与图片格式支持度", () => {
    // AGY 仅支持 PNG / JPEG
    expect(checkPlannerImageSupport("agy", "image/png").supported).toBe(true);
    expect(checkPlannerImageSupport("agy", "image/jpeg").supported).toBe(true);
    expect(checkPlannerImageSupport("agy", "image/webp").supported).toBe(false);
    expect(checkPlannerImageSupport("agy", "image/webp").reason).toContain("PNG/JPEG");

    // Codex, Claude, OpenCode 支持普通图片
    expect(checkPlannerImageSupport("codex", "image/png").supported).toBe(true);
    expect(checkPlannerImageSupport("codex", "image/webp").supported).toBe(true);
    expect(checkPlannerImageSupport("claude-code", "image/png").supported).toBe(true);
    expect(checkPlannerImageSupport("opencode", "image/png").supported).toBe(true);

    // 不支持图片的模型 (CodeBuddy 适配器未声明 file_input，Grok 等)
    expect(checkPlannerImageSupport("codebuddy-code", "image/png").supported).toBe(false);
    expect(checkPlannerImageSupport("grok", "image/png").supported).toBe(false);
    expect(checkPlannerImageSupport("unknown-tool", "image/png").supported).toBe(false);

    // 非图片文件
    expect(checkPlannerImageSupport("codex", "application/pdf").supported).toBe(false);
    expect(checkPlannerImageSupport("codex", "image/bmp").supported).toBe(false);
    expect(checkPlannerImageSupport("codex", "image/avif").supported).toBe(false);
  });

  it("R08: 元数据响应到达前移除，按原请求取消且迟到响应不继续上传", async () => {
    const metadata = deferred<Response>();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      if (init?.method === "POST") return metadata.promise;
      return Response.json({ cancelled: true });
    });
    const modal = await mountAttachmentModal(fetchMock);
    try {
      await act(async () => pasteImage(modal.container));
      const [metadataUrl, metadataInit] = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
      const clientId = JSON.parse(metadataInit!.body as string).request_id;
      await act(async () => modal.container.querySelector<HTMLButtonElement>('[aria-label="移除附件"]')!.click());
      expect(fetchMock).toHaveBeenCalledWith(`${metadataUrl}/requests/${clientId}`, {
        method: "DELETE", keepalive: true,
      });
      expect(metadataInit!.signal!.aborted).toBe(true);
      await act(async () => metadata.resolve(Response.json({ file_id: "late-file" })));
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
      expect(modal.container.querySelector('[aria-label="移除附件"]')).toBeNull();
    } finally { await modal.dispose(); }
  });

  it("R08: 元数据响应丢失后重试，先取消原身份，再创建同草稿的新请求", async () => {
    const cancellation = deferred<Response>();
    let metadataCalls = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      if (init?.method === "POST") {
        if (++metadataCalls === 1) throw new Error("metadata response lost");
        return Response.json({ file_id: "retry-file", upload_path: "/retry-content" });
      }
      if (init?.method === "DELETE") return cancellation.promise;
      return Response.json({ status: "ready" });
    });
    const modal = await mountAttachmentModal(fetchMock);
    try {
      await act(async () => pasteImage(modal.container));
      const [originalUrl, originalInit] = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
      const originalClientId = JSON.parse(originalInit!.body as string).request_id;
      const retry = Array.from(modal.container.querySelectorAll("button")).find(button => button.textContent === "重试")!;
      await act(async () => retry.click());
      expect(metadataCalls).toBe(1);
      expect(modal.container.querySelector("textarea")!.disabled).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(`${originalUrl}/requests/${originalClientId}`, {
        method: "DELETE", keepalive: true,
      });
      await act(async () => cancellation.resolve(Response.json({ cancelled: true })));
      const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
      expect(posts).toHaveLength(2);
      expect(posts[1]![0]).toBe(originalUrl);
      expect(JSON.parse(posts[1]![1]!.body as string).request_id).not.toBe(originalClientId);
      expect(modal.container.querySelector("textarea")!.disabled).toBe(false);
      expect(modal.container.textContent).not.toContain("上传中...");
    } finally {
      cancellation.resolve(Response.json({ cancelled: true }));
      await modal.dispose();
    }
  });

  it("R08: 关闭按整草稿取消，重开后迟到元数据不污染新草稿", async () => {
    const metadata = deferred<Response>();
    const cancellation = deferred<Response>();
    let metadataCalls = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      if (init?.method === "POST" && ++metadataCalls === 1) return metadata.promise;
      if (init?.method === "DELETE") return cancellation.promise;
      return Response.json({ file_id: "new-file", upload_path: "/new-content" });
    });
    const modal = await mountAttachmentModal(fetchMock);
    try {
      await act(async () => pasteImage(modal.container));
      const [originalUrl] = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
      await act(async () => modal.container.querySelector<HTMLButtonElement>(".ms-head button")!.click());
      expect(modal.onClose).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledWith(originalUrl, { method: "DELETE", keepalive: true });
      await act(async () => cancellation.resolve(Response.json({ cancelled: true })));
      expect(modal.onClose).toHaveBeenCalledOnce();
      await modal.render(false);
      await modal.render(true);
      await act(async () => metadata.resolve(Response.json({ file_id: "late-file" })));
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
      await act(async () => pasteImage(modal.container));
      const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
      expect(posts[1]![0]).not.toBe(originalUrl);
      expect(modal.container.querySelectorAll('[aria-label="移除附件"]')).toHaveLength(1);
    } finally {
      cancellation.resolve(Response.json({ cancelled: true }));
      await modal.dispose();
    }
  });

  it("R08: 取消失败保留附件可重试，卸载仍回收整份未提交草稿", async () => {
    let cancellations = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      if (init?.method === "POST") return Response.json({ file_id: "file", upload_path: "/content" });
      if (init?.method === "DELETE" && ++cancellations === 1) return new Response(null, { status: 503 });
      return Response.json({ cancelled: true });
    });
    const modal = await mountAttachmentModal(fetchMock);
    try {
      await act(async () => pasteImage(modal.container));
      const remove = modal.container.querySelector<HTMLButtonElement>('[aria-label="移除附件"]')!;
      await act(async () => remove.click());
      expect(modal.container.querySelector('[aria-label="移除附件"]')).not.toBeNull();
      expect(modal.container.querySelector("textarea")!.disabled).toBe(false);
      await act(async () => remove.click());
      expect(modal.container.querySelector('[aria-label="移除附件"]')).toBeNull();
      await act(async () => pasteImage(modal.container));
      const [draftUrl] = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
      await modal.dispose();
      expect(fetchMock).toHaveBeenCalledWith(draftUrl, { method: "DELETE", keepalive: true });
    } finally {
      if (modal.container.isConnected) await modal.dispose();
    }
  });

  it("R08: 关闭取消响应丢失后保留窗口，只允许再次关闭确认取消", async () => {
    let cancellations = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      if (init?.method === "POST") return Response.json({ file_id: "file", upload_path: "/content" });
      if (init?.method === "DELETE" && ++cancellations === 1) throw new Error("cancel response lost");
      return Response.json({ cancelled: true });
    });
    const modal = await mountAttachmentModal(fetchMock);
    try {
      await act(async () => pasteImage(modal.container));
      const close = modal.container.querySelector<HTMLButtonElement>(".ms-head button")!;
      await act(async () => close.click());
      expect(modal.onClose).not.toHaveBeenCalled();
      expect(modal.container.querySelector("textarea")!.disabled).toBe(true);
      expect(close.disabled).toBe(false);
      await act(async () => close.click());
      expect(modal.onClose).toHaveBeenCalledOnce();
    } finally { await modal.dispose(); }
  });

  it("R08/R09: 创建成功后关闭及卸载不取消已绑定附件", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (String(url) === "/api/workflows") return Response.json({ workflow: { id: "created-workflow" } });
      if (init?.method === "POST") return Response.json({ file_id: "ready-file", upload_path: "/content" });
      return Response.json({ status: "ready" });
    });
    const modal = await mountAttachmentModal(fetchMock);
    try {
      await act(async () => pasteImage(modal.container));
      const title = modal.container.querySelector<HTMLInputElement>("#create-task-title")!;
      const textarea = modal.container.querySelector("textarea")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "需求图片");
        title.dispatchEvent(new Event("input", { bubbles: true }));
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "请读取需求图片");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const submit = Array.from(modal.container.querySelectorAll("button"))
        .find(button => button.textContent === "创建并开始规划")!;
      await act(async () => submit.click());
      expect(modal.onCreated).toHaveBeenCalledWith("created-workflow");
      const [, createInit] = fetchMock.mock.calls.find(([url]) => String(url) === "/api/workflows")!;
      expect(JSON.parse(createInit!.body as string).attachment_ids).toEqual(["ready-file"]);
      await modal.render(false);
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    } finally { await modal.dispose(); }
  });

  it("RequirementComposer 触发 onPasteImages，并正确处理图文混贴与光标文本插入", async () => {
    const onPasteImages = vi.fn();
    const onSubmit = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <RequirementComposer
            initialText="Hello "
            onSubmit={onSubmit}
            onPasteImages={onPasteImages}
          />,
        );
      });

      const textarea = container.querySelector("textarea")!;
      expect(textarea).not.toBeNull();

      // 设置光标位置在 "Hello " 末尾 (位置 6)
      textarea.setSelectionRange(6, 6);

      const fakeImage = new File(["dummy content"], "test.png", { type: "image/png" });
      const clipboardData = {
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => fakeImage,
          },
        ],
        files: [fakeImage],
        getData: (type: string) => (type === "text" ? "world!" : ""),
      };

      const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(pasteEvent, "clipboardData", { value: clipboardData });

      await act(async () => {
        textarea.dispatchEvent(pasteEvent);
      });

      expect(onPasteImages).toHaveBeenCalledTimes(1);
      expect(onPasteImages).toHaveBeenCalledWith([fakeImage]);
      // 光标处保留插入文字
      expect(textarea.value).toBe("Hello world!");
    } finally {
      await act(() => root.unmount());
      container.remove();
    }
  });

  it("CreateWorkflowModal 限制文件个数上限为 10，超过时阻止并提示", async () => {
    vi.mocked(getModelDefaults).mockResolvedValue({
      revision: 1,
      plannerProfile: { ...blankProfile("planner", "codex"), modelId: "test-model" },
      executorProfile: blankProfile("executor", "agy"),
    });

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <CreateWorkflowModal
            isOpen={true}
            defaultWorkspaceRoot="C:\\test"
            onClose={() => {}}
            onCreated={() => {}}
          />,
        );
      });

      const textarea = container.querySelector("textarea")!;
      // 构造 11 个图片
      const files = Array.from({ length: 11 }, (_, i) =>
        new File(["img"], `test_${i}.png`, { type: "image/png" }),
      );

      const clipboardData = {
        items: files.map(f => ({
          kind: "file",
          type: "image/png",
          getAsFile: () => f,
        })),
        files,
        getData: () => "",
      };
      const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(pasteEvent, "clipboardData", { value: clipboardData });

      await act(async () => {
        textarea.dispatchEvent(pasteEvent);
      });

      const errorDiv = container.querySelector(".ms-error");
      expect(errorDiv).not.toBeNull();
      expect(errorDiv!.textContent).toContain("每条消息最多 10 个附件");
    } finally {
      await act(() => root.unmount());
      container.remove();
    }
  });
});
