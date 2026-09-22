/**
 * 原生接口模块入口
 *
 * 根据平台导出对应的原生接口实现。
 * Windows 使用 koffi 调用 Win32 API。
 * POSIX 使用 Node 内建模块。
 */

export interface NativeModule {
  // Job Object (Windows only)
  createJob?(name: string, flags?: number): bigint | null;
  assignProcessToJob?(job: bigint, pid: number): boolean;
  terminateJob?(job: bigint, exitCode: number): boolean;
  queryJobActiveCount?(job: bigint): number;
  closeHandle?(handle: bigint): boolean;

  // Mutex (Windows) / flock (POSIX)
  createMutex?(name: string, initialOwner?: boolean): bigint | null;
  releaseMutex?(mutex: bigint): boolean;
  waitForMutex?(mutex: bigint, timeoutMs: number): 'acquired' | 'timeout' | 'abandoned' | 'error';

  // Process identity
  openProcess?(pid: number, access?: number): bigint | null;
  getProcessCreationTime?(pid: number): bigint | null;

  // POSIX flock
  acquireFlock?(path: string): { fd: number; path: string } | null;
  releaseFlock?(handle: { fd: number; path: string }): void;
  tryAcquireFlock?(path: string): { fd: number; path: string } | null;

  // Process management
  isProcessAlive?(pid: number): boolean;
  killProcessGroup?(pgid: number, signal: number): { success: boolean; error?: string };
}

let _native: NativeModule | null = null;

export function getNative(): NativeModule {
  if (_native) return _native;

  if (process.platform === 'win32') {
    // Windows: use koffi-based implementation
    // Dynamic import to avoid loading koffi on POSIX
    try {
      const windows = require('./windows.js');
      _native = windows.createWindowsNative();
    } catch (err) {
      console.error('[native] Failed to load Windows native module:', err);
      _native = {};
    }
  } else {
    // POSIX: use Node built-in implementation
    try {
      const posix = require('./posix.js');
      _native = posix.createPosixNative();
    } catch (err) {
      console.error('[native] Failed to load POSIX native module:', err);
      _native = {};
    }
  }

  return _native!;
}

export function isWindows(): boolean {
  return process.platform === 'win32';
}

export function isPosix(): boolean {
  return process.platform !== 'win32';
}
