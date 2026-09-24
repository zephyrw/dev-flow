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

const ADAPTER_ID = "cursor-agent" as const;

type CursorFamilyRule = {
  familyId: string;
  accessModelKey: string;
  variants: Record<string, string>;
};

const HEADER_TOKENS = new Set([
  "available",
  "models",
  "model",
  "id",
  "name",
  "label",
  "fast",
  "thinking",
]);

function variantMap(
  prefix: string,
  efforts: readonly string[],
  suffix = "",
): Record<string, string> {
  const variants: Record<string, string> = {};
  for (const effort of efforts) {
    variants[effort] = `${prefix}-${effort}${suffix}`;
  }
  return variants;
}

function family(
  familyId: string,
  dimension: string,
  variants: Record<string, string>,
): CursorFamilyRule {
  return {
    familyId,
    accessModelKey: `${familyId}:${dimension}`,
    variants,
  };
}

const SIX_NONE = ["none", "low", "medium", "high", "xhigh", "max"] as const;
const MUSE = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const FIVE = ["low", "medium", "high", "xhigh", "max"] as const;
const FLASH = ["low", "medium", "high"] as const;
const GROK47 = ["low", "medium", "high", "xhigh"] as const;
const GROK46 = ["low", "medium", "high", "xhigh"] as const;
const GROK45 = ["low", "medium", "high"] as const;
const GPT55 = ["none", "low", "medium", "high", "extra-high"] as const;
const GPT54 = ["low", "medium", "high", "xhigh"] as const;
const GPT54_MINI = ["none", "low", "medium", "high", "xhigh"] as const;
const CODEX_EFFORT = ["low", "high", "xhigh"] as const;
const GPT52 = ["low", "high", "xhigh"] as const;
const GPT51 = ["low", "high"] as const;

function standardAndFast(
  familyId: string,
  prefix: string,
  efforts: readonly string[],
): CursorFamilyRule[] {
  return [
    family(familyId, "standard", variantMap(prefix, efforts)),
    family(familyId, "fast", variantMap(prefix, efforts, "-fast")),
  ];
}

