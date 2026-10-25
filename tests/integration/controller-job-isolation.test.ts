import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { getWindowsNative } from "../../packages/process/src/native/index.js";

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
