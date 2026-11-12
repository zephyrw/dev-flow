import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelEntry } from "../../packages/contracts/src/model-catalog.js";
import { fetchToolModelsWithSWR } from "../../apps/web/src/components/group-model-catalog.js";
import { getAdapterModels, modelCatalogNeedsRefresh, refreshAdapterModels } from "../../apps/web/src/components/model-api.js";

vi.mock("../../apps/web/src/components/model-api.js", () => ({
  getAdapterModels: vi.fn(),
  refreshAdapterModels: vi.fn(),
  modelCatalogNeedsRefresh: vi.fn(),
}));

const entry: ModelEntry = {
  entryId: "codex/openai/example", adapterId: "codex", nativeId: "example", label: "Example",
  selectionKind: "fixed", effort: { status: "unsupported", transport: "none", values: [] },
  source: "native-live", discoveredAt: "2026-11-12T00:00:00Z", hidden: false,
  availability: "listed", capabilityRevision: "example-v1",
};

describe("group model directory confirmation", () => {
  beforeEach(() => vi.resetAllMocks());

  it("retains stale preview but rejects a failed refresh instead of confirming it", async () => {
    vi.mocked(getAdapterModels).mockResolvedValue({ entries: [entry], status: "stale", discoveryStatus: "complete" });
    vi.mocked(modelCatalogNeedsRefresh).mockReturnValue(true);
    vi.mocked(refreshAdapterModels).mockRejectedValue(new Error("refresh failed"));
    const preview = vi.fn();
    await expect(fetchToolModelsWithSWR("codex", preview)).rejects.toThrow("refresh failed");
    expect(preview).toHaveBeenCalledWith([expect.objectContaining({ nativeId: "example" })]);
  });

  it("uses the selected workspace for both discovery and the confirmed reread", async () => {
    const workspace = "workspace:C:/Projects/example";
    const buddy = { ...entry, adapterId: "codebuddy-code" as const };
    vi.mocked(getAdapterModels)
      .mockResolvedValueOnce({ entries: [], status: "missing" })
      .mockResolvedValueOnce({ entries: [buddy], status: "fresh", discoveryStatus: "complete" });
    vi.mocked(modelCatalogNeedsRefresh).mockReturnValue(true);
    const signal = new AbortController().signal;
    const result = await fetchToolModelsWithSWR("codebuddy-code", undefined, workspace, false, signal);
    expect(result).toEqual([expect.objectContaining({ nativeId: "example" })]);
    expect(refreshAdapterModels).toHaveBeenCalledWith("codebuddy-code", signal, workspace);
    expect(getAdapterModels).toHaveBeenNthCalledWith(2, "codebuddy-code", signal, workspace);
  });

  it("does not confirm a directory that is still missing after refresh", async () => {
    vi.mocked(getAdapterModels).mockResolvedValue({ entries: [], status: "missing" });
    vi.mocked(modelCatalogNeedsRefresh).mockReturnValue(true);
    await expect(fetchToolModelsWithSWR("codex")).rejects.toThrow("模型目录尚未确认");
  });

  it("does not publish a late response after the request has been cancelled", async () => {
    const controller = new AbortController();
    vi.mocked(getAdapterModels).mockImplementation(async () => {
      controller.abort();
      return { entries: [entry], status: "fresh", discoveryStatus: "complete" };
    });
    const preview = vi.fn();
    await expect(fetchToolModelsWithSWR("codex", preview, undefined, false, controller.signal)).rejects.toThrow();
    expect(preview).not.toHaveBeenCalled();
  });
});
