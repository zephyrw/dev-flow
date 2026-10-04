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
  expect(manager.observe).toHaveBeenCalled();
  expect(managed.stop).not.toHaveBeenCalled();
});
