import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigSchema } from "../packages/contracts/src/config.js";
import {
  ProjectSchema,
  PlanSchema,
  ReviewSchema,
  ModelDefaultsSchema,
  ModelCatalogSchema,
  ModelAccessRecordSchema,
  MutationReceiptSchema,
  ExecutionSpecWriteRequestSchema,
  ToolProfileSchema,
  ModelErrorBodySchema,
  RepairSelectionSchema,
} from "../packages/contracts/src/index.js";
import { ReviewModelOutputSchema } from "../packages/contracts/src/review-output.js";
import { BrowserRecipeSchema } from "../packages/runtime/src/recipe.js";
import { HttpExecutionSpecGetResponseSchema } from "../packages/core/src/execution-spec-view.js";
const target = process.argv[2] ?? "examples/schemas";
mkdirSync(target, { recursive: true });
for (const [name, schema] of Object.entries({
  config: ConfigSchema,
  project: ProjectSchema,
  plan: PlanSchema,
  review: ReviewModelOutputSchema,
  "browser-recipe": BrowserRecipeSchema,
  "model-defaults": ModelDefaultsSchema,
  "model-catalog": ModelCatalogSchema,
  "model-access": ModelAccessRecordSchema,
  "mutation-receipt": MutationReceiptSchema,
  "execution-spec-get": HttpExecutionSpecGetResponseSchema,
  "execution-spec-write": ExecutionSpecWriteRequestSchema,
  "tool-profile": ToolProfileSchema,
  "model-error": ModelErrorBodySchema,
  "repair-selection": RepairSelectionSchema,
}))
  writeFileSync(
    join(target, name + ".schema.json"),
    JSON.stringify(z.toJSONSchema(schema), null, 2) + "\n",
  );
console.log(target);
