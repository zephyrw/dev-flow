/**
 * 原生接口模块入口
 *
 * 根据平台导出对应的原生接口实现。
 * Windows 使用 koffi 调用 Win32 API。
 * POSIX 使用 Node 内建模块。
 *
 * R01 修复：使用 async import() 替代 require()（ESM 不允许 require），
 * 移除空对象兜底，加载失败时抛出明确错误。
 */

export interface NativeModule {
  // Job Object (Windows only)
  createJob(name: string, flags?: number): bigint | null;
  assignProcessToJob(job: bigint, pid: number): boolean;
  terminateJob(job: bigint, exitCode: number): boolean;
  queryJobActiveCount(job: bigint): number;
  closeHandle(handle: bigint): boolean;

  // Mutex (Windows)
  createMutex(name: string, initialOwner?: boolean): bigint | null;
  releaseMutex(mutex: bigint): boolean;
  waitForMutex(mutex: bigint, timeoutMs: number): 'acquired' | 'timeout' | 'abandoned' | 'error';

  // Process identity
  openProcess(pid: number, access?: number): bigint | null;
  getProcessCreationTime(pid: number): bigint | null;

  // POSIX flock
  acquireFlock?(path: string): { fd: number; path: string } | null;
  releaseFlock?(handle: { fd: number; path: string }): void;
  tryAcquireFlock?(path: string): { fd: number; path: string } | null;

  // Process management
  isProcessAlive(pid: number): boolean;
  killProcessGroup(pgid: number, signal: number): { success: boolean; error?: string };
}

let _native: NativeModule | null = null;
let _initPromise: Promise<NativeModule> | null = null;

/**
 * R01 修复：异步初始化原生模块，使用 import() 替代 require()。
 * 加载失败时抛出明确错误，不返回空对象。
 */
export async function getNativeAsync(): Promise<NativeModule> {
  if (_native) return _native;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    if (process.platform === 'win32') {
      const { createWindowsNative } = await import('./windows.js');
      _native = createWindowsNative() as NativeModule;
    } else {
      const { createPosixNative } = await import('./posix.js');
      _native = createPosixNative() as NativeModule;
    }
    return _native;
  })();

  return _initPromise;
}

/**
 * 同步获取已初始化的原生模块（仅在异步初始化完成后可用）。
 * 未初始化时抛出错误，不再返回空对象。
 */
export function getNative(): NativeModule {
  if (!_native) {
    throw new Error(
      '[native] 原生模块未初始化。请先调用 getNativeAsync() 完成异步加载。'
    );
  }
  return _native;
}

export function isWindows(): boolean {
  return process.platform === 'win32';
}

export function isPosix(): boolean {
  return process.platform !== 'win32';
}
