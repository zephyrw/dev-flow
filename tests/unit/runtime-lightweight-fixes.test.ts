import { expect, it } from "vitest";
import { setup } from "../helpers.js";
import { ProfileRuntime } from "../../packages/runtime/src/profile-runtime.js";
import {
  DeliveryManifestSchema,
  ExecutorRoundOutputSchema,
  ExecutorRoundResultSchema,
  NativeDeliveryManifestSchema,
  normalizeOptionalDeliveryManifest,
  type Run,
} from "../../packages/contracts/src/index.js";
import { modelOutputSchema, normalizeModelOutput } from "../../packages/contracts/src/review-output.js";
import { UserInteractionInputSchema } from "../../packages/contracts/src/user-interaction.js";

it("structured output guidance retains typed intent and text while input remains tolerant", () => {
  const schema = modelOutputSchema(ExecutorRoundOutputSchema, ["main"]);
  expect(schema.properties.status.anyOf[0].enum).toEqual(["completed", "incomplete", "need_planner", "need_user", "unclear"]);
  expect(schema.properties.summary.anyOf[0].type).toBe("string");
  expect(schema.properties.notes.anyOf[0].type).toBe("string");
  const delivery = schema.properties.delivery.anyOf[0];
  for (const key of ["schema_version", "submission_id", "workflow_id", "run_id", "conversation_id", "plan_revision", "plan_hash", "plan_self_check"]) {
    expect(delivery.properties).not.toHaveProperty(key);
    expect(delivery.required).not.toContain(key);
  }
  expect(ExecutorRoundOutputSchema.safeParse({ status: "completed" }).success).toBe(true);
  const received = { status: "completed", notes: { unexpected: true }, delivery: { test_executions: [{ report_paths: ["report.json"] }] } };
  expect(ExecutorRoundOutputSchema.safeParse(received).success).toBe(false);
  expect(ExecutorRoundResultSchema.parse(received).status).toBe("completed");
});

it("closed provider output schema permits concrete questions and user actions", () => {
  const schema = modelOutputSchema(ExecutorRoundOutputSchema, ["main"]);
  expect(schema.additionalProperties).toBe(false);
  expect(schema.required).toContain("user_interaction");
  const interaction = schema.properties.user_interaction.anyOf[0];
  expect(interaction.additionalProperties).toBe(false);
  expect(interaction.properties.kind.enum).toEqual(["action_required", "question"]);
  expect(interaction.required).toEqual(["kind", "title", "message", "details", "action_label", "question", "choices", "allow_free_text", "target", "resume_note"]);
  expect(interaction.properties.question.anyOf[0]).toMatchObject({ type: "string", maxLength: 1000 });
  expect(interaction.properties.allow_free_text.anyOf[0].type).toBe("boolean");
  const choice = interaction.properties.choices.anyOf[0].items;
  expect(choice.additionalProperties).toBe(false);
  expect(choice.required).toEqual(["id", "label", "description"]);
  const target = interaction.properties.target.anyOf[0];
  expect(target.additionalProperties).toBe(false);
  expect(target.required).toEqual(["url", "tab_id", "connection_hint"]);
  expect(target.properties.url.anyOf[0].type).toBe("string");
  const requests = [
    { kind: "question", title: "选择输出格式", message: "两种格式均可使用，请选择。", question: "保存 Markdown 还是 PDF？",
      choices: [{ id: "markdown", label: "Markdown", description: null }], allow_free_text: true },
    { kind: "action_required", title: "登录阅读账号", message: "请在已打开的页面完成登录，成功后继续。",
      target: { url: "https://example.com/login", tab_id: 1, connection_hint: null }, action_label: "已登录，继续" },
  ];
  for (const request of requests) {
    // Providers require all optional keys as null. None of the actual request
    // fields may be rejected by the generated closed object.
    expect(Object.keys(request).every(key => key in interaction.properties)).toBe(true);
    const output = { status: "need_user", user_interaction: {
      ...Object.fromEntries(interaction.required.map((key: string) => [key, null])), ...request,
    } };
    const normalized = normalizeModelOutput(output);
    expect(ExecutorRoundOutputSchema.parse(normalized).status).toBe("need_user");
    expect(UserInteractionInputSchema.parse(normalized.user_interaction).kind).toBe(request.kind);
  }
});

