import { describe, it, expect, vi, afterEach } from "vitest";
import {
  agyApi,
  terminalOperation,
} from "../../apps/web/src/components/agy-api.js";
afterEach(() => vi.unstubAllGlobals());
describe("account browser requests", () => {
  it("reports server failures instead of treating JSON error bodies as success", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              error: { code: "DOMAIN_BUSY", message: "外部 AGY 尚未退出" },
            }),
            { status: 409, headers: { "content-type": "application/json" } },
          ),
        ),
    );
    await expect(agyApi("/switch")).rejects.toThrow("外部 AGY 尚未退出");
  });
  it("treats asynchronous acceptance as pending and waits through external ownership", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              operation_id: "op",
              phase: "pending",
              revision: 1,
            }),
            { status: 202, headers: { "content-type": "application/json" } },
          ),
        ),
    );
    const receipt = await agyApi<{ phase: string }>("/switch");
    expect(terminalOperation(receipt.phase)).toBe(false);
    expect(terminalOperation("waiting_external_exit")).toBe(false);
    expect(terminalOperation("completed")).toBe(true);
  });
});
