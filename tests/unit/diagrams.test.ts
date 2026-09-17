import { it, expect } from "vitest";
import { plan } from "../helpers.js";
import { parsePlanDiagrams } from "../../packages/plans/src/diagrams.js";

it("UT-06 parses Chinese labels in an isolated DOM and rejects invalid diagram grammar", async () => {
  const before = globalThis.window;
  const value = plan("config", "a".repeat(40));
  const result = await parsePlanDiagrams(value);
  expect(result.diagrams).toHaveLength(1);
  expect(globalThis.window).toBe(before);
  value.markdown = value.markdown!.replace(
    /```mermaid[\s\S]*?```/,
    "```mermaid\nflowchart LR\n A[未闭合\n```",
  );
  await expect(parsePlanDiagrams(value)).rejects.toThrow(/Mermaid/);
  expect(globalThis.window).toBe(before);
}, 180000);
