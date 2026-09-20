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

const ADAPTER_ID = "kimi-code" as const;
const SECRET_KEY = /api[_-]?key|token|secret|password|authorization|credential/i;

type TomlValue = string | boolean | number | string[];
type TomlTable = Record<string, TomlValue>;

function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

function stripTomlComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) return line.slice(0, i).trimEnd();
  }
  return line;
}

function parseTomlString(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseTomlValue(raw: string): TomlValue | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((item) => parseTomlString(item)).filter(Boolean);
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return parseTomlString(trimmed);
}

function parseTableName(header: string): string | undefined {
  const match = header.match(/^\[([^\]]+)\]$/);
  const name = match?.[1];
  if (!name) return undefined;
  return name.replace(/^"+|"+$/g, "");
}

function parseTomlTables(text: string): Map<string, TomlTable> {
  const tables = new Map<string, TomlTable>();
  let current: string | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    if (line.startsWith("[")) {
      current = parseTableName(line);
      if (current && !tables.has(current)) tables.set(current, {});
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().replace(/^"+|"+$/g, "");
    if (!key || isSecretKey(key)) continue;
    const value = parseTomlValue(line.slice(eq + 1));
    if (value === undefined) continue;
    tables.get(current)![key] = value;
  }
  return tables;
}

function stringField(table: TomlTable, key: string): string | undefined {
  const value = table[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayField(table: TomlTable, key: string): string[] | undefined {
  const value = table[key];
  if (!Array.isArray(value)) return undefined;
  const items = value.map((item) => String(item).trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function kimiEffort(table: TomlTable): ModelEffort {
  const values = stringArrayField(table, "support_efforts");
  if (!values) {
    return {
      status: "unknown",
      transport: "none",
      values: [],
    };
  }
  const defaultValue = stringField(table, "default_effort");
  return {
    status: "supported",
    transport: "env",
    values,
    ...(defaultValue ? { defaultValue } : {}),
  };
}

function isManagedKimiProvider(provider: string | undefined): boolean {
  if (!provider) return true;
  const value = provider.toLowerCase();
  return (
    value === "kimi" ||
    value === "kimi-code" ||
    value.startsWith("managed:kimi")
  );
}

function toKimiEntry(
  alias: string,
  table: TomlTable,
  discoveredAt: string,
): ModelEntry {
  const providerId = stringField(table, "provider");
  const label =
    stringField(table, "name") ??
    stringField(table, "display_name") ??
    stringField(table, "model") ??
    alias;
  const effort = kimiEffort(table);
  const transport = isManagedKimiProvider(providerId) ? effort.transport : "none";
  const resolvedEffort =
    transport === effort.transport
      ? effort
      : { ...effort, status: "unknown" as const, transport, values: [] as string[] };
  return ModelEntrySchema.parse({
    entryId: makeEntryId(ADAPTER_ID, providerId, alias),
    adapterId: ADAPTER_ID,
    nativeId: alias,
    label,
    providerId,
    selectionKind: "fixed",
    effort: resolvedEffort,
    source: "native-config",
    discoveredAt,
    hidden: false,
    availability: "listed",
    capabilityRevision: `${alias}:${resolvedEffort.status}:${resolvedEffort.values.join(",")}`,
  });
}

function modelAliasFromTableName(name: string): string | undefined {
  if (name.startsWith("models.")) {
    return name.slice("models.".length).replace(/^"+|"+$/g, "");
  }
  return undefined;
}

function parseKimiEntries(input: CatalogParseInput): ModelEntry[] {
  const prepared = prepareCatalogText(input.stdout, input.truncated === true);
  if (prepared.overLimit) {
    throw new Error("over-limit");
  }
  const tables = parseTomlTables(prepared.text);
  const clock = input.discoveredAt ?? new Date().toISOString();
  const entries: ModelEntry[] = [];
  for (const [name, table] of tables) {
    const alias = modelAliasFromTableName(name);
    if (!alias) continue;
    entries.push(toKimiEntry(alias, table, clock));
  }
  return entries;
}

export function parseKimiModelCatalog(input: CatalogParseInput): ModelCatalog {
  const classified = discoveryFailureFromInput(input);
  if (classified) {
    return failedModelCatalog(ADAPTER_ID, input, classified.code, classified.message);
  }
  try {
    const entries = parseKimiEntries(input);
    if (entries.length === 0) {
      return failedModelCatalog(
        ADAPTER_ID,
        input,
        "CATALOG_OUTPUT_INVALID",
        "Kimi config.toml 未解析到 models 元数据",
      );
    }
    const clock = input.discoveredAt ?? new Date().toISOString();
    return freshModelCatalog(ADAPTER_ID, { ...input, discoveredAt: clock }, entries);
  } catch {
    return failedModelCatalog(
      ADAPTER_ID,
      input,
      "CATALOG_OUTPUT_INVALID",
      "Kimi 模型目录解析失败",
    );
  }
}

export async function discoverModels(
  input: CatalogParseInput,
): Promise<ModelCatalog> {
  return parseKimiModelCatalog(input);
}

export { parseStructuredProbeTerminal as parseKimiProbeTerminal } from "../../sdk/src/probe-terminal.js";
