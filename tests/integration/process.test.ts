import { it, expect } from "vitest";
import { resolve, join } from "node:path";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { ProcessManager } from "../../packages/process/src/manager.js";
import { setup } from "../helpers.js";
import { acquireControllerLock } from "../../packages/process/src/controller-lock.js";
const host = resolve(
  "host/DevFlow.WinHost/bin/Release/net10.0-windows/DevFlow.WinHost.exe",
);
it("IT-08 Windows Host captures Unicode output and terminates job descendants on stop", async () => {
  expect(existsSync(host)).toBe(true);
  const s = setup();
  const manager = new ProcessManager(host, true);
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
    expect(performance.now() - started).toBeLessThan(5000);
    expect(output).toContain("你好 DevFlow");
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await manager.close();
    s.store.close();
  }
}, 45000);
it("IT-15 one controller owns each state directory and releases ownership on exit", async () => {
  const s = setup();
  const release = await acquireControllerLock(host, s.root);
  try {
    await expect(acquireControllerLock(host, s.root)).rejects.toThrow();
  } finally {
    await release();
  }
  const again = await acquireControllerLock(host, s.root);
  await again();
  s.store.close();
}, 20000);
it("IT-09 Host preserves large Chinese JSON stdin and escaped Windows paths byte-for-byte", async () => {
  const s = setup(),
    manager = new ProcessManager(host, true);
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
