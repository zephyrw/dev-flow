import { it, expect } from "vitest";
import { CurrentTurn } from "../../packages/adapters/agy/src/current-turn.js";

it("requires a new unfinished user turn before attributing a resumed quota error", () => {
  const turn = new CurrentTurn();
  const event = (index: number, type: string, state: string) => ({
    event: "step_update",
    step_update: { step_index: index, step_type: type, state },
  });
  expect(turn.canAttributeFailureToCurrentTurn()).toBe(false);
  turn.accept(event(20, "user_input", "DONE"));
  expect(turn.canAttributeFailureToCurrentTurn()).toBe(true);
  turn.accept(event(21, "agent_response", "DONE"));
  expect(turn.canAttributeFailureToCurrentTurn()).toBe(false);
  turn.accept(event(10, "user_input", "DONE"));
  expect(turn.canAttributeFailureToCurrentTurn()).toBe(false);
  turn.accept(event(22, "user_input", "DONE"));
  turn.accept(event(23, "agent_response", "ERROR"));
  expect(turn.canAttributeFailureToCurrentTurn()).toBe(true);
});
