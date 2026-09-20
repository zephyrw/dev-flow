import { FlowError } from "../../../contracts/src/index.js";
import type {
  ReasoningSelection,
  SupportedAdapterId,
  ToolProfile,
} from "../../../contracts/src/execution-spec.js";
import type { EffortTransport, ModelEntry } from "../../../contracts/src/model-catalog.js";
import type {
  ModelSelectionCapability,
  ModelSelectionFingerprint,
  ResolvedSelection,
} from "./interface.js";

const COMPOSITE_EFFORTS = new Set(["opusplan", "ultracode"]);

type EffortParts = {
  modelToken: string | null;
  effortArgs: string[];
  effortEnv: Record<string, string>;
  transport: EffortTransport;
};

export function resolveModelSelection(
  profile: ToolProfile,
  catalogEntry: ModelEntry | undefined,
  capability: ModelSelectionCapability = {},
): ResolvedSelection {
  assertHiddenAllowed(profile, catalogEntry);
  assertCatalogAdapter(profile, catalogEntry);
  const reasoning = normalizeReasoning(profile.reasoning);
  assertExplicitEffortAllowed(profile, catalogEntry, capability, reasoning);
  const requested =
    reasoning.mode === "explicit" ? reasoning.value : undefined;
  const built = buildAdapterSelection(
    profile,
    catalogEntry,
    capability,
    requested,
  );
  const effortValue = requested ?? null;
  return {
    adapterId: profile.adapterId,
    modelToken: built.modelToken,
    effortArgs: built.effortArgs,
    effortEnv: built.effortEnv,
    reasoning,
    transport: built.transport,
    fingerprint: buildFingerprint(
      profile,
      built.modelToken,
      built.transport,
      effortValue,
    ),
  };
}

function normalizeReasoning(
  reasoning: ReasoningSelection | undefined,
): ReasoningSelection {
  if (!reasoning) return { mode: "native-default" };
  return reasoning;
}

function baseModelToken(
  profile: ToolProfile,
  catalogEntry: ModelEntry | undefined,
): string | null {
  const fromCatalog = catalogEntry?.nativeId?.trim();
  if (fromCatalog) return fromCatalog;
  const fromProfile = profile.modelId?.trim();
  return fromProfile ? fromProfile : null;
}

function assertHiddenAllowed(
  profile: ToolProfile,
  catalogEntry: ModelEntry | undefined,
): void {
  if (!catalogEntry?.hidden) return;
  const current = profile.modelId?.trim();
  if (current && current === catalogEntry.nativeId) return;
  fail("MODEL_NOT_LISTED", "隐藏模型不能作为普通可选项");
}

function assertCatalogAdapter(
  profile: ToolProfile,
  catalogEntry: ModelEntry | undefined,
): void {
  if (!catalogEntry) return;
  if (catalogEntry.adapterId === profile.adapterId) return;
  fail("MODEL_NOT_LISTED", "目录条目与当前工具不匹配");
}

function assertExplicitEffortAllowed(
  profile: ToolProfile,
  catalogEntry: ModelEntry | undefined,
  capability: ModelSelectionCapability,
  reasoning: ReasoningSelection,
): void {
  if (reasoning.mode !== "explicit") return;
  if (COMPOSITE_EFFORTS.has(reasoning.value)) {
    fail("EFFORT_UNSUPPORTED", "不允许把复合行为当作纯思考强度");
  }
  if (!catalogEntry) {
    if (profile.adapterId === "kimi-code") {
      assertKimiEffortChannel(catalogEntry, capability);
    }
    assertGrok45RejectsXhigh(profile, catalogEntry, reasoning.value);
    return;
  }
  const status = catalogEntry.effort.status;
  if (status === "unknown") {
    fail("EFFORT_METADATA_UNKNOWN", "当前客户端未提供该档位信息");
  }
  if (profile.adapterId === "kimi-code") {
    assertKimiEffortChannel(catalogEntry, capability);
  }
  if (status === "unsupported") {
    fail("EFFORT_UNSUPPORTED", "当前模型不适用思考强度");
  }
  const allowed = allowedEffortValues(profile, catalogEntry, capability);
  if (!allowed.includes(reasoning.value)) {
    fail("EFFORT_UNSUPPORTED", "当前模型不支持该思考强度", {
      value: reasoning.value,
      allowed,
    });
  }
  assertGrok45RejectsXhigh(profile, catalogEntry, reasoning.value);
}

