import { z } from "zod";
import { Id } from "./base.js";

export const SupportedAdapters = [
  "codex",
  "agy",
  "grok-build",
  "claude-code",
  "kimi-code",
  "qoder",
  "opencode",
  "cursor-agent",
  "mimo-code",
] as const;
export type SupportedAdapterId = (typeof SupportedAdapters)[number];

export const PROFILE_OPTION_KEYS = ["prefixArgs"] as const;
export const ToolProfileOptionsSchema = z
  .object({
    prefixArgs: z.array(z.string()).optional(),
  })
  .strict()
  .default({});
export type ToolProfileOptions = z.infer<typeof ToolProfileOptionsSchema>;

export const ReasoningSelectionSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("explicit"),
      value: z.string().min(1),
    })
    .strict(),
  z.object({ mode: z.literal("native-default") }).strict(),
  z.object({ mode: z.literal("not-applicable") }).strict(),
]);
export type ReasoningSelection = z.infer<typeof ReasoningSelectionSchema>;

export const SelectionKindSchema = z.enum([
  "fixed",
  "native-router",
  "native-default",
]);
export type SelectionKind = z.infer<typeof SelectionKindSchema>;

const NativeConfigProfileSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
    "原生命名配置只能是已有配置名，不能包含 shell 片段",
  );

export const ToolProfileObjectSchema = z
  .object({
    id: Id,
    revision: z.number().int().positive().default(1),
    adapterId: z.enum(SupportedAdapters),
    executableRef: z.string().optional(),
    modelSelection: z
      .enum(["native-config", "explicit"])
      .default("native-config"),
    modelId: z.string().optional(),
    providerConfigRef: z.string().optional(),
    options: ToolProfileOptionsSchema,
    toolsetRef: z.string().optional(),
    reasoning: ReasoningSelectionSchema.optional(),
    nativeConfigProfile: NativeConfigProfileSchema.optional(),
    selectionKind: SelectionKindSchema.optional(),
  })
  .strict();

function assertSavedProfile(profile: z.infer<typeof ToolProfileObjectSchema>) {
  if (profile.modelSelection === "explicit" && !profile.modelId?.trim()) {
    return {
      message: "显式选择模型时必须填写 modelId",
      path: ["modelId"] as (string | number)[],
    };
  }
  if (
    profile.selectionKind === "fixed" &&
    (profile.modelSelection !== "explicit" || !profile.modelId?.trim())
  ) {
    return {
      message: "固定模型配置必须显式填写 modelId",
      path: ["modelId"] as (string | number)[],
    };
  }
  return;
}

export const ToolProfileSchema = ToolProfileObjectSchema.superRefine(
  (profile, ctx) => {
    const issue = assertSavedProfile(profile);
    if (!issue) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: issue.message,
      path: issue.path,
    });
  },
);
export type ToolProfile = z.infer<typeof ToolProfileSchema>;

export const OverrideRoles = [
  "reviewer",
  "review_fixer",
  "functional_fixer",
] as const;
export type OverrideRole = (typeof OverrideRoles)[number];

export const RoleBindingSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("inherit") }).strict(),
  z
    .object({
      mode: z.literal("explicit"),
      profile: ToolProfileSchema,
    })
    .strict(),
]);
export type RoleBinding = z.infer<typeof RoleBindingSchema>;

export const RoleOverridesSchema = z
  .object({
    reviewer: RoleBindingSchema,
    review_fixer: RoleBindingSchema,
    functional_fixer: RoleBindingSchema,
  })
  .strict();
export type RoleOverrides = z.infer<typeof RoleOverridesSchema>;

export const inheritRoleOverrides = (): RoleOverrides => ({
  reviewer: { mode: "inherit" },
  review_fixer: { mode: "inherit" },
  functional_fixer: { mode: "inherit" },
});

