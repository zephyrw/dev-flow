import { z } from "zod";
import { PARSER_REVISION, type ModelEntry } from "../../../contracts/src/model-catalog.js";
import { failedModelCatalog, freshModelCatalog, makeEntryId, type CatalogParseInput } from "../../sdk/src/catalog-parse.js";

const adapterId = "codebuddy-code";
const effortValue = z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]);
const nativeModel = z.object({
  modelId: z.string().trim().min(1).max(256).refine(value => !/[\x00-\x20\x7f]/.test(value)),
  name: z.string().trim().min(1).max(256),
  _meta: z.object({ effortOptions: z.array(z.object({ value: z.string() })).optional() }).optional(),
});
const sessionResponse = z.object({
  result: z.object({
    models: z.object({ availableModels: z.array(nativeModel) }),
  }).optional(),
  error: z.object({ message: z.string() }).optional(),
});

export function parseCodeBuddyModelCatalog(input: CatalogParseInput) {
  if (input.truncated) return failedModelCatalog(adapterId, input, "CATALOG_OUTPUT_INVALID", "CodeBuddy 模型目录超出读取限制");
  for (const line of input.stdout.split(/\r?\n/)) {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { continue; }
    if (!raw || typeof raw !== "object" || !("id" in raw) || raw.id !== 2) continue;
    const response = sessionResponse.safeParse(raw);
    if (!response.success) break;
    const message = response.data.error?.message;
    if (message && /authenticat|login|sign[ -]?in|登录/i.test(message))
      return failedModelCatalog(adapterId, input, "AUTH_REQUIRED", "请先登录 CodeBuddy CLI，然后刷新模型");
    const models = response.data.result?.models.availableModels;
    if (!models) break;
    const seen = new Set<string>();
    const entries: ModelEntry[] = [];
    const discoveredAt = input.discoveredAt ?? new Date().toISOString();
    for (const model of models) {
      if (seen.has(model.modelId)) continue;
      seen.add(model.modelId);
      const values = [...new Set(model._meta?.effortOptions?.flatMap(({ value }) => {
        const parsed = effortValue.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      }) ?? [])];
      const label = model.name.replace(/[\x00-\x1f\x7f]/g, "").trim() || model.modelId;
      entries.push({
        entryId: makeEntryId(adapterId, undefined, model.modelId),
        adapterId,
        nativeId: model.modelId,
        label,
        source: "native-live",
        selectionKind: model.modelId === "auto" ? "native-router" : "fixed",
        effort: values.length > 0
          ? { status: "supported", transport: "flag", values }
          : { status: "unknown", transport: "none", values: [] },
        discoveredAt,
        hidden: false,
        availability: "listed",
        capabilityRevision: PARSER_REVISION,
      });
    }
    return freshModelCatalog(adapterId, { ...input, discoveredAt }, entries);
  }
  return failedModelCatalog(adapterId, input, "CATALOG_OUTPUT_INVALID", "CodeBuddy 未返回可用模型目录");
}
