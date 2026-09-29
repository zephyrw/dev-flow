import { expect, it } from "vitest";
import { CurrentTurn } from "../../packages/adapters/agy/src/current-turn.js";
import { DiagnosticRedactionContext, DiagnosticStreamRedactor } from "../../packages/presentation/src/secret-redactor.js";
import { nativeFailureDiagnostic } from "../../packages/runtime/src/profile-runtime.js";
import { classifyFailure, normalizeRuntimeFailure } from "../../packages/runtime/src/errors.js";
import { FlowError } from "../../packages/contracts/src/index.js";

const tls = 'API error (attempt 1): request failed: Post "https://example.test/v1internal:streamGenerateContent": local error: tls: bad record MAC';
const response = "Completed work and test results. ".repeat(700);
const result = { status: "ERROR", response, error: tls, structured_output: { status: "completed" } };

it("retains a provider TLS cause after a response longer than the diagnostic cap", () => {
  const event = { event: "result", result };
  expect(JSON.stringify(event).slice(0, 8000)).not.toContain("bad record MAC");
  const diagnostic = nativeFailureDiagnostic(event);
  expect(diagnostic).toContain(tls.replaceAll('"', '\\"'));
  expect(diagnostic.length).toBeLessThanOrEqual("CLI 返回错误：".length + 8000);
  expect(classifyFailure(diagnostic)).toMatchObject({ code: "MODEL_CONNECTION_FAILED", retry: "auto" });
  const normalized = normalizeRuntimeFailure(new FlowError("NATIVE_RUN_FAILED", diagnostic)) as FlowError;
  expect(normalized.code).toBe("MODEL_CONNECTION_FAILED");
  expect(normalized.message).toContain("连接");
});

it("preserves the current error even when a later response and finish report completion", () => {
  const turn = new CurrentTurn();
  const accept = (index: number, type: string, state: string, extra = {}) => turn.accept({
    event: "step_update", step_update: { step_index: index, step_type: type, state, ...extra },
  });
  accept(473, "user_input", "DONE");
  accept(495, "error_message", "DONE");
  accept(527, "tool", "DONE", { tool_name: "run_command" });
  accept(528, "agent_response", "DONE");
  accept(529, "tool", "ACTIVE", { tool_name: "finish" });
  accept(529, "finish", "DONE");
  expect(turn.staleError(result, [], 0)).toBe(false);
  expect(classifyFailure(nativeFailureDiagnostic({ event: "result", result })).retry).toBe("auto");
});

it("keeps denied actions ahead of both a long answer and the TLS cause", () => {
  const diagnostic = nativeFailureDiagnostic({ event: "result", result: {
    ...result, denied_actions: [{ display_name: "run_command" }],
  } });
  expect(classifyFailure(diagnostic)).toMatchObject({ code: "NATIVE_PERMISSION_DENIED", retry: "manual" });
});

it("retains non-result top-level errors and leaves unknown failures unknown", () => {
  expect(classifyFailure(nativeFailureDiagnostic({ type: "error", message: response, error: tls })))
    .toMatchObject({ code: "MODEL_CONNECTION_FAILED", retry: "auto" });
  const event = { type: "error", message: "process exited 17" };
  expect(nativeFailureDiagnostic(event)).toBe("CLI 返回错误：" + JSON.stringify(event));
  expect(classifyFailure(nativeFailureDiagnostic(event)).code).toBe("EXECUTION_FAILED");
});

it("does not invalidate model login because a quota result embeds an old business token error", () => {
  const diagnostic = nativeFailureDiagnostic({ event: "result", result: {
    status: "ERROR", error: "Individual quota reached. Resets in 3h54m.",
    response: "此前业务接口 Access token has expired，缺少 SSO 会话，unauthenticated",
    structured_output: { summary: "业务接口 token expired", status: "need_user" },
  } });
  expect(diagnostic).not.toContain("SSO");
  expect(diagnostic).not.toContain("token expired");
  expect(classifyFailure(diagnostic).code).toBe("MODEL_QUOTA");
  expect((normalizeRuntimeFailure(new FlowError("NATIVE_RUN_FAILED", diagnostic)) as FlowError).code).toBe("MODEL_QUOTA");
});


it("retains the provider cause through a fresh shared diagnostic context without old business output", () => {
  const context = new DiagnosticRedactionContext();
  const diagnostic = nativeFailureDiagnostic({ event: "result", result: {
    error: tls,
    response: "An old business response mentioned Access token has expired. " + response,
  } }, context);
  expect(diagnostic).toContain("bad record MAC");
  expect(diagnostic).not.toContain("Access token has expired");
  expect(classifyFailure(diagnostic).code).toBe("MODEL_CONNECTION_FAILED");
});

it("shares authentication correlation between raw streams and provider failure diagnostics", () => {
  const context = new DiagnosticRedactionContext();
  const stdout = new DiagnosticStreamRedactor(64 * 1024, context);
  const stderr = new DiagnosticStreamRedactor(64 * 1024, context);
  stdout.push(JSON.stringify({ type: "tool_use", id: "auth-call", name: "Bash",
    input: { command: "provider login" } }) + "\n");
  const bareSecret = "opaque-credential-from-provider";
  const resultOutput = stderr.push(JSON.stringify({ type: "tool_result", tool_use_id: "auth-call",
    content: bareSecret }) + "\n");
  const diagnostic = nativeFailureDiagnostic({ event: "result", result: { error: bareSecret } }, context);
  expect(resultOutput).not.toContain(bareSecret);
  expect(diagnostic).not.toContain(bareSecret);
  expect(diagnostic).toContain("敏感认证操作");
});
