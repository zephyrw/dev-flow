import { expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { getWindowsNative } from "../../packages/process/src/native/index.js";
import { spawnWindowsBackground } from "../../packages/service/src/windows-background.js";

const brokerInput = vi.hoisted(() => ({ keepOpen: false }));
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args);
    if (brokerInput.keepOpen && args[0] === "powershell.exe" && child.stdin) {
      const input = child.stdin;
      // Reproduce a pipe whose writer stays open after the complete request.
      input.end = ((chunk: string | Uint8Array) => { input.write(chunk); return input; }) as typeof input.end;
    }
    return child;
  } };
});

it.skipIf(process.platform !== "win32").each([
  { name: "an open input pipe", keepOpen: true, foreignModules: false },
  { name: "foreign PowerShell modules", keepOpen: false, foreignModules: true },
])("starts from a framed UTF8 request with $name", async ({ keepOpen, foreignModules }) => {
  const root = mkdtempSync(join(tmpdir(), "devflow-broker-input-"));
  const value = "中文路径与引号 \"quoted\"\n第二行 & $value";
  let pid: number | undefined;
  try {
    brokerInput.keepOpen = keepOpen;
    if (foreignModules) {
      const modules = join(root, "modules");
      const utility = join(modules, "Microsoft.PowerShell.Utility");
      mkdirSync(utility, { recursive: true });
      writeFileSync(join(utility, "Microsoft.PowerShell.Utility.psd1"), "@{ RootModule = 'fake.psm1'; ModuleVersion = '1.0.0'; FunctionsToExport = @('ConvertFrom-Json') }");
      writeFileSync(join(utility, "fake.psm1"), "function ConvertFrom-Json { throw 'UNTRUSTED_MODULE_LOADED' }; Export-ModuleMember -Function ConvertFrom-Json");
      vi.stubEnv("PSModulePath", modules);
    }
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    pid = await spawnWindowsBackground(process.execPath, ["-e", "process.stdout.write(process.env.DEVFLOW_INPUT_PROBE)"], root,
      { ...env, DEVFLOW_INPUT_PROBE: value }, join(root, "stdout.log"), join(root, "stderr.log"));
    expect(pid).toBeGreaterThan(0);
    await expect.poll(() => existsSync(join(root, "stdout.log")) ? readFileSync(join(root, "stdout.log"), "utf8") : "").toBe(value);
  } finally {
    brokerInput.keepOpen = false;
    if (foreignModules) vi.unstubAllEnvs();
    if (pid) await expect.poll(() => { try { process.kill(pid!, 0); return true; } catch { return false; } }).toBe(false);
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}, 30000);

it.skipIf(process.platform !== "win32")("controller survives MCP host Job closure while an ordinary detached child does not", async () => {
  const root = mkdtempSync(join(tmpdir(), "devflow-controller-job-"));
  const native = await getWindowsNative();
  const job = native.createJob("devflow-lifecycle-" + crypto.randomUUID(), 0x2000 | 0x800)!;
  const owner = spawn(process.execPath, ["--import", "tsx", resolve("tests/fixtures/background-owner.ts")], { windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let child: { regular: number; isolated: number; error?: string } | undefined;
  let closed = false;
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    expect(native.assignProcessToJob(job, owner.pid!)).toBe(true);
    child = await new Promise<typeof child>((resolveChild, reject) => {
      const timer = setTimeout(() => reject(new Error("fixture timeout")), 20000);
      owner.once("error", reject);
      owner.once("message", value => { clearTimeout(timer); resolveChild(value as typeof child); });
      owner.send!({ root });
    });
    expect(child?.error).toBeUndefined();
    expect(native.isProcessInJob(child!.regular, job)).toBe(true);
    expect(native.isProcessInJob(child!.isolated, job)).toBe(false);
    await expect.poll(() => existsSync(join(root, "stdout.log")) ? readFileSync(join(root, "stdout.log"), "utf8") : "", { timeout: 15000 }).toContain("ready");
    native.closeHandle(job); closed = true;
    await expect.poll(() => alive(owner.pid!)).toBe(false);
    await expect.poll(() => alive(child!.regular)).toBe(false);
    expect(alive(child!.isolated)).toBe(true);
    expect(readFileSync(join(root, "stdout.log"), "utf8")).toContain("ready");
  } finally {
    if (!closed) native.closeHandle(job);
    if (child?.isolated && alive(child.isolated)) process.kill(child.isolated);
    if (alive(owner.pid!)) owner.kill();
    if (child?.isolated) await expect.poll(() => alive(child!.isolated)).toBe(false);
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}, 45000);
