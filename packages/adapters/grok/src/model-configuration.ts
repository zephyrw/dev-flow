import {
  ModelEntrySchema,
  type ModelCatalog,
  type ModelEntry,
  type ModelEffort,
  type ModelSource,
} from "../../../contracts/src/model-catalog.js";
import {
  type CatalogParseInput,
  discoveryFailureFromInput,
  failedModelCatalog,
  freshModelCatalog,
  makeEntryId,
  prepareCatalogText,
} from "../../sdk/src/catalog-parse.js";

const ADAPTER_ID = "grok-build" as const;
const PROVIDER_ID = "xai";
const HEADER_TOKENS = new Set([
  "model",
  "models",
  "id",
  "name",
  "label",
  "available",
  "cached",
  "custom",
  "default",
]);

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as JsonRecord;
}

function grokEffort(nativeId: string): ModelEffort {
  if (nativeId === "grok-4.6" || nativeId.startsWith("grok-4.6-")) {
    return {
      status: "supported",
      transport: "flag",
      values: ["low", "medium", "high", "xhigh"],
      defaultValue: "high",
    };
  }
  if (nativeId === "grok-4.5" || nativeId.startsWith("grok-4.5-")) {
    return {
      status: "supported",
      transport: "flag",
      values: ["low", "medium", "high"],
      defaultValue: "high",
    };
  }
  return {
    status: "unknown",
    transport: "none",
    values: [],
  };
}

function detectSource(input: CatalogParseInput, text: string): ModelSource {
  if (input.source) return input.source;
  if (/cached|cache|上次缓存|自定义/i.test(text)) return "native-cache";
  return "native-live";
}

function isGrokModelId(token: string): boolean {
  if (HEADER_TOKENS.has(token.toLowerCase())) return false;
  if (token.startsWith("-")) return false;
  return /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/.test(token);
}

function firstModelId(line: string): string | undefined {
  const tokens = line
    .split(/[|,;\t ()]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  for (const token of tokens) {
    if (isGrokModelId(token)) return token;
  }
  return undefined;
}

function nativeIdFromRow(row: JsonRecord): string | undefined {
  for (const key of ["id", "model", "nativeId", "name"]) {
    const value = row[key];
    if (typeof value === "string" && isGrokModelId(value.trim())) {
      return value.trim();
    }
  }
  return undefined;
}

function idsFromJson(text: string): string[] | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    const rows = Array.isArray(parsed)
      ? parsed
      : asRecord(parsed)?.models ?? asRecord(parsed)?.data;
    if (!Array.isArray(rows)) return undefined;
    const ids: string[] = [];
    for (const item of rows) {
      const record = asRecord(item);
      const nativeId = record ? nativeIdFromRow(record) : undefined;
      const asString =
        typeof item === "string" && isGrokModelId(item) ? item : nativeId;
      if (asString && !ids.includes(asString)) ids.push(asString);
    }
    return ids;
  } catch {
    return undefined;
  }
}

function parseGrokNativeIds(input: CatalogParseInput): string[] {
  const prepared = prepareCatalogText(input.stdout, input.truncated === true);
  if (prepared.overLimit) {
    throw new Error("over-limit");
  }
  const fromJson = idsFromJson(prepared.text.trim());
  if (fromJson) return fromJson;
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const line of prepared.lines) {
    const nativeId = firstModelId(line);
    if (!nativeId || seen.has(nativeId)) continue;
    seen.add(nativeId);
    ids.push(nativeId);
  }
  return ids;
}

function toGrokEntry(
  nativeId: string,
  discoveredAt: string,
  source: ModelSource,
): ModelEntry {
  const effort = grokEffort(nativeId);
  const providerId = nativeId.startsWith("grok-") ? PROVIDER_ID : undefined;
  return ModelEntrySchema.parse({
    entryId: makeEntryId(ADAPTER_ID, providerId, nativeId),
    adapterId: ADAPTER_ID,
    nativeId,
    label: nativeId,
    providerId,
    selectionKind: "fixed",
    effort,
    source,
    discoveredAt,
    hidden: false,
    availability: "listed",
    capabilityRevision: `${nativeId}:${effort.status}:${effort.values.join(",")}`,
  });
}

export function parseGrokModelCatalog(input: CatalogParseInput): ModelCatalog {
  const classified = discoveryFailureFromInput(input);
  if (classified) {
    return failedModelCatalog(ADAPTER_ID, input, classified.code, classified.message);
  }
  try {
    const ids = parseGrokNativeIds(input);
    if (ids.length === 0) {
      return failedModelCatalog(
        ADAPTER_ID,
        input,
        "CATALOG_OUTPUT_INVALID",
        "grok models 未解析到可调用模型 ID",
      );
    }
    const clock = input.discoveredAt ?? new Date().toISOString();
    const source = detectSource(input, `${input.stdout}\n${input.stderr ?? ""}`);
    const entries = ids.map((nativeId) => toGrokEntry(nativeId, clock, source));
    return freshModelCatalog(ADAPTER_ID, { ...input, discoveredAt: clock }, entries);
  } catch {
    return failedModelCatalog(
      ADAPTER_ID,
      input,
      "CATALOG_OUTPUT_INVALID",
      "Grok 模型目录解析失败",
    );
  }
}

export async function discoverModels(
  input: CatalogParseInput,
): Promise<ModelCatalog> {
  return parseGrokModelCatalog(input);
}

export { parseStructuredProbeTerminal as parseGrokProbeTerminal } from "../../sdk/src/probe-terminal.js";
