import { EventEmitter } from "node:events";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessSpec } from "../../packages/process/src/manager.js";
import { DevFlowAuthHost } from "../../packages/agy-accounts/src/auth-host.js";

const mocks = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("../../packages/process/src/manager.js", () => ({
  ProcessManager: class {
    start(spec: ProcessSpec) {
      return mocks.start(spec);
    }
    async close() {}
  },
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    existsSync: (path: string) =>
      String(path).endsWith("credential-worker.js") || fs.existsSync(path),
  };
});
type Request = { id: string; action: string; generation: string };
function daemon() {
  let resolveCompletion!: (value: { code: number }) => void;
  const requests: Request[] = [];
  const child = Object.assign(new EventEmitter(), {
    id: "synthetic-managed-worker",
    ready: Promise.resolve(),
    completion: new Promise<{ code: number }>((resolve) => {
      resolveCompletion = resolve;
    }),
    writeStdin: vi.fn((line: string) => requests.push(JSON.parse(line))),
    endStdin: vi.fn(),
    stop: vi.fn(async () => {
      resolveCompletion({ code: -1 });
    }),
  });
  return { child, requests, generation: "" };
}
function reply(
  instance: ReturnType<typeof daemon>,
  index: number,
  data: unknown,
) {
  instance.child.emit(
    "stdout",
    Buffer.from(
      JSON.stringify({
        id: instance.requests[index]!.id,
        generation: instance.generation,
        ok: true,
        data,
      }) + "\n",
    ),
  );
}
async function acquire(
  value: DevFlowAuthHost,
  instance: ReturnType<typeof daemon>,
) {
  mocks.start.mockImplementationOnce((spec: ProcessSpec) => {
    instance.generation = spec.args
      .find((arg) => arg.startsWith("--generation="))!
      .slice(13);
    queueMicrotask(() =>
      instance.child.emit(
        "stdout",
        Buffer.from(
          JSON.stringify({
            id: "ready",
            generation: instance.generation,
            ok: true,
            data: { version: "3.0.0-node", pid: 123 },
          }) + "\n",
        ),
      ),
    );
    return instance.child;
  });
  const result = value.acquireDomainLock("realm");
  await vi.waitFor(() => expect(instance.requests.length).toBe(1));
  reply(instance, 0, {
    acquired: true,
    lock_id: "11111111-1111-4111-8111-111111111111",
  });
  const lock = await result;
  expect(lock.acquired).toBe(true);
  return lock;
}
beforeEach(() => {
  vi.stubGlobal(
    "process",
    Object.create(process, { platform: { value: "win32" } }),
  );
  mocks.start.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("AuthHost managed channel loss without a real credential worker", () => {
  it("invalidates the lock and rejects pending RPCs on channel failure", async () => {
    const value = new DevFlowAuthHost(),
      instance = daemon();
    await acquire(value, instance);
    const lost = vi.fn();
    value.onLockLost(lost);
    const pending = value.inspectActive("realm");
    const rejection = expect(pending).rejects.toThrow("auth_host_disconnected");
    expect(() => instance.child.emit("channel_error")).not.toThrow();
    await rejection;
    expect(value.isDomainLockHeld("realm")).toBe(false);
    expect(lost).toHaveBeenCalledTimes(1);
    await expect(value.captureActive("realm", "a")).rejects.toThrow(
      "domain_lock_not_held",
    );
    expect(instance.child.stop).toHaveBeenCalledTimes(1);
    await value.close();
  });
  it("ignores late output and channel failures from a previous generation", async () => {
    const value = new DevFlowAuthHost(),
      old = daemon(),
      current = daemon();
    await acquire(value, old);
    old.child.emit("channel_error");
    await acquire(value, current);
    old.child.emit("channel_error");
    old.child.emit("stdout", Buffer.from("invalid late response\n"));
    expect(value.isDomainLockHeld("realm")).toBe(true);
    expect(current.child.stop).not.toHaveBeenCalled();
    await value.close();
  });
  it("settles concurrent capability requests when releasing the owner", async () => {
    const value = new DevFlowAuthHost(),
      instance = daemon();
    const lock = await acquire(value, instance);
    const released = lock.release();
    const capability = value.capabilities();
    await vi.waitFor(() => expect(instance.requests.length).toBe(3));
    reply(instance, 1, {});
    await released;
    expect((await capability).supported).toBe(false);
    expect(value.isDomainLockHeld("realm")).toBe(false);
    await value.close();
  });
});
