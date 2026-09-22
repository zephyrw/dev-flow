import { z } from "zod";
import { ReviewFindingSchema } from "./review-findings.js";
import { ReviewSchema } from "./index.js";

export const ReviewModelQualitySchema = z.object({
  function_impact: z.enum(["none", "changed", "uncertain"]).default("none"),
  summary: z.string().optional(),
  notes: z.string().optional(),
});

export const ReviewModelOutputSchema = z.object({
  verdict: z.enum(["passed", "changes_required", "need_user"]),
  summary: z.string().optional(),
  findings: z.array(ReviewFindingSchema).optional().default([]),
  unresolved_questions: z.array(z.string()).optional().default([]),
  repair_document: z.string().nullish(),
  notes: z.string().optional(),
  quality: ReviewModelQualitySchema.nullish(),
});
export type ReviewModelOutput = z.infer<typeof ReviewModelOutputSchema>;

/** Codex structured outputs require closed objects and all properties required. */
export function reviewOutputSchema(repositoryIds: string[]) {
  return modelOutputSchema(ReviewModelOutputSchema, repositoryIds);
}
export function modelOutputSchema(
  contract: z.ZodType,
  repositoryIds: string[],
) {
  const schema: any = z.toJSONSchema(contract);
  function visit(node: any, key = "") {
    if (!node || typeof node !== "object") return;
    delete node.default;
    delete node.propertyNames;
    if (node.type === "object") {
      if (
        (key === "baselines" || key === "repository_paths") &&
        node.additionalProperties &&
        typeof node.additionalProperties === "object"
      ) {
        node.properties = Object.fromEntries(
          repositoryIds.map((id) => [
            id,
            structuredClone(node.additionalProperties),
          ]),
        );
        node.required = repositoryIds;
      }
      const required = new Set(node.required ?? []);
      for (const [name, child] of Object.entries<any>(node.properties ?? {})) {
        visit(child, name);
        if (!required.has(name))
          node.properties[name] = { anyOf: [child, { type: "null" }] };
      }
      node.required = Object.keys(node.properties ?? {});
      node.additionalProperties = false;
    }
    if (node.items) visit(node.items);
    for (const kind of ["anyOf", "oneOf", "allOf"])
      if (node[kind]) node[kind].forEach((child: any) => visit(child, key));
    for (const child of Object.values(node.$defs ?? {})) visit(child);
  }
  visit(schema);
  return schema;
}
export function normalizeModelOutput(input: any): any {
  if (Array.isArray(input)) return input.map(normalizeModelOutput);
  if (input && typeof input === "object")
    return Object.fromEntries(
      Object.entries(input)
        .filter(([key, value]) => value !== null || key === "repair_plan")
        .map(([key, value]) => [key, normalizeModelOutput(value)]),
    );
  return input;
}
export function parseReviewOutput(input: any) {
  const value = normalizeModelOutput(input);
  if (value.repair_plan) {
    for (const task of value.repair_plan.tasks ?? [])
      if (task.repo_id === null) delete task.repo_id;
    for (const test of value.repair_plan.tests ?? [])
      for (const key of ["command_id", "scene_id"])
        if (test[key] === null) delete test[key];
  }
  return ReviewSchema.parse(value);
}