const CURSOR_FAMILIES: CursorFamilyRule[] = [
  ...standardAndFast("grok-4.7", "grok-4.7", GROK47),
  ...standardAndFast("cursor-grok-4.7", "cursor-grok-4.7", GROK47),
  ...standardAndFast("grok-4.6", "grok-4.6", GROK46),
  ...standardAndFast("cursor-grok-4.6", "cursor-grok-4.6", GROK46),
  ...standardAndFast("grok-4.5", "grok-4.5", GROK45),
  ...standardAndFast("cursor-grok-4.5", "cursor-grok-4.5", GROK45),
  ...standardAndFast("gpt-5.6-sol", "gpt-5.6-sol", SIX_NONE),
  ...standardAndFast("gpt-5.6-terra", "gpt-5.6-terra", SIX_NONE),
  ...standardAndFast("gpt-5.6-luna", "gpt-5.6-luna", SIX_NONE),
  ...standardAndFast("gpt-5.5", "gpt-5.5", GPT55),
  ...standardAndFast("gpt-5.4", "gpt-5.4", GPT54),
  family("gpt-5.4-mini", "standard", variantMap("gpt-5.4-mini", GPT54_MINI)),
  family("gpt-5.4-nano", "standard", variantMap("gpt-5.4-nano", GPT54_MINI)),
  ...standardAndFast("gpt-5.3-codex", "gpt-5.3-codex", CODEX_EFFORT),
  ...standardAndFast("gpt-5.2", "gpt-5.2", GPT52),
  family("gpt-5.1", "standard", variantMap("gpt-5.1", GPT51)),
  ...standardAndFast("cursor-grok-4.6", "cursor-grok-4.6", GROK46),
  ...standardAndFast("cursor-grok-4.5", "cursor-grok-4.5", GROK45),
  family("claude-opus-5", "standard", variantMap("claude-opus-5", FLASH)),
  family("claude-opus-5", "fast", variantMap("claude-opus-5", FLASH, "-fast")),
  family("claude-opus-5", "thinking", variantMap("claude-opus-5-thinking", FIVE)),
  family(
    "claude-opus-5",
    "thinking-fast",
    variantMap("claude-opus-5-thinking", FIVE, "-fast"),
  ),
  family("claude-opus-4-8", "standard", variantMap("claude-opus-4-8", FIVE)),
  family("claude-opus-4-8", "fast", variantMap("claude-opus-4-8", FIVE, "-fast")),
  family("claude-opus-4-8", "thinking", variantMap("claude-opus-4-8-thinking", FIVE)),
  family(
    "claude-opus-4-8",
    "thinking-fast",
    variantMap("claude-opus-4-8-thinking", FIVE, "-fast"),
  ),
  family("claude-opus-4-7", "standard", variantMap("claude-opus-4-7", FIVE)),
  family("claude-opus-4-7", "fast", variantMap("claude-opus-4-7", FIVE, "-fast")),
  family("claude-opus-4-7", "thinking", variantMap("claude-opus-4-7-thinking", FIVE)),
  family(
    "claude-opus-4-7",
    "thinking-fast",
    variantMap("claude-opus-4-7-thinking", FIVE, "-fast"),
  ),
  family("claude-fable-5-1", "standard", variantMap("claude-fable-5-1", FIVE)),
  family(
    "claude-fable-5-1",
    "thinking",
    variantMap("claude-fable-5-1-thinking", FIVE),
  ),
  family("claude-fable-5", "standard", variantMap("claude-fable-5", FIVE)),
  family("claude-fable-5", "thinking", variantMap("claude-fable-5-thinking", FIVE)),
  family("claude-sonnet-5", "standard", variantMap("claude-sonnet-5", FIVE)),
  family("claude-sonnet-5", "thinking", variantMap("claude-sonnet-5-thinking", FIVE)),
  family("claude-4.6-sonnet", "standard", {
    medium: "claude-4.6-sonnet-medium",
  }),
  family("claude-4.6-sonnet", "thinking", {
    medium: "claude-4.6-sonnet-medium-thinking",
  }),
  family("claude-4.6-opus", "standard", {
    high: "claude-4.6-opus-high",
    max: "claude-4.6-opus-max",
  }),
  family("claude-4.6-opus", "thinking", {
    high: "claude-4.6-opus-high-thinking",
    max: "claude-4.6-opus-max-thinking",
  }),
  family("claude-4.5-opus", "standard", { high: "claude-4.5-opus-high" }),
  family("claude-4.5-opus", "thinking", {
    high: "claude-4.5-opus-high-thinking",
  }),
  family("gemini-3.8-flash", "standard", variantMap("gemini-3.8-flash", FLASH)),
  family("gemini-3.7-flash", "standard", variantMap("gemini-3.7-flash", FLASH)),
  family(
    "gemini-3.6-flash",
    "standard",
    variantMap("gemini-3.6-flash", ["minimal", "low", "medium", "high"]),
  ),
  family("muse-spark-1.3", "standard", variantMap("muse-spark-1.3", MUSE)),
  family("kimi-k3", "standard", variantMap("kimi-k3", ["low", "high", "max"])),
  family("glm-5.2", "standard", variantMap("glm-5.2", ["high", "max"])),
];

