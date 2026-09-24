import { z } from "zod";
import { Id } from "./base.js";

export const TextSectionStatusSchema = z.enum([
  "available",
  "missing",
  "unstructured",
]);
export type TextSectionStatus = z.infer<typeof TextSectionStatusSchema>;

export const TextSectionSchema = z
  .object({
    status: TextSectionStatusSchema,
    summary: z.string(),
    items: z.array(z.string()).default([]),
    source_ref: z.string().optional(),
  })
  .strict();
export type TextSection = z.infer<typeof TextSectionSchema>;

export const FindingViewSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    status: z.enum(["confirmed", "resolved", "open"]).default("confirmed"),
    description: z.string().optional(),
  })
  .strict();
export type FindingView = z.infer<typeof FindingViewSchema>;

export const OverviewTaskViewSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    status: z.enum(["pending", "in_progress", "completed", "blocked"]),
    source: z.enum(["native_work_item", "plan_task", "inferred"]),
  })
  .strict();
export type OverviewTaskView = z.infer<typeof OverviewTaskViewSchema>;

export const OverviewTestViewSchema = z
  .object({
    id: z.string(),
    scenario: z.string(),
    expected: z.string().optional(),
    status: z.enum(["pending", "passed", "failed", "stale"]),
    source: z.enum(["native_acceptance", "plan_test", "inferred"]),
  })
  .strict();
export type OverviewTestView = z.infer<typeof OverviewTestViewSchema>;

export const ProgressViewSchema = z
  .object({
    total: z.number().int().positive(),
    completed: z.number().int().nonnegative(),
    in_progress: z.number().int().nonnegative().optional(),
    failed_or_blocked: z.number().int().nonnegative().optional(),
    percentage: z.number().min(0).max(100),
  })
  .strict();
export type ProgressView = z.infer<typeof ProgressViewSchema>;

export const WorkflowOverviewViewSchema = z
  .object({
    schema_version: z.literal(1).default(1),
    workflow_id: Id,
    plan_revision: z.number().int().nonnegative(),
    plan_hash: z.string().nullable(),
    view_revision: z.string().min(1),
    goal: TextSectionSchema,
    background: TextSectionSchema,
    findings: z.array(FindingViewSchema),
    unresolved: z.array(z.string()),
    tasks: z.array(OverviewTaskViewSchema),
    tests: z.array(OverviewTestViewSchema),
    progress: z
      .object({
        tasks: ProgressViewSchema.nullable(),
        tests: ProgressViewSchema.nullable(),
      })
      .strict(),
    execution_constraints: z
      .object({
        approval_id: z.string().min(1),
        text: z.string(),
        text_hash: z.string().min(1),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type WorkflowOverviewView = z.infer<typeof WorkflowOverviewViewSchema>;
