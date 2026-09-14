import { it, expect } from "vitest";
import { publicEvent } from "../../packages/core/src/util.js";
import { FileBroker } from "../../packages/workspace/src/files.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
it("redacts nested tool JSON values without corrupting quotes or the event structure", () => {
  const input = {
    step_update: {
      tool_info: {
        output: JSON.stringify({
          content: [{ text: 'password=demo\\\"quoted\\path\n下一行' }],
          CRM_DB_PASSWORD: "test-only-value",
        }),
      },
    },
    reasoning: "hidden",
    text: "Bearer abcdef",
  };
  const before = JSON.stringify(input);
  const result = publicEvent(input);
  expect(() => JSON.parse(JSON.stringify(result))).not.toThrow();
  expect(() => JSON.parse(result.step_update.tool_info.output)).not.toThrow();
  expect(JSON.stringify(result)).not.toContain("test-only-value");
  expect(result.reasoning).toBeUndefined();
  expect(publicEvent("binary\0credential")).toBe("[已省略二进制内容]");
  expect(result.text).toBe("Bearer [REDACTED]");
  expect(JSON.stringify(input)).toBe(before);
});
it("search ignores compiled output and binary bytes and rejects direct binary reads", () => {
  const root = mkdtempSync(join(tmpdir(), "devflow-text-"));
  try {
    mkdirSync(join(root, "target"));
    writeFileSync(join(root, "target", "hit.txt"), "needle");
    writeFileSync(
      join(root, "binary.class"),
      Buffer.from("needle\0password=fixture"),
    );
    writeFileSync(join(root, "source.ts"), "// needle 源码");
    const broker = new FileBroker();
    expect(broker.search(root, "needle").map((h) => h.path)).toEqual([
      "source.ts",
    ]);
    expect(() => broker.read(root, "binary.class")).toThrow("二进制");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
