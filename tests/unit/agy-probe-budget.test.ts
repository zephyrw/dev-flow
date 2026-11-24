import { expect, it, vi } from "vitest";
import { AgyAccountProbe, createVerifiedUsageAdapter } from "../../packages/adapters/agy/src/account-probe.js";
vi.mock("../../packages/adapters/agy/src/executable-resolver.js", () => ({ resolveFingerprintedAgyExecutable: async () => ({ resolvedPath: "C:/fixture/agy.exe", fingerprint: "fixture" }), assertAgyExecutableUnchanged: async () => {} }));
it("honors the caller's 10 second quota budget at both CLI and process host boundaries", async () => {
  const run = vi.fn(async () => ({ code: 0, stdout: "Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t99%\t6d 23h", stderr: "" }));
  const probe = new AgyAccountProbe("C:/fixture/agy.exe", createVerifiedUsageAdapter("fixture"), { runAuxiliaryProbe: run });
  const result = await probe.probeUsage({ timeoutMs: 10000 });
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 10000, args: expect.arrayContaining(["--print-timeout", "9s"]) }));
  expect(result.pools[0]).toMatchObject({ pool_id: "Gemini 4 Argon", capability_verified: true, windows: [{ kind: "weekly", remaining_fraction: .99 }] });
});

it("forces a real model check after an auth failure and discards the previous positive cache", async () => {
  const output = [
    { event: "init", init: { model: "gemini-3.8-flash" } },
    { event: "result", result: { status: "SUCCESS", response: "OK" } },
  ].map(event => JSON.stringify(event)).join("\n");
  const run = vi.fn(async () => ({ code: 0, stdout: output, stderr: "" }));
  const probe = new AgyAccountProbe("C:/fixture/agy.exe", createVerifiedUsageAdapter("fixture"), { runAuxiliaryProbe: run });
  const options = { account_id: "a", credential_revision: 1 };
  expect(await probe.probeModelAccess("gemini-3.8-flash", options)).toBe(true);
  expect(await probe.probeModelAccess("gemini-3.8-flash", options)).toBe(true);
  expect(run).toHaveBeenCalledTimes(1);
  run.mockResolvedValue({ code: 1, stdout: "", stderr: "Not logged in" });
  expect(await probe.probeModelAccess("gemini-3.8-flash", { ...options, force: true })).toBe(false);
  expect(await probe.probeModelAccess("gemini-3.8-flash", options)).toBe(false);
  expect(run).toHaveBeenCalledTimes(3);
});

it("grants at least a 30s timeout budget by default for slow CLI model catalog reads", async () => {
  const run = vi.fn(async () => ({ code: 0, stdout: "gemini-4-hydrogen-high\n", stderr: "" }));
  const probe = new AgyAccountProbe("C:/fixture/agy.exe", createVerifiedUsageAdapter("fixture"), { runAuxiliaryProbe: run });
  const models = await probe.probeModels();
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 30000, args: ["models"] }));
  expect(models.native_ids).toContain("gemini-4-hydrogen-high");
});

it("reports a headless authentication failure without returning the sign-in URL", async () => {
  const runAuxiliaryProbe = vi.fn(async () => ({
    code: 1, stdout: "", stderr: "Error: authentication required. Run 'agy' to log in. https://example.test/sign-in",
  }));
  const probe = new AgyAccountProbe("C:/fixture/agy.exe", createVerifiedUsageAdapter("fixture"), { runAuxiliaryProbe });
  await expect(probe.probeUsage()).rejects.toMatchObject({
    code: "authentication_required", message: "authentication_required",
  });
});
