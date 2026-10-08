import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { extractRoundOutput } from "../../packages/runtime/src/round-output.js";

const result = {
  status: "need_user",
  summary: "本地工作已完成，等待测试环境恢复",
  notes: "待完成 IT、E2E、OpenTabs",
};
const json = JSON.stringify(result);
const extract = (replyText: string, extra = {}) =>
  extractRoundOutput({ kind: "execution", replyText, ...extra });

it.each([
  json,
  `\uFEFF ${json}\r\n`,
  `\`\`\`json\n${json}\n\`\`\``,
  `已完成本地工作\n\`\`\`JSON\r\n${json}\r\n\`\`\`\n等待环境恢复`,
  `说明\n${json}\n结束`,
  `说明\n  ~~~~json\n${json}\n  ~~~~\n结束`,
  `说明\n\`\`\`\n${json}\n\`\`\`\n结束`,
])("accepts a current result surrounded by prose and Markdown: %s", (reply) => {
  expect(extract(reply)).toMatchObject({ kind: "resolved", value: result });
});

it.each(["first-reply", "clarification-reply"])(
  "recovers the actual environment-waiting reply: %s",
  (name) => {
    const reply = readFileSync(
      `tests/fixtures/round-output-${name}.txt`,
      "utf8",
    );
    expect(extract(reply)).toMatchObject({
      kind: "resolved",
      value: { status: "need_user" },
    });
  },
);

it("handles nested arrays, escaped quotes, braces and backticks inside strings", () => {
  const value = {
    ...result,
    notes: '包含 } 和 { 及 \\"引号\\"、```，路径 C:\\fixture\\file',
    test_results: [{ test_id: "UT-01", status: "passed" }],
  };
  expect(extract(`说明\n${JSON.stringify(value)}\n结束`)).toMatchObject({
    kind: "resolved",
    value,
  });
});

it("selects a single richer consistent result without merging payloads", () => {
  const rich = { ...result, artifacts: ["migration.sql"] };
  expect(
    extract(`\`\`\`json\n${json}\n\`\`\`\n${JSON.stringify(rich)}`),
  ).toMatchObject({ kind: "resolved", value: rich });
});

it.each([
  `${json}\n${JSON.stringify({ status: "completed", summary: "done" })}`,
  JSON.stringify({ status: "completed", delivery: { status: "need_user" } }),
  JSON.stringify({ status: "need_user", verdict: "completed" }),
])("does not choose an arbitrary winner among conflicting results", (reply) => {
  expect(extract(reply)).toMatchObject({ kind: "ambiguous", rawText: reply });
});

it.each([
  '{"test_id":"UT-01","status":"passed"}',
  '[{"status":"completed"}]',
  '{"config":{"status":"completed"}}',
  '说明\n```javascript\n{"status":"completed"}\n```',
  '{"status":"completed", "delivery":{"status":"need_user"}',
  "{'status':'completed'}",
  '{"status":"completed",}',
  '```json\n{"status":"completed"}',
])("does not lift a test/child/example or repair invalid JSON: %s", (reply) => {
  expect(extract(reply).kind).toBe("unrecognized");
});

it("honors structured output and file precedence while falling through a broken/irrelevant file", () => {
  expect(
    extract('{"status":"completed"}', {
      structured: result,
      outputText: '{"status":"completed"}',
    }),
  ).toMatchObject({ kind: "resolved", source: "structured", value: result });
  expect(extract('{"status":"completed"}', { outputText: json })).toMatchObject(
    { kind: "resolved", source: "output_file", value: result },
  );
  for (const outputText of ["broken", '{"summary":"只有说明"}'])
    expect(extract(json, { outputText })).toMatchObject({
      kind: "resolved",
      source: "reply",
      value: result,
    });
});

it.each(["workflow_id", "run_id", "plan_revision", "plan_hash"])(
  "rejects stale ownership: %s",
  (key) => {
    const expected = {
      workflow_id: "current",
      run_id: "current-run",
      plan_revision: 2,
      plan_hash: "current-hash",
    };
    expect(
      extract(
        JSON.stringify({
          ...result,
          [key]: key === "plan_revision" ? 1 : "old",
        }),
        expected,
      ).kind,
    ).toBe("ambiguous");
  },
);

it("recognizes review results independently from execution and retains optional malformed material", () => {
  expect(
    extractRoundOutput({
      kind: "review",
      replyText: '说明\n{"verdict":"changes_required","findings":[]}\n结束',
    }),
  ).toMatchObject({ kind: "resolved", value: { verdict: "changes_required" } });
  expect(
    extractRoundOutput({
      kind: "review",
      replyText: '{"verdict":"passed","quality":{"verdict":"need_user"}}',
    }).kind,
  ).toBe("ambiguous");
  expect(
    extract(
      JSON.stringify({
        ...result,
        artifacts: 123,
        user_interaction: { broken: true },
      }),
    ),
  ).toMatchObject({
    kind: "resolved",
    value: { status: "need_user", artifacts: 123 },
  });
});

it("limits size, candidate count and nesting without accepting a partial result", () => {
  expect(extract("x".repeat(16 * 1024 * 1024 + 1)).kind).toBe("unrecognized");
  expect(extract((json + "\n").repeat(129)).kind).toBe("ambiguous");
  expect(
    extract("说明\n" + '{"child":'.repeat(129) + json + "}".repeat(129)).kind,
  ).toBe("unrecognized");
});
