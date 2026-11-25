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

import koffi from "koffi";

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
const TH32CS_SNAPPROCESS = 0x00000002;
const TOKEN_QUERY = 0x0008;
// R01 修复：assignProcessToJob 需要 PROCESS_SET_QUOTA | PROCESS_TERMINATE 才能成功绑定
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;

const WAIT_OBJECT_0 = 0;
const WAIT_ABANDONED = 0x80;
const WAIT_TIMEOUT = 258;
const WAIT_FAILED = 0xffffffff;
const INFINITE = 0xffffffff;

// ── Structures ─────────────────────────────────────────────────────────────

const JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = koffi.struct({
  TotalUserTime: "int64",
  TotalKernelTime: "int64",
  ThisPeriodTotalUserTime: "int64",
  ThisPeriodTotalKernelTime: "int64",
  TotalPageFaultCount: "uint32",
  TotalProcesses: "uint32",
  ActiveProcesses: "uint32",
  TotalTerminatedProcesses: "uint32",
});

const IO_COUNTERS = koffi.struct({
  ReadOperationCount: "uint64",
  WriteOperationCount: "uint64",
  OtherOperationCount: "uint64",
  ReadTransferCount: "uint64",
  WriteTransferCount: "uint64",
  OtherTransferCount: "uint64",
});

const JOBOBJECT_BASIC_LIMIT_INFORMATION = koffi.struct({
  PerProcessUserTimeLimit: "int64",
  PerJobUserTimeLimit: "int64",
  LimitFlags: "uint32",
  MinimumWorkingSetSize: "size_t",
  MaximumWorkingSetSize: "size_t",
  ActiveProcessLimit: "uint32",
  Affinity: "size_t",
  PriorityClass: "uint32",
  SchedulingClass: "uint32",
});

const JOBOBJECT_EXTENDED_LIMIT_INFORMATION = koffi.struct({
  BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION,
  IoInfo: IO_COUNTERS,
  ProcessMemoryLimit: "size_t",
  JobMemoryLimit: "size_t",
  PeakProcessMemoryUsed: "size_t",
  PeakJobMemoryUsed: "size_t",
});

const FILETIME = koffi.struct({
  dwLowDateTime: "uint32",
  dwHighDateTime: "uint32",
});

const PROCESSENTRY32W = koffi.struct({
  dwSize: "uint32",
  cntUsage: "uint32",
  th32ProcessID: "uint32",
  th32DefaultHeapID: "uintptr",
  th32ModuleID: "uint32",
  cntThreads: "uint32",
  th32ParentProcessID: "uint32",
  pcPriClassBase: "int32",
  dwFlags: "uint32",
  szExeFile: koffi.array("uint16", 260),
});

// ── Module factory ─────────────────────────────────────────────────────────

