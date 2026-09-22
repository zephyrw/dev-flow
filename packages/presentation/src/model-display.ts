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
};

const KNOWN_MODEL_LABELS: Record<string, string> = {
  "gpt-6-astra": "GPT-6 Astra",
  "gpt-5": "GPT-5",
  "gpt-5.1": "GPT-5.1",
  "gpt-5.2": "GPT-5.2",
  "gpt-5-codex": "GPT-5 Codex",
  "gpt-5.1-codex": "GPT-5.1 Codex",
  "gpt-5.2-codex": "GPT-5.2 Codex",
  "gemini-3.8-flash": "Gemini 3.8 Flash",
  "gemini-3.7-flash": "Gemini 3.7 Flash",
  "gemini-3.6-flash": "Gemini 3.6 Flash",
  "gemini-3.1-pro": "Gemini 3.1 Pro",
  "claude-3-7-sonnet": "Claude 3.7 Sonnet",
  "claude-3-5-sonnet": "Claude 3.5 Sonnet",
};

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
  if (KNOWN_MODEL_LABELS[token]) return KNOWN_MODEL_LABELS[token];

  // 针对形如 gemini-3.8-flash-high 或 gemini-3.8-flash-medium 的变体 ID，映射家族名
  for (const [family, label] of Object.entries(KNOWN_MODEL_LABELS)) {
    if (
      token === `${family}-high` ||
      token === `${family}-medium` ||
      token === `${family}-low`
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

  for (const entry of entries) {
    if (entry.hidden) continue;

    // 只有在具备可信变体结构元数据时才进行归组：
    // 1. entry 显式声明了 familyId
    // 2. entry 显式声明了非空的 effort.variants
    // 3. entry 的 effort.transport === "variant-id" 且声明了 effort.fixedValue
    const hasTrustedVariants = Boolean(
      entry.familyId ||
      (entry.effort.variants && Object.keys(entry.effort.variants).length > 0) ||
      (entry.effort.transport === "variant-id" && entry.effort.fixedValue)
    );

    const familyKey = hasTrustedVariants
      ? (entry.familyId || (entry.adapterId === "agy" ? detectAgyFamily(entry.nativeId) : undefined))
      : undefined;

    if (familyKey) {
      const existing = choicesMap.get(familyKey);
      const variants: Record<string, string> = {
        ...(existing?.variantByEffort ?? {}),
        ...(entry.effort.variants ?? {}),
      };

      if (entry.effort.fixedValue) {
        variants[entry.effort.fixedValue] = entry.nativeId;
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

      choicesMap.set(familyKey, {
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
      });
    } else {
      const choiceId = entry.nativeId;
      const label = formatModelName(entry.adapterId, entry.label || entry.nativeId);
      const effortValues = [...entry.effort.values];
      choicesMap.set(choiceId, {
        choiceId,
        label,
        entryIds: [entry.entryId],
        effortValues,
        defaultEffort: entry.effort.defaultValue,
        variantByEffort: entry.effort.variants ?? {},
        nativeId: entry.nativeId,
        providerId: entry.providerId,
        source: entry.source,
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
