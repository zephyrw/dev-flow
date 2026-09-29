import { it, expect } from "vitest";
import { CurrentTurn } from "../../packages/adapters/agy/src/current-turn.js";
import { confirmAgyQuotaFailure, extractAgyFailureFact } from "../../packages/adapters/agy/src/failure-fact.js";

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

it.each(["unfinished-error", "completed-finish", "tls-with-retained-quota", "no-user-boundary"] as const)(
  "runtime-normalized result keeps the %s turn boundary and requires quota corroboration",
  (kind) => {
    const turn = new CurrentTurn();
    const step = (index: number, type: string, state = "DONE", extra = {}) => ({ event: "step_update",
      step_update: { step_index: index, step_type: type, state, ...extra } });
    if (kind !== "no-user-boundary") turn.accept(step(789, "user_input"));
    if (kind === "completed-finish") {
      turn.accept(step(790, "agent_response"));
      turn.accept(step(791, "tool", "ACTIVE", { tool_name: "finish", tool_info: { name: "finish" } }));
      turn.accept(step(791, "finish"));
    } else if (kind !== "no-user-boundary") {
      turn.accept(step(791, "error_message", "DONE", kind === "tls-with-retained-quota"
        ? { error_info: { message: "local error: tls: bad record MAC" } } : {}));
    }
    const raw = { event: "result", result: { status: "ERROR",
      error: "Individual quota reached. Resets in 37m46s.", response: "earlier response" } };
    turn.accept(raw);
    // This is the event normalization used by both runtime entry points.
    const fact = extractAgyFailureFact({ realmId: "realm", accountId: "account", authEpoch: 45,
      runId: "run", eventOffset: 13, currentTurn: turn.canAttributeFailureToCurrentTurn(),
      event: { ...raw, type: raw.event, error: raw.result.error } });
    if (kind === "completed-finish" || kind === "no-user-boundary") {
      expect(fact.can_switch_account).toBe(false);
    } else {
      // Even a new error boundary cannot prove that the retained quota text
      // describes this turn; the bridge must verify current official quota.
      expect(fact).toMatchObject({ category: "quota_exhausted", can_switch_account: true,
        requires_quota_verification: true, window: "unknown" });
    }
  },
);

it("confirms the real CLI shape: textless current error steps, exact quota footer and exit 3", () => {
  const turn = new CurrentTurn();
  for (const [index, type] of [[410, "user_input"], [411, "error_message"], [412, "error_message"]] as const)
    turn.accept({ event: "step_update", step_update: {
      conversation_id: "fixture", step_index: index, step_type: type, state: "DONE", duration_seconds: 1,
    } });
  const error = "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 37m46s.";
  const fact = extractAgyFailureFact({ realmId: "realm", accountId: "account", authEpoch: 45,
    runId: "run", eventOffset: 13, currentTurn: turn.canAttributeFailureToCurrentTurn(),
    event: { type: "result", error, result: { status: "ERROR", error, response: "earlier response" } } });
  expect(confirmAgyQuotaFailure(fact, { exitCode: 3, currentTurn: turn.canAttributeFailureToCurrentTurn() }))
    .toMatchObject({ reason: "current_turn_quota_exit", can_switch_account: true });
  expect(confirmAgyQuotaFailure(fact, { exitCode: 1, currentTurn: true, stderr: "local error: tls: bad record MAC" }))
    .toHaveProperty("requires_quota_verification", true);
});
