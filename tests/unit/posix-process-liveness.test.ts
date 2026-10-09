import { afterEach, describe, expect, it, vi } from "vitest";
import { isProcessAlive, isProcessGroupAlive } from "../../packages/process/src/native/posix.js";

afterEach(() => vi.restoreAllMocks());

describe("POSIX signal-zero liveness", () => {
  it("keeps polling an EPERM group until it reports ESRCH", () => {
    const kill = vi.spyOn(process, "kill")
      .mockImplementationOnce(() => { throw Object.assign(new Error("kill"), { code: "EPERM" }); })
      .mockImplementationOnce(() => { throw Object.assign(new Error("kill"), { code: "ESRCH" }); });
    expect(isProcessGroupAlive(12345)).toBe(true);
    expect(isProcessGroupAlive(12345)).toBe(false);
    expect(kill).toHaveBeenCalledWith(-12345, 0);
  });

  it("preserves unexpected syscall errors and rejects unsafe group IDs", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("kill"), { code: "EINVAL" });
    });
    expect(() => isProcessAlive(12345)).toThrow("kill");
    expect(() => isProcessGroupAlive(1)).toThrow("INVALID_PROCESS_GROUP");
  });
});
