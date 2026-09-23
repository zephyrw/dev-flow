import { resolve } from "node:path";
import { hash } from "../../core/src/util.js";

/**
 * Acquire an in-process controller lock for the given root directory.
 *
 * Platform behaviour:
 * - Windows: named Mutex `Global\DevFlowAuth_<hash>` via koffi Win32 API
 * - POSIX:   exclusive flock file at `<root>/.devflow-controller.lock`
 *
 * R07 修复：
 * - Windows Mutex 名称与旧版本兼容：Global\DevFlowAuth_<hash>
 * - initialOwner=false 避免递归持有
 * - ESM 兼容：使用动态 import() 替代 require()
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
  // R07 修复：使用动态 import() 替代 require()（ESM 兼容）
  const { getNativeAsync } = await import("./native/index.js");
  const native = await getNativeAsync();

  // R07 修复：Mutex 名称与旧版本兼容
  // 旧 C# 使用: Local\DevFlowController.<hash>
  // 旧 Go 使用: Global\<hash>
  // 统一为: Global\DevFlowAuth_<hash>（Global 命名空间，跨会话互斥）
  const mutexName = `Global\\DevFlowAuth_${lockHash}`;

  // R07 修复：initialOwner=false，避免创建者立即持有导致递归
  const mutex = native.createMutex(mutexName, false);
  if (!mutex) {
    throw new Error(`Failed to create controller mutex: ${mutexName}`);
  }

  // 单次等待获取互斥锁
  const result = native.waitForMutex(mutex, 10_000);
  if (result !== "acquired") {
    native.closeHandle(mutex);
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
    native.releaseMutex(mutex);
    native.closeHandle(mutex);
  };
}

// ── POSIX ───────────────────────────────────────────────────────────────────

async function acquirePosixLock(
  lockPath: string,
): Promise<() => Promise<void>> {
  // R07 修复：使用动态 import() 替代 require()（ESM 兼容）
  const { acquireFlock, releaseFlock } = await import("./native/posix.js");

  const handle = acquireFlock(lockPath);

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    releaseFlock(handle);
  };
}
