import { expect, it } from "vitest";
import { NativeDeniedCalls } from "../../packages/runtime/src/native-permission-events.js";

const session = "native-session";
const input = { command: "git status --short" };
const rejected = "The user rejected permission to use this specific tool call.";
const claudeResult = (permission_denials: unknown[], session_id = session) => ({
  type: "result", session_id, permission_denials,
});
const claudeDenial = (tool_use_id = "call-1", tool_input: unknown = input) => ({
  tool_use_id, tool_name: "Bash", tool_input,
});
const openCodeResult = (error: unknown = rejected, callID = "call-1", parameters: unknown = input) => ({
  type: "tool_use", sessionID: session,
  part: { type: "tool", sessionID: session, callID, tool: "bash",
    state: { status: "error", input: parameters, error } },
});

it("reads Claude structured denials with exact IDs and parameters, preserving distinct calls", () => {
  const calls = new NativeDeniedCalls("claude-code");
  calls.accept(claudeResult([claudeDenial(), claudeDenial(), claudeDenial("call-2")]), session);
  expect(calls.currentDenial).toBe(true);
  expect(calls.denied).toEqual([{ name: "Bash", parameters: input }, { name: "Bash", parameters: input }]);
  expect(calls.observations.map(item => [item.native_call_id, item.session_id])).toEqual([
    ["call-1", session], ["call-2", session],
  ]);
});

it("does not reinterpret Claude tool output or model text as a permission protocol", () => {
  const calls = new NativeDeniedCalls("claude-code");
  calls.accept({ type: "assistant", session_id: session, message: { content: [
    { type: "tool_use", id: "call-1", name: "Bash", input },
    { type: "text", text: "permission check failed: needs permission" },
  ] } }, session);
  calls.accept({ type: "user", session_id: session, message: { content: [
    { type: "tool_result", tool_use_id: "call-1", is_error: true, content: "permission check failed: permission denied" },
  ] } }, session);
  expect(calls.currentDenial).toBe(false);
  expect(calls.immediate).toBeUndefined();
});

it("pairs Claude permission_denied only with the exact native tool ID", () => {
  const calls = new NativeDeniedCalls("claude-code");
  calls.accept({ type: "assistant", session_id: session, message: { content: [
    { type: "tool_use", id: "call-1", name: "Bash", input },
    { type: "tool_use", id: "call-2", name: "Bash", input: { command: "different" } },
  ] } }, session);
  calls.accept({ type: "system", subtype: "permission_denied", session_id: session,
    tool_use_id: "call-1", tool_name: "Bash" }, session);
  expect(calls.immediate).toEqual([{ name: "Bash", parameters: input }]);
  calls.accept({ type: "system", subtype: "permission_denied", session_id: session,
    tool_use_id: "unknown-call", tool_name: "Bash" }, session);
  expect(calls.currentDenial).toBe(true);
  expect(calls.immediate).toEqual([]);
});

it("does not attribute another session or child result to the Claude root", () => {
  const calls = new NativeDeniedCalls("claude-code");
  calls.accept(claudeResult([claudeDenial()], "other-session"), session);
  calls.accept({ ...claudeResult([claudeDenial()]), parent_tool_use_id: "parent-call" }, session);
  calls.accept(claudeResult([claudeDenial()]), undefined);
  expect(calls.currentDenial).toBe(false);
});

it.each([undefined, null, [], "parameters omitted"])("confirms Claude denial without inventing parameters: %s", parameters => {
  const calls = new NativeDeniedCalls("claude-code");
  calls.accept(claudeResult([{ tool_use_id: "call-1", tool_name: "Bash", tool_input: parameters }]), session);
  expect(calls.currentDenial).toBe(true);
  expect(calls.immediate).toEqual([]);
  expect(calls.denied).toEqual([]);
});

it("does not choose between conflicting parameters or fall back to the last call ID", () => {
  const calls = new NativeDeniedCalls("claude-code");
  calls.accept(claudeResult([claudeDenial(), claudeDenial("call-1", { command: "different" })]), session);
  expect(calls.currentDenial).toBe(true);
  expect(calls.denied).toEqual([]);
  calls.accept(claudeResult([{ tool_name: "Bash", tool_input: input }]), session);
  expect(calls.currentDenial).toBe(true);
  expect(calls.observations).toEqual([]);
  expect(calls.denied).toEqual([]);
  calls.accept(claudeResult([]), session);
  expect(calls.currentDenial).toBe(false);
});

it.each([
  rejected,
  "The user rejected permission to use this specific tool call with the following feedback: stay in the worktree",
  'The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules [{"permission":"bash","pattern":"*","action":"deny"}]',
])("recognizes the OpenCode native permission error serialization: %s", error => {
  const calls = new NativeDeniedCalls("opencode");
  calls.accept(openCodeResult(error), session);
  expect(calls.currentDenial).toBe(true);
  expect(calls.denied).toEqual([{ name: "bash", parameters: input }]);
  expect(calls.observations[0]).toMatchObject({ native_call_id: "call-1", session_id: session });
});

it.each([
  "EACCES: permission denied, open '/protected/file'",
  "remote: permission denied",
  "permission rejected",
  "permission check failed",
  `Command failed: ${rejected}`,
  'The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules not-json',
])("preserves ordinary OpenCode errors without an authorization card: %s", error => {
  const calls = new NativeDeniedCalls("opencode");
  calls.accept(openCodeResult(error), session);
  expect(calls.currentDenial).toBe(false);
  expect(calls.immediate).toBeUndefined();
});

it("requires OpenCode's error ToolPart and matching envelope/part sessions", () => {
  const calls = new NativeDeniedCalls("opencode");
  const other = openCodeResult();
  other.part.sessionID = "child-session";
  calls.accept(other, session);
  calls.accept({ ...openCodeResult(), sessionID: "other-session" }, session);
  const deniedStatus = openCodeResult();
  deniedStatus.part.state.status = "denied";
  calls.accept(deniedStatus, session);
  expect(calls.currentDenial).toBe(false);
});

it("keeps incomplete OpenCode denials non-authorizing and deduplicates by call ID", () => {
  const calls = new NativeDeniedCalls("opencode");
  calls.accept(openCodeResult(), session);
  calls.accept(openCodeResult(), session);
  expect(calls.denied).toHaveLength(1);
  calls.accept(openCodeResult(rejected, "call-2", null), session);
  expect(calls.currentDenial).toBe(true);
  expect(calls.denied).toEqual([]);
  const completed = openCodeResult(rejected, "call-2");
  completed.part.state.status = "completed";
  calls.accept(completed, session);
  expect(calls.denied).toEqual([{ name: "bash", parameters: input }]);
});
