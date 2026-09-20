import { describe, it, expect } from "vitest";
import { extractAgyFailureFact } from "../../packages/adapters/agy/src/failure-fact.js";

const binding = { realmId: "realm", accountId: "account", authEpoch: 2, runId: "run",
  conversationId: "conversation", eventOffset: 10, currentTurn: true };
describe("AGY trusted failure facts", () => {
  it("preserves binding and recognizes current structured quota errors", () => {
    expect(extractAgyFailureFact({ ...binding, event: { type: "error", error: { code: "quota_exhausted", window: "weekly" } } }))
      .toMatchObject({ category: "quota_exhausted", can_switch_account: true, conversation_id: "conversation", source_offset: 10, window: "weekly" });
  });
  it.each([
    { errorMessage: "weekly quota exhausted" },
    { stdout: "weekly quota exhausted", errorMessage: "failed" },
    { errorMessage: "weekly quota remaining 50%" },
    { errorMessage: "quota 0%" },
    { currentTurn: false, event: { type: "error", error: { code: "quota_exhausted" } } },
    { eventOffset: undefined, event: { type: "error", error: { code: "quota_exhausted" } } },
    { event: { type: "assistant", error: { code: "quota_exhausted" } } },
  ])("refuses text/history/assistant output as switching evidence: %j", input => {
    expect(extractAgyFailureFact({ ...binding, ...input }).can_switch_account).toBe(false);
  });
  it("treats uncorroborated resource exhaustion as rate limiting", () => {
    expect(extractAgyFailureFact({ ...binding, event: { type: "error", code: "RESOURCE_EXHAUSTED" } }))
      .toMatchObject({ category: "rate_limit", can_switch_account: false });
  });
  it("only switches for structured current authentication failure", () => {
    expect(extractAgyFailureFact({ ...binding, event: { type: "result", error: { code: "invalid_grant" } } }))
      .toMatchObject({ category: "auth_invalid", requires_reauth: true, can_switch_account: true });
    expect(extractAgyFailureFact({ ...binding, errorMessage: "invalid_grant" }).can_switch_account).toBe(false);
  });
  it("does not persist raw upstream text", () => {
    expect(extractAgyFailureFact({ ...binding, errorMessage: "test failed sensitive-value" }).raw_message)
      .toBe("business_test_or_review_failure");
  });
});
