/**
 * POSIX native interface module.
 *
 * Used only on non-Windows platforms. Implements flock-equivalent exclusive
 * advisory locking and process-group helpers with Node built-in modules only
 * (no koffi, no native addons).
 *
 * Lock model (maps to flock(LOCK_EX | LOCK_NB)):
 * - Acquire is an atomic exclusive open (O_CREAT | O_EXCL) on a dedicated
 *   lock file; the returned fd must stay open while the lock is held.
 * - Release closes the fd first, then removes the lock file. Never delete and
 *   recreate the lock file while holding it — a new inode would be a second
 *   independent lock.
 * - ESRCH on kill means the target is already gone (not a kill failure).
 * - EPERM is a real failure and must be reported.
 */

import {
  closeSync,
  constants as fsConstants,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";

type FsConstantsWithLockFlags = typeof fsConstants & {
  LOCK_SH?: number;
  LOCK_EX?: number;
  LOCK_NB?: number;
  LOCK_UN?: number;
};

const lockFlags = fsConstants as FsConstantsWithLockFlags;

/**
 * flock(2) operation flags from <sys/file.h>.
 * Node's fs.constants does not export these today; prefer them when present
 * and otherwise use the POSIX numeric values.
 */
export const LOCK_SH: number = lockFlags.LOCK_SH ?? 1;
export const LOCK_EX: number = lockFlags.LOCK_EX ?? 2;
export const LOCK_NB: number = lockFlags.LOCK_NB ?? 4;
export const LOCK_UN: number = lockFlags.LOCK_UN ?? 8;

/** Combined operation used by acquireFlock / tryAcquireFlock. */
export const LOCK_EX_NB: number = LOCK_EX | LOCK_NB;

export type FlockHandle = {
  /** Open file descriptor held while the lock is held. */
  fd: number;
  /** Absolute or caller-supplied lock file path. */
  path: string;
};

export type KillProcessGroupResult = {
  success: boolean;
  error?: string;
};

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as NodeJS.ErrnoException).code === "string"
  );
}

function errnoCode(error: unknown): string | undefined {
  return isErrnoException(error) ? error.code : undefined;
}

/**
 * Exclusive non-blocking lock acquisition.
 * Mirrors flock(fd, LOCK_EX | LOCK_NB): one holder per lock path.
 */
function openExclusiveLock(path: string): number {
  return openSync(
    path,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR,
    0o644,
  );
}

function writeHolderPid(fd: number): void {
  try {
    writeSync(fd, `${process.pid}\n`);
  } catch {
    // Holder pid is diagnostic only; lock ownership does not depend on it.
  }
}

function readHolderPid(path: string): number | null {
  try {
    const text = readFileSync(path, "utf8").trim();
    if (!/^\d+$/.test(text)) return null;
    const pid = Number(text);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort stale takeover when the previous holder is gone.
 * Only called when the path already exists; never while this process holds it.
 */
function tryClearStaleLock(path: string): boolean {
  const pid = readHolderPid(path);
  if (pid === null) return false;
  if (isProcessAlive(pid)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Non-blocking exclusive lock attempt.
 * @returns handle when acquired; null when the lock is busy.
 */
export function tryAcquireFlock(path: string): FlockHandle | null {
  const attempt = (): FlockHandle | null => {
    try {
      const fd = openExclusiveLock(path);
      writeHolderPid(fd);
      return { fd, path };
    } catch (error) {
      if (errnoCode(error) === "EEXIST") return null;
      throw error;
    }
  };

  const acquired = attempt();
  if (acquired) return acquired;
  if (!tryClearStaleLock(path)) return null;
  return attempt();
}

/**
 * Acquire an exclusive non-blocking lock (LOCK_EX | LOCK_NB).
 * @throws Error with code EAGAIN when the lock is already held.
 */
export function acquireFlock(path: string): FlockHandle {
  const handle = tryAcquireFlock(path);
  if (handle) return handle;
  const error = new Error(`flock busy: ${path}`) as NodeJS.ErrnoException;
  error.code = "EAGAIN";
  throw error;
}

/**
 * Release the lock and close the held fd.
 * Close before unlink so the lock path is never replaced while the old fd is
 * still open (different inode would form a second lock).
 */
export function releaseFlock(handle: FlockHandle): void {
  try {
    closeSync(handle.fd);
  } catch {
    // Already closed.
  }
  try {
    unlinkSync(handle.path);
  } catch {
    // Already removed.
  }
}

/**
 * True when a process id exists (signal 0 probe).
 * ESRCH → gone. EPERM → exists but not signalable by us.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (errnoCode(error) === "ESRCH") return false;
    return true;
  }
}

/**
 * Signal an entire POSIX process group.
 * ESRCH is success (the group is already gone). EPERM is a reported error.
 */
export function killProcessGroup(
  pgid: number,
  signal: number,
): KillProcessGroupResult {
  if (!Number.isInteger(pgid) || pgid <= 0) {
    return { success: false, error: `invalid pgid: ${pgid}` };
  }
  try {
    // Negative pid addresses the process group on POSIX.
    process.kill(-pgid, signal);
    return { success: true };
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ESRCH") {
      // Target process group no longer exists — not an error for kill.
      return { success: true };
    }
    if (code === "EPERM") {
      return { success: false, error: "EPERM" };
    }
    return {
      success: false,
      error: code ?? (error instanceof Error ? error.message : String(error)),
    };
  }
}

/**
 * Factory compatible with native/index.ts getNative() which expects
 * `require('./posix.js').createPosixNative()`.
 */
export function createPosixNative() {
  return {
    acquireFlock,
    releaseFlock,
    tryAcquireFlock,
    isProcessAlive,
    killProcessGroup,
  };
}
