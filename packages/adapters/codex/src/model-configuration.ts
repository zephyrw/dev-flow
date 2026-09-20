import {
  ModelEntrySchema,
  type ModelCatalog,
  type ModelEntry,
  type ModelSource,
} from "../../../contracts/src/model-catalog.js";
import {
  type CatalogParseInput,
  assertCatalogNotOverLimit,
  discoveryFailureFromInput,
  failedModelCatalog,
  freshModelCatalog,
  makeEntryId,
  prepareCatalogText,
} from "../../sdk/src/catalog-parse.js";

type JsonRecord = Record<string, unknown>;

const ADAPTER_ID = "codex" as const;
const PROVIDER_ID = "openai";

function asRecord(value: unknown): JsonRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as JsonRecord;
}

function parseJsonValue(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function collectJsonDocuments(text: string, truncated: boolean): unknown[] {
  const prepared = prepareCatalogText(text, truncated);
  assertCatalogNotOverLimit(prepared);
  const whole = parseJsonValue(prepared.text.trim());
  if (whole !== undefined) return [whole];
  const documents: unknown[] = [];
  for (const line of prepared.lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = parseJsonValue(trimmed);
    if (parsed === undefined) continue;
    documents.push(parsed);
  }
  return documents;
}

function flattenRpcPayloads(documents: unknown[]): JsonRecord[] {
  const payloads: JsonRecord[] = [];
  for (const document of documents) {
    if (Array.isArray(document)) {
      for (const item of document) {
        const record = asRecord(item);
        if (record) payloads.push(record);
      }
      continue;
    }
    const record = asRecord(document);
    if (!record) continue;
    if (Array.isArray(record.messages)) {
      for (const item of record.messages) {
        const message = asRecord(item);
        if (message) payloads.push(message);
      }
      continue;
    }
    payloads.push(record);
  }
  return payloads;
}

function isAppServerModelItem(value: unknown): value is JsonRecord {
  const record = asRecord(value);
  if (!record) return false;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const model = typeof record.model === "string" ? record.model.trim() : "";
  return (id.length > 0 && isCodexModelId(id)) || (model.length > 0 && isCodexModelId(model));
}

function isCodexModelId(token: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(token);
}

function isCacheModelItem(value: unknown): value is JsonRecord {
  const record = asRecord(value);
  if (!record) return false;
  return typeof record.slug === "string" && isCodexModelId(record.slug.trim());
}

function readAppServerRows(payload: JsonRecord): JsonRecord[] | undefined {
  if (payload.error) return undefined;
  const result = asRecord(payload.result) ?? payload;
  const buckets = [result.data, result.models];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) continue;
    return bucket.filter(isAppServerModelItem);
  }
  if (isAppServerModelItem(result) && !Array.isArray(result.data)) {
    return [result];
  }
  return undefined;
}

function readCacheRows(document: unknown): JsonRecord[] | undefined {
  if (Array.isArray(document)) {
    if (!document.some(isCacheModelItem)) return undefined;
    return document.filter(isCacheModelItem);
  }
  const record = asRecord(document);
  if (!record) return undefined;
  const buckets = [record.models, record.data, record.items];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) continue;
    if (!bucket.some(isCacheModelItem)) continue;
    return bucket.filter(isCacheModelItem);
  }
  if (isCacheModelItem(record)) return [record];
  return undefined;
}

function readEffortValues(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return undefined;
  const values: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) {
      values.push(item);
      continue;
    }
    const record = asRecord(item);
    const rawEffort = record?.reasoningEffort ?? record?.effort;
    if (typeof rawEffort === "string") {
      const effort = rawEffort.trim();
      if (effort) values.push(effort);
    }
  }
  return values;
}

function detectSource(
  input: CatalogParseInput,
  payloads: JsonRecord[],
): ModelSource {
  if (input.source) return input.source;
  const hasInitialize = payloads.some((payload) => {
    const result = asRecord(payload.result);
    return Boolean(result?.protocolVersion || result?.serverInfo || result?.capabilities);
  });
  return hasInitialize ? "native-live" : "native-cache";
}

function toCodexEntry(
  row: JsonRecord,
  source: ModelSource,
  discoveredAt: string,
): ModelEntry | undefined {
  const fromCache = toCodexCacheEntry(row, source, discoveredAt);
  if (fromCache) return fromCache;
  return toCodexAppServerEntry(row, source, discoveredAt);
}

function toCodexCacheEntry(
  row: JsonRecord,
  source: ModelSource,
  discoveredAt: string,
): ModelEntry | undefined {
  const nativeId =
    typeof row.slug === "string" && row.slug.trim() ? row.slug.trim() : "";
  if (!nativeId) return undefined;
  const label =
    typeof row.display_name === "string" && row.display_name.trim()
      ? row.display_name.trim()
      : nativeId;
  const hidden = isHiddenVisibility(row.visibility) || row.hidden === true;
  const effortValues = readEffortValues(
    row.supported_reasoning_levels ?? row.supportedReasoningEfforts,
  );
  const defaultValue =
    typeof row.default_reasoning_level === "string"
      ? row.default_reasoning_level
      : typeof row.defaultReasoningEffort === "string"
        ? row.defaultReasoningEffort
        : undefined;
  return buildCodexEntry(
    nativeId,
    nativeId,
    label,
    hidden,
    effortValues,
    defaultValue,
    source,
    discoveredAt,
  );
}