function assertKimiEffortChannel(
  catalogEntry: ModelEntry | undefined,
  capability: ModelSelectionCapability,
): void {
  const provider = capability.kimiProvider ?? catalogEntry?.providerId;
  if (isKimiManagedProvider(provider)) return;
  fail(
    "CLI_PARAMETER_UNSUPPORTED",
    "当前客户端暂不能按次覆盖此 provider 的思考强度",
  );
}

function isKimiManagedProvider(provider: string | undefined): boolean {
  if (!provider) return true;
  const value = provider.toLowerCase();
  return (
    value === "kimi" ||
    value === "kimi-code" ||
    value.startsWith("managed:kimi")
  );
}

function allowedEffortValues(
  profile: ToolProfile,
  catalogEntry: ModelEntry | undefined,
  capability: ModelSelectionCapability,
): string[] {
  if (profile.adapterId === "kimi-code" && capability.kimiSupportEfforts) {
    return capability.kimiSupportEfforts;
  }
  return catalogEntry?.effort.values ?? [];
}

function assertGrok45RejectsXhigh(
  profile: ToolProfile,
  catalogEntry: ModelEntry | undefined,
  value: string,
): void {
  if (value !== "xhigh") return;
  const token = baseModelToken(profile, catalogEntry);
  if (!isGrok45Id(token)) return;
  fail("EFFORT_UNSUPPORTED", "grok-4.5 不支持 xhigh");
}

function isGrok45Id(token: string | null): boolean {
  if (!token) return false;
  return (
    token === "grok-4.5" ||
    token.startsWith("grok-4.5-") ||
    token === "cursor-grok-4.5" ||
    token.startsWith("cursor-grok-4.5-")
  );
}

function buildFingerprint(
  profile: ToolProfile,
  modelToken: string | null,
  transport: EffortTransport,
  effortValue: string | null,
): ModelSelectionFingerprint {
  return {
    adapterId: profile.adapterId,
    executable: profile.executableRef,
    nativeConfigProfile: profile.nativeConfigProfile,
    modelId: modelToken,
    effortTransport: transport,
    effortValue,
  };
}

function noEffort(modelToken: string | null): EffortParts {
  return {
    modelToken,
    effortArgs: [],
    effortEnv: {},
    transport: "none",
  };
}

function buildAdapterSelection(
  profile: ToolProfile,
  catalogEntry: ModelEntry | undefined,
  capability: ModelSelectionCapability,
  requested: string | undefined,
): EffortParts {
  const token = baseModelToken(profile, catalogEntry);
  if (!requested) return noEffort(token);
  switch (profile.adapterId) {
    case "codex":
      return buildCodex(token, requested);
    case "agy":
      return buildAgy(catalogEntry, token, requested);
    case "claude-code":
      return buildClaude(token, requested);
    case "cursor-agent":
      return buildCursor(catalogEntry, token, requested);
    case "grok-build":
      return buildReasoningFlag(token, requested);
    case "kimi-code":
      return buildKimi(token, requested);
    case "qoder":
      return buildReasoningFlag(token, requested);
    case "opencode":
      return buildOpenCode(token, requested, capability);
    default: {
      const adapter: SupportedAdapterId = profile.adapterId;
      fail("CLI_PARAMETER_UNSUPPORTED", `不支持的工具 ${adapter}`);
    }
  }
}

function buildCodex(token: string | null, value: string): EffortParts {
  return {
    modelToken: token,
    effortArgs: ["-c", `model_reasoning_effort="${value}"`],
    effortEnv: {},
    transport: "config",
  };
}

function buildAgy(
  catalogEntry: ModelEntry | undefined,
  token: string | null,
  value: string,
): EffortParts {
  const resolved = lookupVariant(catalogEntry, token, value, true);
  if (resolved.independentFlag) {
    return {
      modelToken: resolved.modelToken,
      effortArgs: ["--effort", value],
      effortEnv: {},
      transport: "flag",
    };
  }
  return {
    modelToken: resolved.modelToken,
    effortArgs: [],
    effortEnv: {},
    transport: "variant-id",
  };
}

