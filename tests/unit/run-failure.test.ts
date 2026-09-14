import { it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { classifyFailure } from "../../packages/runtime/src/errors.js";
import { observeAgy } from "../../packages/adapters/agy/src/session.js";
import { FlowError } from "../../packages/contracts/src/index.js";
import type { ManagedProcess } from "../../packages/process/src/manager.js";

it("DF-STAGE-U05 policy reasons stay distinct from model auth", () => {
  const resAuth = classifyFailure("Hook rejected with POLICY_UNAUTHORIZED");
  expect(resAuth.code).toBe("UNAUTHORIZED");

  const resTimeout = classifyFailure("Hook rejected with POLICY_RUN_TIMEOUT");
  expect(resTimeout.code).toBe("TIMEOUT");

  const resRevoked = classifyFailure("Hook rejected with POLICY_RUN_REVOKED");
  expect(resRevoked.code).toBe("RUN_REVOKED");

  const resModel = classifyFailure("Please run agy login to continue (unauthenticated)");
  expect(resModel.code).toBe("MODEL_AUTH");
});

it("DF-STAGE-U06 timeout without result retains TIMEOUT", async () => {
  const fakeProc = new EventEmitter() as ManagedProcess;
  fakeProc.id = "fake-proc";
  fakeProc.termination_reason = "timeout";
  fakeProc.stop = async () => {};
  fakeProc.completion = Promise.resolve({ code: 130, termination_reason: "timeout" });

  await expect(
    observeAgy(fakeProc, {
      model: "test-model",
      cwd: process.cwd(),
      log: "fake.log",
      onEvent: () => {},
      onDiagnostic: () => {},
    }),
  ).rejects.toThrowError(
    expect.objectContaining({
      code: "TIMEOUT",
      message: expect.stringContaining("时限"),
    }),
  );
});

it("DF-STAGE-U07 exit 130 alone does not prove timeout", async () => {
  const fakeProc = new EventEmitter() as ManagedProcess;
  fakeProc.id = "fake-proc-130";
  fakeProc.stop = async () => {};
  fakeProc.completion = Promise.resolve({ code: 130 });

  await expect(
    observeAgy(fakeProc, {
      model: "test-model",
      cwd: process.cwd(),
      log: "fake.log",
      onEvent: () => {},
      onDiagnostic: () => {},
    }),
  ).rejects.toThrowError(
    expect.objectContaining({
      code: "EXECUTION_FAILED",
    }),
  );
});