export function createWindowsNative() {
  // Load DLLs
  const kernel32 = koffi.load("kernel32.dll");
  const advapi32 = koffi.load("advapi32.dll");
  let cachedCurrentUserSid: string | undefined;

  // ── Win32 function declarations ──────────────────────────────────────────

  const GetLastError: () => DWORD = kernel32.func(
    "__stdcall",
    "GetLastError",
    "uint32",
    [],
  );

  const CreateJobObjectW: (
    lpJobAttributes: HANDLE | null,
    lpName: string | null,
  ) => HANDLE = kernel32.func("__stdcall", "CreateJobObjectW", "void *", [
    "void *",
    "str16",
  ]);

  const CloseHandle: (hObject: HANDLE) => BOOL = kernel32.func(
    "__stdcall",
    "CloseHandle",
    "int",
    ["void *"],
  );

  const AssignProcessToJobObject: (hJob: HANDLE, hProcess: HANDLE) => BOOL =
    kernel32.func("__stdcall", "AssignProcessToJobObject", "int", [
      "void *",
      "void *",
    ]);

  const TerminateJobObject: (hJob: HANDLE, uExitCode: DWORD) => BOOL =
    kernel32.func("__stdcall", "TerminateJobObject", "int", [
      "void *",
      "uint32",
    ]);

  const QueryInformationJobObject: (
    hJob: HANDLE,
    JobObjectInformationClass: DWORD,
    lpJobObjectInformation: any,
    cbJobObjectInformationLength: DWORD,
    lpReturnLength: any,
  ) => BOOL = kernel32.func("__stdcall", "QueryInformationJobObject", "int", [
    "void *",
    "int",
    "void *",
    "uint32",
    "void *",
  ]);

  const SetInformationJobObject: (
    hJob: HANDLE,
    JobObjectInformationClass: DWORD,
    lpJobObjectInformation: any,
    cbJobObjectInformationLength: DWORD,
  ) => BOOL = kernel32.func("__stdcall", "SetInformationJobObject", "int", [
    "void *",
    "int",
    "void *",
    "uint32",
  ]);

  const CreateMutexW: (
    lpMutexAttributes: HANDLE | null,
    bInitialOwner: BOOL,
    lpName: string | null,
  ) => HANDLE = kernel32.func("__stdcall", "CreateMutexW", "void *", [
    "void *",
    "int",
    "str16",
  ]);

  const ReleaseMutex: (hMutex: HANDLE) => BOOL = kernel32.func(
    "__stdcall",
    "ReleaseMutex",
    "int",
    ["void *"],
  );

  const WaitForSingleObject: (hHandle: HANDLE, dwMilliseconds: DWORD) => DWORD =
    kernel32.func("__stdcall", "WaitForSingleObject", "uint32", [
      "void *",
      "uint32",
    ]);

  const OpenProcess: (
    dwDesiredAccess: DWORD,
    bInheritHandle: BOOL,
    dwProcessId: DWORD,
  ) => HANDLE = kernel32.func("__stdcall", "OpenProcess", "void *", [
    "uint32",
    "int",
    "uint32",
  ]);

  const GetProcessId: (hProcess: HANDLE) => DWORD = kernel32.func(
    "__stdcall",
    "GetProcessId",
    "uint32",
    ["void *"],
  );

  const GetProcessTimes: (
    hProcess: HANDLE,
    lpCreationTime: any,
    lpExitTime: any,
    lpKernelTime: any,
    lpUserTime: any,
  ) => BOOL = kernel32.func("__stdcall", "GetProcessTimes", "int", [
    "void *",
    "void *",
    "void *",
    "void *",
    "void *",
  ]);

  // ── Helpers ──────────────────────────────────────────────────────────────

  function nullHandle(): HANDLE {
    return 0n as HANDLE;
  }

  function isNull(h: HANDLE | null): boolean {
    return h == null || h === 0n || h === -1n;
  }

  function filetimeToBigInt(ft: {
    dwLowDateTime: number;
    dwHighDateTime: number;
  }): bigint {
    return (BigInt(ft.dwHighDateTime) << 32n) | BigInt(ft.dwLowDateTime);
  }

  // ── Implementation ──────────────────────────────────────────────────────

  return {
    isProcessInJob(pid: number, job: HANDLE): boolean {
      const process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
      if (isNull(process)) {
        const error = GetLastError();
        if (error === 87) return false;
        throw new Error("PROCESS_MEMBERSHIP_UNKNOWN:" + error);
      }
      try {
        const result = Buffer.alloc(4);
        const query = kernel32.func("__stdcall", "IsProcessInJob", "int", [
          "void *",
          "void *",
          "void *",
        ]);
        if (!query(process, job, result))
          throw new Error("JOB_MEMBERSHIP_UNKNOWN:" + GetLastError());
        return result.readInt32LE() !== 0;
      } finally {
        CloseHandle(process);
      }
    },
    spawnInteractive(
      executable: string,
      args: string[],
      cwd: string,
      env: Record<string, string>,
      job: HANDLE,
    ) {
      if (
        [executable, cwd, ...args, ...Object.values(env)].some((value) =>
          value.includes("\0"),
        )
      )
        throw new Error("INVALID_PROCESS_ARGUMENT");
      const quote = (value: string) =>
        '"' +
        value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1") +
        '"';
      const command = Buffer.from(
        [executable, ...args].map(quote).join(" ") + "\0",
        "utf16le",
      );
      const environment = Buffer.from(
        Object.entries(env)
          .sort(([a], [b]) => a.toUpperCase().localeCompare(b.toUpperCase()))
          .map(([key, value]) => `${key}=${value}`)
          .join("\0") + "\0\0",
        "utf16le",
      );
      const startupType = koffi.struct({
        cb: "uint32",
        reserved: "void *",
        desktop: "void *",
        title: "void *",
        x: "uint32",
        y: "uint32",
        xSize: "uint32",
        ySize: "uint32",
        xChars: "uint32",
        yChars: "uint32",
        fill: "uint32",
        flags: "uint32",
        show: "uint16",
        reservedSize: "uint16",
        reservedBytes: "void *",
        stdin: "void *",
        stdout: "void *",
        stderr: "void *",
      });
      const processType = koffi.struct({
        process: "void *",
        thread: "void *",
        pid: "uint32",
        tid: "uint32",
      });
      const startup = Buffer.alloc(koffi.sizeof(startupType));
      startup.writeUInt32LE(startup.length);
      const output = Buffer.alloc(koffi.sizeof(processType));
      const create = kernel32.func("__stdcall", "CreateProcessW", "int", [
        "str16",
        "void *",
        "void *",
        "void *",
        "int",
        "uint32",
        "void *",
        "str16",
        "void *",
        "void *",
      ]);
      if (
        !create(
          executable,
          command,
          null,
          null,
          0,
          0x4 | 0x10 | 0x400,
          environment,
          cwd,
          startup,
          output,
        )
      )
        throw new Error(`CreateProcessW failed: ${GetLastError()}`);
      const info = koffi.decode(output, processType) as {
        process: HANDLE;
        thread: HANDLE;
        pid: number;
      };
      const terminate = kernel32.func("__stdcall", "TerminateProcess", "int", [
        "void *",
        "uint32",
      ]);
      const resume = kernel32.func("__stdcall", "ResumeThread", "uint32", [
        "void *",
      ]);
      let threadOpen = true;
      let processOpen = true;
      const close = () => {
        if (threadOpen) {
          CloseHandle(info.thread);
          threadOpen = false;
        }
        if (processOpen) {
          CloseHandle(info.process);
          processOpen = false;
        }
      };
      if (!AssignProcessToJobObject(job, info.process)) {
        const error = GetLastError();
        terminate(info.process, 1);
        close();
        throw new Error(`AssignProcessToJobObject failed: ${error}`);
      }
      return {
        pid: info.pid,
        handle: info.process,
        close,
        resume: () => {
          if (resume(info.thread) === 0xffffffff)
            throw new Error(`ResumeThread failed: ${GetLastError()}`);
          CloseHandle(info.thread);
          threadOpen = false;
        },
        exitCode: () => {
          const code = Buffer.alloc(4);
          const query = kernel32.func(
            "__stdcall",
            "GetExitCodeProcess",
            "int",
            ["void *", "void *"],
          );
          if (!query(info.process, code))
            throw new Error(`GetExitCodeProcess failed: ${GetLastError()}`);
          return code.readUInt32LE();
        },
      };
    },
    // ── Job Object ───────────────────────────────────────────────────────

    createJob(name: string, flags?: number): HANDLE | null {
      const job = CreateJobObjectW(null, name);
      const error = GetLastError();
      if (isNull(job)) return null;
      if (error === 183) {
        CloseHandle(job);
        throw new Error("JOB_ALREADY_EXISTS");
      }

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
            ReadOperationCount: 0n,
            WriteOperationCount: 0n,
            OtherOperationCount: 0n,
            ReadTransferCount: 0n,
            WriteTransferCount: 0n,
            OtherTransferCount: 0n,
          },
          ProcessMemoryLimit: 0n,
          JobMemoryLimit: 0n,
          PeakProcessMemoryUsed: 0n,
          PeakJobMemoryUsed: 0n,
        });
        const ok = SetInformationJobObject(
          job,
          JobObjectExtendedLimitInformation,
          ext,
          koffi.sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION),
        );
        koffi.free(ext);
        if (!ok) {
          CloseHandle(job);
          return null;
        }
      }

      return job;
    },

    // R01 修复：AssignProcessToJobObject 需要 PROCESS_SET_QUOTA | PROCESS_TERMINATE
    allowJobSurvival(job: HANDLE): boolean {
      const limits = Buffer.alloc(koffi.sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
      return !!SetInformationJobObject(job, JobObjectExtendedLimitInformation, limits, limits.length);
    },

    assignProcessToJob(job: HANDLE, pid: number): boolean {
      const hProcess = OpenProcess(
        PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE,
        0,
        pid,
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
        job,
        JobObjectBasicAccountingInformation,
        info,
        koffi.sizeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION),
        null,
      );
      if (!ok) {
        koffi.free(info);
        return -1;
      }
      const decoded = koffi.decode(
        info,
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
      );
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

    waitForMutex(
      mutex: HANDLE,
      timeoutMs: number,
    ): "acquired" | "timeout" | "abandoned" | "error" {
      const ms = timeoutMs < 0 ? INFINITE : Math.min(timeoutMs, INFINITE);
      const result = WaitForSingleObject(mutex, ms);
      if (result === WAIT_OBJECT_0) return "acquired";
      if (result === WAIT_TIMEOUT) return "timeout";
      if (result === WAIT_ABANDONED) return "abandoned";
      return "error";
    },

    // ── Process identity ─────────────────────────────────────────────────

    openProcess(pid: number, access?: number): HANDLE | null {
      const h = OpenProcess(
        access ?? PROCESS_QUERY_LIMITED_INFORMATION,
        0,
        pid,
      );
      if (!isNull(h)) return h;
      const error = GetLastError();
      if (error === 87) return null;
      throw new Error(`OpenProcess failed: ${error}`);
    },

    openJob(name: string): HANDLE | null {
      const open = kernel32.func("__stdcall", "OpenJobObjectW", "void *", [
        "uint32",
        "int",
        "str16",
      ]);
      const handle = open(4, 0, name) as HANDLE | null;
      if (!isNull(handle)) return handle;
      const error = GetLastError();
      if (error === 2) return null;
      throw new Error(`OpenJobObject failed: ${error}`);
    },

    isProcessRunning(handle: HANDLE): boolean {
      const result = WaitForSingleObject(handle, 0);
      if (result === WAIT_OBJECT_0) return false;
      if (result === WAIT_TIMEOUT) return true;
      throw new Error(`WaitForSingleObject failed: ${GetLastError()}`);
    },

    getProcessCreationTime(pid: number): bigint | null {
      const h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
      if (isNull(h)) {
        const error = GetLastError();
        if (error === 87) return null;
        throw new Error(`OpenProcess failed: ${error}`);
      }

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

    listProcessInventory(targetExeNames: readonly string[]): Array<{
      pid: number;
      parent: number;
      exe_path: string;
      name: string;
      sid?: string;
      create_time?: number;
    }> {
      const CreateToolhelp32Snapshot = kernel32.func(
        "__stdcall",
        "CreateToolhelp32Snapshot",
        "void *",
        ["uint32", "uint32"],
      );
      const Process32FirstW = kernel32.func(
        "__stdcall",
        "Process32FirstW",
        "int",
        ["void *", "void *"],
      );
      const Process32NextW = kernel32.func(
        "__stdcall",
        "Process32NextW",
        "int",
        ["void *", "void *"],
      );
      const QueryFullProcessImageNameW = kernel32.func(
        "__stdcall",
        "QueryFullProcessImageNameW",
        "int",
        ["void *", "uint32", "void *", "void *"],
      );
      const LocalFree = kernel32.func("void * __stdcall LocalFree(void *value)");
      const OpenProcessToken = advapi32.func(
        "__stdcall",
        "OpenProcessToken",
        "int",
        ["void *", "uint32", "void *"],
      );
      const GetTokenInformation = advapi32.func(
        "__stdcall",
        "GetTokenInformation",
        "int",
        ["void *", "uint32", "void *", "uint32", "void *"],
      );
      const ConvertSidToStringSidW = advapi32.func(
        "__stdcall",
        "ConvertSidToStringSidW",
        "int",
        ["void *", "void *"],
      );
      const GetCurrentProcess = kernel32.func(
        "void * __stdcall GetCurrentProcess()",
      );

      const readTokenSid = (processHandle: HANDLE): string => {
        const tokenSlot = Buffer.alloc(koffi.sizeof("void *"));
        if (!OpenProcessToken(processHandle, TOKEN_QUERY, tokenSlot)) {
          throw new Error(`OpenProcessToken failed: ${GetLastError()}`);
        }
        const token = koffi.decode(tokenSlot, "void *") as HANDLE | null;
        if (isNull(token)) throw new Error("token_invalid");
        let sidPtr: HANDLE | null = null;
        try {
          const sizeBuf = Buffer.alloc(4);
          GetTokenInformation(token, 1, null, 0, sizeBuf);
          const length = sizeBuf.readUInt32LE();
          if (!length || length > 65536) {
            throw new Error(`GetTokenInformation size failed: ${GetLastError()}`);
          }
          const userBuf = Buffer.alloc(length);
          if (!GetTokenInformation(token, 1, userBuf, length, sizeBuf)) {
            throw new Error(`GetTokenInformation failed: ${GetLastError()}`);
          }
          const sidSlot = Buffer.alloc(koffi.sizeof("void *"));
          if (!ConvertSidToStringSidW(koffi.decode(userBuf, "void *"), sidSlot)) {
            throw new Error(`ConvertSidToStringSidW failed: ${GetLastError()}`);
          }
          sidPtr = koffi.decode(sidSlot, "void *") as HANDLE | null;
          if (isNull(sidPtr)) throw new Error("sid_invalid");
          const sid = koffi.decode.string16(sidPtr);
          if (!/^S-1-(?:\d+-)*\d+$/.test(sid)) throw new Error("sid_invalid");
          return sid;
        } finally {
          if (!isNull(sidPtr)) LocalFree(sidPtr!);
          CloseHandle(token!);
        }
      };

      if (!cachedCurrentUserSid) {
        cachedCurrentUserSid = readTokenSid(GetCurrentProcess());
      }
      const currentSid = cachedCurrentUserSid;
      const targets = new Set(targetExeNames.map((n) => n.toLowerCase()));
      const snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) as HANDLE | null;
      if (isNull(snap)) {
        throw new Error(`CreateToolhelp32Snapshot failed: ${GetLastError()}`);
      }

      const items: Array<{
        pid: number;
        parent: number;
        exe_path: string;
        name: string;
        sid?: string;
        create_time?: number;
      }> = [];
      const entrySize = koffi.sizeof(PROCESSENTRY32W);
      const entryBuf = Buffer.alloc(entrySize);
      entryBuf.writeUInt32LE(entrySize, 0);

      try {
        let ok = Process32FirstW(snap!, entryBuf);
        if (!ok) {
          const err = GetLastError();
          if (err !== 18) throw new Error(`Process32FirstW failed: ${err}`);
          return items;
        }
        const pathChars = 1024;
        const pathBuf = Buffer.alloc(pathChars * 2);
        const pathLenBuf = Buffer.alloc(4);
        const ctime = koffi.alloc(FILETIME, 1);
        const etime = koffi.alloc(FILETIME, 1);
        const ktime = koffi.alloc(FILETIME, 1);
        const utime = koffi.alloc(FILETIME, 1);

        try {
          while (ok) {
            const entry = koffi.decode(entryBuf, PROCESSENTRY32W) as {
              th32ProcessID: number;
              th32ParentProcessID: number;
              szExeFile: number[];
            };
            const end = entry.szExeFile.indexOf(0);
            const codeUnits = end >= 0 ? entry.szExeFile.slice(0, end) : entry.szExeFile;
            const name = Buffer.from(new Uint16Array(codeUnits).buffer).toString("utf16le");
            const pid = entry.th32ProcessID;
            const parent = entry.th32ParentProcessID;

            if (pid > 0 && targets.has(name.toLowerCase())) {
              const hProc = OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
              );
              if (isNull(hProc)) {
                const err = GetLastError();
                if (err !== 87) {
                  // Verify whether the PID already exited before failing closed.
                  const check = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                  if (!isNull(check)) {
                    const exited = WaitForSingleObject(check, 0) === WAIT_OBJECT_0;
                    CloseHandle(check);
                    if (!exited) throw new Error(`Cannot establish AGY process owner: ${err}`);
                  } else if (GetLastError() !== 87) {
                    throw new Error(`Cannot establish AGY process owner: ${err}`);
                  }
                }
              } else {
                try {
                  let ownerSid: string | undefined;
                  try {
                    ownerSid = readTokenSid(hProc);
                  } catch (err) {
                    if (WaitForSingleObject(hProc, 0) === WAIT_OBJECT_0) {
                      ownerSid = undefined;
                    } else {
                      throw err;
                    }
                  }
                  if (ownerSid === currentSid) {
                    pathLenBuf.writeUInt32LE(pathChars, 0);
                    if (!QueryFullProcessImageNameW(hProc, 0, pathBuf, pathLenBuf)) {
                      const err = GetLastError();
                      if (WaitForSingleObject(hProc, 0) !== WAIT_OBJECT_0) {
                        throw new Error(`QueryFullProcessImageNameW failed: ${err}`);
                      }
                    } else {
                      const len = pathLenBuf.readUInt32LE(0);
                      const exe_path = pathBuf.subarray(0, len * 2).toString("utf16le");
                      let create_time: number | undefined;
                      if (GetProcessTimes(hProc, ctime, etime, ktime, utime)) {
                        const ct = filetimeToBigInt(koffi.decode(ctime, FILETIME));
                        create_time = Number((ct - 116444736000000000n) / 10000n);
                      }
                      items.push({ pid, parent, exe_path, name, sid: ownerSid, create_time });
                    }
                  }
                } finally {
                  CloseHandle(hProc);
                }
              }
            } else {
              items.push({ pid, parent, exe_path: "", name });
            }

            entryBuf.writeUInt32LE(entrySize, 0);
            ok = Process32NextW(snap!, entryBuf);
            if (!ok) {
              const error = GetLastError();
              if (error !== 18) throw new Error(`Process32NextW failed: ${error}`);
            }
          }
        } finally {
          koffi.free(ctime);
          koffi.free(etime);
          koffi.free(ktime);
          koffi.free(utime);
        }
      } finally {
        CloseHandle(snap!);
      }
      return items;
    },
  };
}
