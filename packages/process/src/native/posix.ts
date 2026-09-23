import koffi from "koffi";
import { closeSync, constants, openSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

export const LOCK_SH = 1,
  LOCK_EX = 2,
  LOCK_NB = 4,
  LOCK_UN = 8;
export const LOCK_EX_NB = LOCK_EX | LOCK_NB;
export type FlockHandle = { fd: number; path: string };
let flock: ((fd: number, operation: number) => number) | undefined;
const held = new Set<FlockHandle>();
function lockCall(fd: number, operation: number) {
  if (process.platform === "win32") throw new Error("FLOCK_UNSUPPORTED");
  flock ??= koffi
    .load(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6")
    .func("flock", "int", ["int", "int"]);
  return flock(fd, operation);
}
export function tryAcquireFlock(path: string): FlockHandle | null {
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR, 0o600);
  try {
    if (lockCall(fd, LOCK_EX_NB) !== 0) {
      const errno = koffi.errno();
      if (errno === 11 || errno === 35) {
        closeSync(fd);
        return null;
      }
      throw new Error(`FLOCK_FAILED:${errno}`);
    }
    const handle = { fd, path };
    held.add(handle);
    return handle;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
export function acquireFlock(path: string): FlockHandle {
  const handle = tryAcquireFlock(path);
  if (!handle)
    throw Object.assign(new Error("CONTROLLER_ALREADY_ACTIVE"), {
      code: "EAGAIN",
    });
  return handle;
}
export function releaseFlock(handle: FlockHandle): void {
  if (!held.delete(handle)) return;
  try {
    lockCall(handle.fd, LOCK_UN);
  } finally {
    closeSync(handle.fd);
  }
}
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
export function isProcessGroupAlive(pgid: number): boolean {
  if (!Number.isSafeInteger(pgid) || pgid <= 1)
    throw new Error("INVALID_PROCESS_GROUP");
  return isProcessAlive(-pgid);
}
export function getProcessCreationTime(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("INVALID_PID");
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      if (!start || !/^\d+$/.test(start))
        throw new Error("PROCESS_IDENTITY_INVALID");
      return (
        readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() +
        ":" +
        start
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  try {
    const start = execFileSync(
      "/bin/ps",
      ["-p", String(pid), "-o", "lstart="],
      {
        encoding: "utf8",
        timeout: 3000,
        env: { ...process.env, LC_ALL: "C" },
      },
    ).trim();
    return start || null;
  } catch (error) {
    if (!isProcessAlive(pid)) return null;
    throw error;
  }
}
export function killProcessGroup(
  pgid: number,
  signal: number | NodeJS.Signals,
): { success: boolean; error?: string } {
  if (!Number.isSafeInteger(pgid) || pgid <= 1)
    return { success: false, error: "INVALID_PROCESS_GROUP" };
  try {
    process.kill(-pgid, signal);
    return { success: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH"
      ? { success: true }
      : { success: false, error: code ?? "PROCESS_SIGNAL_FAILED" };
  }
}
export function createPosixNative() {
  return {
    acquireFlock,
    releaseFlock,
    tryAcquireFlock,
    isProcessAlive,
    isProcessGroupAlive,
    getProcessCreationTime,
    killProcessGroup,
  };
}
