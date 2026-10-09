import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DarwinProcessInfo } from "../../packages/process/src/native/darwin-processes.js";
const fixture = vi.hoisted(() => ({
  list: vi.fn(),
  info: vi.fn(),
  path: vi.fn(),
}));
vi.mock("../../packages/process/src/native/darwin-processes.js", () => ({
  listDarwinProcesses: fixture.list,
  darwinProcessInfo: fixture.info,
  darwinProcessPath: fixture.path,
}));
vi.mock("../../packages/process/src/native/index.js", () => ({
  getNativeAsync: async () => ({}),
}));
import { AgyAccountProcessHost } from "../../packages/process/src/agy-account-processes.js";
import type { ProcessManager } from "../../packages/process/src/manager.js";
import type { Store } from "../../packages/store/src/store.js";
const uid = process.getuid?.() ?? 501;
const info = (pid: number, pgid: number): DarwinProcessInfo => ({
  pid,
  pgid,
  parent: 1,
  uid,
  name: "agy",
  creation_time: "100:" + pid,
  create_time: 100000 + pid / 1000,
});
function host(owned = false) {
  const identity = {
    backend: "node-v1",
    id: "run",
    attempt_id: "attempt",
    pgid: 60,
    launcher_pid: 60,
    launcher_creation_time: "100:60",
  };
  const record = {
    id: "run",
    pid: 77,
    status: "running",
    identity,
    agy_account: { realm_id: "realm", account_id: "account" },
  };
  const manager = { get: () => ({ identity, pid: 77 }) };
  return new AgyAccountProcessHost({
    store: { list: () => (owned ? [record] : []) } as unknown as Store,
    agyExecutable: "/tmp/agy",
    processManager: manager as unknown as ProcessManager,
  });
}
describe.skipIf(process.platform !== "darwin")(
  "macOS AGY external process inventory",
  () => {
    beforeEach(() => {
      fixture.list.mockReset();
      fixture.info.mockReset();
      fixture.path.mockReset();
      fixture.list.mockReturnValue([
        info(77, 60),
        info(78, 70),
        { ...info(79, 80), uid: uid + 1 },
      ]);
      fixture.info.mockImplementation((pid) =>
        info(pid, pid === 77 ? 60 : pid === 78 ? 70 : 60),
      );
      fixture.path.mockReturnValue("/tmp/agy");
    });
    it("reports only same-user external AGY processes and excludes the owned group", async () => {
      expect(
        (await host(true).findExternalAgyProcesses()).map((row) => row.pid),
      ).toEqual([78]);
      expect(
        (await host().findExternalAgyProcesses()).map((row) => row.pid),
      ).toEqual([77, 78]);
    });
    it("blocks switching when the owned group leader PID was reused", async () => {
      fixture.info.mockImplementation((pid) =>
        pid === 60
          ? { ...info(60, 60), creation_time: "new" }
          : info(pid, pid === 77 ? 60 : 70),
      );
      await expect(host(true).findExternalAgyProcesses()).rejects.toThrow(
        "AGY_MANAGED_PROCESS_IDENTITY_UNKNOWN",
      );
    });
    it("ignores a disappeared PID but rejects a live inaccessible or reused candidate", async () => {
      fixture.path.mockImplementation((pid) => {
        if (pid === 77) throw Error("denied");
        return "/tmp/agy";
      });
      fixture.info.mockImplementation((pid) =>
        pid === 77 ? undefined : info(pid, 70),
      );
      expect(
        (await host().findExternalAgyProcesses()).map((row) => row.pid),
      ).toEqual([78]);
      fixture.info.mockImplementation((pid) => info(pid, 60));
      await expect(host().findExternalAgyProcesses()).rejects.toThrow("denied");
      fixture.path.mockReturnValue("/tmp/agy");
      fixture.info.mockReturnValue({
        ...info(77, 60),
        creation_time: "reused",
      });
      await expect(host().findExternalAgyProcesses()).rejects.toThrow(
        "AGY_PROCESS_IDENTITY_UNKNOWN",
      );
    });
  },
);
