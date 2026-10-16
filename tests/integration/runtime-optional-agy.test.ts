import { afterEach, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { buildServer } from "../../apps/api/src/server.js";
import type { AgyAccountService } from "../../packages/agy-accounts/src/service.js";
import { executablePath } from "../../packages/process/src/executable.js";
import { LocalRuntime } from "../../packages/runtime/src/runtime.js";
import { setup, testConsoleHeaders } from "../helpers.js";

const fixtures: (ReturnType<typeof setup> & { runtime: LocalRuntime })[] = [];

function fixture() {
  const s = setup();
  s.config.models.agy_executable = join(s.root, "missing", "custom-agy-client.exe");
  const runtime = new LocalRuntime(s.engine);
  s.engine.runtime = runtime;
  const account = {
    registerConsumer: vi.fn(() => () => {}),
    setWorkflowWaitValidator: vi.fn(),
    isManaged: vi.fn(() => true),
    markUsageStarted: vi.fn(),
  };
  const admission = vi.spyOn(runtime.processes, "setAdmissionGuard");
  const state = { ...s, runtime, account, admission };
  fixtures.push(state);
  return state;
}

afterEach(async () => {
  for (const s of fixtures.splice(0)) {
    await s.runtime.processes.close();
    s.store.close();
    rmSync(s.root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

it("starts the workbench without AGY while actual executable lookup still reports it missing", async () => {
  const s = fixture();
  s.runtime.attachAccountService(s.account as unknown as AgyAccountService);
  const app = await buildServer(s.engine);
  try {
    const health = await app.inject({ method: "GET", url: "/api/health", headers: testConsoleHeaders(s.config) });
    expect(health.statusCode).toBe(200);
    expect(s.account.registerConsumer).toHaveBeenCalledOnce();
    expect(() => executablePath(s.config.models.agy_executable)).toThrowError(
      expect.objectContaining({ code: "EXECUTABLE_MISSING" }),
    );
  } finally {
    await app.close();
  }
});

it("does not block another client when AGY is absent, and still enforces AGY account permits", () => {
  const s = fixture();
  s.runtime.attachAccountService(s.account as unknown as AgyAccountService);
  const guard = s.admission.mock.calls[0]![0]!;
  const spec = { id: "other-client", executable: process.execPath, args: [], cwd: s.root, env: {}, timeout_ms: 1000 };
  expect(() => guard(spec)).not.toThrow();
  expect(s.account.markUsageStarted).not.toHaveBeenCalled();
  for (const executable of [s.config.models.agy_executable, "agy.exe"]) {
    expect(() => guard({ ...spec, executable })).toThrowError(
      expect.objectContaining({ code: "AGY_ACCOUNT_PERMIT_REQUIRED" }),
    );
  }
});

it("does not suppress invalid executable configuration", () => {
  const s = fixture();
  s.config.models.agy_executable = "invalid\ncommand";
  expect(() => s.runtime.attachAccountService(s.account as unknown as AgyAccountService)).toThrowError(
    expect.objectContaining({ code: "EXECUTABLE_INVALID" }),
  );
});
