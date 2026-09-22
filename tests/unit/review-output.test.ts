import { it, expect } from "vitest";
import { reviewOutputSchema } from "../../packages/contracts/src/review-output.js";
it("UT-16 Codex wire schema uses explicit repository keys and closed required properties", () => {
  const schema = reviewOutputSchema(["main", "api"]);
  expect(JSON.stringify(schema)).not.toContain("propertyNames");
  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "object") {
      expect(node.additionalProperties).toBe(false);
      expect(node.required).toEqual(Object.keys(node.properties ?? {}));
    }
    for (const value of Object.values(node))
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") walk(value);
  };
  walk(schema);
});
