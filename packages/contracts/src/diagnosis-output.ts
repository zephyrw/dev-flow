import { z } from "zod";
import { PlanSchema } from "./index.js";
import { modelOutputSchema } from "./review-output.js";

export const DiagnosisSchema = z
  .object({
    diagnosis: z.string().min(10),
    instructions: z.string().min(10),
    requires_plan_change: z.boolean(),
    repair_plan: PlanSchema.nullable(),
  })
  .strict();

export const diagnosisOutputSchema = (repositoryIds: string[]) =>
  modelOutputSchema(DiagnosisSchema, repositoryIds);

export function parseDiagnosisOutput(input: unknown) {
  const value: any = structuredClone(input);
  // Wire-format optional properties are required-but-nullable. The plan
  // contract uses absent optional properties and still validates required ones.
  const omitNull = (node: any): any =>
    Array.isArray(node)
      ? node.map(omitNull)
      : node && typeof node === "object"
        ? Object.fromEntries(
            Object.entries(node)
              .filter(([, v]) => v !== null)
              .map(([k, v]) => [k, omitNull(v)]),
          )
        : node;
  if (value?.repair_plan) value.repair_plan = omitNull(value.repair_plan);
  return DiagnosisSchema.parse(value);
}
