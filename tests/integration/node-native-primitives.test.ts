import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, existsSync, openSync, closeSync } from "node:fs";
import { fork, spawn, execFileSync, type ChildProcess } from "node:child_process";
import koffi from "koffi";

const isWindows = process.platform === "win32";
const repoRoot = join(import.meta.dirname, "..", "..");

const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JobObjectBasicAccountingInformation = 1;
const JobObjectExtendedLimitInformation = 9;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const WAIT_OBJECT_0 = 0;
const WAIT_ABANDONED = 0x80;
const WAIT_TIMEOUT = 0x102;
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

const FILETIME_TO_UNIX_EPOCH = 116444736000000000n;

type IpcMessage = {
  type: string;
  pid?: number;
  code?: number | null;
  attempt_id?: string;
  version?: number;
  [key: string]: unknown;
};

let tmpDir: string;
let testSuffix: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "devflow-native-primitives-"));
  testSuffix = `${process.pid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
});

afterAll(() => {
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
});

function resolveRunnerEntry(): string {
  const candidates = [
    join(repoRoot, "dist", "packages", "process", "src", "runner-entry.js"),
    join(repoRoot, "packages", "process", "src", "runner-entry.js"),
  ];
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    throw new Error(
      `runner-entry.js not found. Run pnpm run build first. Tried:\n${candidates.join("\n")}`,
    );
  }
  return found;
}

function loadKernel32() {
  return koffi.load("kernel32.dll");
}

function closeHandle(kernel32: ReturnType<typeof koffi.load>, handle: unknown) {
  if (!handle) return;
  const CloseHandle = kernel32.func("CloseHandle", "bool", ["void *"]);
  CloseHandle(handle);
}

function fileTimeToIso(buf: Buffer): string {
  const low = buf.readUInt32LE(0);
  const high = buf.readUInt32LE(4);
  const ticks = (BigInt(high) << 32n) | BigInt(low);
  const ms = Number((ticks - FILETIME_TO_UNIX_EPOCH) / 10000n);
  return new Date(ms).toISOString();
}

function getProcessIdentity(pid: number): { pid: number; creationTime: string } {
  if (isWindows) {
    const kernel32 = loadKernel32();
    try {
      const OpenProcess = kernel32.func("OpenProcess", "void *", ["uint32", "int", "uint32"]);
      const GetProcessTimes = kernel32.func("GetProcessTimes", "bool", [
        "void *",
        "void *",
        "void *",
        "void *",
        "void *",
      ]);
      const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
      if (!handle) {
        throw new Error(`OpenProcess failed for pid ${pid}`);
      }
      try {
        const creation = Buffer.alloc(8);
        const exitTime = Buffer.alloc(8);
        const kernel = Buffer.alloc(8);
        const user = Buffer.alloc(8);
        const ok = GetProcessTimes(handle, creation, exitTime, kernel, user);
        if (!ok) {
          throw new Error(`GetProcessTimes failed for pid ${pid}`);
        }
        return { pid, creationTime: fileTimeToIso(creation) };
      } finally {
        closeHandle(kernel32, handle);
      }
    } finally {
      kernel32.unload();
    }
  }

  const raw = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
  }).trim();
  if (!raw) {
    throw new Error(`ps returned no creation time for pid ${pid}`);
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`unable to parse creation time for pid ${pid}: ${raw}`);
  }
  return { pid, creationTime: parsed.toISOString() };
}

function collectIpc(child: ChildProcess): IpcMessage[] {
  const inbox: IpcMessage[] = [];
  child.on("message", (message: IpcMessage) => {
    if (message) inbox.push(message);
  });
  return inbox;
}

async function waitForMessage(
  inbox: IpcMessage[],
  type: string,
  timeoutMs = 10000,
): Promise<IpcMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const index = inbox.findIndex((message) => message?.type === type);
    if (index >= 0) {
      const [message] = inbox.splice(index, 1);
      return message!;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for IPC message '${type}'`);
}

async function waitForProcessExit(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

function killQuietly(pid: number | undefined) {
  if (!pid) return;
  try {
    process.kill(pid);
  } catch {}
}

function cleanedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  delete env.NODE_DEBUG;
  return env;
}

