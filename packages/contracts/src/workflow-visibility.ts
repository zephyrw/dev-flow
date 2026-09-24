import { z } from "zod";
import { Id } from "./base.js";

export const WorkflowVisibilitySchema = z
  .object({
    schema_version: z.literal(1).default(1),
    workflow_id: Id,
    revision: z.number().int().nonnegative(),
    archived: z.boolean(),
    archived_at: z.string().nullable(),
    restored_at: z.string().nullable(),
    updated_at: z.string().min(1),
  })
  .strict();
export type WorkflowVisibility = z.infer<typeof WorkflowVisibilitySchema>;

export const WorkflowVisibilityUpdateRequestSchema = z
  .object({
    request_id: z.string().min(1),
    expected_visibility_revision: z.number().int().nonnegative(),
    archived: z.boolean(),
  })
  .strict();
export type WorkflowVisibilityUpdateRequest = z.infer<
  typeof WorkflowVisibilityUpdateRequestSchema
>;

export const WorkflowVisibilityResponseSchema = z
  .object({
    workflow_id: Id,
    visibility: WorkflowVisibilitySchema,
    changed: z.boolean(),
    request_id: z.string().min(1),
  })
  .strict();
export type WorkflowVisibilityResponse = z.infer<
  typeof WorkflowVisibilityResponseSchema
>;

export const WorkflowVisibilityFilterSchema = z.enum(["visible", "archived", "all"]);
export type WorkflowVisibilityFilter = z.infer<typeof WorkflowVisibilityFilterSchema>;

export interface ArchivedWorkflowSummary {
  workflow_id: string;
  project_id: string;
  title: string;
  current_state: string;
  archived_at: string | null;
  visibility_revision: number;
  source_root?: string;
  worktree_path?: string;
  branch?: string;
  plan_revision?: number;
  is_running: boolean;
}
