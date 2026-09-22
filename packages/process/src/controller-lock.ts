import { resolve } from "node:path";
import { hash } from "../../core/src/util.js";

/**
 * Acquire an in-process controller lock for the given root directory.
 *
 * Platform behaviour:
 * - Windows: named Mutex `Local\DevFlow.<hash>` via koffi Win32 API
 * - POSIX:   exclusive flock file at `<root>/.devflow-controller.lock`
 *
 * @returns A release function (idempotent) that frees the lock when called.
 */
export async function acquireControllerLock(
  root: string,
): Promise<() => Promise<void>> {
  const lockHash = hash(resolve(root).toLowerCase());

  if (process.platform === "win32") {
    return acquireWindowsLock(lockHash);
  }
  return acquirePosixLock(resolve(root, ".devflow-controller.lock"));
}

// ── Windows ─────────────────────────────────────────────────────────────────

async function acquireWindowsLock(
  lockHash: string,
): Promise<() => Promise<void>> {
  // Dynamic require to avoid loading koffi on POSIX
  const { getNative } = require("./native/index.js") as typeof import("./native/index.js");
  const native = getNative();

  const mutexName = `Local\\DevFlow.${lockHash}`;
  const mutex = native.createMutex!(mutexName, true);
  if (!mutex) {
    throw new Error(`Failed to create controller mutex: ${mutexName}`);
  }

  const result = native.waitForMutex!(mutex, 10_000);
  if (result !== "acquired") {
    native.closeHandle!(mutex);
    if (result === "timeout") {
      throw new Error(
        `Controller lock timeout after 10s: ${mutexName}`,
      );
    }
    throw new Error(
      `Controller lock failed (${result}): ${mutexName}`,
    );
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    native.releaseMutex!(mutex);
    native.closeHandle!(mutex);
  };
}

// ── POSIX ───────────────────────────────────────────────────────────────────

async function acquirePosixLock(
  lockPath: string,
): Promise<() => Promise<void>> {
  // Dynamic require to avoid loading koffi on POSIX
  const { acquireFlock, releaseFlock } = require("./native/posix.js") as typeof import("./native/posix.js");

  const handle = acquireFlock(lockPath);

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    releaseFlock(handle);
  };
}
