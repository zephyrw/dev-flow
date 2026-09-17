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
] as const;
export type SupportedAdapterId = (typeof SupportedAdapters)[number];

export const ToolProfileSchema = z
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
    options: z.record(z.string(), z.unknown()).default({}),
    toolsetRef: z.string().optional(),
  })
  .strict()
  .refine((p) => p.modelSelection !== "explicit" || !!p.modelId?.trim(), {
    message: "显式选择模型时必须填写 modelId",
    path: ["modelId"],
  });
export type ToolProfile = z.infer<typeof ToolProfileSchema>;

export const ExecutionSpecSchema = z
  .object({
    id: Id,
    revision: z.number().int().positive().default(1),
    workflow_id: Id,
    plannerProfile: ToolProfileSchema,
    executorProfile: ToolProfileSchema,
    template_id: z.string().default("native-development"),
    template_revision: z.number().int().positive().default(3),
    mode: z.enum(["single_tool", "composite"]).default("single_tool"),
    created_at: z.string().min(1),
  })
  .strict();
export type ExecutionSpec = z.infer<typeof ExecutionSpecSchema>;
