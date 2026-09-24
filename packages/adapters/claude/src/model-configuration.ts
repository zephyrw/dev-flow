import {
  ModelEntrySchema,
  OfficialSeedSchema,
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
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ADAPTER_ID = "claude-code" as const;
const PROVIDER_ID = "anthropic";
const COMPOSITE_IDS = new Set(["opusplan", "ultracode"]);
const ROUTER_ALIASES = new Set([
  "opus",
  "sonnet",
  "haiku",
  "fable",
  "opusplan",
  "ultracode",
]);
const FULL_EFFORT = ["low", "medium", "high", "xhigh", "max"];
const NO_XHIGH = ["low", "medium", "high", "max"];
const CLAUDE_OFFICIAL_EFFORT: Record<string, string[]> = {
  "claude-fable-5-1": FULL_EFFORT,
  "claude-fable-5": FULL_EFFORT,
  "claude-opus-5": FULL_EFFORT,
  "claude-sonnet-5": FULL_EFFORT,
  "claude-opus-4-8": FULL_EFFORT,
  "claude-opus-4-7": FULL_EFFORT,
  "claude-opus-4-6": NO_XHIGH,
  "claude-sonnet-4-6": NO_XHIGH,
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as JsonRecord;
}

function parseJsonDocument(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function effortForClaude(nativeId: string, seedValues?: string[]): ModelEffort {
  const known = CLAUDE_OFFICIAL_EFFORT[nativeId];
  if (known) {
    return {
      status: "supported",
      transport: "flag",
      values: known,
    };
  }
  // 别名支持：如 opus, sonnet, fable, 或 claude-3-7-sonnet
  const lower = nativeId.toLowerCase();
  if (lower === "opus" || lower.startsWith("claude-opus")) {
    return {
      status: "supported",
      transport: "flag",
      values: FULL_EFFORT,
      defaultValue: "high",
    };
  }
  if (lower === "sonnet" || lower.startsWith("claude-sonnet")) {
    return {
      status: "supported",
      transport: "flag",
      values: FULL_EFFORT,
      defaultValue: "high",
    };
  }
  if (lower === "fable" || lower.startsWith("claude-fable")) {
    return {
      status: "supported",
      transport: "flag",
      values: FULL_EFFORT,
      defaultValue: "high",
    };
  }
  const filtered = (seedValues ?? []).filter(
    (value) => value && !COMPOSITE_IDS.has(value),
  );
  if (filtered.length > 0) {
    return {
      status: "supported",
      transport: "flag",
      values: filtered,
    };
  }
  return {
    status: "unknown",
    transport: "none",
    values: [],
  };
}

function selectionKindFor(nativeId: string): "fixed" | "native-router" {
  if (ROUTER_ALIASES.has(nativeId)) return "native-router";
  return "fixed";
}

function toClaudeEntry(
  nativeId: string,
  label: string,
  source: "official-seed" | "native-config",
  discoveredAt: string,
  seedValues?: string[],
): ModelEntry {
  const effort = effortForClaude(nativeId, seedValues);
  return ModelEntrySchema.parse({
    entryId: makeEntryId(ADAPTER_ID, PROVIDER_ID, nativeId),
    adapterId: ADAPTER_ID,
    nativeId,
    label,
    providerId: PROVIDER_ID,
    selectionKind: selectionKindFor(nativeId),
    effort,
    source,
    discoveredAt,
    hidden: false,
    availability: source === "native-config" ? "listed" : "candidate",
    capabilityRevision: `${nativeId}:${effort.status}:${effort.values.join(",")}`,
  });
}

function nativeIdFromRow(row: JsonRecord): string | undefined {
  for (const key of ["nativeId", "model", "id"]) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function readSeedList(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  const rows: JsonRecord[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (record) rows.push(record);
  }
  return rows;
}

function splitClaudeDocument(value: unknown): {
  officialSeed: JsonRecord[];
  configuredModels: JsonRecord[];
} {
  if (Array.isArray(value)) {
    return { officialSeed: readSeedList(value), configuredModels: [] };
  }
  const record = asRecord(value);
  if (!record) {
    throw new Error("Claude 目录输入必须是 JSON 对象或数组");
  }
  return {
    officialSeed: readSeedList(record.officialSeed ?? record.seeds),
    configuredModels: readSeedList(
      record.configuredModels ?? record.models ?? record.configured,
    ),
  };
}

function parseClaudeCatalogRows(
  input: CatalogParseInput,
): ModelEntry[] {
  const prepared = prepareCatalogText(input.stdout, input.truncated === true);
  if (prepared.overLimit) {
    throw new Error("over-limit");
  }
  const document = parseJsonDocument(prepared.text.trim());
  const split = splitClaudeDocument(document);
  const clock = input.discoveredAt ?? new Date().toISOString();
  const byId = new Map<string, ModelEntry>();
  for (const raw of split.officialSeed) {
    const seed = OfficialSeedSchema.parse(raw);
    if (!seed.nativeIdConfirmed || !seed.nativeId?.trim()) continue;
    const nativeId = seed.nativeId.trim();
    byId.set(
      nativeId,
      toClaudeEntry(
        nativeId,
        seed.label,
        "official-seed",
        clock,
        seed.effortValues,
      ),
    );
  }
  for (const row of split.configuredModels) {
    const nativeId = nativeIdFromRow(row);
    if (!nativeId) continue;
    const label =
      typeof row.label === "string" && row.label.trim()
        ? row.label.trim()
        : nativeId;
    const existing = byId.get(nativeId);
    byId.set(
      nativeId,
      toClaudeEntry(
        nativeId,
        label,
        "native-config",
        clock,
        existing?.effort.values,
      ),
    );
  }
  return [...byId.values()];
}

export function parseClaudeModelCatalog(input: CatalogParseInput): ModelCatalog {
  const classified = discoveryFailureFromInput(input);
  if (classified) {
    return failedModelCatalog(ADAPTER_ID, input, classified.code, classified.message);
  }
  try {
    const rawStdout = input.stdout?.trim() ? input.stdout : claudeCatalogStdout();
    const entries = parseClaudeCatalogRows({ ...input, stdout: rawStdout });
    if (entries.length === 0) {
      const fallbackRows = parseClaudeCatalogRows({ ...input, stdout: claudeCatalogStdout() });
      const clock = input.discoveredAt ?? new Date().toISOString();
      return freshModelCatalog(ADAPTER_ID, { ...input, discoveredAt: clock }, fallbackRows);
    }
    const clock = input.discoveredAt ?? new Date().toISOString();
    return freshModelCatalog(ADAPTER_ID, { ...input, discoveredAt: clock }, entries);
  } catch {
    const fallbackRows = parseClaudeCatalogRows({ ...input, stdout: claudeCatalogStdout() });
    const clock = input.discoveredAt ?? new Date().toISOString();
    return freshModelCatalog(ADAPTER_ID, { ...input, discoveredAt: clock }, fallbackRows);
  }
}

export async function discoverModels(
  input: CatalogParseInput,
): Promise<ModelCatalog> {
  return parseClaudeModelCatalog(input);
}

export { parseStructuredProbeTerminal as parseClaudeProbeTerminal } from "../../sdk/src/probe-terminal.js";

export function claudeOfficialCatalogStdout(): string {
  const officialSeed = [
    seed("claude-fable-5-1", "Claude Fable 5.1", FULL_EFFORT),
    seed("claude-fable-5", "Claude Fable 5", FULL_EFFORT),
    seed("claude-opus-5", "Claude Opus 5", FULL_EFFORT),
    seed("claude-sonnet-5", "Claude Sonnet 5", FULL_EFFORT),
    seed("claude-opus-4-8", "Claude Opus 4.8", FULL_EFFORT),
    seed("claude-opus-4-7", "Claude Opus 4.7", FULL_EFFORT),
    seed("claude-opus-4-6", "Claude Opus 4.6", NO_XHIGH),
    seed("claude-sonnet-4-6", "Claude Sonnet 4.6", NO_XHIGH),
    seed("claude-haiku-4-5", "Claude Haiku 4.5"),
  ];
  return JSON.stringify({ officialSeed, configuredModels: [] });
}

export function readClaudeConfiguredModels(): Array<{
  nativeId: string;
  label: string;
}> {
  const candidatePaths = [
    join(homedir(), ".claude", "settings.json"),
    join(homedir(), ".claude.json"),
    join(homedir(), ".config", "claude", "settings.json"),
    join(homedir(), ".config", "claude", "config.json"),
  ];
  const models: Array<{ nativeId: string; label: string }> = [];
  for (const settingsPath of candidatePaths) {
    if (!existsSync(settingsPath)) continue;
    try {
      const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as unknown;
      const record = asRecord(raw);
      if (!record) continue;
      addConfiguredModel(models, record.model);
      const env = asRecord(record.env);
      if (env) {
        addConfiguredModel(models, env.ANTHROPIC_MODEL);
        addConfiguredModel(models, env.ANTHROPIC_DEFAULT_OPUS_MODEL);
        addConfiguredModel(models, env.ANTHROPIC_DEFAULT_SONNET_MODEL);
        addConfiguredModel(models, env.ANTHROPIC_DEFAULT_HAIKU_MODEL);
        addConfiguredModel(models, env.ANTHROPIC_DEFAULT_FABLE_MODEL);
      }
    } catch {
      // ignore parse error
    }
  }
  return models;
}

function addConfiguredModel(
  models: Array<{ nativeId: string; label: string }>,
  value: unknown,
) {
  if (typeof value !== "string" || !value.trim()) return;
  const rawId = value.trim();
  // 提取纯模型名，例如 mimo-v2.6-pro[1M] -> mimo-v2.6-pro
  const cleanId = rawId.replace(/\[.*?\]$/, "").trim();
  for (const candidate of [cleanId, rawId]) {
    if (!candidate) continue;
    if (!models.some((item) => item.nativeId === candidate)) {
      models.push({ nativeId: candidate, label: candidate });
    }
  }
}

export function claudeCatalogStdout(): string {
  const document = JSON.parse(claudeOfficialCatalogStdout()) as {
    officialSeed: unknown[];
    configuredModels: Array<{ nativeId: string; label: string }>;
  };
  document.configuredModels = readClaudeConfiguredModels();
  return JSON.stringify(document);
}

function seed(nativeId: string, label: string, effortValues?: string[]) {
  return OfficialSeedSchema.parse({
    sourceUrl: "https://code.claude.com/docs/en/model-config",
    checkedAt: "2026-09-18",
    nativeIdConfirmed: true,
    nativeId,
    label,
    ...(effortValues ? { effortValues, effortEvidence: "official model-config" } : {
      effortEvidence: "effort not verified",
    }),
  });
}
