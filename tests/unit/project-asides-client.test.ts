import { afterEach, describe, expect, it, vi } from "vitest";
import { readWorkflowAsidePage } from "../../apps/web/src/use-project-asides.js";

afterEach(() => vi.unstubAllGlobals());

describe("workflow aside response contract", () => {
  it("retains only current workflow summaries and requests the snapshot cursor", async () => {
    const page = {
      items: [
        {
          id: "aside_own",
          project_id: "p1",
          workflow_id: "wf1",
          workflow_title: "任务 1",
          question_preview: "只读提问",
          status: "completed",
          created_at: "2026-09-20T00:00:00.000Z",
        },
        {
          id: "aside_other",
          project_id: "p1",
          workflow_id: "wf2",
          workflow_title: "任务 2",
          question_preview: "不应展示",
          status: "completed",
          created_at: "2026-09-20T00:01:00.000Z",
        },
      ],
      total: 1,
      next_cursor: null,
      snapshot_cursor: 4,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(page)));
    vi.stubGlobal("fetch", fetchMock);
    const result = await readWorkflowAsidePage("wf1", {
      limit: 10,
      snapshot_cursor: 4,
    });
    expect(result.items.map((item) => item.id)).toEqual(["aside_own"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workflows/wf1/aside-history?limit=10&snapshot_cursor=4",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it.each([
    { bad: "structure" },
    [],
    { items: {}, total: 1, next_cursor: null, snapshot_cursor: 1 },
    { items: [], total: -1, next_cursor: null, snapshot_cursor: 1 },
  ])("rejects a malformed page as a local API error", async (value) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(value))),
    );
    await expect(readWorkflowAsidePage("wf1")).rejects.toThrow(
      "任务提问响应格式无效",
    );
  });
});
