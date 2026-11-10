import { z } from "zod";

export const taskListTaskStatus = z.enum(["pending", "in_progress", "completed", "blocked", "unreported"]);
export const taskListTestStatus = z.enum(["not_run", "running", "passed", "failed", "blocked", "skipped", "stale", "unreported"]);
const stateFields = {
  summary: z.string().max(2000).optional(),
  updated_at: z.string().max(64).nullish(),
  started_at: z.string().max(64).nullish(),
};
export const TaskListSchema = z.object({
  schema_version: z.literal(1),
  workflow_id: z.string(),
  plan_revision: z.number().int().positive(),
  plan_ref: z.string(),
  writer_run_id: z.string().nullable(),
  updated_at: z.string().max(64).nullish(),
  tasks: z.array(z.object({
    id: z.string(), title: z.string(), module_id: z.string().optional(),
    repo_id: z.string().optional(), description: z.string(), depends_on: z.array(z.string()),
    completion_criteria: z.array(z.string()), test_ids: z.array(z.string()),
    status: taskListTaskStatus, completed_at: z.string().max(64).nullish(), ...stateFields,
  })),
  tests: z.array(z.object({
    test_id: z.string(), case_id: z.string(), task_ids: z.array(z.string()),
    layer: z.enum(["unit", "integration", "e2e", "opentabs"]),
    scenario: z.string(), expected_outcome: z.string().optional(),
    status: taskListTestStatus, attempt: z.number().int().nonnegative().optional(),
    finished_at: z.string().max(64).nullish(), ...stateFields,
  })),
  checks: z.array(z.object({
    id: z.string(), kind: z.enum(["typecheck", "build"]), status: taskListTestStatus, ...stateFields,
  })).default([]),
});
export type TaskList = z.infer<typeof TaskListSchema>;
