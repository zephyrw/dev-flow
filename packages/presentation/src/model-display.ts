import type { ModelEntry } from "../../contracts/src/model-catalog.js";

export type ModelChoice = {
  choiceId: string;
  label: string;
  entryIds: string[];
  effortValues: string[];
  defaultEffort?: string;
  variantByEffort: Record<string, string>;
  nativeId: string;
  providerId?: string;
  source: string;
  effortStatus: ModelEntry["effort"]["status"];
  selectionKind: ModelEntry["selectionKind"];
};

const KNOWN_MODEL_LABELS: Record<string, string> = {
  "gpt-6-astra": "GPT-6 Astra",
  "gpt-5": "GPT-5",
  "gpt-5.1": "GPT-5.1",
  "gpt-5.2": "GPT-5.2",
  "gpt-5-codex": "GPT-5 Codex",
  "gpt-5.1-codex": "GPT-5.1 Codex",
  "gpt-5.2-codex": "GPT-5.2 Codex",
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-5.6-terra": "GPT-5.6 Terra",
  "gpt-5.6-luna": "GPT-5.6 Luna",
  "gpt-5.5": "GPT-5.5",
  "gemini-3.8-flash": "Gemini 3.8 Flash",
  "gemini-3.7-flash": "Gemini 3.7 Flash",
  "gemini-3.6-flash": "Gemini 3.6 Flash",
  "gemini-3.1-pro": "Gemini 3.1 Pro",
  "claude-fable-5-1": "Claude Fable 5.1",
  "claude-fable-5": "Claude Fable 5",
  "claude-opus-5": "Claude Opus 5",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-opus-4-8": "Claude Opus 4.8",
  "claude-opus-4-7": "Claude Opus 4.7",
  "claude-opus-4-6": "Claude Opus 4.6",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-haiku-4-5": "Claude Haiku 4.5",
  "claude-3-7-sonnet": "Claude 3.7 Sonnet",
  "claude-3-5-sonnet": "Claude 3.5 Sonnet",
  "grok-4.7": "Grok 4.7",
  "grok-4.6": "Grok 4.6",
  "grok-4.5": "Grok 4.5",
  "grok-4": "Grok 4",
  "cursor-grok-4.6": "Grok 4.6",
  "cursor-grok-4.5": "Grok 4.5",
  "composer-2.5": "Composer 2.5",
  "glm-5.3-flash": "GLM 5.3 Flash",
  "glm-53-flash": "GLM 5.3 Flash",
  "glm-5.3": "GLM 5.3",
  "glm-5.2": "GLM 5.2",
  "qwen-3.8-max": "Qwen 3.8 Max",
  "deepseek-v4-pro": "DeepSeek V4 Pro",
  "deepseek-v4-flash": "DeepSeek V4 Flash",
  "kimi-k3": "Kimi K3",
  "kimi-k2.7-code": "Kimi K2.7 Code",
  "kimi-k2.5": "Kimi K2.5",
  "xiaomi/mimo-v2.6-pro": "MiMo V2.6 Pro",
  "xiaomi/mimo-v2.6-flash": "MiMo V2.6 Flash",
  "xiaomi/mimo-v2.5": "MiMo V2.5",
  "mimo-v2.6-pro": "MiMo V2.6 Pro",
  "mimo-v2.6-flash": "MiMo V2.6 Flash",
  "mimo-v2.5": "MiMo V2.5",
};

export function isEquivalentModelName(
  a?: string | null,
  b?: string | null,
): boolean {
  if (!a || !b) return false;
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .trim()
      .replace(/[\s\-_.:/]/g, "");
  return normalize(a) === normalize(b);
}

export function formatToolName(adapterId?: string | null): string {
  if (!adapterId) return "";
  switch (adapterId) {
    case "codex":
      return "Codex";
    case "agy":
      return "AGY";
    case "mimo-code":
      return "MiMo Code";
    case "claude-code":
      return "Claude Code";
    case "cursor-agent":
      return "Cursor Agent";
    case "grok-build":
      return "Grok Build";
    case "kimi-code":
      return "Kimi Code";
    case "qoder":
      return "Qoder";
    case "opencode":
      return "OpenCode";
    default:
      return adapterId;
  }
}

export function formatModelName(
  adapterId?: string | null,
  modelIdOrLabel?: string | null,
): string {
  if (!modelIdOrLabel || !modelIdOrLabel.trim()) return "";
  const token = modelIdOrLabel.trim();
  const lower = token.toLowerCase();
  if (KNOWN_MODEL_LABELS[token]) return KNOWN_MODEL_LABELS[token];
  if (KNOWN_MODEL_LABELS[lower]) return KNOWN_MODEL_LABELS[lower];

  // 针对形如 gemini-3.8-flash-high 或 gemini-3.8-flash-medium 的变体 ID，映射家族名
  for (const [family, label] of Object.entries(KNOWN_MODEL_LABELS)) {
    if (
      token === `${family}-high` ||
      token === `${family}-medium` ||
      token === `${family}-low` ||
      lower === `${family}-high` ||
      lower === `${family}-medium` ||
      lower === `${family}-low`
    ) {
      return label;
    }
  }

  return token;
}

