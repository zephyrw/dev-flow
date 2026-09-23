import { resolve, join } from "node:path";
import { mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { hash } from "../../core/src/util.js";
import { getNativeAsync, getWindowsNative } from "./native/index.js";

// Windows mutex ownership is recursive on the same OS thread.
const heldRoots = new Set<string>();
export async function acquireControllerLock(
  root: string,
): Promise<() => Promise<void>> {
  const absolute = resolve(root);
  mkdirSync(absolute, { recursive: true });
  let canonical = realpathSync.native(absolute);
  if (process.platform === "win32") canonical = canonical.toLowerCase();
  if (heldRoots.has(canonical)) throw new Error("CONTROLLER_ALREADY_ACTIVE");
  heldRoots.add(canonical);
  const release: Array<() => void> = [];
  try {
    await getNativeAsync();
    const hashes = [
      ...new Set([hash(absolute.toLowerCase()), hash(canonical)]),
    ].sort();
    if (process.platform === "win32") {
      const native = await getWindowsNative();
      for (const key of hashes) {
        for (const name of [
          `Local\\DevFlowController.${key}`,
          `Global\\${key}`,
          key,
          `Local\\DevFlow.${key}`,
          `Global\\DevFlowAuth_${key}`,
        ]) {
          const mutex = native.createMutex(name, false);
          if (!mutex) throw new Error("CONTROLLER_LOCK_UNAVAILABLE");
          const result = native.waitForMutex(mutex, 0);
          if (result !== "acquired" && result !== "abandoned") {
            native.closeHandle(mutex);
            throw new Error("CONTROLLER_ALREADY_ACTIVE");
          }
          release.push(() => {
            try {
              if (!native.releaseMutex(mutex))
                throw new Error("CONTROLLER_UNLOCK_FAILED");
            } finally {
              native.closeHandle(mutex);
            }
          });
        }
      }
    } else {
      const native = await import("./native/posix.js");
      for (const key of hashes) {
        const handle = native.acquireFlock(
          join(tmpdir(), `devflow-${key}.lock`),
        );
        release.push(() => native.releaseFlock(handle));
      }
    }
  } catch (error) {
    for (const unlock of release.reverse()) {
      try {
        unlock();
      } catch {}
    }
    heldRoots.delete(canonical);
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    let failure: unknown;
    for (const unlock of release.reverse()) {
      try {
        unlock();
      } catch (error) {
        failure ??= error;
      }
    }
    heldRoots.delete(canonical);
    if (failure) throw failure;
  };
}
