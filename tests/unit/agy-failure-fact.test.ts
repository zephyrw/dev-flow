import { describe, it, expect } from "vitest";
import { confirmAgyQuotaFailure, extractAgyFailureFact } from "../../packages/adapters/agy/src/failure-fact.js";

const binding = { realmId: "realm", accountId: "account", authEpoch: 2, runId: "run",
  conversationId: "conversation", eventOffset: 10, currentTurn: true };
const quotaMessage = "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 37m46s.";
const nativeQuotaResult = () => ({ type: "result", error: quotaMessage,
  result: { status: "ERROR", error: quotaMessage, response: "earlier response" } });
describe("AGY trusted failure facts", () => {
  it("confirms a bound current provider quota result only at its quota exit", () => {
    const fact = extractAgyFailureFact({ ...binding, event: nativeQuotaResult() });
    expect(confirmAgyQuotaFailure(fact, { exitCode: 3, currentTurn: true, stderr: "" }))
      .toMatchObject({ category: "quota_exhausted", reason: "current_turn_quota_exit", can_switch_account: true });
    expect(confirmAgyQuotaFailure(fact, { exitCode: 3, currentTurn: true, stderr: "" }))
      .not.toHaveProperty("requires_quota_verification");
  });
  it.each([
    { exitCode: 1, currentTurn: true, stderr: "" },
    { exitCode: 3, currentTurn: false, stderr: "" },
    { exitCode: 3, currentTurn: true, stderr: "local error: tls: bad record MAC" },
    { exitCode: 3, currentTurn: true, stderr: "permission denied" },
    { exitCode: 3, currentTurn: true, stderr: "", terminationReason: "manual" },
  ])("does not promote a retained quota footer on a conflicting or historical completion: %j", completion => {
    const fact = extractAgyFailureFact({ ...binding, event: nativeQuotaResult() });
    expect(confirmAgyQuotaFailure(fact, completion)).toHaveProperty("requires_quota_verification", true);
  });
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
  it("recognizes the runtime-normalized provider result only as a quota candidate requiring official verification", () => {
    expect(extractAgyFailureFact({ ...binding, event: nativeQuotaResult() })).toMatchObject({
      category: "quota_exhausted", can_switch_account: true, requires_quota_verification: true,
      reason: "provider_result_quota_requires_verification", window: "unknown", requires_reauth: false,
      source_event_type: "result", source_offset: 10,
      raw_message: "provider_result_quota_requires_verification",
    });
  });
  it("keeps explicit structured quota evidence independent of text verification", () => {
    expect(extractAgyFailureFact({ ...binding, event: { type: "error", error: { code: "five_hour_quota_exhausted" } } }))
      .not.toHaveProperty("requires_quota_verification");
  });
  it("does not use unverified result metadata to choose an exhausted quota window", () => {
    expect(extractAgyFailureFact({ ...binding, event: { ...nativeQuotaResult(), window: "weekly" } }))
      .toMatchObject({ requires_quota_verification: true, window: "unknown" });
  });
  it.each([
    { currentTurn: false },
    { eventOffset: undefined },
    { authEpoch: 0 },
    { runId: undefined },
    { event: { ...nativeQuotaResult(), type: "assistant" } },
    { event: { type: "error", error: quotaMessage } },
    { event: { type: "result", error: quotaMessage } },
    { event: { ...nativeQuotaResult(), result: { status: "SUCCESS", error: quotaMessage } } },
    { event: { ...nativeQuotaResult(), result: { status: "ERROR", response: quotaMessage } } },
    { event: { ...nativeQuotaResult(), result: { status: "ERROR", error: quotaMessage, denied_actions: [{ display_name: "run_command" }] } } },
    { event: { type: "result", error: "RESOURCE_EXHAUSTED: 429", result: { status: "ERROR", error: "RESOURCE_EXHAUSTED: 429" } } },
  ])("does not promote incomplete, historical, or non-quota provider text: %j", (overrides) => {
    expect(extractAgyFailureFact({ ...binding, event: nativeQuotaResult(), ...overrides }).can_switch_account).toBe(false);
  });
});
