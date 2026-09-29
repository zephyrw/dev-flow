import { expect, it } from "vitest";
import { CurrentTurn } from "../../packages/adapters/agy/src/current-turn.js";

const result = {
  status: "ERROR",
  error:
    "API error (attempt 1): request failed: local error: tls: bad record MAC",
  response: '{"status":"need_user"}',
};

const step = (index: number, type: string, state: string) => ({
  event: "step_update",
  step_update: { step_index: index, step_type: type, state },
});

it("recognizes a retained TLS error after a complete new turn", () => {
  const turn = new CurrentTurn();
  turn.accept(step(447, "user_input", "DONE"));
  turn.accept(step(454, "tool", "DONE"));
  turn.accept(step(455, "agent_response", "DONE"));
  expect(turn.staleError(result, [], 0)).toBe(true);
});

it.each([
  "no_user_boundary",
  "unfinished_response",
  "current_error",
  "later_tool",
  "denied_action",
  "abnormal_exit",
])("preserves a real or unproven TLS failure: %s", (scenario) => {
  const turn = new CurrentTurn();
  if (scenario !== "no_user_boundary")
    turn.accept(step(447, "user_input", "DONE"));
  turn.accept(step(454, "tool", "DONE"));
  turn.accept(
    step(
      455,
      "agent_response",
      scenario === "unfinished_response" ? "ACTIVE" : "DONE",
    ),
  );
  if (scenario === "current_error") turn.accept(step(456, "error", "ERROR"));
  if (scenario === "later_tool") turn.accept(step(456, "tool", "DONE"));
  expect(
    turn.staleError(
      {
        ...result,
        ...(scenario === "denied_action"
          ? { denied_actions: [{ display_name: "run_command" }] }
          : {}),
      },
      [],
      scenario === "abnormal_exit" ? 2 : 0,
    ),
  ).toBe(false);
});
