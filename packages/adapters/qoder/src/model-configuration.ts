import {
  ModelEntrySchema,
  type ModelCatalog,
  type ModelEntry,
  type ModelEffort,
} from "../../../contracts/src/model-catalog.js";
import {
  type CatalogParseInput,
  discoveryFailureFromInput,
  failedModelCatalog,
  freshModelCatalog,
  makeEntryId,
  prepareCatalogText,
} from "../../sdk/src/catalog-parse.js";

const ADAPTER_ID = "qoder" as const;
const ROUTER_TOKENS = new Set(["auto", "ultimate", "performance", "efficient"]);
const HEADER_TOKENS = new Set([
  "model",
  "models",
  "available",
  "id",
  "name",
  "label",
]);
const QODER_EFFORT_BY_ID: Record<string, string[]> = {
  "qwen-3.8-max": ["low", "medium", "xhigh"],
  "kimi-k3": ["low", "high", "max"],
  "glm-5.3": ["low", "high", "max"],
  "glm-5.2": ["high", "max"],
  "deepseek-v4-pro": ["high", "max"],
  "deepseek-v4-flash": ["low", "high", "max"],
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as JsonRecord;
}

function isCallableNativeId(token: string): boolean {
  if (HEADER_TOKENS.has(token.toLowerCase())) return false;
  if (token === "auto") return true;
  if (ROUTER_TOKENS.has(token.toLowerCase())) return true;
  return /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/.test(token);
}

function nativeIdFromLine(line: string): string | undefined {
  const paren = line.match(/\(([a-z0-9][a-z0-9._-]*)\)/i);
  if (paren && isCallableNativeId(paren[1]!)) return paren[1]!.toLowerCase();
  const tokens = line
    .split(/[|,;\t ]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  for (const token of tokens) {
    if (isCallableNativeId(token)) return token.toLowerCase();
  }
  return undefined;
}

function nativeIdFromRow(row: JsonRecord): string | undefined {
  for (const key of ["id", "model", "nativeId", "token"]) {
    const value = row[key];
    if (typeof value === "string" && isCallableNativeId(value.trim())) {
      return value.trim().toLowerCase();
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
      if (typeof item === "string" && isCallableNativeId(item.trim())) {
        const id = item.trim().toLowerCase();
        if (!ids.includes(id)) ids.push(id);
        continue;
      }
      const record = asRecord(item);
      const nativeId = record ? nativeIdFromRow(record) : undefined;
      if (nativeId && !ids.includes(nativeId)) ids.push(nativeId);
    }
    return ids;
  } catch {
    return undefined;
  }
}

function parseQoderNativeIds(input: CatalogParseInput): string[] {
  const prepared = prepareCatalogText(input.stdout, input.truncated === true);
  if (prepared.overLimit) {
    throw new Error("over-limit");
  }
  const fromJson = idsFromJson(prepared.text.trim());
  if (fromJson) return fromJson;
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const line of prepared.lines) {
    const nativeId = nativeIdFromLine(line);
    if (!nativeId || seen.has(nativeId)) continue;
    seen.add(nativeId);
    ids.push(nativeId);
  }
  return ids;
}

function qoderEffort(nativeId: string): ModelEffort {
  const values = QODER_EFFORT_BY_ID[nativeId];
  if (values && values.length > 0) {
    return {
      status: "supported",
      transport: "flag",
      values,
    };
  }
  return {
    status: "unknown",
    transport: "none",
    values: [],
  };
}

function toQoderEntry(nativeId: string, discoveredAt: string): ModelEntry {
  const router = ROUTER_TOKENS.has(nativeId);
  const effort = router
    ? { status: "unknown" as const, transport: "none" as const, values: [] as string[] }
    : qoderEffort(nativeId);
  return ModelEntrySchema.parse({
    entryId: makeEntryId(ADAPTER_ID, undefined, nativeId),
    adapterId: ADAPTER_ID,
    nativeId,
    label: nativeId,
    selectionKind: router ? "native-router" : "fixed",
    effort,
    source: "native-live",
    discoveredAt,
    hidden: false,
    availability: "listed",
    capabilityRevision: `${nativeId}:${effort.status}:${effort.values.join(",")}`,
  });
}

export const QODER_OFFICIAL_SEEDS = [
  "auto",
  "qwen-3.8-max",
  "glm-5.3",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
];

function fallbackQoderCatalog(input: CatalogParseInput): ModelCatalog {
  const clock = input.discoveredAt ?? new Date().toISOString();
  const entries = QODER_OFFICIAL_SEEDS.map((id) => toQoderEntry(id, clock));
  return freshModelCatalog(ADAPTER_ID, { ...input, discoveredAt: clock }, entries);
}

export function parseQoderModelCatalog(input: CatalogParseInput): ModelCatalog {
  const classified = discoveryFailureFromInput(input);
  if (classified) {
    return failedModelCatalog(ADAPTER_ID, input, classified.code, classified.message);
  }
  try {
    const ids = parseQoderNativeIds(input);
    if (ids.length === 0) {
      return fallbackQoderCatalog(input);
    }
    const clock = input.discoveredAt ?? new Date().toISOString();
    const entries = ids.map((nativeId) => toQoderEntry(nativeId, clock));
    return freshModelCatalog(ADAPTER_ID, { ...input, discoveredAt: clock }, entries);
  } catch {
    return fallbackQoderCatalog(input);
  }
}

export async function discoverModels(
  input: CatalogParseInput,
): Promise<ModelCatalog> {
  return parseQoderModelCatalog(input);
}

export { parseStructuredProbeTerminal as parseQoderProbeTerminal } from "../../sdk/src/probe-terminal.js";
