import { afterEach, describe, expect, it, vi } from "vitest";
import { AgyAccountProbe, createVerifiedUsageAdapter } from "../../packages/adapters/agy/src/account-probe.js";

const executable = vi.hoisted(() => ({ fingerprint: "cli-v1", resolvedPath: "C:/fixture/agy.exe" }));
vi.mock("../../packages/adapters/agy/src/executable-resolver.js", () => ({
  resolveAgyExecutable: () => executable,
}));

const model = "gemini-3.8-flash-high";
const identity = { account_id: "account-a", credential_revision: 1 };
const success = {
  code: 0,
  stdout: [
    JSON.stringify({ event: "init", init: { model } }),
    JSON.stringify({ event: "result", result: { status: "SUCCESS" } }),
  ].join("\n"),
  stderr: "",
};
function fixture() {
  const runAuxiliaryProbe = vi.fn(async (_options: any) => success);
  const adapter = createVerifiedUsageAdapter("cli-v1", "1.2.12");
  const probe = new AgyAccountProbe(executable.resolvedPath, adapter, { runAuxiliaryProbe });
  return { probe, adapter, runAuxiliaryProbe };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
afterEach(() => { vi.restoreAllMocks(); executable.fingerprint = "cli-v1"; });

describe("AGY model access probe cache and shared calls", () => {
  it("records only confirmed success and rechecks after the existing 24h TTL", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(100_000);
    const f = fixture();
    expect(await f.probe.probeModelAccess(model, identity)).toBe(true);
    clock.mockReturnValue(100_000 + 86_400_000 - 1);
    expect(await f.probe.probeModelAccess(model, identity)).toBe(true);
    expect(f.runAuxiliaryProbe).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(100_000 + 86_400_000);
    expect(await f.probe.probeModelAccess(model, identity)).toBe(true);
    expect(f.runAuxiliaryProbe).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ...success, code: 1 },
    { ...success, stdout: "not-json" },
    { ...success, stdout: success.stdout.replace("SUCCESS", "ERROR") },
    { ...success, stdout: success.stdout.replace(model, "other-model") },
    { ...success, stdout: JSON.stringify({ event: "init", init: { model } }) },
  ])("does not cache an unsuccessful or unproven response %#", async (result) => {
    const f = fixture();
    f.runAuxiliaryProbe.mockResolvedValueOnce(result);
    expect(await f.probe.probeModelAccess(model, identity)).toBe(false);
    expect(await f.probe.probeModelAccess(model, identity)).toBe(true);
    expect(f.runAuxiliaryProbe).toHaveBeenCalledTimes(2);
  });

  it("does not share success across accounts, revisions, models or executable fingerprints", async () => {
    const f = fixture();
    await f.probe.probeModelAccess(model, identity);
    await f.probe.probeModelAccess(model, { ...identity, account_id: "account-b" });
    await f.probe.probeModelAccess(model, { ...identity, credential_revision: 2 });
    expect(await f.probe.probeModelAccess("other-model", identity)).toBe(false);
    executable.fingerprint = "cli-v2";
    expect(await f.probe.probeModelAccess(model, identity)).toBe(false); // unverified binary
    f.adapter.executable_fingerprint = "cli-v2";
    await f.probe.probeModelAccess(model, identity);
    expect(f.runAuxiliaryProbe).toHaveBeenCalledTimes(5);
  });

  it("joins concurrent callers and releases its lock after completion", async () => {
    const f = fixture(), pending = deferred<typeof success>();
    f.runAuxiliaryProbe.mockReturnValueOnce(pending.promise);
    const first = f.probe.probeModelAccess(model, identity);
    const second = f.probe.probeModelAccess(model, identity);
    await vi.waitFor(() => expect(f.runAuxiliaryProbe).toHaveBeenCalledTimes(1));
    await expect(f.probe.probeModelAccess(model, { ...identity, account_id: "b" })).rejects.toThrow("probe_identity_busy");
    await expect(f.probe.probeUsage(identity)).rejects.toThrow("probe_identity_busy");
    await expect(f.probe.probeIdentity(identity)).rejects.toThrow("probe_identity_busy");
    pending.resolve(success);
    expect(await Promise.all([first, second])).toEqual([true, true]);
    await f.probe.probeModelAccess(model, { ...identity, account_id: "b" });
    expect(f.runAuxiliaryProbe).toHaveBeenCalledTimes(2);
  });

  it("cancelling one caller leaves the shared probe available to the other caller", async () => {
    const f = fixture(), pending = deferred<typeof success>(), controller = new AbortController();
    f.runAuxiliaryProbe.mockReturnValueOnce(pending.promise);
    const first = f.probe.probeModelAccess(model, { ...identity, signal: controller.signal });
    const cancelled = expect(first).rejects.toThrow("first cancelled");
    const second = f.probe.probeModelAccess(model, identity);
    await vi.waitFor(() => expect(f.runAuxiliaryProbe).toHaveBeenCalledTimes(1));
    controller.abort(new Error("first cancelled"));
    await cancelled;
    expect(f.runAuxiliaryProbe.mock.calls[0]![0].signal.aborted).toBe(false);
    pending.resolve(success);
    expect(await second).toBe(true);
    await f.probe.probeModelAccess(model, identity);
    expect(f.runAuxiliaryProbe).toHaveBeenCalledTimes(1);
  });

  it("stops after all callers cancel, retains the lock until exit and never caches late success", async () => {
    const f = fixture(), pending = deferred<typeof success>(), controller = new AbortController();
    f.runAuxiliaryProbe.mockReturnValueOnce(pending.promise);
    const first = f.probe.probeModelAccess(model, { ...identity, signal: controller.signal });
    const cancelled = expect(first).rejects.toThrow();
    await vi.waitFor(() => expect(f.runAuxiliaryProbe).toHaveBeenCalledTimes(1));
    controller.abort();
    await cancelled;
    expect(f.runAuxiliaryProbe.mock.calls[0]![0].signal.aborted).toBe(true);
    await expect(f.probe.probeModelAccess(model, identity)).rejects.toThrow("probe_identity_busy");
    pending.resolve(success);
    await vi.waitFor(() => expect((f.probe as any).modelAccessFlight).toBeUndefined());
    expect(await f.probe.probeModelAccess(model, identity)).toBe(true);
    expect(f.runAuxiliaryProbe).toHaveBeenCalledTimes(2);
  });

  it("clears failures and does not start or reuse cached success for an aborted caller", async () => {
    const f = fixture();
    f.runAuxiliaryProbe.mockRejectedValueOnce(new Error("timeout"));
    await expect(f.probe.probeModelAccess(model, identity)).rejects.toThrow("timeout");
    expect(await f.probe.probeModelAccess(model, identity)).toBe(true);
    const controller = new AbortController(); controller.abort();
    await expect(f.probe.probeModelAccess(model, { ...identity, signal: controller.signal })).rejects.toThrow();
    expect(f.runAuxiliaryProbe).toHaveBeenCalledTimes(2);
  });

  it.each(["probeUsage", "probeIdentity"] as const)("does not overlap an active %s", async (method) => {
    const f = fixture(), pending = deferred<typeof success>();
    f.runAuxiliaryProbe.mockReturnValueOnce(pending.promise);
    const other = f.probe[method](identity).catch(() => undefined);
    await vi.waitFor(() => expect(f.runAuxiliaryProbe).toHaveBeenCalledTimes(1));
    await expect(f.probe.probeModelAccess(model, identity)).rejects.toThrow("probe_identity_busy");
    pending.resolve(success);
    await other;
    expect(await f.probe.probeModelAccess(model, identity)).toBe(true);
    expect(f.runAuxiliaryProbe).toHaveBeenCalledTimes(2);
  });
});