export function formatRuntimeDisplay(
  inputOrAdapter?:
    | {
        adapterId?: string | null;
        modelId?: string | null;
        effort?: string | null;
      }
    | string
    | null,
  rawModelId?: string | null,
  effort?: string | null,
): string {
  let adapterId: string | null | undefined;
  let modelId: string | null | undefined;
  let eff: string | null | undefined;

  if (typeof inputOrAdapter === "object" && inputOrAdapter !== null) {
    adapterId = inputOrAdapter.adapterId;
    modelId = inputOrAdapter.modelId;
    eff = inputOrAdapter.effort;
  } else {
    adapterId = inputOrAdapter;
    modelId = rawModelId;
    eff = effort;
  }

  const tool = formatToolName(adapterId);
  const model = formatModelName(adapterId, modelId);
  if (!tool && !model) return "选择模型";
  if (!tool) return model;
  if (!model) return tool;

  const effortPart =
    eff &&
    eff !== "default" &&
    eff !== "none" &&
    eff !== "native-default" &&
    eff !== "not-applicable"
      ? ` (${eff})`
      : "";

  return `${tool} · ${model}${effortPart}`;
}

export function buildModelChoices(entries: ModelEntry[]): ModelChoice[] {
  const choicesMap = new Map<string, ModelChoice>();

  // 保证排序稳定，同时让 native-config（用户本地配置文件里的模型）排在最前
  const sortedEntries = [...entries].sort((a, b) => {
    const aConfig = a.source === "native-config" ? 1 : 0;
    const bConfig = b.source === "native-config" ? 1 : 0;
    return bConfig - aConfig;
  });

  for (const entry of sortedEntries) {
    if (entry.hidden || entry.availability === "unavailable") continue;

    // A family label alone does not prove that distinct IDs are effort variants.
    const variants = entry.effort.variants ?? {};
    const mappedEffort = Object.entries(variants).find(([, id]) => id === entry.nativeId)?.[0];
    const fixedEffort = entry.effort.fixedValue ?? mappedEffort;
    const hasTrustedVariants = entry.effort.status === "supported" && Boolean(fixedEffort);
    const familyKey = hasTrustedVariants
      ? entry.familyId || (entry.adapterId === "agy" ? detectAgyFamily(entry.nativeId) : undefined)
      : undefined;
    const scope = `${entry.adapterId}/${entry.providerId ?? ""}/`;

    if (familyKey) {
      const existing = choicesMap.get(scope + familyKey);
      const variants: Record<string, string> = {
        ...(existing?.variantByEffort ?? {}),
        ...(entry.effort.variants ?? {}),
      };

      if (fixedEffort) {
        variants[fixedEffort] = entry.nativeId;
      }

      const effortValues = Array.from(
        new Set([
          ...(existing?.effortValues ?? []),
          ...entry.effort.values,
          ...Object.keys(variants),
        ]),
      );

      const label = formatModelName(entry.adapterId, familyKey);
      const defaultNative =
        variants["high"] ||
        variants["medium"] ||
        variants["low"] ||
        entry.nativeId;

      choicesMap.set(scope + familyKey, {
        choiceId: familyKey,
        label,
        entryIds: [...(existing?.entryIds ?? []), entry.entryId],
        effortValues,
        defaultEffort:
          existing?.defaultEffort ??
          entry.effort.defaultValue ??
          (effortValues.includes("high") ? "high" : effortValues[0]),
        variantByEffort: variants,
        nativeId: defaultNative,
        providerId: entry.providerId,
        source: entry.source,
        effortStatus: entry.effort.status,
        selectionKind: entry.selectionKind,
      });
    } else {
      const choiceId = entry.nativeId;
      const label = formatModelName(entry.adapterId, entry.label || entry.nativeId);
      const effortValues = [...entry.effort.values];
      choicesMap.set(scope + choiceId, {
        choiceId,
        label,
        entryIds: [entry.entryId],
        effortValues,
        defaultEffort: entry.effort.defaultValue,
        variantByEffort: entry.effort.variants ?? {},
        nativeId: entry.nativeId,
        providerId: entry.providerId,
        source: entry.source,
        effortStatus: entry.effort.status,
        selectionKind: entry.selectionKind,
      });
    }
  }

  return Array.from(choicesMap.values());
}

function detectAgyFamily(nativeId: string): string | undefined {
  for (const suffix of ["-high", "-medium", "-low"]) {
    if (nativeId.endsWith(suffix)) {
      return nativeId.slice(0, -suffix.length);
    }
  }
  return undefined;
}
