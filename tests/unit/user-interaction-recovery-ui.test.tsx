// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCurrentUserInteraction } from "../../apps/web/src/use-user-interaction.js";
import type { UserInteractionRecord } from "../../packages/contracts/src/user-interaction.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const pending: UserInteractionRecord = {
  id: "int-1",
  workflow_id: "wf-1",
  source_run_id: "run-1",
  source_plan_revision: 1,
  purpose: "execute",
  role: "executor",
  status: "pending",
  created_at: "2026-09-30T00:00:00Z",
  request: {
    kind: "action_required",
    title: "请登录",
    message: "完成登录",
    action_label: "已登录",
  },
};

describe("交互查询自动恢复与任务隔离", () => {
  let root: Root;
  let container: HTMLDivElement;
  let latest: ReturnType<typeof useCurrentUserInteraction>;
  const fetchMock = vi.fn<typeof fetch>();

  function Harness({ workflowId = "wf-1", state = "HUMAN_PENDING" }) {
    latest = useCurrentUserInteraction(workflowId, state);
    return (
      <div>
        {latest.fetchError || latest.interaction?.request.title || "无待办"}
      </div>
    );
  }
  async function render(workflowId = "wf-1", state = "HUMAN_PENDING") {
    await act(async () =>
      root.render(<Harness workflowId={workflowId} state={state} />),
    );
  }
  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }
  async function emit(type: string, workflowId = "wf-1") {
    await act(async () => {
      window.dispatchEvent(new CustomEvent(type, { detail: { workflowId } }));
    });
  }
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("人工验收阶段断连后自动查询成功并清除红条，无需切换任务", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockImplementation(async () => Response.json({ interaction: null }));
    await render();
    expect(container.textContent).toContain("无法连接本机服务");
    await advance(1000);
    expect(container.textContent).toBe("无待办");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(30000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["HUMAN_PENDING", "WAITING_INPUT"])(
    "%s 的服务失败最多自动重试三次",
    async (state) => {
      fetchMock.mockImplementation(async () =>
        Response.json({ error: { code: "UNAVAILABLE" } }, { status: 503 }),
      );
      await render("wf-1", state);
      await advance(1000);
      await advance(2000);
      await advance(4000);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      await advance(60000);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(container.textContent).toContain("HTTP 503");
    },
  );

  it.each([403, 200])("权限或格式错误不自动重试（HTTP %i）", async (status) => {
    fetchMock.mockImplementation(async () => new Response("{}", { status }));
    await render("wf-1", "WAITING_INPUT");
    await advance(60000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(
      status === 403 ? "访问权限" : "数据格式异常",
    );
  });

  it.each(["devflow-reconnected", "devflow-detail-refreshed"])(
    "%s 只恢复所属任务的交互",
    async (event) => {
      fetchMock.mockImplementation(
        async () => new Response("{}", { status: 403 }),
      );
      await render();
      fetchMock.mockImplementation(async () =>
        Response.json({ interaction: pending }),
      );
      await emit(event, "wf-other");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await emit(event);
      expect(container.textContent).toBe("请登录");
      expect(latest.fetchError).toBe("");
    },
  );

  it("切换任务取消旧请求，迟到的旧结果不能覆盖新任务", async () => {
    let resolveOld!: (response: Response) => void;
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockImplementation(async () => Response.json({ interaction: null }));
    await render();
    const signal = fetchMock.mock.calls[0]![1]!.signal!;
    await render("wf-2");
    expect(signal.aborted).toBe(true);
    await act(async () => resolveOld(Response.json({ interaction: pending })));
    expect(container.textContent).toBe("无待办");
    expect(latest.interaction).toBeNull();
    await advance(30000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("切换任务和卸载都取消待执行的重试", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockImplementation(async () => Response.json({ interaction: null }));
    await render();
    await render("wf-2");
    await advance(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockRejectedValue(new TypeError("offline"));
    await act(async () => latest.fetchInteraction());
    await act(async () => root.render(<div />));
    await advance(30000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("等待输入时同步其他窗口处理完成的交互", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ interaction: pending }))
      .mockImplementation(async () => Response.json({ interaction: null }));
    await render("wf-1", "WAITING_INPUT");
    expect(container.textContent).toBe("请登录");
    await advance(3000);
    expect(latest.interaction).toBeNull();
  });

  it("查询超时后有限重试，恢复时清除超时提示", async () => {
    fetchMock
      .mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init!.signal!.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      )
      .mockImplementation(async () => Response.json({ interaction: null }));
    await render();
    await advance(10000);
    expect(container.textContent).toContain("查询超时");
    await advance(1000);
    expect(container.textContent).toBe("无待办");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("查询进行中合并多个刷新信号，完成后补查且不反复中止", async () => {
    let resolveFirst!: (response: Response) => void;
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementation(async () => Response.json({ interaction: pending }));
    await render();
    await emit("devflow-detail-refreshed");
    await emit("devflow-reconnected");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(false);
    await act(async () => resolveFirst(Response.json({ interaction: null })));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("请登录");
  });
});
