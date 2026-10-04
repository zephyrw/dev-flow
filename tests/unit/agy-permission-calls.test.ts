import { expect, it } from "vitest";
import { AgyDeniedCalls } from "../../packages/adapters/agy/src/permission-calls.js";

const session = "session-1";
const tool = (parameters: unknown, step_index = 1, conversation_id = session) => ({ event: "step_update", step_update: {
  step_type: "tool", state: "ERROR", step_index, conversation_id, tool_info: { name: "call_mcp_tool", parameters,
    error: { type: "TOOL_ERROR", message: 'permission check failed for mcp "opentabs/browser_emulate_device": user denied permission for mcp(opentabs/browser_emulate_device)' } },
} });
const denied = { event: "result", result: { denied_actions: [{ display_name: "CallMcpTool", action: "mcp" }] } };

it("retains exact MCP arguments and deduplicates the same denied call", () => {
  const calls = new AgyDeniedCalls();
  const parameters = { ServerName: "opentabs", ToolName: "browser_emulate_device", Arguments: { tabId: 1 } };
  calls.accept(tool(parameters), session);
  calls.accept(tool(parameters, 2), session);
  calls.accept(denied, session);
  expect(calls.denied).toEqual([{ name: "call_mcp_tool", parameters }]);
});

it("never pairs a historical turn or a different conversation with the current denial", () => {
  const calls = new AgyDeniedCalls();
  calls.accept(tool({ stale: true }), session);
  calls.accept({ event: "step_update", step_update: { step_type: "user_input", state: "DONE", step_index: 2 } }, session);
  calls.accept(tool({ other: true }, 3, "other-session"), session);
  calls.accept(denied, session);
  expect(calls.denied).toEqual([]);
  expect(calls.currentDenial).toBe(false);
});

it("ignores a cumulative denial footer after the resumed MCP call succeeds", () => {
  const calls = new AgyDeniedCalls();
  calls.accept(tool({ old: true }), session);
  calls.accept({ event: "step_update", step_update: { step_type: "user_input", state: "DONE", step_index: 20 } }, session);
  const done = tool({ new: true }, 21);
  done.step_update.state = "DONE";
  calls.accept(done, session);
  calls.accept(denied, session);
  expect(calls.currentDenial).toBe(false);
  expect(calls.denied).toEqual([]);
  const result = { status: "ERROR", error: "transport EOF", denied_actions: denied.result.denied_actions };
  expect(calls.currentResult(result)).toEqual({ status: "ERROR", error: "transport EOF" });
  expect(result.denied_actions).toHaveLength(1);
});

it("retains actual current refusals and uncertain footers in failure attribution", () => {
  const calls = new AgyDeniedCalls();
  expect(calls.currentResult(denied.result)).toEqual(denied.result);
  calls.accept({ event: "step_update", step_update: { step_type: "user_input", state: "DONE", step_index: 0 } }, session);
  calls.accept(tool({ current: true }), session);
  calls.accept(denied, session);
  expect(calls.currentResult(denied.result)).toEqual(denied.result);
});

it.each([undefined, null, "not-an-object", []])("missing or invalid public parameters never create a grant: %s", parameters => {
  const calls = new AgyDeniedCalls();
  calls.accept(tool(parameters), session);
  calls.accept(denied, session);
  expect(calls.denied).toEqual([]);
});

it("uses native metadata when the stream omits arguments and tolerates an unavailable record", () => {
  const calls = new AgyDeniedCalls(() => ({ name: "call_mcp_tool", parameters: { ToolName: "native" } }));
  calls.accept(tool(undefined), session);
  calls.accept(denied, session);
  expect(calls.denied[0]?.parameters).toEqual({ ToolName: "native" });
  const unavailable = new AgyDeniedCalls(() => { throw new Error("unavailable"); });
  unavailable.accept(tool(undefined), session);
  unavailable.accept(denied, session);
  expect(unavailable.denied).toEqual([]);
});

it("recognizes a current native permission rejection immediately, but not OS errors or replayed history", () => {
  const calls = new AgyDeniedCalls();
  const event = tool({ ServerName: "opentabs", ToolName: "browser_emulate_device" }, 2);
  (event.step_update.tool_info as any).error = { type: "TOOL_ERROR", message: 'permission check failed for mcp "opentabs/browser_emulate_device": user denied permission for mcp(opentabs/browser_emulate_device)' };
  calls.accept(event, session);
  expect(calls.immediate).toBeUndefined();
  calls.accept({ event: "step_update", step_update: { step_type: "user_input", state: "DONE", step_index: 1 } }, session);
  calls.accept(event, session);
  expect(calls.immediate).toHaveLength(1);
  (event.step_update.tool_info as any).error.message = "EACCES: permission denied, open file";
  calls.accept(event, session);
  expect(calls.immediate).toBeUndefined();
});

it("never approves another error from the same tool name just because the footer mentions that tool", () => {
  const calls = new AgyDeniedCalls();
  const deniedCall = tool({ ToolName: "denied" });
  const unrelated = tool({ ToolName: "failed-for-another-reason" }, 2);
  unrelated.step_update.tool_info.error.message = "Element not found";
  calls.accept(deniedCall, session);
  calls.accept(unrelated, session);
  calls.accept(denied, session);
  expect(calls.denied).toEqual([{ name: "call_mcp_tool", parameters: { ToolName: "denied" } }]);
});
