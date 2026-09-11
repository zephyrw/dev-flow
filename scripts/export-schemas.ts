import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigSchema } from "../packages/contracts/src/config.js";
import {
  ProjectSchema,
  PlanSchema,
  ReviewSchema,
} from "../packages/contracts/src/index.js";
import { BrowserRecipeSchema } from "../packages/runtime/src/recipe.js";
const target = process.argv[2] ?? "examples/schemas";
mkdirSync(target, { recursive: true });
for (const [name, schema] of Object.entries({
  config: ConfigSchema,
  project: ProjectSchema,
  plan: PlanSchema,
  review: ReviewSchema,
  "browser-recipe": BrowserRecipeSchema,
}))
  writeFileSync(
    join(target, name + ".schema.json"),
    JSON.stringify(z.toJSONSchema(schema), null, 2) + "\n",
  );
console.log(target);
