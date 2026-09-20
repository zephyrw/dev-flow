import {
  ModelEntrySchema,
  type ModelCatalog,
  type ModelEntry,
} from "../../../contracts/src/model-catalog.js";
import {
  type CatalogParseInput,
  discoveryFailureFromInput,
  failedModelCatalog,
  freshModelCatalog,
  makeEntryId,
  prepareCatalogText,
} from "../../sdk/src/catalog-parse.js";

const ADAPTER_ID = "agy" as const;

const HEADER_TOKENS = new Set([
  "model",
  "models",
  "id",
  "name",
  "label",
  "description",
  "provider",
  "model-id",
  "modelid",
  "模型",
  "名称",
  "说明",
]);

// These exact families are confirmed by the model catalog contract. Unknown IDs
// must not acquire an effort capability just because their name ends in -high.
const AGY_VARIANTS: Record<string, Record<string, string>> = {
  "gemini-3.8-flash": { high: "gemini-3.8-flash-high", medium: "gemini-3.8-flash-medium" },
  "gemini-3.7-flash": { high: "gemini-3.7-flash-high", medium: "gemini-3.7-flash-medium" },
  "gemini-3.6-flash": { high: "gemini-3.6-flash-high", medium: "gemini-3.6-flash-medium" },
  "gemini-3.1-pro": { high: "gemini-3.1-pro-high" },
};

function providerFromSlug(nativeId: string): string | undefined {
  if (nativeId.startsWith("gemini-")) return "google";
  if (nativeId.startsWith("claude-")) return "anthropic";
  if (nativeId.startsWith("gpt-")) return "openai";
  return undefined;
}

function isCallableModelId(token: string): boolean {
  if (HEADER_TOKENS.has(token.toLowerCase())) return false;
  return /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/.test(token);
}

function firstCallableToken(line: string): string | undefined {
  const tokens = line
    .split(/[|,;\t ]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  for (const token of tokens) {
    if (isCallableModelId(token)) return token;
  }
  return undefined;
}

function fixedEffort(nativeId: string): { value: string; family: string } | undefined {
  for (const [family, variants] of Object.entries(AGY_VARIANTS)) {
    for (const [value, id] of Object.entries(variants)) {
      if (id === nativeId) return { value, family };
    }
  }
  return undefined;
}

function toAgyEntry(
  nativeId: string,
  discoveredAt: string,
  source: CatalogParseInput["source"],
  familyVariants?: Record<string, string>,
): ModelEntry {
  const providerId = providerFromSlug(nativeId);
  const fixed = fixedEffort(nativeId);
  const values = familyVariants
    ? Object.keys(familyVariants)
    : fixed
      ? [fixed.value]
      : [];
  const effort = fixed
    ? {
        status: "supported" as const,
        transport: "none" as const,
        values,
        fixedValue: fixed.value,
        ...(familyVariants ? { variants: familyVariants } : {}),
      }
    : {
        status: "unknown" as const,
        transport: "none" as const,
        values: [] as string[],
      };
  return ModelEntrySchema.parse({
    entryId: makeEntryId(ADAPTER_ID, providerId, nativeId),
    adapterId: ADAPTER_ID,
    nativeId,
    label: nativeId,
    providerId,
    ...(fixed ? { familyId: fixed.family, accessModelKey: fixed.family } : {}),
    selectionKind: "fixed",
    effort,
    source: source ?? "native-live",
    discoveredAt,
    hidden: false,
    availability: "listed",
    capabilityRevision: `${nativeId}:${effort.status}:${values.join(",")}`,
  });
}

function agyFamilyVariants(ids: string[]): Map<string, Record<string, string>> {
  const families = new Map<string, Record<string, string>>();
  for (const nativeId of ids) {
    const fixed = fixedEffort(nativeId);
    if (!fixed) continue;
    const current = families.get(fixed.family) ?? {};
    current[fixed.value] = nativeId;
    families.set(fixed.family, current);
  }
  return families;
}

function parseAgyNativeIds(input: CatalogParseInput): string[] {
  const prepared = prepareCatalogText(input.stdout, input.truncated === true);
  if (prepared.overLimit) {
    throw new Error("over-limit");
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const line of prepared.lines) {
    const nativeId = firstCallableToken(line);
    if (!nativeId || seen.has(nativeId)) continue;
    seen.add(nativeId);
    ids.push(nativeId);
  }
  return ids;
}

export function parseAgyModelCatalog(input: CatalogParseInput): ModelCatalog {
  const classified = discoveryFailureFromInput(input);
  if (classified) {
    return failedModelCatalog(ADAPTER_ID, input, classified.code, classified.message);
  }
  try {
    const ids = parseAgyNativeIds(input);
    if (ids.length === 0) {
      return failedModelCatalog(
        ADAPTER_ID,
        input,
        "CATALOG_OUTPUT_INVALID",
        "agy models 未解析到可调用模型 ID",
      );
    }
    const clock = input.discoveredAt ?? new Date().toISOString();
    const families = agyFamilyVariants(ids);
    const entries = ids.map((nativeId) => {
      const fixed = fixedEffort(nativeId);
      const variants = fixed ? families.get(fixed.family) : undefined;
      return toAgyEntry(nativeId, clock, input.source, variants);
    });
    return freshModelCatalog(ADAPTER_ID, { ...input, discoveredAt: clock }, entries);
  } catch {
    return failedModelCatalog(
      ADAPTER_ID,
      input,
      "CATALOG_OUTPUT_INVALID",
      "agy 模型目录解析失败",
    );
  }
}

export async function discoverModels(
  input: CatalogParseInput,
): Promise<ModelCatalog> {
  return parseAgyModelCatalog(input);
}

export { parseStructuredProbeTerminal as parseAgyProbeTerminal } from "../../sdk/src/probe-terminal.js";
