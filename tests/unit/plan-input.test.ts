import { expect, it } from "vitest";
import { z } from "zod";
import { RelativePath } from "../../packages/contracts/src/base.js";
import { normalizePlanPaths, parsePlanInput } from "../../packages/contracts/src/plan-input.js";
import { modelOutputSchema } from "../../packages/contracts/src/review-output.js";
import { FlowError } from "../../packages/contracts/src/index.js";

const schema = z.object({ modules: z.array(z.object({ paths: z.array(RelativePath) })) });
it("canonicalizes only safe trailing directory separators and preserves the original", () => {
  const value = { modules: [{ paths: ["src/views/homepage/material/ai-mix/"] }], description: "keep/",
    scope: { repository_paths: { web: ["src/"] }, allowed_paths: ["docs/"] } };
  expect(normalizePlanPaths(value)).toEqual({ ...value, modules: [{ paths: ["src/views/homepage/material/ai-mix"] }],
    scope: { repository_paths: { web: ["src"] }, allowed_paths: ["docs"] } });
  expect(value.modules[0]!.paths[0]).toMatch(/\/$/);
  expect(parsePlanInput(schema, value).modules[0]!.paths[0]).not.toMatch(/\/$/);
});
it.each(["/src/", "C:/src/", "src\\child/", "src/../", "src//child/", "src//", "./src/", "../src/", 42])(
  "retains and explains unsafe input %s", value => {
    try { parsePlanInput(schema, { modules: [{ paths: [value] }] }); throw new Error("accepted unsafe path"); }
    catch (error) {
      expect(error).toBeInstanceOf(FlowError);
      expect(error).toMatchObject({ code: "PLAN_VALIDATION_FAILED", details: { fields: [{ path: "modules.0.paths.0", value }] } });
    }
  });
it("tells structured-output models the directory contract", () => {
  expect(JSON.stringify(modelOutputSchema(schema, []))).toContain("目录不带末尾");
});
