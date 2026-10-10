import { it, expect } from "vitest";
import { resolve, join } from "node:path";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { ProcessManager } from "../../packages/process/src/manager.js";
import { setup } from "../helpers.js";
import { acquireControllerLock } from "../../packages/process/src/controller-lock.js";
import { vi } from "vitest";

it("optional cleanup hooks finish before completion and retain the tool exit code", async () => {
  const s = setup(), manager = new ProcessManager();
  try {
    for (const exitCode of [0, 42]) {
      const order: string[] = [];
      const proc = manager.start({
        id: `cleanup-hook-${exitCode}-${crypto.randomUUID()}`,
        executable: process.execPath,
        args: ["-e", `process.exit(${exitCode})`],
        cwd: s.root, env: {}, timeout_ms: 15000,
      }, {
        onCleanupStart: () => { order.push("start"); },
        beforePipesClose: async () => {
          await new Promise(resolve => setTimeout(resolve, 25));
          order.push("cleaned");
        },
      });
      expect((await proc.completion).code).toBe(exitCode);
      order.push("completed");
      expect(order).toEqual(["start", "cleaned", "completed"]);
    }
  } finally {
    await manager.close();
    s.store.close();
  }
}, 45000);

it("an optional cleanup hook failure refuses successful completion", async () => {
  const lifecycle: Record<string, unknown>[] = [];
  const s = setup(), manager = new ProcessManager((_spec, event) => lifecycle.push(event));
  let failCleanup = true;
  const proc = manager.start({
    id: `cleanup-hook-failure-${crypto.randomUUID()}`,
    executable: process.execPath, args: ["-e", "process.exit(0)"],
    cwd: s.root, env: {}, timeout_ms: 15000,
  }, {
    beforePipesClose: async () => {
      if (failCleanup) throw new Error("owned cleanup refused password=must-not-leak");
    },
  });
  try {
    const error = await proc.completion.catch(error => error);
    expect(error).toMatchObject({
      code: "PROCESS_STOP_UNCONFIRMED",
      details: { cleanup_stage: "cleanup_hook", cleanup_reason: "cleanup_hook_failed" },
    });
    expect(String(error)).toContain("cleanup_hook_failed");
    expect(String(error)).not.toContain("must-not-leak");
    expect(lifecycle.at(-1)).toMatchObject({ status: "failed", confirmed: false, cleanup_reason: "cleanup_hook_failed" });
    expect(JSON.stringify(lifecycle)).not.toContain("must-not-leak");
    expect(manager.list()).toContain(proc.id);
    // Join the current failed cleanup before retrying this fixture's final cleanup.
    await proc.stop().catch(() => {});
    expect((await manager.stop(proc.id)).status).toBe("unknown");
  } finally {
    failCleanup = false;
    await manager.close();
    s.store.close();
  }
}, 45000);

function resolvePowerShell(): string | null {
  const checkPwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" });
  if (!checkPwsh.error && checkPwsh.status === 0) return "pwsh";
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      const localPwsh = join(localAppData, "Programs", "PowerShell", "7", "pwsh.exe");
      if (existsSync(localPwsh)) return localPwsh;
    }
    const programFiles = process.env.ProgramFiles;
    if (programFiles) {
      const pfPwsh = join(programFiles, "PowerShell", "7", "pwsh.exe");
      if (existsSync(pfPwsh)) return pfPwsh;
    }
    const sysRoot = process.env.SystemRoot ?? "C:\\Windows";
    const winPs = join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (existsSync(winPs)) return winPs;
    return "powershell.exe";
  }
  return null;
}

