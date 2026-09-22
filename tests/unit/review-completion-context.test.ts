import { expect, it } from "vitest";
import {
  reviewCompletionContext,
  type ReviewCompletion,
} from "../../packages/core/src/review-completion.js";
import {
  projectReviewCompletion,
  reviewContractContext,
} from "../../packages/runtime/src/review-materials.js";
import { objectHash } from "../../packages/core/src/util.js";

function mockEngine(storeData: Record<string, any> = {}) {
  const store = {
    get: (table: string, id: string) => storeData[`${table}:${id}`],
    list: (table: string, id: string) => storeData[`list:${table}:${id}`] ?? [],
    put: (table: string, key: string, id: string, val: any) => {
      storeData[`${table}:${id}`] = val;
    },
  };
  const quality = {
    getOrCreateGate: () => ({ cycle: 1 }),
  };
  return { store, quality } as any;
}

function computeFingerprint(w: any) {
  return objectHash({
    plan: w.plan_hash,
    revision: w.plan_revision,
    snapshot: w.snapshot_id,
    environment: w.environment_revision,
    feedback: w.feedback,
    phase: undefined,
    feedback_cursor: 0,
  });
}

it("UT05: original completion record is preserved in store, while model projection uses current instruction and background reviews", () => {
  const workflow = {
    id: "wf-1",
    stage: "quality_before_human",
    plan_revision: 1,
    plan_hash: "plan-hash-1",
    snapshot_id: "snap-1",
    environment_revision: 1,
    feedback: [],
    review_request_id: "req-1",
  };
  const run = { id: "run-1" } as any;

  const validFingerprint = computeFingerprint(workflow);
  const legacyInstruction = "历史旧指令：每项 document_hash 绑定完整正文 SHA-256，返回完整 repair_plan";
  const rawRecord: ReviewCompletion = {
    fingerprint: validFingerprint,
    automatic_attempts: 1,
    attempts: [
      {
        run_id: "old-run-0",
        review: { verdict: "changes_required", findings: [{ message: "旧问题" }] },
        reason: "Schema validation failed: missing document_hash",
      },
    ],
    instruction: legacyInstruction,
    updated_at: "2026-09-20T10:00:00Z",
  };

  const storeData: Record<string, any> = {
    "review_completion:wf-1": rawRecord,
  };
  const engine = mockEngine(storeData);

  // 1. Storage retains original historical instruction
  const fromStorage = reviewCompletionContext(engine, workflow as any);
  expect(fromStorage).not.toBeNull();
  expect(fromStorage?.instruction).toBe(legacyInstruction);
  expect(fromStorage?.attempts?.[0]?.reason).toContain("missing document_hash");

  // 2. Projected context replaces instruction and marks previous reviews as historical background
  const projected = projectReviewCompletion(fromStorage);
  expect(projected).not.toBeNull();
  expect(projected?.instruction).not.toContain("document_hash");
  expect(projected?.instruction).toContain("不核验测试真实性");
  expect(projected?.instruction).toContain("不要求证明工具");
  expect(projected?.previous_reviews?.[0]?.context_role).toBe("historical_background");
  expect((projected as any)?.attempts).toBeUndefined();

  // 3. reviewContractContext passes the projected completion to the model
  const contractContext = reviewContractContext(engine, workflow as any, run);
  expect(contractContext.completion).toEqual(projected);
});

it("UT06: mismatched fingerprint returns null and preserves attention match semantics without phantom completion", () => {
  const workflow = {
    id: "wf-1",
    stage: "quality_before_human",
    plan_revision: 2, // Revision changed
    plan_hash: "plan-hash-2",
    snapshot_id: "snap-2",
    environment_revision: 1,
    feedback: [],
    review_request_id: "req-2",
  };
  const run = { id: "run-2" } as any;

  // Stored record has old fingerprint
  const rawRecord: ReviewCompletion = {
    fingerprint: "stale-fingerprint",
    automatic_attempts: 1,
    attempts: [],
    instruction: "stale",
    updated_at: "2026-09-20T10:00:00Z",
  };
  const storeData: Record<string, any> = {
    "review_completion:wf-1": rawRecord,
  };
  const engine = mockEngine(storeData);

  const fromStorage = reviewCompletionContext(engine, workflow as any);
  expect(fromStorage).toBeNull();

  const contractContext = reviewContractContext(engine, workflow as any, run);
  expect(contractContext.completion).toBeNull();
});
