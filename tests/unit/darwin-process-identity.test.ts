import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const kernel = vi.hoisted(() => ({ status: 5, pid: 70, fullAvailable: false, shortAvailable: true,
  errno: 0, listed: [70], listFailure: false, info: vi.fn(), list: vi.fn() }));
vi.mock("koffi", () => ({
  default: {
    errno: (value?: number) => value === undefined ? kernel.errno : (kernel.errno = value),
    load: () => ({
      func: (signature: string) => {
        return signature.includes("proc_pidinfo") ? kernel.info
          : signature.includes("proc_listpids") ? kernel.list : () => 0;
      },
    }),
  },
}));
import { darwinProcessInfo, listDarwinProcesses, observeDarwinProcessGroup } from "../../packages/process/src/native/darwin-processes.js";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const getuid = Object.getOwnPropertyDescriptor(process, "getuid");
beforeEach(() => {
  // The native ABI boundary is mocked; exercise its contract on every CI host.
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  Object.defineProperty(process, "getuid", { configurable: true, value: () => 501 });
  Object.assign(kernel, { status: 5, pid: 70, fullAvailable: false, shortAvailable: true,
    errno: 0, listed: [70], listFailure: false });
  kernel.info.mockReset().mockImplementation((_pid: number, flavor: number, arg: number, buffer: Buffer) => {
    // XNU lists zombproc, but proc_pidinfo cannot find it unless arg != 0.
    if (kernel.status === 5 && arg === 0) { kernel.errno = 3; return 0; }
    if (flavor === 3 && kernel.fullAvailable) {
      buffer.writeUInt32LE(kernel.pid, 12);
      buffer.writeUInt32LE(kernel.status, 4);
      buffer.writeUInt32LE(501, 20);
      buffer.writeUInt32LE(70, 100);
      buffer.writeBigUInt64LE(100n, 120);
      buffer.writeBigUInt64LE(123n, 128);
      return buffer.length;
    }
    if (flavor === 13 && kernel.shortAvailable) {
      buffer.writeUInt32LE(kernel.pid, 0);
      buffer.writeUInt32LE(70, 8);
      buffer.writeUInt32LE(kernel.status, 12);
      return buffer.length;
    }
    kernel.errno = 1;
    return 0;
  });
  kernel.list.mockReset().mockImplementation((_type: number, _uid: number, buffer: Buffer | null) => {
    if (kernel.listFailure) { kernel.errno = 1; return 0; }
    if (!buffer) return (kernel.listed.length + 20) * 4;
    kernel.listed.forEach((pid, index) => buffer.writeInt32LE(pid, index * 4));
    return kernel.listed.length * 4;
  });
  vi.spyOn(process, "kill").mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
  if (getuid) Object.defineProperty(process, "getuid", getuid);
  else Reflect.deleteProperty(process, "getuid");
});
describe("macOS kernel process identity contract", () => {
  it("requests listed zombies and ignores only kernel-confirmed zombie state", () => {
    expect(kernel.info(70, 13, 0, Buffer.alloc(64))).toBe(0);
    expect(listDarwinProcesses()).toEqual([]);
    expect(kernel.info).toHaveBeenCalledWith(70, 3, 1, expect.any(Buffer), 136);
    expect(kernel.info).toHaveBeenCalledWith(70, 13, 1, expect.any(Buffer), 64);
    expect(process.kill).not.toHaveBeenCalled();
  });
  it("accepts full kernel birth identity for a live process and ignores a full-record zombie", () => {
    kernel.fullAvailable = true;
    kernel.status = 2;
    expect(darwinProcessInfo(70)).toMatchObject({ pid: 70, uid: 501, pgid: 70, creation_time: "100:123" });
    kernel.status = 5;
    expect(darwinProcessInfo(70)).toBeUndefined();
  });
  it("keeps the whole inventory unconfirmed if a live process lacks birth identity", () => {
    kernel.status = 2;
    expect(() => listDarwinProcesses()).toThrow("PROCESS_IDENTITY_UNKNOWN");
    try { darwinProcessInfo(70); } catch (error) {
      expect(error).toMatchObject({ code: "DARWIN_PROCESS_QUERY_FAILED", reason: "bsd_read_unconfirmed",
        facts: { pid: 70, flavor: 3, arg: 1, errno: 1, short_flavor: 13, status: 2 } });
    }
  });
  it("rejects a reused or mismatched PID even if the returned short record is a zombie", () => {
    kernel.pid = 71;
    expect(() => darwinProcessInfo(70)).toThrow("PROCESS_IDENTITY_UNKNOWN");
    kernel.fullAvailable = true;
    expect(() => darwinProcessInfo(70)).toThrow("PROCESS_IDENTITY_UNKNOWN");
  });
  it("skips a PID that disappears between enumeration and lookup only after ESRCH", () => {
    kernel.shortAvailable = false;
    vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    expect(listDarwinProcesses()).toEqual([]);
    vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
    expect(() => listDarwinProcesses()).toThrow("PROCESS_IDENTITY_UNKNOWN");
  });
  it("preserves inventory query failure facts and refuses failed enumeration", () => {
    kernel.listFailure = true;
    expect(() => listDarwinProcesses()).toThrow("PROCESS_INVENTORY_UNKNOWN");
    try { listDarwinProcesses(); } catch (error) {
      expect(error).toMatchObject({ code: "DARWIN_PROCESS_QUERY_FAILED", reason: "inventory_size_failed",
        facts: { type: 4, typeinfo: 501, errno: 1, size: 0 } });
    }
  });
  it("observes the complete requested process group independently of same-user inventory", () => {
    kernel.listed = [70, 71, 72];
    kernel.info.mockImplementation((pid: number, flavor: number, arg: number, buffer: Buffer) => {
      expect(flavor).toBe(13);
      expect(arg).toBe(1);
      if (pid === 72) return 0;
      buffer.writeUInt32LE(pid, 0);
      buffer.writeUInt32LE(70, 8);
      buffer.writeUInt32LE(pid === 70 ? 2 : 5, 12);
      return buffer.length;
    });
    expect(observeDarwinProcessGroup(70)).toEqual({ listed: 3, live: 1, zombie: 1, unknown: 1,
      complete: false, reason: "group_observed" });
    expect(kernel.list.mock.calls.every(([type, typeinfo]) => type === 2 && typeinfo === 70)).toBe(true);
  });
  it("never presents failed group enumeration or an unreadable member as complete", () => {
    kernel.listFailure = true;
    expect(observeDarwinProcessGroup(70)).toMatchObject({ complete: false, reason: "group_size_failed", errno: 1 });
    kernel.listFailure = false;
    kernel.pid = 71;
    expect(observeDarwinProcessGroup(70)).toMatchObject({ complete: false, unknown: 1 });
  });
});
