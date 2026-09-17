import { z } from "zod";

const Text = z.string().trim().min(1);
/** Executor evidence, never an alternative implementation plan. */
export const PlanSelfCheckReportSchema = z
  .object({
    request_id: Text,
    source_delivery_revision_id: Text,
    plan_revision: z.number().int().positive(),
    plan_hash: Text,
    authority_hash: Text,
    run_id: Text,
    verdict: z.enum(["passed", "changes_required"]),
    checks: z
      .array(
        z
          .object({
            check_id: Text,
            status: z.enum(["passed", "failed"]),
            evidence: z.array(Text).min(1),
          })
          .strict(),
      )
      .min(1),
    findings: z.array(
      z
        .object({
          id: Text,
          description: Text,
          resolution: Text,
          status: z.enum(["fixed", "open"]),
          evidence: z.array(Text).min(1),
        })
        .strict(),
    ),
  })
  .strict();
export type PlanSelfCheckReport = z.infer<typeof PlanSelfCheckReportSchema>;

export interface PlanSelfCheckRequest {
  id: string;
  workflow_id: string;
  plan_revision: number;
  plan_hash: string;
  authority_hash: string;
  context_hash: string;
  source_delivery_revision_id: string;
  source_run_id: string;
  status: "queued" | "running" | "passed";
  check_ids: string[];
  run_id?: string;
  delivery_revision_id?: string;
  report_hash?: string;
  created_at: string;
  completed_at?: string;
}
