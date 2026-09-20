import { describe, it, expect, vi } from "vitest";
import { AgyLoginLauncher } from "../../packages/agy-accounts/src/login.js";
import { AgyAccountProbe } from "../../packages/adapters/agy/src/account-probe.js";

describe("AGY external capability boundaries", () => {
  it("does not invent a login command when no verified owned login is installed", async () => {
    const job = { start: vi.fn() };
    const result = await new AgyLoginLauncher(job).startInteractiveLogin();
    expect(result).toMatchObject({ completed: false, fully_stopped: true, error: "interactive_login_capability_unverified" });
    expect(job.start).not.toHaveBeenCalled();
  });
  it("does not execute an arbitrary binary as a usage probe without a verified adapter", async () => {
    const probe = new AgyAccountProbe(process.execPath);
    expect(await probe.probeUsage()).toMatchObject({ capability_verified: false, pools: [], cli_version: "unknown" });
    expect(await probe.probeModelAccess("anything", { account_id: "a", credential_revision: 1 })).toBe(false);
  });
  it("honors cancellation even when capability is unavailable", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(new AgyAccountProbe(process.execPath).probeUsage({ signal: controller.signal })).rejects.toThrow();
  });
});
