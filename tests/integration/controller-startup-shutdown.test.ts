import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { acquireControllerLock } from "../../packages/process/src/controller-lock.js";
import { getNativeAsync } from "../../packages/process/src/native/index.js";
import { setup } from "../helpers.js";

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected an assigned port");
  await new Promise<void>((yes, no) => server.close(error => error ? no(error) : yes()));
  return address.port;
}

it.each([
  { mode: "full", stop: "api" },
  { mode: "accounts", stop: "api" },
  { mode: "full", stop: "cli" },
  { mode: "accounts", stop: "cli" },
] as const)("the $mode controller records ownership before health succeeds and can shut down through $stop", async ({ mode, stop }) => {
  const s = setup();
  s.store.close();
  const port = await unusedPort();
  const origin = `http://localhost:${port}`;
  s.config.server = { host: "127.0.0.1", port, human_origin: origin };
  s.config.models.agy_executable = join(s.root, "missing-agy.exe");
  const config = join(s.root, "devflow.json");
  writeFileSync(config, JSON.stringify(s.config));
  const entry = resolve(process.env.DEVFLOW_BUILD_OUTDIR || "dist", "apps/api/src", mode === "full" ? "main.js" : "accounts-main.js");
  const child = spawn(process.execPath, [entry], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DEVFLOW_CONFIG: config, DEVFLOW_ACCOUNT_SCOPE: `startup-test-${process.pid}-${mode}` },
  });
  let output = "";
  child.stdout.on("data", chunk => { output = (output + chunk).slice(-32768); });
  child.stderr.on("data", chunk => { output = (output + chunk).slice(-32768); });
  let exited = false;
  const completed = new Promise<number | null>((yes, no) => {
    child.once("error", no);
    child.once("exit", code => { exited = true; yes(code); });
  });
  void completed.catch(() => {});
  try {
    const deadline = Date.now() + 60000;
    let healthy = false;
    while (Date.now() < deadline && !exited) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) { healthy = true; break; }
      } catch { /* The isolated controller has not bound its port yet. */ }
      await delay(50);
    }
    expect(healthy, output).toBe(true);
    const descriptor = JSON.parse(readFileSync(join(s.config.storage_root, "controller-process.json"), "utf8"));
    expect(descriptor).toMatchObject({ pid: child.pid, entry, mode, executable: process.execPath });
    const native = await getNativeAsync();
    expect(descriptor.creation_time).toBe(String(native.getProcessCreationTime(child.pid!)));
    if (stop === "cli") {
      const cli = resolve(process.env.DEVFLOW_BUILD_OUTDIR || "dist", "packages/cli/src/main.js");
      // Keep the parent event loop free to reap the controller on POSIX.
      const runStop = () => new Promise<{ status: number | null; stdout: string; stderr: string }>((yes, no) => {
        const command = spawn(process.execPath, [cli, "stop"], {
          windowsHide: true,
          timeout: 30000,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            DEVFLOW_CONFIG: config,
            DEVFLOW_INSTALL_ROOT: s.root,
            DEVFLOW_VERSION_ROOT: resolve(dirname(entry), "../../../.."),
          },
        });
        let stdout = "";
        let stderr = "";
        command.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
        command.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
        command.once("error", no);
        command.once("close", status => yes({ status, stdout, stderr }));
      });
      const record = join(s.config.storage_root, "controller-process.json");
      // A matching display timestamp must never authorize a different process identity.
      writeFileSync(record, JSON.stringify({ ...descriptor, started: descriptor.creation_time, creation_time: "stale-identity" }));
      const rejected = await runStop();
      expect(rejected.status, rejected.stdout).not.toBe(0);
      expect(rejected.stderr).toContain("无法确认控制器进程身份");
      expect((await fetch(`http://127.0.0.1:${port}/api/health`)).ok).toBe(true);
      writeFileSync(record, JSON.stringify(descriptor));
      const stopped = await runStop();
      expect(stopped.status, stopped.stderr).toBe(0);
      expect(stopped.stdout).toContain("DevFlow 服务已停止");
    } else {
      const response = await fetch(`http://127.0.0.1:${port}/api/maintenance/quiesce`, {
        method: "POST",
        headers: { origin, "content-type": "application/json", "sec-fetch-site": "same-origin" },
        body: JSON.stringify({ shutdown: true, on_active_tasks: "pause-and-update", transaction_id: "startup-regression" }),
        signal: AbortSignal.timeout(15000),
      });
      expect(response.status, await response.text()).toBe(200);
    }
    const stopDeadline = Date.now() + 15000;
    while (!exited && Date.now() < stopDeadline) await delay(50);
    expect(exited, output).toBe(true);
    expect(await completed, output).toBe(0);
    const unlock = await acquireControllerLock(s.config.storage_root);
    await unlock();
    expect(output).not.toMatch(/CRITICAL|Cannot access 'close'/);
  } finally {
    if (!exited) child.kill();
    await completed.catch(() => {});
    rmSync(s.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
