import { expect, it } from "vitest";
import { CurrentTurn } from "../../packages/adapters/agy/src/current-turn.js";

const result = {
  status: "ERROR",
  error: "API error (attempt 1): request failed: wsasend: An existing connection was forcibly closed by the remote host.",
  response: "本轮结果已通过 finish 返回。",
  structured_output: { status: "completed" },
};
const step = (index: number, type: string, state = "DONE", extra: Record<string, unknown> = {}) => ({
  event: "step_update",
  step_update: { step_index: index, step_type: type, state, ...extra },
});
const user = step(407, "user_input");
const response = step(487, "agent_response");
const finishStart = step(488, "tool", "ACTIVE", { tool_name: "finish" });
const finishDone = step(488, "finish");

function observe(events: ReturnType<typeof step>[]) {
  const turn = new CurrentTurn();
  events.forEach((event) => turn.accept(event));
  return turn;
}

it.each([
  { tool_name: "finish" },
  { tool_info: { name: "finish" } },
])("accepts the explicit same-step finish terminal after a completed response: %j", (name) => {
  const turn = observe([
    user,
    step(486, "tool", "DONE", { tool_name: "run_command" }),
    response,
    step(488, "tool", "ACTIVE", name),
    finishDone,
  ]);
  expect(turn.staleError(result, [], 0)).toBe(true);
  expect(turn.canAttributeFailureToCurrentTurn()).toBe(false);
});

it.each([
  { name: "finish is still active", events: [user, response, finishStart] },
  { name: "finish failed", events: [user, response, finishStart, step(488, "finish", "ERROR")] },
  { name: "completion belongs to another step", events: [user, response, finishStart, step(489, "finish")] },
  { name: "ordinary tool cannot impersonate finish", events: [user, response, step(488, "tool", "ACTIVE", { tool_name: "run_command" }), finishDone] },
  { name: "unnamed tool cannot impersonate finish", events: [user, response, step(488, "tool", "ACTIVE"), finishDone] },
  { name: "a later real tool is unfinished", events: [user, response, finishStart, finishDone, step(489, "tool", "ACTIVE", { tool_name: "run_command" })] },
  { name: "a later real tool completed without a new response", events: [user, response, finishStart, finishDone, step(489, "tool", "DONE", { tool_name: "run_command" })] },
  { name: "an earlier real tool after the model response remains unaccounted for", events: [user, step(485, "agent_response"), step(486, "tool", "DONE", { tool_name: "run_command" }), finishStart, finishDone] },
  { name: "no new user boundary", events: [response, finishStart, finishDone] },
  { name: "no model response", events: [user, finishStart, finishDone] },
  { name: "model response is still active", events: [user, step(487, "agent_response", "ACTIVE"), finishStart, finishDone] },
  { name: "current provider error is retained", events: [user, step(480, "error_message"), response, finishStart, finishDone] },
  { name: "new user input clears prior completion", events: [user, response, finishStart, finishDone, step(490, "user_input")] },
  { name: "new user input clears pending finish attribution", events: [user, response, finishStart, step(490, "user_input"), step(491, "tool", "ACTIVE"), step(491, "finish")] },
])("keeps a failure when $name", ({ events }) => {
  expect(observe(events).staleError(result, [], 0)).toBe(false);
});

it("does not override current denied actions even with a valid finish terminal", () => {
  const turn = observe([user, response, finishStart, finishDone]);
  expect(turn.staleError({ ...result, denied_actions: [{ display_name: "run_command" }] }, [], 0)).toBe(false);
});

it.each([2, -1, null])("does not override abnormal exit %s even with a valid finish terminal", (exit) => {
  expect(observe([user, response, finishStart, finishDone]).staleError(result, [], exit)).toBe(false);
});

const invalidFinish = step(727, "tool", "ERROR", { tool_name: "finish", tool_info: {
  name: "finish", error: { type: "TOOL_ERROR", message: "invalid arguments:\n- at '/delivery': missing property 'workflow_id'\n- at '/delivery': got object, want null" },
} });
const repairedFinish = [step(728, "agent_response"), step(729, "tool", "ACTIVE", { tool_name: "finish" }), step(729, "finish")];
it("recognizes a corrected finish argument error using the real 673→727→728→729 sequence", () => {
  const turn = observe([step(673, "user_input"), step(726, "agent_response"), invalidFinish]);
  expect(turn.staleError(result, [], 0)).toBe(false);
  repairedFinish.forEach(e => turn.accept(e));
  expect(turn.staleError(result, [], 0)).toBe(true);
  expect(turn.canAttributeFailureToCurrentTurn()).toBe(false);
});
it.each([
  { name: "no later successful finish", tail: [step(728, "agent_response")] },
  { name: "later finish is still active", tail: repairedFinish.slice(0, 2) },
  { name: "unidentified finish terminal", tail: [step(728, "agent_response"), step(729, "finish")] },
  { name: "no corrective model response", tail: repairedFinish.slice(1) },
  { name: "current provider error", tail: [step(728, "error_message"), ...repairedFinish] },
])("keeps finish validation pending with $name", ({ tail }) => {
  expect(observe([step(673, "user_input"), step(726, "agent_response"), invalidFinish, ...tail]).staleError(result, [], 0)).toBe(false);
});
it.each([
  { type: "TOOL_ERROR", message: "permission denied" },
  { type: "TOOL_ERROR", message: "transport failed" },
  { type: "PROVIDER_ERROR", message: "invalid arguments: unavailable model" },
])("never clears other finish errors after a later successful finish: %j", error => {
  const failed = step(727, "tool", "ERROR", { tool_name: "finish", tool_info: { error } });
  expect(observe([step(673, "user_input"), failed, ...repairedFinish]).staleError(result, [], 0)).toBe(false);
});
it("does not clear another tool's reported execution failure when finish parameters are repaired", () => {
  const tool = step(725, "tool", "ERROR", { tool_name: "run_command", tool_info: {
    output: JSON.stringify({ error: { code: "SCOPE_VIOLATION", message: "outside approved scope" } }),
  } });
  const turn = observe([step(673, "user_input"), tool, invalidFinish, ...repairedFinish]);
  expect(turn.reportedFailure("SCOPE_VIOLATION: blocked")).toEqual({ code: "SCOPE_VIOLATION", message: "outside approved scope" });
});
it("does not hide real quota exit 3 after a corrected finish", () => {
  expect(observe([step(673, "user_input"), invalidFinish, ...repairedFinish]).staleError({
    ...result, error: "Individual quota reached. Resets in 2h27m8s.",
  }, [], 3)).toBe(false);
});
