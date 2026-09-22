import { z } from "zod";
import { Id, RelativePath } from "./base.js";

export const ReviewFindingSchema = z
  .object({
    id: Id.optional(),
    severity: z.enum(["P0", "P1", "P2", "P3"]).optional(),
    repo_id: Id.optional(),
    path: RelativePath.optional(),
    line: z.number().int().positive().optional(),
    trigger: z.string().optional(),
    evidence: z.string().optional(),
    consequence: z.string().optional(),
    relation_to_change: z
      .enum(["introduced", "in_scope", "historical", "suggestion"])
      .optional(),
    disposition: z
      .enum(["confirmed", "false_positive", "out_of_scope"])
      .optional(),
    reason: z.string().optional(),
  })
  .passthrough();

export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;
