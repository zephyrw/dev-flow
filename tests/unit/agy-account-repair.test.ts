import { expect, it, vi } from "vitest";
import { repairFailure } from "../../packages/core/src/repair.js";
import { FlowError } from "../../packages/contracts/src/index.js";
import type { Engine } from "../../packages/core/src/engine.js";

it.each([
  "AGY_ACCOUNT_WAIT",
  "AGY_ACCOUNT_UNAVAILABLE",
  "AGY_ACCOUNT_PERMIT_REVOKED",
])("%s does not start code repair or change its counters", async (code) => {
  const plan = vi.fn(() => {
    throw new Error("must not load a repair plan");
  });
  const put = vi.fn();
  const engine = {
    get: () => ({ run_id: "run", state: "EXECUTING" }),
    plan,
    store: { put },
  } as unknown as Engine;
  expect(
    await repairFailure(
      engine,
      "workflow",
      new FlowError(code, "账号运行状态", 409),
      "run",
    ),
  ).toBeNull();
  expect(plan).not.toHaveBeenCalled();
  expect(put).not.toHaveBeenCalled();
});
