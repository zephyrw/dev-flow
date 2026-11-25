import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { AgyAccountJobRunner } from "../../packages/process/src/agy-account-job-runner.js";
import type { ProcessManager } from "../../packages/process/src/manager.js";

it("preserves a confirmed auxiliary timeout instead of reducing it to model denial", async () => {
  const managed = Object.assign(new EventEmitter(), {
    completion: Promise.resolve({ code: -1, confirmed: true, termination_reason: "timeout" }),
    stop: vi.fn(),
  });
  const manager = { start: vi.fn(() => managed), observe: vi.fn(async () => ({ state: "confirmed_exited" })) };
  const runner = new AgyAccountJobRunner("unused", manager as unknown as ProcessManager);
  const output = await runner.runAuxiliaryProbe({ executable: "unused", args: [],
    lease: { lease_id: "fixture", operation_id: "fixture" } as any, timeoutMs: 90000 });
  expect(output).toMatchObject({ code: -1, termination_reason: "timeout" });
  expect(manager.start).toHaveBeenLastCalledWith(expect.objectContaining({
    interactive: false, env: { ANTIGRAVITY_REMOTE_OOB_AUTH: "1" },
  }));
  expect(manager.observe).toHaveBeenCalled();
  expect(managed.stop).not.toHaveBeenCalled();

  await runner.start({ executable: "unused", args: ["acp", "--login"], signal: new AbortController().signal });
  expect(manager.start).toHaveBeenLastCalledWith(expect.objectContaining({
    args: ["acp", "--login"], interactive: true, env: {},
  }));
});

it("stops an auxiliary probe when its sign-in prompt arrives in chunks", async () => {
  let finish!: (value: { code: number }) => void;
  const managed = Object.assign(new EventEmitter(), {
    completion: new Promise<{ code: number }>(resolve => { finish = resolve; }),
    stop: vi.fn(async () => { finish({ code: -1 }); }),
  });
  const manager = { start: vi.fn(() => managed), observe: vi.fn(async () => ({ state: "confirmed_exited" })) };
  const runner = new AgyAccountJobRunner("unused", manager as unknown as ProcessManager);
  const pending = runner.runAuxiliaryProbe({ executable: "unused", args: [],
    lease: { lease_id: "fixture", operation_id: "fixture" } as any });
  await vi.waitFor(() => expect(managed.listenerCount("stderr")).toBe(1));
  managed.emit("stderr", Buffer.from("Authentic"));
  managed.emit("stderr", Buffer.from("ation required. Please visit the URL to log in:\n"));
  await expect(pending).rejects.toMatchObject({ code: "authentication_required" });
  expect(managed.stop).toHaveBeenCalledOnce();
});