it("Codex executor and planner takeover output schemas contain typed artifact items at both levels", () => {
  const schema = modelOutputSchema(ExecutorRoundOutputSchema, ["main"]);
  const artifacts = schema.properties.artifacts.anyOf[0].items;
  expect(artifacts.anyOf.map((node: any) => node.type)).toEqual(["string", "object"]);
  expect(schema.properties.delivery.anyOf[0].properties.artifacts.anyOf[0].items).toEqual(artifacts);
  function check(node: any) {
    expect(!!node.type || !!node.anyOf || !!node.$ref).toBe(true);
    if (node.type === "object") {
      expect(node.additionalProperties).toBe(false);
      expect(node.required).toEqual(Object.keys(node.properties ?? {}));
      Object.values(node.properties ?? {}).forEach(check);
    }
    if (node.items) check(node.items);
    node.anyOf?.forEach(check);
  }
  check(schema);
  // Only generation is typed. Existing/native optional material is still accepted.
  const historical = { status: "completed", artifacts: [{ custom: { previous: true } }],
    delivery: { artifacts: [{ custom: "legacy" }] } };
  expect(ExecutorRoundResultSchema.parse(historical)).toEqual(historical);
  expect(normalizeOptionalDeliveryManifest(historical).artifacts).toEqual(historical.artifacts);
});

it("optional malformed materials preserve result intent and independently usable report paths", () => {
  const raw = {
    status: "completed",
    summary: { unexpected: true },
    delivery: {
      test_executions: [
        { repo_id: "main", report_paths: ["reports/result.json", null] },
        { tool_call_id: "call", command: "test", report_paths: ["reports/valid.json"] },
      ],
      implementations: [{ path: "app.ts" }, { path: 32 }],
      artifacts: [{ path: "notes.txt" }],
    },
  };
  expect(ExecutorRoundResultSchema.parse(raw).status).toBe("completed");
  expect(NativeDeliveryManifestSchema.parse(raw).delivery).toEqual(raw.delivery);
  expect(DeliveryManifestSchema.safeParse(raw.delivery).success).toBe(false);
  const material = normalizeOptionalDeliveryManifest(raw);
  expect(material.status).toBe("completed");
  expect(material.summary).toBeUndefined();
  expect(material.implementations).toEqual([{ path: "app.ts" }]);
  expect(material.test_executions).toHaveLength(1);
  expect(material.artifacts).toEqual([
    { path: "notes.txt" },
    { path: "reports/result.json", repo_id: "main" },
  ]);
});

it("runtime only consumes run-bound continuation for the matching purpose and workflow", () => {
  const s = setup();
  try {
    const runtime = new ProfileRuntime(s.engine, {} as any) as any;
    const run = { id: "current", workflow_id: "w", purpose: "implement" } as Run;
    const review = { kind: "intent_clarification", purpose: "review", role: "planner", source_run_id: "old-review" };
    s.store.put("run_continuation", "w", "w", review);
    expect(runtime.readContinuation(run)).toBeUndefined();
    expect(runtime.readContinuation({ ...run, continuation: review })).toBeUndefined();
    const execute = { ...review, purpose: "execute", role: "executor", source_run_id: "previous" };
    s.store.put("run_continuation", run.id, "w", execute);
    expect(runtime.readContinuation(run)).toEqual(execute);
    s.store.put("run", "previous", "other", { id: "previous", workflow_id: "other" });
    expect(runtime.readContinuation(run)).toBeUndefined();
    s.store.put("run", "previous", "w", { id: "previous", workflow_id: "w" });
    expect(runtime.readContinuation({ ...run, continuation: execute })).toEqual(execute);
  } finally {
    s.store.close();
  }
});