const NO_EFFORT_FAMILIES: Array<{ rule: CursorFamilyRule; nativeId: string }> = [
  { rule: family("composer-2.5", "standard", {}), nativeId: "composer-2.5" },
  { rule: family("composer-2.5", "fast", {}), nativeId: "composer-2.5-fast" },
  { rule: family("gpt-5-mini", "standard", {}), nativeId: "gpt-5-mini" },
  { rule: family("gpt-5.3-codex", "default", {}), nativeId: "gpt-5.3-codex" },
  { rule: family("gpt-5.3-codex", "default-fast", {}), nativeId: "gpt-5.3-codex-fast" },
  { rule: family("gpt-5.2", "default", {}), nativeId: "gpt-5.2" },
  { rule: family("gpt-5.2", "default-fast", {}), nativeId: "gpt-5.2-fast" },
  { rule: family("gpt-5.1", "default", {}), nativeId: "gpt-5.1" },
  {
    rule: family("claude-4.5-sonnet", "standard", {}),
    nativeId: "claude-4.5-sonnet",
  },
  {
    rule: family("claude-4.5-sonnet", "thinking", {}),
    nativeId: "claude-4.5-sonnet-thinking",
  },
  {
    rule: family("claude-4-sonnet", "standard", {}),
    nativeId: "claude-4-sonnet",
  },
  {
    rule: family("claude-4-sonnet", "thinking", {}),
    nativeId: "claude-4-sonnet-thinking",
  },
  { rule: family("gemini-3.1-pro", "standard", {}), nativeId: "gemini-3.1-pro" },
  { rule: family("gemini-3-flash", "standard", {}), nativeId: "gemini-3-flash" },
  {
    rule: family("gemini-3.5-flash", "standard", {}),
    nativeId: "gemini-3.5-flash",
  },
  { rule: family("kimi-k2.7-code", "standard", {}), nativeId: "kimi-k2.7-code" },
];

const NATIVE_TO_FAMILY = new Map<string, CursorFamilyRule>();
function bindFamily(rule: CursorFamilyRule, extraNativeIds: string[] = []) {
  for (const nativeId of Object.values(rule.variants)) {
    NATIVE_TO_FAMILY.set(nativeId, rule);
  }
  for (const nativeId of extraNativeIds) {
    NATIVE_TO_FAMILY.set(nativeId, rule);
  }
}
for (const rule of CURSOR_FAMILIES) bindFamily(rule);
for (const item of NO_EFFORT_FAMILIES) bindFamily(item.rule, [item.nativeId]);

function providerFromId(nativeId: string): string | undefined {
  if (
    nativeId.startsWith("cursor-grok-") ||
    nativeId.startsWith("grok-") ||
    nativeId.startsWith("composer-")
  ) {
    return "cursor";
  }
  if (nativeId.startsWith("gpt-") || nativeId === "auto") return "openai";
  if (nativeId.startsWith("claude-")) return "anthropic";
  if (nativeId.startsWith("gemini-")) return "google";
  if (nativeId.startsWith("kimi-")) return "kimi";
  if (nativeId.startsWith("glm-")) return "zhipu";
  if (nativeId.startsWith("muse-")) return "cursor";
  return undefined;
}

function isCursorModelId(token: string): boolean {
  if (token.startsWith("-")) return false;
  if (HEADER_TOKENS.has(token.toLowerCase())) return false;
  if (token === "auto") return true;
  return /^[a-z][a-z0-9]*(?:[.+_-][a-z0-9]+)+$/.test(token);
}

