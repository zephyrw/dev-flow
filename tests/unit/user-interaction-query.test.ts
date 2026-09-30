import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getCurrentUserInteraction,
  InteractionQueryError,
} from "../../apps/web/src/components/user-interaction-api.js";

afterEach(() => vi.unstubAllGlobals());

describe("交互查询错误", () => {
  it.each([
    [401, "permission", false],
    [403, "permission", false],
    [404, "http", false],
    [408, "http", true],
    [429, "http", true],
    [503, "service", true],
  ])("保留 HTTP %i 的分类与服务诊断", async (status, category, retryable) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          {
            error: {
              code: "TEST_FAILURE",
              message: "测试服务拒绝",
              request_id: "req-1",
            },
          },
          { status: Number(status) },
        ),
      ),
    );
    await expect(getCurrentUserInteraction("wf-1")).rejects.toMatchObject({
      category,
      retryable,
      status,
      code: "TEST_FAILURE",
      requestId: "req-1",
      message: expect.stringContaining(`HTTP ${status}`),
    });
  });

  it("区分网络断连并允许重试", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );
    await expect(getCurrentUserInteraction("wf-1")).rejects.toMatchObject({
      category: "network",
      retryable: true,
    });
  });

  it.each([
    "<html>旧页面</html>",
    "{}",
    '{"interaction":{"workflow_id":"wf-other"}}',
  ])("响应格式错误不能被当成没有交互: %s", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
    await expect(getCurrentUserInteraction("wf-1")).rejects.toMatchObject({
      category: "response",
      retryable: false,
      status: 200,
    });
  });

  it("明确的空交互成功返回 null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ interaction: null })),
    );
    await expect(getCurrentUserInteraction("wf-1")).resolves.toBeNull();
  });

  it("保留有效交互的会话归属字段，并拒绝另一个任务的记录", async () => {
    const record = {
      id: "int-1",
      workflow_id: "wf-1",
      source_run_id: "run-1",
      source_plan_revision: 1,
      root_conversation_id: "root-1",
      source_generation: 2,
      native_session_id: "session-1",
      purpose: "execute",
      role: "executor",
      status: "pending",
      created_at: "2026-09-30T00:00:00Z",
      request: {
        kind: "action_required",
        title: "请登录",
        message: "完成登录",
      },
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(async () => Response.json({ interaction: record })),
    );
    await expect(getCurrentUserInteraction("wf-1")).resolves.toEqual(record);
    await expect(getCurrentUserInteraction("wf-2")).rejects.toMatchObject({
      category: "response",
      retryable: false,
    });
  });

  it("读取响应过程中断连仍可自动重试", async () => {
    const response = Response.json({ interaction: null });
    vi.spyOn(response, "json").mockRejectedValue(new TypeError("terminated"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(getCurrentUserInteraction("wf-1")).rejects.toMatchObject({
      category: "network",
      retryable: true,
      status: 200,
    });
  });

  it("取消请求保留 AbortError，不能显示网络故障", async () => {
    const controller = new AbortController();
    controller.abort();
    const aborted = new DOMException("Aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(aborted));
    await expect(
      getCurrentUserInteraction("wf-1", controller.signal),
    ).rejects.toBe(aborted);
    expect(aborted).not.toBeInstanceOf(InteractionQueryError);
  });
});
