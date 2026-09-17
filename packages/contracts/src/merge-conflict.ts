import { z } from "zod";

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
  status: "pending" | "running" | "resolved" | "blocked";
  created_at: string;
  updated_at: string;
}
