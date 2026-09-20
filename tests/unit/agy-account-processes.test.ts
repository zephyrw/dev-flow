import { describe, expect, it, vi } from "vitest";
import { AgyAccountProcessHost } from "../../packages/process/src/agy-account-processes.js";
import type { Store } from "../../packages/store/src/store.js";
import type { ProcessManager } from "../../packages/process/src/manager.js";

function fixture(actualPid?: number) {
  const stop = vi.fn(async () => {});
  const host = new AgyAccountProcessHost({
    store: {
      list: () => [
        {
          id: "run-1",
          pid: 123,
          agy_account: {
            realm_id: "default-agy-realm",
            account_id: "a",
            auth_epoch: 1,
            permit_id: "p",
          },
        },
      ],
    } as unknown as Store,
    hostExecutable: "unused-test-host",
    agyExecutable: "unused-agy",
    processManager: {
      get: () => (actualPid ? { pid: actualPid } : undefined),
      stop,
    } as unknown as ProcessManager,
  });
  return { host, stop };
}
describe("AGY owned process boundary", () => {
  it("never kills a reused PID or an unowned process", async () => {
    const { host, stop } = fixture(456);
    expect(await host.stopProcess(123, "account_switch")).toBe(false);
    expect(await host.stopProcess(999, "account_switch")).toBe(false);
    expect(stop).not.toHaveBeenCalled();
  });
  it("does not equate root completion with an empty Job", async () => {
    const { host, stop } = fixture(123);
    vi.spyOn(host, "confirmJobsStopped").mockResolvedValue(false);
    expect(await host.stopProcess(123, "account_switch")).toBe(false);
    expect(stop).toHaveBeenCalledWith("run-1", "account_switch");
    expect(await host.confirmProcessesStopped([123], 500)).toBe(false);
  });
  it("fails closed when no persisted ownership exists for confirmation", async () => {
    const { host } = fixture();
    const confirm = vi
      .spyOn(host, "confirmJobsStopped")
      .mockResolvedValue(true);
    expect(await host.confirmProcessesStopped([999], 500)).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });
});
