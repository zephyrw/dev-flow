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

const ADAPTER_ID = "mimo-code" as const;

const LOGICAL_MODEL_LABELS: Record<string, string> = {
  "mimo-v2.6-pro": "MiMo V2.6 Pro",
  "mimo-v2.6-flash": "MiMo V2.6 Flash",
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as JsonRecord;
}

function isProviderModel(token: string): boolean {
  if (!token.includes("/")) return false;
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
  const provider =
    typeof row.providerID === "string"
      ? row.providerID.trim()
      : typeof row.providerId === "string"
        ? row.providerId.trim()
        : typeof row.provider === "string"
          ? row.provider.trim()
          : undefined;
  const model =
    typeof row.id === "string" && !row.id.includes("/")
      ? row.id.trim()
      : typeof row.model === "string"
        ? row.model.trim()
        : undefined;
  if (provider && model) return `${provider}/${model}`;
  if (typeof row.provider === "string" && typeof row.model === "string") {
    const id = `${row.provider.trim()}/${row.model.trim()}`;
    return id.includes("/") ? id : undefined;
  }
  return undefined;
}

type MimoRow = {
  base: string;
  variants: string[];
  label?: string;
  providerId?: string;
};

function rowFromRecord(row: JsonRecord): MimoRow | undefined {
  const id = idFromRecord(row);
  if (!id) return undefined;
  const hash = id.indexOf("#");
  const base = hash < 0 ? id : id.slice(0, hash);
  const inlineVariant = hash < 0 ? undefined : id.slice(hash + 1);
  const variants = [
    ...variantsFromUnknown(row.variants ?? row.variant ?? row.thinking),
    ...(inlineVariant ? [inlineVariant] : []),
  ];
  const label =
    typeof row.label === "string"
      ? row.label.trim()
      : typeof row.name === "string"
        ? row.name.trim()
        : LOGICAL_MODEL_LABELS[base.split("/").pop() ?? ""];
  return {
    base,
    variants,
    label,
    providerId: base.split("/")[0],
  };
}

function mergeRow(target: Map<string, MimoRow>, row: MimoRow): void {
  const existing = target.get(row.base) ?? {
    base: row.base,
    variants: [],
    label: row.label,
    providerId: row.providerId,
  };
  for (const variant of row.variants) {
    if (!existing.variants.includes(variant)) existing.variants.push(variant);
  }
  // JSON 元数据中的 name 优先于行级 fallback 标签。
  if (row.label) existing.label = row.label;
  if (row.providerId) existing.providerId = row.providerId;
  target.set(row.base, existing);
}

/**
 * 解析 `mimo models --verbose`：模型行后可跟多行 JSON 元数据。
 * 不能简单按行截取，否则会丢失 variant 与 provider 信息。
 */
