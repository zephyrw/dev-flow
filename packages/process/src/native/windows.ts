/**
 * Windows native interface module.
 *
 * Uses koffi@3.3.1 to call Win32 APIs for Job Objects, Mutex, and process
 * identity queries. No business logic — pure OS primitive wrappers.
 *
 * Design constraints:
 * - All koffi.load() calls are lazy (inside createWindowsNative) so the module
 *   is only loaded when actually required on win32.
 * - HANDLE values are represented as BigInt for 64-bit safety.
 * - Every acquired handle must be released by the caller via closeHandle().
 * - Error reporting uses GetLastError() after each Win32 call.
 */

import koffi from 'koffi';

// ── Win32 type aliases ─────────────────────────────────────────────────────

/** Opaque HANDLE (pointer-sized). koffi maps this to BigInt on 64-bit. */
type HANDLE = bigint;
type DWORD = number;
type BOOL = number;

// ── Job Object constants ───────────────────────────────────────────────────

const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JobObjectBasicAccountingInformation = 1;
const JobObjectExtendedLimitInformation = 9;

const PROCESS_SYNCHRONIZE = 0x00100000;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

const WAIT_OBJECT_0 = 0;
const WAIT_ABANDONED = 0x80;
const WAIT_TIMEOUT = 258;
const WAIT_FAILED = 0xFFFFFFFF;
const INFINITE = 0xFFFFFFFF;

// ── Structures ─────────────────────────────────────────────────────────────

const JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = koffi.struct({
  TotalUserTime: 'int64',
  TotalKernelTime: 'int64',
  ThisPeriodTotalUserTime: 'int64',
  ThisPeriodTotalKernelTime: 'int64',
  TotalPageFaultCount: 'uint32',
  TotalProcesses: 'uint32',
  ActiveProcesses: 'uint32',
  TotalTerminatedProcesses: 'uint32',
});

const IO_COUNTERS = koffi.struct({
  ReadOperationCount: 'uint64',
  WriteOperationCount: 'uint64',
  OtherOperationCount: 'uint64',
  ReadTransferCount: 'uint64',
  WriteTransferCount: 'uint64',
  OtherTransferCount: 'uint64',
});

const JOBOBJECT_BASIC_LIMIT_INFORMATION = koffi.struct({
  PerProcessUserTimeLimit: 'int64',
  PerJobUserTimeLimit: 'int64',
  LimitFlags: 'uint32',
  MinimumWorkingSetSize: 'size_t',
  MaximumWorkingSetSize: 'size_t',
  ActiveProcessLimit: 'uint32',
  Affinity: 'size_t',
  PriorityClass: 'uint32',
  SchedulingClass: 'uint32',
});

const JOBOBJECT_EXTENDED_LIMIT_INFORMATION = koffi.struct({
  BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION,
  IoInfo: IO_COUNTERS,
  ProcessMemoryLimit: 'size_t',
  JobMemoryLimit: 'size_t',
  PeakProcessMemoryUsed: 'size_t',
  PeakJobMemoryUsed: 'size_t',
});

const FILETIME = koffi.struct({
  dwLowDateTime: 'uint32',
  dwHighDateTime: 'uint32',
});

// ── Module factory ─────────────────────────────────────────────────────────

