import { describe, it, expect } from "vitest";
import {
  confirmAgyQuotaFailure,
  extractAgyFailureFact,
  extractAgyStderrQuotaCandidate,
  isAgyIndividualQuotaError,
  unwrapAgyQuotaError,
} from "../../packages/adapters/agy/src/failure-fact.js";

const binding = { realmId: "realm", accountId: "account", authEpoch: 2, runId: "run",
  conversationId: "conversation", eventOffset: 10, currentTurn: true };
const quotaMessage = "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 37m46s.";
const nativeQuotaResult = () => ({ type: "result", error: quotaMessage,
  result: { status: "ERROR", error: quotaMessage, response: "earlier response" } });
describe("AGY trusted failure facts", () => {
  it.each([
    "local error: tls: bad record MAC",
    "network error: connection reset",
    "permission denied",
    "operation timed out",
  ])("rejects a quota line mixed with %s before selecting or unwrapping it", conflict => {
    for (const mixed of [`${quotaMessage}\n${conflict}`, `${conflict}\r\n${quotaMessage}`]) {
      for (const error of [mixed, `CLI 返回错误：${mixed}`, JSON.stringify({ error: mixed })]) {
        expect(unwrapAgyQuotaError(error)).toBeUndefined();
        expect(isAgyIndividualQuotaError(error)).toBe(false);
        expect(unwrapAgyQuotaError({ error })).toBeUndefined();
        expect(extractAgyFailureFact({ ...binding,
          event: { type: "result", error, result: { status: "ERROR", error } },
        }).can_switch_account).toBe(false);
      }
    }
  });
  it("keeps unambiguous quota messages recognizable in supported wrappers", () => {
    for (const error of [quotaMessage, `AGY_ERROR: ${quotaMessage}`,
      JSON.stringify({ error: quotaMessage }), `CLI 返回错误：${JSON.stringify({ error: quotaMessage })}`]) {
      expect(unwrapAgyQuotaError(error)).toBe(quotaMessage);
      expect(isAgyIndividualQuotaError(error)).toBe(true);
    }
  });
  it("confirms a bound current provider quota result only at its quota exit", () => {
    const fact = extractAgyFailureFact({ ...binding, event: nativeQuotaResult() });
    // exitCode 3 是明确的配额退出码
    expect(confirmAgyQuotaFailure(fact, { exitCode: 3, currentTurn: true, stderr: "" }))
      .toMatchObject({ category: "quota_exhausted", reason: "current_turn_quota_exit", can_switch_account: true });
    expect(confirmAgyQuotaFailure(fact, { exitCode: 3, currentTurn: true, stderr: "" }))
      .not.toHaveProperty("requires_quota_verification");

    // 退出码 0 保留额度核验要求，不能直接认定为额度确认，避免历史文字掩盖真实超时
    expect(confirmAgyQuotaFailure(fact, { exitCode: 0, currentTurn: true, stderr: "" }))
      .toHaveProperty("requires_quota_verification", true);

    // stdout 包含原生超时等冲突诊断时，禁止认定为额度退出
    expect(confirmAgyQuotaFailure(fact, { exitCode: 3, currentTurn: true, stdout: "operation timed out" }))
      .toHaveProperty("requires_quota_verification", true);
  });
  it("unwraps JSON-wrapped and prefix-wrapped quota error messages", () => {
    const wrappedJson = JSON.stringify({ error: quotaMessage });
    const factJson = extractAgyFailureFact({
      ...binding,
      event: { type: "result", error: wrappedJson, result: { status: "ERROR", error: wrappedJson } },
    });
    expect(factJson).toMatchObject({
      category: "quota_exhausted",
      can_switch_account: true,
      requires_quota_verification: true,
    });
    expect(confirmAgyQuotaFailure(factJson, { exitCode: 3, currentTurn: true, stderr: "" }))
      .toMatchObject({ category: "quota_exhausted", reason: "current_turn_quota_exit" });

    const prefixed = `CLI 返回错误：${wrappedJson}`;
    const factPrefixed = extractAgyFailureFact({
      ...binding,
      event: { type: "result", error: prefixed, result: { status: "ERROR", error: prefixed } },
    });
    expect(factPrefixed).toMatchObject({
      category: "quota_exhausted",
      can_switch_account: true,
      requires_quota_verification: true,
    });
  });
  it("extracts constrained quota failure candidate from current process stderr", () => {
    const stderrMsg = `AGY_ERROR: ${quotaMessage}`;
    const candidate = extractAgyStderrQuotaCandidate({
      realmId: "realm",
      accountId: "account",
      authEpoch: 2,
      runId: "run",
      conversationId: "conv",
      stderr: stderrMsg,
      currentProcess: true,
    });
    expect(candidate).toBeDefined();
    expect(candidate).toMatchObject({
      category: "quota_exhausted",
      can_switch_account: true,
      requires_quota_verification: true,
      reason: "stderr_quota_requires_verification",
    });

    // 冲突诊断（如网络/超时）时不提取为额度候选
    const conflictCandidate = extractAgyStderrQuotaCandidate({
      realmId: "realm",
      accountId: "account",
      authEpoch: 2,
      runId: "run",
      conversationId: "conv",
      stderr: `${stderrMsg}\nlocal error: tls: bad record MAC`,
      currentProcess: true,
    });
    expect(conflictCandidate).toBeUndefined();
  });
  it.each([0, 3])("requires official verification for process stderr before user_input even at exit %s", exitCode => {
    const candidate = extractAgyStderrQuotaCandidate({
      ...binding, currentProcess: true, stderr: `error: ${quotaMessage}\nAGY_ERROR: ${JSON.stringify({ error: quotaMessage })}`,
    });
    expect(candidate).toMatchObject({ source_event_type: "stderr", run_id: binding.runId,
      account_id: binding.accountId, auth_epoch: binding.authEpoch, requires_quota_verification: true });
    for (const currentTurn of [false, true]) {
      expect(confirmAgyQuotaFailure(candidate!, { exitCode, currentTurn, stderr: quotaMessage }))
        .toHaveProperty("requires_quota_verification", true);
    }
  });
  it.each([
    { currentProcess: false }, { runId: undefined }, { authEpoch: 0 },
    { stderr: `${quotaMessage}\noperation timed out` },
    { stderr: `${quotaMessage}\npermission denied` },
  ])("rejects unbound or conflicting process stderr: %j", overrides => {
    expect(extractAgyStderrQuotaCandidate({ ...binding, currentProcess: true, stderr: quotaMessage, ...overrides }))
      .toBeUndefined();
  });
  it.each([
    { exitCode: 1, currentTurn: true, stderr: "" },
    { exitCode: 3, currentTurn: false, stderr: "" },
    { exitCode: 3, currentTurn: true, stderr: "local error: tls: bad record MAC" },
    { exitCode: 3, currentTurn: true, stderr: "subscriber fell behind updates, stalled for 10s" },
    { exitCode: 3, currentTurn: true, stderr: "API error (attempt 1): INTERNAL (code 500): Internal error encountered." },
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
