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
import { modelOutputSchema } from "../../packages/contracts/src/review-output.js";

it("structured output guidance retains typed intent and text while input remains tolerant", () => {
  const schema = modelOutputSchema(ExecutorRoundOutputSchema, ["main"]);
  expect(schema.properties.status.anyOf[0].enum).toEqual(["completed", "need_planner", "need_user", "unclear"]);
  expect(schema.properties.summary.anyOf[0].type).toBe("string");
  expect(schema.properties.notes.anyOf[0].type).toBe("string");
  expect(ExecutorRoundOutputSchema.safeParse({ status: "completed" }).success).toBe(true);
  const received = { status: "completed", notes: { unexpected: true }, delivery: { test_executions: [{ report_paths: ["report.json"] }] } };
  expect(ExecutorRoundOutputSchema.safeParse(received).success).toBe(false);
  expect(ExecutorRoundResultSchema.parse(received).status).toBe("completed");
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