function toCodexAppServerEntry(
  row: JsonRecord,
  source: ModelSource,
  discoveredAt: string,
): ModelEntry | undefined {
  const catalogId =
    typeof row.id === "string" && row.id.trim() ? row.id.trim() : "";
  const modelToken =
    typeof row.model === "string" && row.model.trim() ? row.model.trim() : "";
  const nativeId = modelToken || catalogId;
  if (!nativeId) return undefined;
  const label =
    typeof row.displayName === "string" && row.displayName.trim()
      ? row.displayName.trim()
      : nativeId;
  const hidden = row.hidden === true;
  const effortValues = readEffortValues(row.supportedReasoningEfforts);
  const defaultValue =
    typeof row.defaultReasoningEffort === "string"
      ? row.defaultReasoningEffort
      : undefined;
  return buildCodexEntry(
    catalogId || nativeId,
    nativeId,
    label,
    hidden,
    effortValues,
    defaultValue,
    source,
    discoveredAt,
  );
}

function isHiddenVisibility(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return ["hide", "hidden"].includes(value.trim().toLowerCase());
}

function buildCodexEntry(
  catalogId: string,
  nativeId: string,
  label: string,
  hidden: boolean,
  effortValues: string[] | undefined,
  defaultValue: string | undefined,
  source: ModelSource,
  discoveredAt: string,
): ModelEntry {
  const effort =
    effortValues && effortValues.length > 0
      ? {
          status: "supported" as const,
          transport: "config" as const,
          values: effortValues,
          ...(defaultValue ? { defaultValue } : {}),
        }
      : {
          status: "unknown" as const,
          transport: "config" as const,
          values: [] as string[],
        };
  return ModelEntrySchema.parse({
    entryId: makeEntryId(ADAPTER_ID, PROVIDER_ID, catalogId || nativeId),
    adapterId: ADAPTER_ID,
    nativeId,
    label,
    providerId: PROVIDER_ID,
    selectionKind: "fixed",
    effort,
    source,
    discoveredAt,
    hidden,
    availability: "listed",
    capabilityRevision: `${nativeId}:${effort.status}:${effort.values.join(",")}`,
  });
}

function parseCodexRows(
  input: CatalogParseInput,
): { rows: JsonRecord[]; source: ModelSource } {
  const documents = collectJsonDocuments(input.stdout, input.truncated === true);
  const cacheRows = readFirstCacheRows(documents);
  if (cacheRows) {
    return {
      rows: cacheRows,
      source: input.source ?? "native-cache",
    };
  }
  const payloads = flattenRpcPayloads(documents);
  const rpcError = payloads.find((payload) => asRecord(payload.error));
  if (rpcError) {
    const error = asRecord(rpcError.error);
    const message =
      typeof error?.message === "string" ? error.message : "model/list 返回错误";
    throw new Error(message);
  }
  const rows: JsonRecord[] = [];
  let sawModelList = false;
  for (const payload of payloads) {
    if (typeof payload.method === "string" && !payload.result) continue;
    const extracted = readAppServerRows(payload);
    if (!extracted) continue;
    sawModelList = true;
    rows.push(...extracted);
  }
  if (!sawModelList) {
    throw new Error("未找到 model/list 结果");
  }
  return { rows, source: detectSource(input, payloads) };
}

function readFirstCacheRows(documents: unknown[]): JsonRecord[] | undefined {
  for (const document of documents) {
    const rows = readCacheRows(document);
    if (rows) return rows;
  }
  return undefined;
}

export function parseCodexModelCatalog(input: CatalogParseInput): ModelCatalog {
  const classified = discoveryFailureFromInput(input);
  if (classified) {
    return failedModelCatalog(ADAPTER_ID, input, classified.code, classified.message);
  }
  try {
    const parsed = parseCodexRows(input);
    const clock = input.discoveredAt ?? new Date().toISOString();
    const entries = parsed.rows
      .map((row) => toCodexEntry(row, parsed.source, clock))
      .filter((entry): entry is ModelEntry => Boolean(entry));
    return freshModelCatalog(ADAPTER_ID, { ...input, discoveredAt: clock }, entries);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Codex 目录解析失败";
    return failedModelCatalog(ADAPTER_ID, input, "CATALOG_OUTPUT_INVALID", message);
  }
}

export async function discoverModels(
  input: CatalogParseInput,
): Promise<ModelCatalog> {
  return parseCodexModelCatalog(input);
}

export { parseStructuredProbeTerminal as parseCodexProbeTerminal } from "../../sdk/src/probe-terminal.js";