function firstModelId(line: string): string | undefined {
  const tokens = line
    .split(/[|,;\t ]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  for (const token of tokens) {
    if (isCursorModelId(token)) return token;
  }
  return undefined;
}

function presentVariants(
  rule: CursorFamilyRule,
  listed: Set<string>,
): { values: string[]; variants: Record<string, string> } {
  const values: string[] = [];
  const variants: Record<string, string> = {};
  for (const [effort, nativeId] of Object.entries(rule.variants)) {
    if (!listed.has(nativeId)) continue;
    values.push(effort);
    variants[effort] = nativeId;
  }
  return { values, variants };
}

function unknownEffort() {
  return {
    status: "unknown" as const,
    transport: "none" as const,
    values: [] as string[],
  };
}

function toCursorEntry(
  nativeId: string,
  listed: Set<string>,
  discoveredAt: string,
  source: CatalogParseInput["source"],
): ModelEntry {
  const providerId = providerFromId(nativeId);
  if (nativeId === "auto") {
    return ModelEntrySchema.parse({
      entryId: makeEntryId(ADAPTER_ID, providerId, nativeId),
      adapterId: ADAPTER_ID,
      nativeId,
      label: nativeId,
      providerId,
      accessModelKey: nativeId,
      selectionKind: "native-router",
      effort: unknownEffort(),
      source: source ?? "native-live",
      discoveredAt,
      hidden: false,
      availability: "listed",
      capabilityRevision: `${nativeId}:native-router:unknown`,
    });
  }
  const rule = NATIVE_TO_FAMILY.get(nativeId);
  if (!rule) {
    return ModelEntrySchema.parse({
      entryId: makeEntryId(ADAPTER_ID, providerId, nativeId),
      adapterId: ADAPTER_ID,
      nativeId,
      label: nativeId,
      providerId,
      accessModelKey: nativeId,
      selectionKind: "fixed",
      effort: unknownEffort(),
      source: source ?? "native-live",
      discoveredAt,
      hidden: false,
      availability: "listed",
      capabilityRevision: `${nativeId}:unknown`,
    });
  }
  const mapped = presentVariants(rule, listed);
  const fixedValue = Object.entries(rule.variants).find(
    ([, id]) => id === nativeId,
  )?.[0];
  const effort =
    mapped.values.length > 0
      ? {
          status: "supported" as const,
          transport: "variant-id" as const,
          values: mapped.values,
          fixedValue,
          variants: mapped.variants,
        }
      : unknownEffort();
  return ModelEntrySchema.parse({
    entryId: makeEntryId(ADAPTER_ID, providerId, nativeId),
    adapterId: ADAPTER_ID,
    nativeId,
    label: nativeId,
    providerId,
    familyId: rule.familyId,
    accessModelKey: rule.accessModelKey,
    selectionKind: "fixed",
    effort,
    source: source ?? "native-live",
    discoveredAt,
    hidden: false,
    availability: "listed",
    capabilityRevision: `${rule.accessModelKey}:${effort.values.join(",") || "unknown"}`,
  });
}

function parseCursorNativeIds(input: CatalogParseInput): string[] {
  const prepared = prepareCatalogText(input.stdout, input.truncated === true);
  if (prepared.overLimit) {
    throw new Error("over-limit");
  }
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

export const CURSOR_DEFAULT_SEEDS = [
  "grok-4.7",
  "grok-4.6",
  "grok-4.5",
  "composer-2.5",
  "claude-opus-5",
  "claude-sonnet-5",
  "gpt-5.6-sol",
];

function fallbackCursorCatalog(input: CatalogParseInput): ModelCatalog {
  const clock = input.discoveredAt ?? new Date().toISOString();
  const ids = [...CURSOR_DEFAULT_SEEDS];
  const listed = new Set(ids);
  const entries = ids.map((nativeId) =>
    toCursorEntry(nativeId, listed, clock, "official-seed"),
  );
  return freshModelCatalog(ADAPTER_ID, { ...input, discoveredAt: clock }, entries);
}

export function parseCursorModelCatalog(input: CatalogParseInput): ModelCatalog {
  const classified = discoveryFailureFromInput(input);
  if (classified) {
    return failedModelCatalog(ADAPTER_ID, input, classified.code, classified.message);
  }
  try {
    const ids = parseCursorNativeIds(input);
    if (ids.length === 0) {
      return fallbackCursorCatalog(input);
    }
    const mergedIds =
      ids.length > 10
        ? [...new Set([...CURSOR_DEFAULT_SEEDS, ...ids])]
        : ids;
    const listed = new Set(mergedIds);
    const clock = input.discoveredAt ?? new Date().toISOString();
    const entries = mergedIds.map((nativeId) =>
      toCursorEntry(nativeId, listed, clock, input.source),
    );
    return freshModelCatalog(ADAPTER_ID, { ...input, discoveredAt: clock }, entries);
  } catch {
    return fallbackCursorCatalog(input);
  }
}

export async function discoverModels(
  input: CatalogParseInput,
): Promise<ModelCatalog> {
  return parseCursorModelCatalog(input);
}

export { parseStructuredProbeTerminal as parseCursorProbeTerminal } from "../../sdk/src/probe-terminal.js";
