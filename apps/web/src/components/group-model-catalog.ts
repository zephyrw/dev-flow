import { buildModelChoices, type ModelChoice } from "../../../../packages/presentation/src/model-display.js";
import { getAdapterModels, modelCatalogNeedsRefresh, refreshAdapterModels } from "./model-api.js";

// The server owns account/configuration-scoped caches. Never reuse a browser
// cache from another workspace or treat an unsuccessful refresh as verified.
export async function fetchToolModelsWithSWR(
  tool: string,
  onPreview?: (choices: ModelChoice[]) => void,
  scopeId?: string,
  forceRefresh = false,
  signal?: AbortSignal,
): Promise<ModelChoice[]> {
  const adapter = tool === "codebuddy" ? "codebuddy-code" : tool;
  const choicesFor = (data: Awaited<ReturnType<typeof getAdapterModels>>) =>
    buildModelChoices(data.entries.filter(entry => entry.adapterId === adapter &&
      entry.selectionKind === "fixed" && !entry.hidden && entry.availability !== "unavailable" &&
      (adapter !== "agy" || entry.availability === "listed")));
  let data = await getAdapterModels(adapter, signal, scopeId);
  signal?.throwIfAborted();
  onPreview?.(choicesFor(data));
  if (forceRefresh || modelCatalogNeedsRefresh(data)) {
    await refreshAdapterModels(adapter, signal, scopeId);
    data = await getAdapterModels(adapter, signal, scopeId);
  }
  signal?.throwIfAborted();
  if (data.status !== "fresh" || data.discoveryStatus === "missing") {
    throw new Error(data.catalog?.errorMessage || "模型目录尚未确认，请刷新后重试。");
  }
  return choicesFor(data);
}
