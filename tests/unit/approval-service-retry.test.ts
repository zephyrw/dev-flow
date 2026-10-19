import { expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APPROVAL_CAPACITY_ERROR, APPROVAL_FAILURE_ENTITY, isApprovalCapacityToolError } from "../../packages/core/src/approval-service-retry.js";
import { CodexSessionObserver } from "../../packages/runtime/src/codex-session-observer.js";
import { approvalFixture, approvalOutput, SESSION, CHILD } from "../fixtures/approval-service.js";

it("recognizes the exact native CreateProcess rejection with explicit non-execution", () => {
  expect(isApprovalCapacityToolError(approvalOutput())).toBe(true);
  for (const message of ["permission denied", "Rejected by safety review", "cancelled", "model at capacity",
    APPROVAL_CAPACITY_ERROR.replace("The action was not executed", "The action may have executed")]) {
    expect(isApprovalCapacityToolError(approvalOutput(message))).toBe(false);
  }
  const stdout = approvalOutput();
  stdout.output[0]!.text += stdout.output[1]!.text;
  expect(isApprovalCapacityToolError(stdout)).toBe(false);
  expect(isApprovalCapacityToolError({ type: "function_call_output", output: APPROVAL_CAPACITY_ERROR })).toBe(false);
  expect(isApprovalCapacityToolError({ type: "message", content: APPROVAL_CAPACITY_ERROR })).toBe(false);
});

it("binds tool call/output to the current root Run; ignores unpaired, child, and late records", async () => {
  const s = approvalFixture();
  try {
    s.accept(approvalOutput());
    expect(s.store.get(APPROVAL_FAILURE_ENTITY, s.run.id)).toBeUndefined();
    s.accept({ type: "custom_tool_call", name: "exec", call_id: "call-1", input: "command" }, CHILD);
    s.accept(approvalOutput(), CHILD);
    expect(s.store.get(APPROVAL_FAILURE_ENTITY, s.run.id)).toBeUndefined();
    s.fail();
    expect(s.store.get(APPROVAL_FAILURE_ENTITY, s.run.id)).toMatchObject({ run_id: s.run.id, native_session_id: SESSION });
    s.store.remove(APPROVAL_FAILURE_ENTITY, s.run.id);
    s.store.put("run_stop", s.run.id, s.w.id, { reason: "user pause" });
    s.fail();
    expect(s.store.get(APPROVAL_FAILURE_ENTITY, s.run.id)).toBeUndefined();
  } finally { await s.cleanup(); }
});

it("retains capacity evidence after a different check but clears it after the same invocation succeeds", async () => {
  const s = approvalFixture();
  try {
    s.fail();
    const success = (input: string, callId: string) => {
      s.accept({ type: "custom_tool_call", name: "exec", call_id: callId, input });
      s.accept({ type: "custom_tool_call_output", call_id: callId,
        output: [{ type: "input_text", text: "Script completed\nOutput:\nclean" }] });
    };
    success("await tools.exec_command({cmd: 'git status --short'})", "check");
    expect(s.store.get(APPROVAL_FAILURE_ENTITY, s.run.id)).toBeDefined();
    success("await tools.exec_command({cmd: 'git add app.txt'})", "retry");
    expect(s.store.get(APPROVAL_FAILURE_ENTITY, s.run.id)).toBeUndefined();
    s.fail();
    s.accept({ type: "custom_tool_call", name: "exec", call_id: "call-2", input: "another action" });
    s.accept({ ...approvalOutput("Permission denied"), call_id: "call-2" });
    expect(s.store.get(APPROVAL_FAILURE_ENTITY, s.run.id)).toBeUndefined();
  } finally { await s.cleanup(); }
});

it.each(["valid", "wrong-cwd", "historical", "child"])("observes only trusted current root session records: %s", async mode => {
  const s = approvalFixture();
  const home = join(s.root, "codex");
  const dir = join(home, "sessions", ...s.run.started_at.slice(0, 10).split("-"));
  mkdirSync(dir, { recursive: true });
  const sessionId = mode === "child" ? CHILD : SESSION;
  const row = (type: string, payload: Record<string, unknown>, old = false) => JSON.stringify({
    type, payload, timestamp: old ? "2000-01-01T00:00:00Z" : new Date().toISOString(),
  }) + "\n";
  writeFileSync(join(dir, `rollout-test-${sessionId}.jsonl`),
    row("session_meta", { id: sessionId, cwd: mode === "wrong-cwd" ? home : s.root }) +
    row("response_item", { type: "custom_tool_call", name: "exec", call_id: "call-1", input: "command" }, mode === "historical") +
    row("response_item", approvalOutput(), mode === "historical"));
  const observer = new CodexSessionObserver({ home, cwd: s.root, startedAt: s.run.started_at,
    onTrustedRootRecord: (record, session) => s.observer.accept(record, session) });
  try {
    observer.bind(SESSION);
    if (mode === "child") observer.bindChild(CHILD, SESSION);
    await observer.poll();
    expect(!!s.store.get(APPROVAL_FAILURE_ENTITY, s.run.id)).toBe(mode === "valid");
  } finally { await observer.close(); await s.cleanup(); }
});