it("managed PowerShell executes a batch program with Windows runtime variables while secrets stay excluded", async () => {
  const shell = resolvePowerShell();
  if (!shell || process.platform !== "win32") return;
  const s = setup(),
    manager = new ProcessManager();
  const batch = join(s.root, "probe.cmd");
  writeFileSync(batch, "@echo off\r\necho batch-really-ran\r\nexit /b 7\r\n");
  vi.stubEnv("DEVFLOW_PRIVATE_SECRET", "must-not-leak");
  vi.stubEnv("JAVA_HOME", "C:\\synthetic-java-runtime");
  try {
    const proc = manager.start({
      id: "batch-" + crypto.randomUUID(),
      executable: shell,
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ErrorActionPreference='Stop'; if ($env:DEVFLOW_PRIVATE_SECRET) { throw 'secret leaked' }; if ($env:JAVA_HOME -ne 'C:\\synthetic-java-runtime') { throw 'runtime missing' }; & '${batch.replaceAll("'", "''")}'; exit $LASTEXITCODE`,
      ],
      cwd: s.root,
      env: {},
      timeout_ms: 15000,
    });
    let output = "";
    proc.on("stdout", (b) => (output += b.toString()));
    expect((await proc.completion).code).toBe(7);
    expect(output).toContain("batch-really-ran");
  } finally {
    vi.unstubAllEnvs();
    await manager.close();
    s.store.close();
  }
});
it("IT-08 Windows Host captures Unicode output and terminates job descendants on stop", async () => {
  const s = setup();
  const manager = new ProcessManager();
  const childScript = join(s.root, "child.cjs");
  writeFileSync(childScript, "setInterval(()=>{},1000);");
  const marker = join(s.root, "pid.txt");
  const script = join(s.root, "parent.cjs");
  writeFileSync(
    script,
    `const cp=require('node:child_process');const fs=require('node:fs');const child=cp.spawn(process.execPath,[${JSON.stringify(childScript)}],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(marker)},String(child.pid));console.log('你好 DevFlow');setInterval(()=>{},1000);`,
  );
  const proc = manager.start({
    id: "tree-test",
    executable: process.execPath,
    args: [script],
    cwd: s.root,
    env: {},
    timeout_ms: 30000,
  });
  let output = "";
  proc.on("stdout", (b: Buffer) => (output += b.toString("utf8")));
  try {
    await new Promise<void>((ready, fail) => {
      const timer = setTimeout(
        () => fail(Error("Host 子进程未在 20 秒内就绪")),
        20000,
      );
      proc.on("stdout", () => {
        if (output.includes("你好 DevFlow")) {
          clearTimeout(timer);
          ready();
        }
      });
      void proc.completion.then(() => {
        clearTimeout(timer);
        fail(Error("子进程在就绪前退出"));
      }, fail);
    });
    expect(existsSync(marker)).toBe(true);
    const pid = Number(readFileSync(marker, "utf8"));
    const started = performance.now();
    await proc.stop();
    // POSIX gives the group 5 seconds for graceful shutdown before SIGKILL.
    expect(performance.now() - started).toBeLessThan(process.platform === "win32" ? 5000 : 15000);
    expect(output).toContain("你好 DevFlow");
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await manager.close();
    s.store.close();
  }
}, 45000);
it("IT-15 one controller owns each state directory and releases ownership on exit", async () => {
  const s = setup();
  const release = await acquireControllerLock(s.root);
  try {
    await expect(acquireControllerLock(s.root)).rejects.toThrow();
  } finally {
    await release();
  }
  const again = await acquireControllerLock(s.root);
  await again();
  s.store.close();
}, 20000);
it("IT-09 Host preserves large Chinese JSON stdin and escaped Windows paths byte-for-byte", async () => {
  const s = setup(),
    manager = new ProcessManager();
  const value = JSON.stringify({
    text: '中文"嵌套引号"\\路径\n'.repeat(10000),
    id: crypto.randomUUID(),
  });
  const proc = manager.start({
    id: "stdin-" + crypto.randomUUID(),
    executable: process.execPath,
    args: ["-e", "process.stdin.pipe(process.stdout)"],
    cwd: s.root,
    env: {},
    timeout_ms: 15000,
    stdin: value,
  });
  const output: Buffer[] = [];
  proc.on("stdout", (b: Buffer) => output.push(b));
  try {
    expect((await proc.completion).code).toBe(0);
    expect(Buffer.concat(output)).toEqual(Buffer.from(value));
  } finally {
    await manager.close();
    s.store.close();
  }
}, 20000);
