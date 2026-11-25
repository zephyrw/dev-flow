import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgyAccountProcessHost } from "../../packages/process/src/agy-account-processes.js";
import type { Store } from "../../packages/store/src/store.js";

const mockNative = vi.hoisted(() => ({
  listProcessInventory: vi.fn(),
  openJob: vi.fn(() => null),
  isProcessInJob: vi.fn(() => false),
  closeHandle: vi.fn(),
}));

vi.mock("../../packages/process/src/native/index.js", () => ({
  getNativeAsync: async () => mockNative,
}));

function makeHost() {
  const store = { list: vi.fn(() => []) } as unknown as Store;
  return new AgyAccountProcessHost({ store, agyExecutable: "C:/fixture/agy.exe" });
}

describe.skipIf(process.platform !== "win32")("AGY native Toolhelp32 process inventory", () => {
  beforeEach(() => {
    mockNative.listProcessInventory.mockReset();
  });

  it("queries normalized target process names once without spawning PowerShell", async () => {
    mockNative.listProcessInventory.mockReturnValue([
      { pid: 34037, parent: 1, name: "agy.exe", exe_path: "C:/fixture/agy.exe", sid: "S-1-5-21-test" },
    ]);
    const host = makeHost();
    const external = await host.findExternalAgyProcesses();
    expect(mockNative.listProcessInventory).toHaveBeenCalledTimes(1);
    const names = mockNative.listProcessInventory.mock.calls[0]?.[0] as string[];
    expect(names).toEqual(expect.arrayContaining(["agy", "agy.exe", "antigravity.exe"]));
    expect(external).toHaveLength(1);
    expect(external[0]?.pid).toBe(34037);
  });

  it("propagates native inventory errors instead of hiding live access failures", async () => {
    mockNative.listProcessInventory.mockImplementation(() => {
      throw new Error("Access denied");
    });
    const host = makeHost();
    await expect(host.findExternalAgyProcesses()).rejects.toThrow("Access denied");
  });

  it("rejects live matching external process without resolvable exe_path", async () => {
    mockNative.listProcessInventory.mockReturnValue([
      { pid: 34038, parent: 1, name: "agy.exe", exe_path: "", sid: "S-1-5-21-test" },
    ]);
    const host = makeHost();
    await expect(host.findExternalAgyProcesses()).rejects.toThrow("AGY_EXTERNAL_PROCESS_PATH_UNKNOWN");
  });
});
