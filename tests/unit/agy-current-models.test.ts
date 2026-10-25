import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseAgyModelCatalog } from "../../packages/adapters/agy/src/model-configuration.js";
import { buildModelChoices } from "../../packages/presentation/src/model-display.js";
import { resolveModelSelection } from "../../packages/adapters/sdk/src/model-selection.js";
import { ToolProfileSchema } from "../../packages/contracts/src/index.js";

it("keeps an older account's native models and excludes explicitly unavailable entries", () => {
  const catalog = parseAgyModelCatalog({ stdout: "gemini-3.8-flash-high\nclaude-opus-4-6-thinking\nclaude-sonnet-4-6\ngemini-4-argon-high Unavailable\n" });
  expect(catalog.entries.map(entry => entry.nativeId)).toEqual(["gemini-3.8-flash-high", "claude-opus-4-6-thinking", "claude-sonnet-4-6"]);
});

it("groups the live AGY catalog into five choices and maps each supported effort to its actual CLI ID", () => {
  const catalog = parseAgyModelCatalog({ stdout: readFileSync(new URL("../fixtures/model-catalog/agy/models-20261023.txt", import.meta.url), "utf8") });
  const choices = buildModelChoices(catalog.entries);
  expect(choices.map(c => c.label)).toEqual(expect.arrayContaining(["Gemini 4 Argon", "Gemini 3.8 Flash", "Claude Opus 5.5", "Claude Sonnet 5.5"]));
  expect(choices).toHaveLength(5);
  for (const family of ["gemini-4-argon", "claude-opus-5-5", "claude-sonnet-5-5"]) {
    const entry = catalog.entries.find(e => e.nativeId === family + "-high")!;
    for (const effort of ["low", "medium", "high"] as const) {
      const selection = resolveModelSelection(ToolProfileSchema.parse({ id: "agy-current", revision: 1, adapterId: "agy", modelSelection: "explicit", modelId: entry.nativeId, reasoning: { mode: "explicit", value: effort }, options: {} }), entry);
      expect(selection.modelToken).toBe(family + "-" + effort);
    }
    expect(() => resolveModelSelection(ToolProfileSchema.parse({ id: "agy-current", revision: 1, adapterId: "agy", modelSelection: "explicit", modelId: entry.nativeId, reasoning: { mode: "explicit", value: "max" }, options: {} }), entry)).toThrow();
  }
});
