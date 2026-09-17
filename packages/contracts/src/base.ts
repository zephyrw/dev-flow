import { z } from "zod";

export const Id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/);

export const RelativePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (p) =>
      !p.includes("\\") &&
      !p.includes(":") &&
      !p.startsWith("/") &&
      p.split("/").every((s) => s && s !== "." && s !== ".."),
    "必须是无穿越的相对路径",
  );

export const Layer = z.enum(["unit", "integration", "e2e", "opentabs"]);

export const States = [
  "RESEARCHING",
  "PLANNING",
  "PLAN_PENDING",
  "QUEUED",
  "EXECUTING",
  "VERIFYING",
  "DELIVERY_VERIFYING",
  "QUALITY_REVIEW",
  "AFTER_HUMAN_REVIEW",
  "PLANNER_TAKEOVER",
  "HUMAN_PENDING",
  "HUMAN_VERIFY",
  "REVIEW_QUEUED",
  "REVIEWING",
  "REPAIR_PLAN_PENDING",
  "REPAIR_RESEARCH_REQUIRED",
  "INTEGRATING",
  "COMMITTING",
  "COMMITTED",
  "COMPLETED",
  "CLEANUP_PENDING",
  "COMMIT_PARTIAL",
  "STOPPING",
  "STOPPED",
  "PAUSED",
  "BLOCKED",
  "RECOVERY_REQUIRED",
  "WAITING_AUTHORIZATION",
  "WAITING_INPUT",
] as const;

export type State = (typeof States)[number];

export const ScopeSchema = z
  .object({
    repository_paths: z.record(Id, z.array(RelativePath).min(1)).default({}),
    allowed_paths: z.array(RelativePath).min(1),
    protected_paths: z.array(z.string()).default([".git", ".agents", ".codex"]),
    allow_dependency_changes: z.boolean().default(false),
    allow_public_api_changes: z.boolean().default(false),
  })
  .strict();
