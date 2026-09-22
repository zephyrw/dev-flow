import { z } from "zod";
import { Id } from "./base.js";
import { SupportedAdapters, type SupportedAdapterId } from "./execution-spec.js";

export const EFFORT_LABELS = {
  none: "无",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最大",
  ultra: "原生 Ultra",
} as const;
export type EffortLabelValue = keyof typeof EFFORT_LABELS;

export const EffortStatusSchema = z.enum([
  "supported",
  "unsupported",
  "unknown",
]);
export type EffortStatus = z.infer<typeof EffortStatusSchema>;

export const EffortTransportSchema = z.enum([
  "config",
  "flag",
  "env",
  "variant-id",
  "variant-flag",
  "none",
]);
export type EffortTransport = z.infer<typeof EffortTransportSchema>;

export const ModelEffortSchema = z
  .object({
    status: EffortStatusSchema,
    transport: EffortTransportSchema,
    values: z.array(z.string()),
    defaultValue: z.string().optional(),
    fixedValue: z.string().optional(),
    variants: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type ModelEffort = z.infer<typeof ModelEffortSchema>;

export const ModelSourceSchema = z.enum([
  "native-live",
  "native-cache",
  "native-config",
  "official-seed",
  "manual",
]);
export type ModelSource = z.infer<typeof ModelSourceSchema>;

export const ModelAvailabilitySchema = z.enum([
  "listed",
  "candidate",
  "unavailable",
]);
export type ModelAvailability = z.infer<typeof ModelAvailabilitySchema>;

export const ModelSelectionKindSchema = z.enum(["fixed", "native-router"]);

export const ModelEntrySchema = z
  .object({
    entryId: z.string().min(1),
    adapterId: z.enum(SupportedAdapters),
    nativeId: z.string().min(1),
    label: z.string().min(1),
    providerId: z.string().optional(),
    familyId: z.string().optional(),
    accessModelKey: z.string().optional(),
    selectionKind: ModelSelectionKindSchema,
    effort: ModelEffortSchema,
    source: ModelSourceSchema,
    discoveredAt: z.string().min(1),
    hidden: z.boolean(),
    availability: ModelAvailabilitySchema,
    capabilityRevision: z.string().min(1),
  })
  .strict();
export type ModelEntry = z.infer<typeof ModelEntrySchema>;

export const ModelCatalogStatusSchema = z.enum([
  "fresh",
  "stale",
  "missing",
  "refreshing",
  "failed",
]);
export type ModelCatalogStatus = z.infer<typeof ModelCatalogStatusSchema>;

export const ModelInvocationCapabilitySchema = z.object({
  opencodeVariantEncoding: z.enum(["flag", "hash"]).optional(),
}).strict();
export type ModelInvocationCapability = z.infer<typeof ModelInvocationCapabilitySchema>;

export const ModelCatalogSchema = z
  .object({
    adapterId: z.enum(SupportedAdapters),
    scopeHash: z.string().min(1),
    cliPath: z.string().optional(),
    cliVersion: z.string().optional(),
    nativeConfigScope: z.string().optional(),
    nativeConfigProfile: z.string().optional(),
    invocationCapability: ModelInvocationCapabilitySchema.optional(),
    status: ModelCatalogStatusSchema,
    discoveredAt: z.string().min(1),
    staleAfter: z.string().min(1),
    entries: z.array(ModelEntrySchema),
    errorCode: z.string().optional(),
    errorMessage: z.string().optional(),
  })
  .strict();
export type ModelCatalog = z.infer<typeof ModelCatalogSchema>;

export const ToolDiscoveryStatusSchema = z.enum([
  "detected",
  "not-detected",
  "identity-mismatch",
  "environment-unavailable",
]);
export type ToolDiscoveryStatus = z.infer<typeof ToolDiscoveryStatusSchema>;

export const ToolSummarySchema = z
  .object({
    adapterId: z.enum(SupportedAdapters),
    label: z.string().min(1),
    executablePath: z.string().optional(),
    cliVersion: z.string().optional(),
    probeStatus: ToolDiscoveryStatusSchema,
    installHint: z.string().optional(),
    nativeConfigSummary: z.string().optional(),
    catalogStatus: ModelCatalogStatusSchema,
    catalogUpdatedAt: z.string().optional(),
  })
  .strict();
export type ToolSummary = z.infer<typeof ToolSummarySchema>;

export const OfficialSeedSchema = z
  .object({
    sourceUrl: z.string().min(1),
    checkedAt: z.string().min(1),
    cliVersionConstraint: z.string().optional(),
    nativeIdConfirmed: z.boolean(),
    effortEvidence: z.string().optional(),
    nativeId: z.string().optional(),
    label: z.string().min(1),
    effortValues: z.array(z.string()).optional(),
  })
  .strict();
export type OfficialSeed = z.infer<typeof OfficialSeedSchema>;

export const TOOL_DISPLAY_ORDER: Array<{
  adapterId: SupportedAdapterId;
  label: string;
}> = [
  { adapterId: "codex", label: "Codex" },
  { adapterId: "agy", label: "Antigravity CLI" },
  { adapterId: "claude-code", label: "Claude Code" },
  { adapterId: "cursor-agent", label: "Cursor Agent" },
  { adapterId: "grok-build", label: "Grok Build" },
  { adapterId: "kimi-code", label: "Kimi Code" },
  { adapterId: "qoder", label: "Qoder CLI" },
  { adapterId: "opencode", label: "OpenCode" },
  { adapterId: "mimo-code", label: "MiMo Code" },
];

export const CATALOG_FRESH_MS = 24 * 60 * 60 * 1000;
export const VERSION_HELP_TIMEOUT_MS = 10_000;
export const CATALOG_READ_TIMEOUT_MS = 30_000;
export const CATALOG_OUTPUT_LIMIT = 2 * 1024 * 1024;
export const TOOL_SCAN_CONCURRENCY = 2;
export const CATALOG_QUERY_CONCURRENCY = 1;

export const ModelCatalogEntityIdSchema = z
  .string()
  .regex(/^catalog:[a-f0-9]{64}$/);
export const CatalogScopeIdSchema = Id;