export const ExecutionSpecObjectSchema = z
  .object({
    schema_version: z.literal(2).optional(),
    id: Id,
    revision: z.number().int().positive().default(1),
    workflow_id: Id,
    plannerProfile: ToolProfileSchema,
    executorProfile: ToolProfileSchema,
    roleOverrides: RoleOverridesSchema.optional(),
    template_id: z.string().default("native-development"),
    template_revision: z.number().int().positive().default(7),
    quality_policy_version: z.number().int().positive().optional(),
    mode: z.enum(["single_tool", "composite"]).default("single_tool"),
    created_at: z.string().min(1),
    source_defaults_revision: z.number().int().nonnegative().optional(),
  })
  .strict();

export type ExecutionSpec = Omit<
  z.infer<typeof ExecutionSpecObjectSchema>,
  "schema_version" | "roleOverrides"
> & {
  schema_version: 2;
  roleOverrides: RoleOverrides;
};

export const PersistedExecutionSpecSchema = ExecutionSpecObjectSchema.extend({
  schema_version: z.literal(2),
  roleOverrides: RoleOverridesSchema,
}).strict();

function stripUnknownOptions(options: unknown): ToolProfileOptions {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return {};
  }
  const record = options as Record<string, unknown>;
  const prefixArgs = record.prefixArgs;
  if (prefixArgs === undefined) return {};
  return ToolProfileOptionsSchema.parse({ prefixArgs });
}

export function parseStoredToolProfile(raw: unknown): ToolProfile {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return ToolProfileSchema.parse(raw);
  }
  const input = { ...(raw as Record<string, unknown>) };
  if ("options" in input) input.options = stripUnknownOptions(input.options);
  if (input.reasoning === undefined) delete input.reasoning;
  return ToolProfileSchema.parse(input);
}

export function parseStoredExecutionSpec(raw: unknown): ExecutionSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("执行配置无法读取");
  }
  const input = { ...(raw as Record<string, unknown>) };
  if (input.plannerProfile)
    input.plannerProfile = parseStoredToolProfile(input.plannerProfile);
  if (input.executorProfile)
    input.executorProfile = parseStoredToolProfile(input.executorProfile);
  const parsed = ExecutionSpecObjectSchema.parse(input);
  return {
    ...parsed,
    schema_version: 2,
    roleOverrides: parsed.roleOverrides ?? inheritRoleOverrides(),
  };
}

export const ExecutionSpecSchema = z.preprocess(
  (value) => parseStoredExecutionSpec(value),
  PersistedExecutionSpecSchema,
) as z.ZodType<ExecutionSpec>;

export function specMode(spec: {
  plannerProfile: ToolProfile;
  executorProfile: ToolProfile;
  roleOverrides?: RoleOverrides;
}): "single_tool" | "composite" {
  const adapters = new Set<SupportedAdapterId>([
    spec.plannerProfile.adapterId,
    spec.executorProfile.adapterId,
  ]);
  for (const role of OverrideRoles) {
    const binding = spec.roleOverrides?.[role];
    if (binding?.mode === "explicit") adapters.add(binding.profile.adapterId);
  }
  return adapters.size === 1 ? "single_tool" : "composite";
}

export const ExecutionSpecViewSchema = z
  .object({
    persisted: z.boolean(),
    source: z.enum(["task", "legacy"]),
    spec: z
      .object({
        schema_version: z.literal(2),
        id: z.string(),
        revision: z.number().int().nonnegative(),
        workflow_id: Id,
        plannerProfile: ToolProfileSchema,
        executorProfile: ToolProfileSchema,
        roleOverrides: RoleOverridesSchema,
        template_id: z.string(),
        template_revision: z.number().int().positive(),
        quality_policy_version: z.number().int().positive().optional(),
        mode: z.enum(["single_tool", "composite"]),
        created_at: z.string().min(1),
        source_defaults_revision: z.number().int().nonnegative().optional(),
      })
      .strict(),
  })
  .strict();
export type ExecutionSpecView = z.infer<typeof ExecutionSpecViewSchema>;
