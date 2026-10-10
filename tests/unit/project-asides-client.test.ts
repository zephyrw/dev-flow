import { afterEach, describe, expect, it, vi } from "vitest";
import { readProjectAsidePage } from "../../apps/web/src/use-project-asides.js";

afterEach(() => vi.unstubAllGlobals());

describe("project aside response contract", () => {
  it("retains valid paginated summaries and requests the snapshot cursor", async () => {
    const page = { items: [], total: 0, next_cursor: null, snapshot_cursor: 4 };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(page)));
    vi.stubGlobal("fetch", fetchMock);
    await expect(readProjectAsidePage("p1", { limit: 10, snapshot_cursor: 4 })).resolves.toEqual(page);
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/p1/asides?limit=10&snapshot_cursor=4", expect.objectContaining({ credentials: "same-origin" }));
  });

  it.each([{ bad: "structure" }, [], { items: {}, total: 1, next_cursor: null, snapshot_cursor: 1 }, { items: [], total: -1, next_cursor: null, snapshot_cursor: 1 }])("rejects a malformed page as a local API error", async value => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(value))));
    await expect(readProjectAsidePage("p1")).rejects.toThrow("项目提问响应格式无效");
  });
});
