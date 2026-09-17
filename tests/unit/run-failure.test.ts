import { it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { classifyFailure } from "../../packages/runtime/src/errors.js";
import { observeAgy } from "../../packages/adapters/agy/src/session.js";
import { FlowError } from "../../packages/contracts/src/index.js";
import type { ManagedProcess } from "../../packages/process/src/manager.js";
import { agyArguments } from "../../packages/adapters/agy/src/session.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("native AGY startup and exact resume explicitly accept workspace edits without bypassing permissions", () => {
  for (const conversation of [undefined, "original-session"]) {
    const args = agyArguments(
      "configured-model",
      "approved work",
      5,
      conversation,
      "project",
      "accept-edits",
    );
    expect(args[args.indexOf("--mode") + 1]).toBe("accept-edits");
    if (conversation)
      expect(args[args.indexOf("--conversation") + 1]).toBe(conversation);
    expect(args).not.toContain("--dangerously-skip-permissions");
  }
  expect(agyArguments("model", "legacy", 5)).not.toContain("--mode");
});

it("native permission denial is distinct from DevFlow's hook and is never a model-repair instruction", () => {
  expect(
    classifyFailure('{"denied_actions":[{"action":"write_file"}]}'),
  ).toMatchObject({ code: "NATIVE_PERMISSION_DENIED", retry: "manual" });
  expect(classifyFailure("POLICY_DEFAULT_DENY")).toMatchObject({
    code: "AUTHORIZATION_ROUTING_REQUIRED",
    retry: "manual",
  });
});

it("SUCCESS transport with denied editing retains the native tool and target and fails closed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "devflow-denial-"));
  const proc = new EventEmitter() as ManagedProcess;
  proc.stop = async () => {};
  let finish!: (v: { code: number }) => void;
  proc.completion = new Promise((resolve) => {
    finish = resolve;
  });
  const result = observeAgy(proc, {
    model: "model",
    cwd: directory,
    log: join(directory, "run.jsonl"),
    onEvent: () => {},
    onDiagnostic: () => {},
  });
  const rejected = expect(result).rejects.toMatchObject({
    code: "NATIVE_PERMISSION_DENIED",
    message: expect.stringContaining("C:/work/UserService.java"),
  });
  for (const e of [
    {
      event: "init",
      conversation_id: "c",
      init: { model: "model", cwd: directory },
    },
    {
      event: "step_update",
      step_update: {
        conversation_id: "c",
        step_index: 4,
        step_type: "tool",
        state: "ERROR",
        tool_name: "replace_file_content",
        tool_info: { parameters: { TargetFile: "C:/work/UserService.java" } },
      },
    },
    {
      event: "result",
      result: {
        conversation_id: "c",
        status: "SUCCESS",
        response: "正在处理",
        denied_actions: [
          { action: "write_file", display_name: "ReplaceFileContent" },
        ],
      },
    },
  ])
    proc.emit("stdout", Buffer.from(JSON.stringify(e) + "\n"));
  finish({ code: 0 });
  await rejected;
});

it("DF-STAGE-U05 policy reasons stay distinct from model auth", () => {
  const resAuth = classifyFailure("Hook rejected with POLICY_UNAUTHORIZED");
  expect(resAuth.code).toBe("UNAUTHORIZED");

  const resTimeout = classifyFailure("Hook rejected with POLICY_RUN_TIMEOUT");
  expect(resTimeout.code).toBe("TIMEOUT");

  const resRevoked = classifyFailure("Hook rejected with POLICY_RUN_REVOKED");
  expect(resRevoked.code).toBe("RUN_REVOKED");

  const resModel = classifyFailure(
    "Please run agy login to continue (unauthenticated)",
  );
  expect(resModel.code).toBe("MODEL_AUTH");
});

it("DF-STAGE-U06 timeout without result retains TIMEOUT", async () => {
  const fakeProc = new EventEmitter() as ManagedProcess;
  fakeProc.id = "fake-proc";
  fakeProc.termination_reason = "timeout";
  fakeProc.stop = async () => {};
  fakeProc.completion = Promise.resolve({
    code: 130,
    termination_reason: "timeout",
  });

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