function buildClaude(token: string | null, value: string): EffortParts {
  return {
    modelToken: token,
    effortArgs: ["--effort", value],
    effortEnv: { CLAUDE_CODE_EFFORT_LEVEL: value },
    transport: "flag",
  };
}

function buildCursor(
  catalogEntry: ModelEntry | undefined,
  token: string | null,
  value: string,
): EffortParts {
  const resolved = lookupVariant(catalogEntry, token, value, false);
  return {
    modelToken: resolved.modelToken,
    effortArgs: [],
    effortEnv: {},
    transport: "variant-id",
  };
}

function buildReasoningFlag(token: string | null, value: string): EffortParts {
  return {
    modelToken: token,
    effortArgs: ["--reasoning-effort", value],
    effortEnv: {},
    transport: "flag",
  };
}

function buildKimi(token: string | null, value: string): EffortParts {
  return {
    modelToken: token,
    effortArgs: [],
    effortEnv: { KIMI_MODEL_THINKING_EFFORT: value },
    transport: "env",
  };
}

function buildOpenCode(
  token: string | null,
  value: string,
  capability: ModelSelectionCapability,
): EffortParts {
  if (!token) fail("MODEL_NOT_LISTED", "OpenCode 需要 provider/model");
  const base = openCodeBase(token);
  const encoding = capability.opencodeVariantEncoding;
  if (encoding === "hash") {
    return {
      modelToken: `${base}#${value}`,
      effortArgs: [],
      effortEnv: {},
      transport: "variant-id",
    };
  }
  if (encoding === "flag") {
    return {
      modelToken: base,
      effortArgs: ["--variant", value],
      effortEnv: {},
      transport: "variant-flag",
    };
  }
  const hash = token.indexOf("#");
  if (hash > 0 && token.slice(hash + 1) === value) {
    return {
      modelToken: token,
      effortArgs: [],
      effortEnv: {},
      transport: "variant-id",
    };
  }
  fail("CLI_PARAMETER_UNSUPPORTED", "缺少 OpenCode variant 编码能力");
}

function openCodeBase(token: string | null): string {
  if (!token) return "";
  const hash = token.indexOf("#");
  if (hash < 0) return token;
  return token.slice(0, hash);
}

function tokenMatchesEffort(token: string, value: string): boolean {
  const base = token.endsWith("-fast") ? token.slice(0, -5) : token;
  if (value === "extra-high") return base.endsWith("-extra-high");
  if (value === "xhigh") return base.endsWith("-xhigh");
  if (value === "high") {
    return (
      base.endsWith("-high") &&
      !base.endsWith("-xhigh") &&
      !base.endsWith("-extra-high")
    );
  }
  return base.endsWith(`-${value}`);
}

function lookupVariant(
  catalogEntry: ModelEntry | undefined,
  fallback: string | null,
  value: string,
  allowIndependentFlag: boolean,
): { modelToken: string | null; independentFlag: boolean } {
  if (catalogEntry?.selectionKind === "native-router") {
    return { modelToken: catalogEntry.nativeId, independentFlag: false };
  }
  const mapped = catalogEntry?.effort.variants?.[value];
  if (mapped) {
    return { modelToken: mapped, independentFlag: false };
  }
  if (catalogEntry?.effort.fixedValue === value) {
    return { modelToken: catalogEntry.nativeId, independentFlag: false };
  }
  if (
    allowIndependentFlag &&
    catalogEntry?.effort.transport === "flag" &&
    catalogEntry.effort.values.includes(value)
  ) {
    return {
      modelToken: catalogEntry.nativeId || fallback,
      independentFlag: true,
    };
  }
  if (!catalogEntry && fallback && tokenMatchesEffort(fallback, value)) {
    return { modelToken: fallback, independentFlag: false };
  }
  fail("EFFORT_UNSUPPORTED", "目录中不存在该思考强度对应的精确模型", {
    value,
  });
}

function fail(
  code: string,
  message: string,
  details: Record<string, unknown> | null = null,
): never {
  throw new FlowError(code, message, 422, details);
}
