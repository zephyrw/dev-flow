import { z } from "zod";
import type { ConflictFunctionImpact } from "./tr-handoff.js";

export const MergeConflictBlockerSchema = z.object({
  path: z.string().min(1),
  reason: z.string().min(1),
});

export const MergeConflictReceiptSchema = z
  .object({
    request_id: z.string().min(1),
    workflow_id: z.string().min(1),
    run_id: z.string().min(1),
    candidate_commit: z.string().min(1),
    source_commit: z.string().min(1),
    status: z.enum(["resolved", "blocked"]),
    resolved_paths: z.array(z.string()),
    blockers: z.array(MergeConflictBlockerSchema).optional(),
    function_impact: z.enum(["none", "changed", "uncertain"]).optional(),
    function_impact_explanation: z.string().optional(),
  })
  .refine(
    (data) => {
      if (
        data.status === "resolved" &&
        data.blockers &&
        data.blockers.length > 0
      ) {
        return false;
      }
      return true;
    },
    { message: "有 blocker 时 status 不得返回 resolved" },
  );

export type MergeConflictReceipt = z.infer<typeof MergeConflictReceiptSchema>;

export interface AcceptanceCarry {
  original: unknown;
  requires_confirmation: boolean;
  integration?: boolean;
  reported_function_impact?: ConflictFunctionImpact;
  function_impact_explanation?: string;
  review_id?: string;
}

export function conflictImpactNeedsConfirmation(
  impact?: ConflictFunctionImpact,
) {
  return impact === "changed" || impact === "uncertain";
}

export function retainConflictFunctionImpact(
  current?: ConflictFunctionImpact,
  incoming?: ConflictFunctionImpact,
) {
  if (conflictImpactNeedsConfirmation(incoming)) return incoming;
  if (conflictImpactNeedsConfirmation(current)) return current;
  return incoming ?? current;
}

export interface MergeConflictRequest {
  id: string;
  workflow_id: string;
  repo_id: string;
  plan_revision: number;
  plan_hash: string;
  candidate_commit: string;
  source_commit: string;
  worktree_root: string;
  common_dir: string;
  conflict_paths: string[];
  execution_spec_id?: string;
  run_id: string;
  source_stage?: string;
  source_state?: string;
  quality_phase?: "before_human" | "after_human";
  resolution_instructions?: string;
  reported_function_impact?: ConflictFunctionImpact;
  function_impact_explanation?: string;
  status: "pending" | "running" | "resolved" | "blocked";
  created_at: string;
  updated_at: string;
}
