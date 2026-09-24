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

const ADAPTER_ID = "opencode" as const;
const HEADER_TOKENS = new Set([
  "model",
  "models",
  "provider",
  "variant",
  "variants",
  "id",
  "name",
]);

type JsonRecord = Record<string, unknown>;
type OpenCodeRow = { base: string; variants: string[] };

function asRecord(value: unknown): JsonRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as JsonRecord;
}

function openCodeBase(token: string): { base: string; variant?: string } {
  const hash = token.indexOf("#");
  if (hash < 0) return { base: token };
  return { base: token.slice(0, hash), variant: token.slice(hash + 1) };
}

function isProviderModel(token: string): boolean {
  if (HEADER_TOKENS.has(token.toLowerCase())) return false;
  return /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:+-]*(?:#[a-z0-9._-]+)?$/i.test(
    token,
  );
}

function variantsFromUnknown(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw
      .split(/[|,;\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  const record = asRecord(raw);
  if (!record) return [];
  return Object.keys(record).filter(Boolean);
}

function idFromRecord(row: JsonRecord): string | undefined {
  if (typeof row.id === "string" && row.id.includes("/")) return row.id.trim();
  if (typeof row.nativeId === "string" && row.nativeId.includes("/")) {
    return row.nativeId.trim();
  }
  if (typeof row.provider === "string" && typeof row.model === "string") {
    const id = `${row.provider.trim()}/${row.model.trim()}`;
    return id.includes("/") ? id : undefined;
  }
  return undefined;
}

function rowFromRecord(row: JsonRecord): OpenCodeRow | undefined {
  const id = idFromRecord(row);
  if (!id) return undefined;
  const split = openCodeBase(id);
  const variants = [
    ...variantsFromUnknown(row.variants ?? row.variant),
    ...(split.variant ? [split.variant] : []),
  ];
  return { base: split.base, variants };
}

function mergeRow(target: Map<string, string[]>, row: OpenCodeRow): void {
  const existing = target.get(row.base) ?? [];
  for (const variant of row.variants) {
    if (!existing.includes(variant)) existing.push(variant);
  }
  target.set(row.base, existing);
}

function rowsFromJson(text: string): Map<string, string[]> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    const items = Array.isArray(parsed)
      ? parsed
      : asRecord(parsed)?.models ?? asRecord(parsed)?.data;
    if (!Array.isArray(items)) return undefined;
    const merged = new Map<string, string[]>();
    for (const item of items) {
      if (typeof item === "string" && item.includes("/")) {
        const split = openCodeBase(item.trim());
        mergeRow(merged, {
          base: split.base,
          variants: split.variant ? [split.variant] : [],
        });
        continue;
      }
      const record = asRecord(item);
      const row = record ? rowFromRecord(record) : undefined;
      if (row) mergeRow(merged, row);
    }
    return merged;
  } catch {
    return undefined;
  }
}

function variantsFromFollowLine(line: string): string[] | undefined {
  const match = line.match(/^\s+variants?\s*[:：]\s*(.+)$/i);
  const raw = match?.[1];
  if (!raw) return undefined;
  return raw
    .split(/[|,;\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function rowsFromText(lines: string[]): Map<string, string[]> {
  const merged = new Map<string, string[]>();
  let current: string | undefined;
  for (const line of lines) {
    const follow = variantsFromFollowLine(line);
    if (follow && current) {
      mergeRow(merged, { base: current, variants: follow });
      continue;
    }
    const tokens = line
      .split(/[|,;\t ]+/)
      .map((token) => token.trim())
      .filter(Boolean);
    const id = tokens.find((token) => isProviderModel(token));
    if (!id) continue;
    const split = openCodeBase(id);
    current = split.base;
    mergeRow(merged, {
      base: split.base,
      variants: split.variant ? [split.variant] : [],
    });
  }
  return merged;
}

function parseOpenCodeRows(input: CatalogParseInput): Map<string, string[]> {
  const prepared = prepareCatalogText(input.stdout, input.truncated === true);
  if (prepared.overLimit) {
    throw new Error("over-limit");
  }
  return rowsFromJson(prepared.text.trim()) ?? rowsFromText(prepared.lines);
}

function openCodeEffort(variants: string[]): ModelEffort {
  if (variants.length === 0) {
    return {
      status: "unknown",
      transport: "none",
      values: [],
    };
  }
  return {
    status: "supported",
    transport: "variant-flag",
    values: variants,
  };
}

function toOpenCodeEntry(
  nativeId: string,
  variants: string[],
  discoveredAt: string,
): ModelEntry {
  const providerId = nativeId.split("/")[0];
  const effort = openCodeEffort(variants);
  return ModelEntrySchema.parse({
    entryId: makeEntryId(ADAPTER_ID, providerId, nativeId),
    adapterId: ADAPTER_ID,
    nativeId,
    label: nativeId,
    providerId,
    selectionKind: "fixed",
    effort,
    source: "native-live",
    discoveredAt,
    hidden: false,
    availability: "listed",
    capabilityRevision: `${nativeId}:${effort.status}:${effort.values.join(",")}`,
  });
}

export const OPENCODE_OFFICIAL_SEEDS: Array<{ base: string; variants: string[] }> = [
  { base: "anthropic/claude-3-7-sonnet", variants: [] },
  { base: "anthropic/claude-3-5-sonnet", variants: [] },
  { base: "openai/gpt-4o", variants: [] },
  { base: "deepseek/deepseek-chat", variants: [] },
  { base: "deepseek/deepseek-reasoner", variants: [] },
];

function fallbackOpenCodeCatalog(input: CatalogParseInput): ModelCatalog {
  const clock = input.discoveredAt ?? new Date().toISOString();
  const entries: ModelEntry[] = OPENCODE_OFFICIAL_SEEDS.map((s) =>
    toOpenCodeEntry(s.base, s.variants, clock),
  );
  return freshModelCatalog(ADAPTER_ID, { ...input, discoveredAt: clock }, entries);
}

export function parseOpenCodeModelCatalog(input: CatalogParseInput): ModelCatalog {
  const classified = discoveryFailureFromInput(input);
  if (classified) {
    return failedModelCatalog(ADAPTER_ID, input, classified.code, classified.message);
  }
  try {
    const rows = parseOpenCodeRows(input);
    if (rows.size === 0) {
      return fallbackOpenCodeCatalog(input);
    }
    const clock = input.discoveredAt ?? new Date().toISOString();
    const entries: ModelEntry[] = [];
    for (const [nativeId, variants] of rows) {
      entries.push(toOpenCodeEntry(nativeId, variants, clock));
    }
    return freshModelCatalog(ADAPTER_ID, { ...input, discoveredAt: clock }, entries);
  } catch {
    return fallbackOpenCodeCatalog(input);
  }
}

export async function discoverModels(
  input: CatalogParseInput,
): Promise<ModelCatalog> {
  return parseOpenCodeModelCatalog(input);
}

export function detectOpenCodeVariantEncoding(
  helpText: string,
): "flag" | "hash" | undefined {
  const hasFlag = /--variant\b/.test(helpText);
  const hasHash = /#<variant>|#variant|provider\/model#/i.test(helpText);
  if (hasFlag && !hasHash) return "flag";
  if (hasHash && !hasFlag) return "hash";
  if (hasFlag) return "flag";
  if (hasHash) return "hash";
  return undefined;
}

export { parseStructuredProbeTerminal as parseOpenCodeProbeTerminal } from "../../sdk/src/probe-terminal.js";