function parseMimoRows(input: CatalogParseInput): Map<string, MimoRow> {
  const prepared = prepareCatalogText(input.stdout, input.truncated === true);
  if (prepared.overLimit) throw new Error("over-limit");
  const text = prepared.text.trim();
  try {
    const parsed = JSON.parse(text) as unknown;
    const items = Array.isArray(parsed)
      ? parsed
      : asRecord(parsed)?.models ?? asRecord(parsed)?.data;
    if (Array.isArray(items)) {
      const merged = new Map<string, MimoRow>();
      for (const item of items) {
        if (typeof item === "string" && item.includes("/")) {
          mergeRow(merged, { base: item.trim().split("#")[0]!, variants: [] });
          continue;
        }
        const record = asRecord(item);
        const row = record ? rowFromRecord(record) : undefined;
        if (row) mergeRow(merged, row);
      }
      return merged;
    }
  } catch {
    // fall through to multi-line parse
  }

  const merged = new Map<string, MimoRow>();
  let current: MimoRow | undefined;
  let jsonBuffer: string[] = [];
  const flushJson = () => {
    if (!current || jsonBuffer.length === 0) {
      jsonBuffer = [];
      return;
    }
    try {
      const record = asRecord(JSON.parse(jsonBuffer.join("\n")));
      if (record) {
        const fromJson = rowFromRecord(record);
        if (fromJson) {
          mergeRow(merged, {
            base: current.base,
            variants: fromJson.variants,
            label: fromJson.label ?? current.label,
            providerId: fromJson.providerId ?? current.providerId,
          });
        }
      }
    } catch {
      // ignore incomplete metadata block
    }
    jsonBuffer = [];
  };

  for (const line of prepared.lines) {
    if (jsonBuffer.length > 0) {
      jsonBuffer.push(line);
      const joined = jsonBuffer.join("\n");
      try {
        JSON.parse(joined);
        flushJson();
      } catch {
        // incomplete multi-line JSON; keep buffering
      }
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      jsonBuffer.push(trimmed);
      const joined = jsonBuffer.join("\n");
      try {
        JSON.parse(joined);
        flushJson();
      } catch {
        // incomplete multi-line JSON; keep buffering
      }
      continue;
    }
    const tokens = trimmed
      .split(/[|,;\t ]+/)
      .map((token) => token.trim())
      .filter(Boolean);
    const id = tokens.find((token) => isProviderModel(token));
    if (!id) continue;
    const hash = id.indexOf("#");
    const base = hash < 0 ? id : id.slice(0, hash);
    const inlineVariant = hash < 0 ? undefined : id.slice(hash + 1);
    const labelToken = tokens.find(
      (token) => token !== id && LOGICAL_MODEL_LABELS[token],
    );
    current = {
      base,
      variants: inlineVariant ? [inlineVariant] : [],
      label: labelToken
        ? LOGICAL_MODEL_LABELS[labelToken]
        : LOGICAL_MODEL_LABELS[base.split("/").pop() ?? ""],
      providerId: base.split("/")[0],
    };
    mergeRow(merged, current);
  }
  flushJson();
  return merged;
}

function mimoEffort(variants: string[]): ModelEffort {
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

function toMimoEntry(row: MimoRow, discoveredAt: string): ModelEntry {
  const nativeId = row.base;
  const providerId = row.providerId ?? nativeId.split("/")[0];
  const effort = mimoEffort(row.variants);
  const logicalKey = Object.keys(LOGICAL_MODEL_LABELS).find((key) =>
    nativeId.endsWith(key) || nativeId.includes("/" + key),
  );
  const label =
    row.label ??
    (logicalKey ? LOGICAL_MODEL_LABELS[logicalKey] : undefined) ??
    nativeId;
  return ModelEntrySchema.parse({
    entryId: makeEntryId(ADAPTER_ID, providerId, nativeId),
    adapterId: ADAPTER_ID,
    nativeId,
    label,
    providerId,
    familyId: logicalKey,
    selectionKind: "fixed",
    effort,
    source: "native-live",
    discoveredAt,
    hidden: false,
    availability: "listed",
    capabilityRevision: `${nativeId}:${effort.status}:${effort.values.join(",")}`,
  });
}

export function parseMimoModelCatalog(input: CatalogParseInput): ModelCatalog {
  const classified = discoveryFailureFromInput(input);
  if (classified) {
    return failedModelCatalog(ADAPTER_ID, input, classified.code, classified.message);
  }
  try {
    const rows = parseMimoRows(input);
    if (rows.size === 0) {
      return failedModelCatalog(
        ADAPTER_ID,
        input,
        "CATALOG_OUTPUT_INVALID",
        "mimo models 未解析到 provider/model",
      );
    }
    const clock = input.discoveredAt ?? new Date().toISOString();
    const entries: ModelEntry[] = [];
    for (const row of rows.values()) {
      entries.push(toMimoEntry(row, clock));
    }
    return freshModelCatalog(ADAPTER_ID, { ...input, discoveredAt: clock }, entries);
  } catch {
    return failedModelCatalog(
      ADAPTER_ID,
      input,
      "CATALOG_OUTPUT_INVALID",
      "MiMo Code 模型目录解析失败",
    );
  }
}

export async function discoverModels(
  input: CatalogParseInput,
): Promise<ModelCatalog> {
  return parseMimoModelCatalog(input);
}

export function detectMimoVariantEncoding(
  helpText: string,
): "flag" | "hash" | undefined {
  const hasFlag = /--variant\b/.test(helpText);
  const hasHash = /#<variant>|#variant|provider\/model#/i.test(helpText);
  if (hasFlag) return "flag";
  if (hasHash) return "hash";
  return undefined;
}
