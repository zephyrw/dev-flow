import { z } from "zod";
import { ReviewSchema } from "./index.js";

/** Codex structured outputs require closed objects and all properties required. */
export function reviewOutputSchema(repositoryIds: string[]) {
  return modelOutputSchema(ReviewSchema, repositoryIds);
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
export function parseReviewOutput(input: any) {
  const value = structuredClone(input);
  if (value.repair_plan) {
    for (const task of value.repair_plan.tasks ?? [])
      if (task.repo_id === null) delete task.repo_id;
    for (const test of value.repair_plan.tests ?? [])
      for (const key of ["command_id", "scene_id"])
        if (test[key] === null) delete test[key];
  }
  return ReviewSchema.parse(value);
}
