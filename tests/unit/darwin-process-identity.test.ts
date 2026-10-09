import { afterEach, describe, expect, it, vi } from "vitest";
const kernel = vi.hoisted(() => ({ status: 5, pid: 70, shortAvailable: true }));
vi.mock("koffi", () => ({
  default: {
    load: () => ({
      func: (signature: string) => {
        if (!signature.includes("proc_pidinfo")) return () => 0;
        return (_pid: number, flavor: number, _arg: number, buffer: Buffer) => {
          if (flavor !== 13 || !kernel.shortAvailable) return 0;
          buffer.writeUInt32LE(kernel.pid, 0);
          buffer.writeUInt32LE(kernel.status, 12);
          return buffer.length;
        };
      },
    }),
  },
}));
import { darwinProcessInfo } from "../../packages/process/src/native/darwin-processes.js";
afterEach(() => vi.restoreAllMocks());
describe.skipIf(process.platform !== "darwin")(
  "macOS inaccessible process identity",
  () => {
    it("ignores only a kernel-confirmed zombie, retaining fail-closed behavior for live, unknown or reused PIDs", () => {
      vi.spyOn(process, "kill").mockReturnValue(true);
      expect(darwinProcessInfo(70)).toBeUndefined();
      kernel.status = 2;
      expect(() => darwinProcessInfo(70)).toThrow("PROCESS_IDENTITY_UNKNOWN");
      kernel.status = 5;
      kernel.pid = 71;
      expect(() => darwinProcessInfo(70)).toThrow("PROCESS_IDENTITY_UNKNOWN");
      kernel.pid = 70;
      kernel.shortAvailable = false;
      expect(() => darwinProcessInfo(70)).toThrow("PROCESS_IDENTITY_UNKNOWN");
    });
  },
);
