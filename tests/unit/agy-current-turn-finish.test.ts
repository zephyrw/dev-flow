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
