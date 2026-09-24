import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

export const GROK_OFFICIAL_SEEDS = [
  "grok-4.7",
  "grok-4.6",
  "grok-4.5",
  "grok-4",
];

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as JsonRecord;
}

export function readGrokConfiguredModels(): Array<{
  nativeId: string;
  label: string;
}> {
  const configPath = join(homedir(), ".grok", "config.toml");
  if (!existsSync(configPath)) return [];
  try {
    const text = readFileSync(configPath, "utf8");
    const models: Array<{ nativeId: string; label: string }> = [];
    const lines = text.split(/\r?\n/);
    let currentSection = "";
    let currentName = "";
    let currentModel = "";

    const flushCurrent = () => {
      if (currentSection.startsWith("model.") && currentSection.length > "model.".length) {
        const sectionId = currentSection.slice("model.".length).replace(/^"+|"+$/g, "").trim();
        const nativeId = sectionId || currentModel;
        const label = currentName || currentModel || sectionId;
        if (nativeId && !models.some((m) => m.nativeId === nativeId)) {
          models.push({ nativeId, label });
        }
      }
      currentName = "";
      currentModel = "";
    };

    for (const rawLine of lines) {
      const line = rawLine.replace(/#.*$/, "").trim();
      if (!line) continue;
      const sectionMatch = line.match(/^\[([^\]]+)\]$/);
      if (sectionMatch) {
        flushCurrent();
        currentSection = sectionMatch[1]!.trim();
        continue;
      }
      const eq = line.indexOf("=");
      if (eq > 0) {
        const key = line.slice(0, eq).trim();
        const rawVal = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        if (key === "name") currentName = rawVal;
        if (key === "model") currentModel = rawVal;
      }
    }
    flushCurrent();
    return models;
  } catch {
    return [];
  }
}

function grokEffort(nativeId: string): ModelEffort {
  if (nativeId === "grok-4.7" || nativeId.startsWith("grok-4.7-")) {
    return {
      status: "supported",
      transport: "flag",
      values: ["low", "medium", "high", "xhigh"],
      defaultValue: "high",
    };
  }
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
  label?: string,
): ModelEntry {
  const effort = grokEffort(nativeId);
  const providerId = nativeId.startsWith("grok-") ? PROVIDER_ID : undefined;
  return ModelEntrySchema.parse({
    entryId: makeEntryId(ADAPTER_ID, providerId, nativeId),
    adapterId: ADAPTER_ID,
    nativeId,
    label: label ?? nativeId,
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

function fallbackGrokCatalog(input: CatalogParseInput): ModelCatalog {
  const clock = input.discoveredAt ?? new Date().toISOString();
  const configured = readGrokConfiguredModels();
  const configEntries = configured.map((c) =>
    toGrokEntry(c.nativeId, clock, "native-config", c.label),
  );
  const configIds = new Set(configured.map((c) => c.nativeId));
  const seedEntries = GROK_OFFICIAL_SEEDS.filter((id) => !configIds.has(id)).map((id) =>
    toGrokEntry(id, clock, "official-seed"),
  );
  return freshModelCatalog(ADAPTER_ID, { ...input, discoveredAt: clock }, [
    ...configEntries,
    ...seedEntries,
  ]);
}

export function parseGrokModelCatalog(input: CatalogParseInput): ModelCatalog {
  const classified = discoveryFailureFromInput(input);
  if (classified) {
    return failedModelCatalog(ADAPTER_ID, input, classified.code, classified.message);
  }
  try {
    const ids = parseGrokNativeIds(input);
    if (ids.length === 0) {
      return fallbackGrokCatalog(input);
    }
    const clock = input.discoveredAt ?? new Date().toISOString();
    const source = detectSource(input, `${input.stdout}\n${input.stderr ?? ""}`);
    const configured = readGrokConfiguredModels();
    const configMap = new Map(configured.map((c) => [c.nativeId, c]));
    const hasLocalConfigInOutput = ids.some((id) => configMap.has(id));

    if (hasLocalConfigInOutput) {
      const mergedEntries: ModelEntry[] = [];
      const seen = new Set<string>();
      for (const c of configured) {
        seen.add(c.nativeId);
        mergedEntries.push(toGrokEntry(c.nativeId, clock, "native-config", c.label));
      }
      for (const seedId of GROK_OFFICIAL_SEEDS) {
        if (!seen.has(seedId)) {
          seen.add(seedId);
          const seedSource = ids.includes(seedId) ? source : "official-seed";
          mergedEntries.push(toGrokEntry(seedId, clock, seedSource));
        }
      }
      for (const id of ids) {
        if (!seen.has(id)) {
          seen.add(id);
          mergedEntries.push(toGrokEntry(id, clock, source));
        }
      }
      return freshModelCatalog(ADAPTER_ID, { ...input, discoveredAt: clock }, mergedEntries);
    }

    const entries = ids.map((nativeId) => toGrokEntry(nativeId, clock, source));
    return freshModelCatalog(ADAPTER_ID, { ...input, discoveredAt: clock }, entries);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Grok 模型目录解析失败";
    return failedModelCatalog(ADAPTER_ID, input, "CATALOG_OUTPUT_INVALID", message);
  }
}

export async function discoverModels(
  input: CatalogParseInput,
): Promise<ModelCatalog> {
  return parseGrokModelCatalog(input);
}

export { parseStructuredProbeTerminal as parseGrokProbeTerminal } from "../../sdk/src/probe-terminal.js";
