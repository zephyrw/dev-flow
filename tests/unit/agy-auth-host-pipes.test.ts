import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DevFlowAuthHost } from "../../packages/agy-accounts/src/auth-host.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()), spawn: mocks.spawn,
}));

function daemon() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null as number | null, killed: false,
    kill: vi.fn(() => { child.killed = true; return true; }),
  });
  const requests: Array<{ id: string; action: string }> = [];
  child.stdin.on("data", (data: Buffer) => requests.push(JSON.parse(data.toString())));
  return { child, requests };
}
function host() {
  const value = new DevFlowAuthHost("synthetic-helper-never-executed");
  vi.spyOn(value, "capabilities").mockResolvedValue({ supported: true, platform: "win32", version: "2.0.0", dpapi_available: true, cred_manager_available: true, named_mutex_available: true });
  return value;
}
async function acquire(value: DevFlowAuthHost, instance: ReturnType<typeof daemon>) {
  mocks.spawn.mockReturnValueOnce(instance.child);
  const result = value.acquireDomainLock("realm");
  await vi.waitFor(() => expect(instance.requests.length).toBe(1));
  instance.child.stdout.write(JSON.stringify({ id: instance.requests[0]!.id, ok: true, data: { acquired: true, lock_id: "synthetic-lock" } }) + "\n");
  expect((await result).acquired).toBe(true);
}
afterEach(() => vi.restoreAllMocks());
describe("AuthHost pipe loss without a real helper", () => {
  it.each(["stdin", "stdout", "stderr"] as const)("fails closed on %s errors without an unhandled event", async (pipe) => {
    const value = host(), instance = daemon();
    await acquire(value, instance);
    const lost = vi.fn(); value.onLockLost(lost);
    const pending = value.inspectActive("realm");
    const rejection = expect(pending).rejects.toThrow("auth_host_disconnected");
    expect(() => instance.child[pipe].emit("error", new Error("synthetic EPIPE"))).not.toThrow();
    await rejection;
    expect(value.isDomainLockHeld("realm")).toBe(false);
    expect(lost).toHaveBeenCalledTimes(1);
    await expect(value.captureActive("realm", "a")).rejects.toThrow("domain_lock_not_held");
  });
  it("ignores late old-daemon pipe, exit and malformed output events", async () => {
    const value = host(), old = daemon(), current = daemon();
    await acquire(value, old);
    old.child.stdin.emit("error", new Error("synthetic disconnect"));
    await acquire(value, current);
    old.child.stderr.emit("error", new Error("synthetic late error"));
    old.child.stdout.write("invalid late response\n");
    old.child.emit("exit", 1);
    expect(value.isDomainLockHeld("realm")).toBe(true);
    expect(current.child.kill).not.toHaveBeenCalled();
    current.child.stdin.emit("error", new Error("synthetic cleanup"));
  });
});