export function createWindowsNative() {
  // Load DLLs
  const kernel32 = koffi.load('kernel32.dll');

  // ── Win32 function declarations ──────────────────────────────────────────

  const GetLastError: () => DWORD =
    kernel32.func('__stdcall', 'GetLastError', 'uint32', []);

  const CreateJobObjectW: (lpJobAttributes: HANDLE | null, lpName: string | null) => HANDLE =
    kernel32.func('__stdcall', 'CreateJobObjectW', 'void *', ['void *', 'str16']);

  const CloseHandle: (hObject: HANDLE) => BOOL =
    kernel32.func('__stdcall', 'CloseHandle', 'int', ['void *']);

  const AssignProcessToJobObject: (hJob: HANDLE, hProcess: HANDLE) => BOOL =
    kernel32.func('__stdcall', 'AssignProcessToJobObject', 'int', ['void *', 'void *']);

  const TerminateJobObject: (hJob: HANDLE, uExitCode: DWORD) => BOOL =
    kernel32.func('__stdcall', 'TerminateJobObject', 'int', ['void *', 'uint32']);

  const QueryInformationJobObject: (
    hJob: HANDLE, JobObjectInformationClass: DWORD,
    lpJobObjectInformation: any, cbJobObjectInformationLength: DWORD,
    lpReturnLength: any
  ) => BOOL =
    kernel32.func('__stdcall', 'QueryInformationJobObject', 'int',
      ['void *', 'int', 'void *', 'uint32', 'void *']);

  const SetInformationJobObject: (
    hJob: HANDLE, JobObjectInformationClass: DWORD,
    lpJobObjectInformation: any, cbJobObjectInformationLength: DWORD
  ) => BOOL =
    kernel32.func('__stdcall', 'SetInformationJobObject', 'int',
      ['void *', 'int', 'void *', 'uint32']);

  const CreateMutexW: (
    lpMutexAttributes: HANDLE | null, bInitialOwner: BOOL, lpName: string | null
  ) => HANDLE =
    kernel32.func('__stdcall', 'CreateMutexW', 'void *', ['void *', 'int', 'str16']);

  const ReleaseMutex: (hMutex: HANDLE) => BOOL =
    kernel32.func('__stdcall', 'ReleaseMutex', 'int', ['void *']);

  const WaitForSingleObject: (hHandle: HANDLE, dwMilliseconds: DWORD) => DWORD =
    kernel32.func('__stdcall', 'WaitForSingleObject', 'uint32', ['void *', 'uint32']);

  const OpenProcess: (dwDesiredAccess: DWORD, bInheritHandle: BOOL, dwProcessId: DWORD) => HANDLE =
    kernel32.func('__stdcall', 'OpenProcess', 'void *', ['uint32', 'int', 'uint32']);

  const GetProcessId: (hProcess: HANDLE) => DWORD =
    kernel32.func('__stdcall', 'GetProcessId', 'uint32', ['void *']);

  const GetProcessTimes: (
    hProcess: HANDLE,
    lpCreationTime: any, lpExitTime: any,
    lpKernelTime: any, lpUserTime: any
  ) => BOOL =
    kernel32.func('__stdcall', 'GetProcessTimes', 'int',
      ['void *', 'void *', 'void *', 'void *', 'void *']);

  // ── Helpers ──────────────────────────────────────────────────────────────

  function nullHandle(): HANDLE {
    return 0n as HANDLE;
  }

  function isNull(h: HANDLE): boolean {
    return h === 0n || h === (BigInt(-1) as unknown as HANDLE);
  }

  function filetimeToBigInt(ft: { dwLowDateTime: number; dwHighDateTime: number }): bigint {
    return (BigInt(ft.dwHighDateTime) << 32n) | BigInt(ft.dwLowDateTime);
  }

  // ── Implementation ──────────────────────────────────────────────────────

  return {
    // ── Job Object ───────────────────────────────────────────────────────

    createJob(name: string, flags?: number): HANDLE | null {
      const job = CreateJobObjectW(null, name);
      if (isNull(job)) return null;

      // Apply limit flags (default: KILL_ON_JOB_CLOSE)
      const limitFlags = flags ?? JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      if (limitFlags !== 0) {
        const ext = koffi.alloc(JOBOBJECT_EXTENDED_LIMIT_INFORMATION, 1);
        koffi.encode(ext, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, {
          BasicLimitInformation: {
            PerProcessUserTimeLimit: 0n,
            PerJobUserTimeLimit: 0n,
            LimitFlags: limitFlags,
            MinimumWorkingSetSize: 0n,
            MaximumWorkingSetSize: 0n,
            ActiveProcessLimit: 0,
            Affinity: 0n,
            PriorityClass: 0,
            SchedulingClass: 0,
          },
          IoInfo: {
            ReadOperationCount: 0n, WriteOperationCount: 0n, OtherOperationCount: 0n,
            ReadTransferCount: 0n, WriteTransferCount: 0n, OtherTransferCount: 0n,
          },
          ProcessMemoryLimit: 0n,
          JobMemoryLimit: 0n,
          PeakProcessMemoryUsed: 0n,
          PeakJobMemoryUsed: 0n,
        });
        const ok = SetInformationJobObject(
          job, JobObjectExtendedLimitInformation,
          ext, koffi.sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)
        );
        koffi.free(ext);
        if (!ok) {
          CloseHandle(job);
          return null;
        }
      }

      return job;
    },

    assignProcessToJob(job: HANDLE, pid: number): boolean {
      const hProcess = OpenProcess(
        PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid
      );
      if (isNull(hProcess)) return false;
      const ok = AssignProcessToJobObject(job, hProcess);
      CloseHandle(hProcess);
      return !!ok;
    },

    terminateJob(job: HANDLE, exitCode: number): boolean {
      return !!TerminateJobObject(job, exitCode);
    },

    queryJobActiveCount(job: HANDLE): number {
      const info = koffi.alloc(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, 1);
      const ok = QueryInformationJobObject(
        job, JobObjectBasicAccountingInformation,
        info, koffi.sizeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION), null
      );
      if (!ok) {
        koffi.free(info);
        return -1;
      }
      const decoded = koffi.decode(info, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION);
      koffi.free(info);
      return decoded.ActiveProcesses;
    },

    closeHandle(handle: HANDLE): boolean {
      return !!CloseHandle(handle);
    },

    // ── Mutex ────────────────────────────────────────────────────────────

    createMutex(name: string, initialOwner?: boolean): HANDLE | null {
      const h = CreateMutexW(null, initialOwner ? 1 : 0, name);
      return isNull(h) ? null : h;
    },

    releaseMutex(mutex: HANDLE): boolean {
      return !!ReleaseMutex(mutex);
    },

    waitForMutex(mutex: HANDLE, timeoutMs: number): 'acquired' | 'timeout' | 'abandoned' | 'error' {
      const ms = timeoutMs < 0 ? INFINITE : Math.min(timeoutMs, INFINITE);
      const result = WaitForSingleObject(mutex, ms);
      if (result === WAIT_OBJECT_0) return 'acquired';
      if (result === WAIT_TIMEOUT) return 'timeout';
      if (result === WAIT_ABANDONED) return 'abandoned';
      return 'error';
    },

    // ── Process identity ─────────────────────────────────────────────────

    openProcess(pid: number, access?: number): HANDLE | null {
      const h = OpenProcess(access ?? PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
      return isNull(h) ? null : h;
    },

    getProcessCreationTime(pid: number): bigint | null {
      const h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
      if (isNull(h)) return null;

      const ctime = koffi.alloc(FILETIME, 1);
      const etime = koffi.alloc(FILETIME, 1);
      const ktime = koffi.alloc(FILETIME, 1);
      const utime = koffi.alloc(FILETIME, 1);

      const ok = GetProcessTimes(h, ctime, etime, ktime, utime);
      if (!ok) {
        koffi.free(ctime);
        koffi.free(etime);
        koffi.free(ktime);
        koffi.free(utime);
        CloseHandle(h);
        return null;
      }

      const ct = koffi.decode(ctime, FILETIME);
      const result = filetimeToBigInt(ct);

      koffi.free(ctime);
      koffi.free(etime);
      koffi.free(ktime);
      koffi.free(utime);
      CloseHandle(h);
      return result;
    },
  };
}