describe("node-native-primitives", () => {
  it("koffi loads successfully on the current platform", () => {
    expect(koffi).toBeDefined();
    expect(typeof koffi.load).toBe("function");

    if (isWindows) {
      const kernel32 = koffi.load("kernel32.dll");
      expect(kernel32).toBeDefined();
      const GetCurrentProcessId = kernel32.func("GetCurrentProcessId", "uint32", []);
      expect(GetCurrentProcessId()).toBe(process.pid);
      kernel32.unload();
      return;
    }

    const libcName = process.platform === "darwin" ? "libSystem.dylib" : "libc.so.6";
    const libc = koffi.load(libcName);
    expect(libc).toBeDefined();
    libc.unload();
  });

  describe("Windows Job Object", () => {
    it.skipIf(!isWindows)(
      "create, assign, query active count, terminate, close",
      async () => {
        const kernel32 = loadKernel32();
        const tool = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
          cwd: tmpDir,
          stdio: "ignore",
          windowsHide: true,
          env: cleanedEnv(),
        });

        let job: unknown = null;
        try {
          expect(tool.pid).toBeTypeOf("number");

          const CreateJobObjectW = kernel32.func("CreateJobObjectW", "void *", [
            "void *",
            "str16",
          ]);
          const SetInformationJobObject = kernel32.func("SetInformationJobObject", "bool", [
            "void *",
            "int",
            "void *",
            "uint32",
          ]);
          const OpenProcess = kernel32.func("OpenProcess", "void *", ["uint32", "int", "uint32"]);
          const AssignProcessToJobObject = kernel32.func("AssignProcessToJobObject", "bool", [
            "void *",
            "void *",
          ]);
          const QueryInformationJobObject = kernel32.func("QueryInformationJobObject", "bool", [
            "void *",
            "int",
            "void *",
            "uint32",
            "void *",
          ]);
          const TerminateJobObject = kernel32.func("TerminateJobObject", "bool", [
            "void *",
            "uint32",
          ]);

          const jobName = `Local\\DevFlowTest.job.${testSuffix}`;
          job = CreateJobObjectW(null, jobName);
          expect(job).toBeTruthy();

          // JOBOBJECT_EXTENDED_LIMIT_INFORMATION, x64 layout: LimitFlags at offset 16.
          const limits = Buffer.alloc(144);
          limits.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16);
          expect(
            SetInformationJobObject(job, JobObjectExtendedLimitInformation, limits, limits.length),
          ).toBe(true);

          const processHandle = OpenProcess(
            PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            tool.pid!,
          );
          expect(processHandle).toBeTruthy();
          try {
            expect(AssignProcessToJobObject(job, processHandle)).toBe(true);
          } finally {
            closeHandle(kernel32, processHandle);
          }

          const accounting = Buffer.alloc(48);
          expect(
            QueryInformationJobObject(
              job,
              JobObjectBasicAccountingInformation,
              accounting,
              accounting.length,
              null,
            ),
          ).toBe(true);
          const activeAfterAssign = accounting.readUInt32LE(40);
          expect(activeAfterAssign).toBeGreaterThan(0);

          expect(TerminateJobObject(job, 1)).toBe(true);

          const dead = await waitForProcessExit(tool.pid!, 5000);
          expect(dead).toBe(true);

          accounting.fill(0);
          expect(
            QueryInformationJobObject(
              job,
              JobObjectBasicAccountingInformation,
              accounting,
              accounting.length,
              null,
            ),
          ).toBe(true);
          expect(accounting.readUInt32LE(40)).toBe(0);
        } finally {
          killQuietly(tool.pid);
          tool.kill();
          if (job) closeHandle(kernel32, job);
          kernel32.unload();
        }
      },
    );
  });

  describe("Windows Mutex", () => {
    it.skipIf(!isWindows)("create, acquire, release", () => {
      const kernel32 = loadKernel32();
      let mutex: unknown = null;
      try {
        const CreateMutexW = kernel32.func("CreateMutexW", "void *", ["void *", "int", "str16"]);
        const WaitForSingleObject = kernel32.func("WaitForSingleObject", "uint32", [
          "void *",
          "uint32",
        ]);
        const ReleaseMutex = kernel32.func("ReleaseMutex", "bool", ["void *"]);

        const name = `Local\\DevFlowTest.mutex.${testSuffix}`;
        mutex = CreateMutexW(null, 0, name);
        expect(mutex).toBeTruthy();

        const acquired = WaitForSingleObject(mutex, 0);
        expect(acquired === WAIT_OBJECT_0 || acquired === WAIT_ABANDONED).toBe(true);

        expect(ReleaseMutex(mutex)).toBe(true);

        const reacquired = WaitForSingleObject(mutex, 0);
        expect(reacquired === WAIT_OBJECT_0 || reacquired === WAIT_ABANDONED).toBe(true);
        expect(ReleaseMutex(mutex)).toBe(true);
      } finally {
        if (mutex) closeHandle(kernel32, mutex);
        kernel32.unload();
      }
    });

    it.skipIf(!isWindows)(
      "concurrent access from two processes rejects the second holder",
      async () => {
        const mutexName = `Local\\DevFlowTest.mutex.concurrent.${testSuffix}`;
        const holdScript = `
          const koffi = require("koffi");
          const kernel32 = koffi.load("kernel32.dll");
          const CreateMutexW = kernel32.func("CreateMutexW", "void *", ["void *", "int", "str16"]);
          const WaitForSingleObject = kernel32.func("WaitForSingleObject", "uint32", ["void *", "uint32"]);
          const ReleaseMutex = kernel32.func("ReleaseMutex", "bool", ["void *"]);
          const CloseHandle = kernel32.func("CloseHandle", "bool", ["void *"]);
          const name = process.env.DEVFLOW_TEST_MUTEX_NAME;
          const mutex = CreateMutexW(null, 0, name);
          if (!mutex) {
            console.log(JSON.stringify({ ok: false, stage: "create" }));
            process.exit(1);
          }
          const result = WaitForSingleObject(mutex, 0);
          if (result !== 0 && result !== 0x80) {
            console.log(JSON.stringify({ ok: false, stage: "acquire", result }));
            process.exit(1);
          }
          console.log(JSON.stringify({ ok: true, held: true }));
          process.stdin.resume();
          process.stdin.on("end", () => {
            ReleaseMutex(mutex);
            CloseHandle(mutex);
            process.exit(0);
          });
          setTimeout(() => {
            ReleaseMutex(mutex);
            CloseHandle(mutex);
            process.exit(0);
          }, 15000);
        `;

        const child = spawn(process.execPath, ["-e", holdScript], {
          cwd: repoRoot,
          env: cleanedEnv({ DEVFLOW_TEST_MUTEX_NAME: mutexName }),
          stdio: ["pipe", "pipe", "ignore"],
          windowsHide: true,
        });

        const kernel32 = loadKernel32();
        let parentMutex: unknown = null;
        try {
          const held = await new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("child did not hold mutex")), 10000);
            let out = "";
            child.stdout.on("data", (chunk: Buffer) => {
              out += chunk.toString("utf8");
              const line = out.split("\n").find((entry) => entry.trim());
              if (!line) return;
              clearTimeout(timer);
              resolve(line);
            });
            child.on("exit", (code) => {
              clearTimeout(timer);
              reject(new Error(`mutex holder child exited early: ${code}`));
            });
          });
          expect(JSON.parse(held)).toMatchObject({ ok: true, held: true });

          const CreateMutexW = kernel32.func("CreateMutexW", "void *", ["void *", "int", "str16"]);
          const WaitForSingleObject = kernel32.func("WaitForSingleObject", "uint32", [
            "void *",
            "uint32",
          ]);
          const ReleaseMutex = kernel32.func("ReleaseMutex", "bool", ["void *"]);

          parentMutex = CreateMutexW(null, 0, mutexName);
          expect(parentMutex).toBeTruthy();

          const busy = WaitForSingleObject(parentMutex, 0);
          expect(busy).toBe(WAIT_TIMEOUT);

          child.stdin.end();
          const childExited = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), 5000);
            child.on("exit", () => {
              clearTimeout(timer);
              resolve(true);
            });
          });
          expect(childExited).toBe(true);

          const acquired = WaitForSingleObject(parentMutex, 0);
          expect(acquired === WAIT_OBJECT_0 || acquired === WAIT_ABANDONED).toBe(true);
          expect(ReleaseMutex(parentMutex)).toBe(true);
        } finally {
          try {
            child.stdin?.end();
          } catch {}
          killQuietly(child.pid);
          child.kill();
          if (parentMutex) closeHandle(kernel32, parentMutex);
          kernel32.unload();
        }
      },
    );
  });

  describe("Process identity", () => {
    it("reports pid and creation time for a live child", async () => {
      const tool = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
        cwd: tmpDir,
        stdio: "ignore",
        windowsHide: true,
        env: cleanedEnv(),
      });
      try {
        expect(tool.pid).toBeTypeOf("number");
        // Give the OS a moment to publish the process entry.
        await new Promise((resolve) => setTimeout(resolve, 50));
        const identity = getProcessIdentity(tool.pid!);
        expect(identity.pid).toBe(tool.pid);
        expect(identity.creationTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        const created = Date.parse(identity.creationTime);
        expect(Number.isFinite(created)).toBe(true);
        expect(Math.abs(Date.now() - created)).toBeLessThan(60_000);
      } finally {
        killQuietly(tool.pid);
        tool.kill();
      }
    });
  });

  describe("POSIX flock", () => {
    it.skipIf(isWindows)("acquire, release, concurrent lock rejection", async () => {
      const lockPath = join(tmpDir, `devflow-test-${testSuffix}.lock`);
      const libcName = process.platform === "darwin" ? "libSystem.dylib" : "libc.so.6";
      const libc = koffi.load(libcName);
      let fd: number | undefined;
      try {
        const flockFn = libc.func("flock", "int", ["int", "int"]);
        fd = openSync(lockPath, "w");

        expect(flockFn(fd, LOCK_EX | LOCK_NB)).toBe(0);

        const rejectScript = `
          const fs = require("fs");
          const koffi = require("koffi");
          const LOCK_EX = 2;
          const LOCK_NB = 4;
          const LOCK_UN = 8;
          const libcName = process.platform === "darwin" ? "libSystem.dylib" : "libc.so.6";
          const libc = koffi.load(libcName);
          const flockFn = libc.func("flock", "int", ["int", "int"]);
          const fd = fs.openSync(process.env.DEVFLOW_TEST_LOCK_PATH, "w");
          const result = flockFn(fd, LOCK_EX | LOCK_NB);
          console.log(JSON.stringify({ result, errno: koffi.errno() }));
          if (result === 0) flockFn(fd, LOCK_UN);
          fs.closeSync(fd);
          process.exit(result === 0 ? 0 : 2);
        `;

        const runRejectChild = () =>
          new Promise<{ code: number | null; result: number }>((resolve, reject) => {
            const child = spawn(process.execPath, ["-e", rejectScript], {
              cwd: repoRoot,
              env: cleanedEnv({ DEVFLOW_TEST_LOCK_PATH: lockPath }),
              stdio: ["ignore", "pipe", "ignore"],
            });
            let out = "";
            child.stdout.on("data", (chunk: Buffer) => {
              out += chunk.toString("utf8");
            });
            child.on("error", reject);
            child.on("exit", (code) => {
              try {
                const parsed = JSON.parse(out.trim().split("\n").pop() ?? "{}");
                resolve({ code, result: parsed.result });
              } catch (err) {
                reject(err instanceof Error ? err : new Error(String(err)));
              }
            });
          });

        const rejected = await runRejectChild();
        expect(rejected.code).toBe(2);
        expect(rejected.result).not.toBe(0);

        expect(flockFn(fd, LOCK_UN)).toBe(0);
        closeSync(fd);
        fd = undefined;

        const afterRelease = await runRejectChild();
        expect(afterRelease.code).toBe(0);
        expect(afterRelease.result).toBe(0);
      } finally {
        if (fd !== undefined) {
          try {
            closeSync(fd);
          } catch {}
        }
        libc.unload();
      }
    });
  });

  describe("Runner entry IPC", () => {
    function forkRunner() {
      const runnerEntry = resolveRunnerEntry();
      return fork(runnerEntry, [], {
        cwd: tmpDir,
        env: cleanedEnv(),
        execArgv: [],
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      });
    }

    function sendStart(child: ChildProcess, args: string[], extraEnv: Record<string, string> = {}) {
      child.send?.({
        type: "start",
        attempt_id: `att_${testSuffix}`,
        executable: process.execPath,
        args,
        cwd: tmpDir,
        env: cleanedEnv(extraEnv),
      });
    }

    it("spawn runner, receive ready, send start, receive started and exited", async () => {
      const child = forkRunner();
      const inbox = collectIpc(child);
      try {
        const ready = await waitForMessage(inbox, "ready");
        expect(ready.type).toBe("ready");

        sendStart(child, ["-e", "process.exit(0)"]);
        const started = await waitForMessage(inbox, "started");
        expect(started.pid).toBeTypeOf("number");
        expect(started.pid).toBeGreaterThan(0);

        const exited = await waitForMessage(inbox, "exited");
        expect(exited.code).toBe(0);
      } finally {
        killQuietly(child.pid);
        child.kill();
      }
    });

    it("stop via IPC terminates the tool and the runner observes exit", async () => {
      const child = forkRunner();
      const inbox = collectIpc(child);
      let toolPid: number | undefined;
      try {
        await waitForMessage(inbox, "ready");
        sendStart(child, ["-e", "setTimeout(() => {}, 60000)"]);
        const started = await waitForMessage(inbox, "started");
        toolPid = started.pid;
        expect(toolPid).toBeTypeOf("number");

        child.send?.({ type: "stop", attempt_id: `att_${testSuffix}` });

        const exited = await waitForMessage(inbox, "exited", 15000);
        expect(exited).toBeDefined();

        const dead = await waitForProcessExit(toolPid!, 5000);
        expect(dead).toBe(true);
      } finally {
        killQuietly(toolPid);
        killQuietly(child.pid);
        child.kill();
      }
    });

    it("IPC disconnect kills the tool", async () => {
      const child = forkRunner();
      const inbox = collectIpc(child);
      let toolPid: number | undefined;
      try {
        await waitForMessage(inbox, "ready");
        sendStart(child, ["-e", "setTimeout(() => {}, 60000)"]);
        const started = await waitForMessage(inbox, "started");
        toolPid = started.pid;
        expect(toolPid).toBeTypeOf("number");

        child.disconnect?.();

        const dead = await waitForProcessExit(toolPid!, 10000);
        expect(dead).toBe(true);
      } finally {
        killQuietly(toolPid);
        killQuietly(child.pid);
        try {
          child.kill();
        } catch {}
      }
    });
  });
});
