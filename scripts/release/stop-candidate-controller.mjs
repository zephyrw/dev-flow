// Internal candidate-only cleanup helper; refuses missing or mismatched persistent process identity.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const source = resolve(process.argv[2]);
const install = resolve(process.argv[3]);
const native = await (await import(pathToFileURL(join(source, "dist/packages/process/src/native/index.js")))).getNativeAsync();
async function stopOwnedController() {
  const record = join(install, "state", "controller-process.json");
  if (!existsSync(record)) return;
  const owned = JSON.parse(readFileSync(record, "utf8"));
  const pointer = JSON.parse(readFileSync(join(install, "current.json"), "utf8"));
  const expectedRoot = join(install, "versions", pointer.version);
  assert.equal(resolve(pointer.root), expectedRoot);
  assert.equal(resolve(owned.entry), join(expectedRoot, "dist/apps/api/src/main.js"));
  assert.equal(resolve(owned.executable), join(expectedRoot, "runtime", process.platform === "win32" ? "node.exe" : "node"));
  assert(Number.isSafeInteger(owned.pid) && owned.pid > 1 && typeof owned.creation_time === "string", "Controller ownership missing");
  const current = native.getProcessCreationTime(owned.pid);
  if (current === null) return;
  assert.equal(String(current), owned.creation_time, "Controller PID was reused");
  // Exercise the same identity checks and graceful shutdown used by installed users.
  const executable = join(install, "bootstrap/runtime", process.platform === "win32" ? "node.exe" : "node");
  const entry = join(install, "bootstrap/entry.mjs");
  const stopped = spawnSync(executable, [entry, "stop"], {
    encoding: "utf8", windowsHide: true, timeout: 90000,
  });
  assert(!stopped.error, "Installed CLI stop failed: " + (stopped.error?.message ?? ""));
  assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout || "Installed CLI stop failed");
  for (let i = 0; i < 100; i++) {
    try {
      if (String(native.getProcessCreationTime(owned.pid)) !== owned.creation_time) return;
    } catch (error) {
      // A terminating macOS process can briefly hide its BSD identity while
      // still answering kill(0). Wait for kernel proof of exit; never kill an
      // unknown process or treat an unknown identity as successful cleanup.
      if (process.platform !== "darwin" || error?.message !== "PROCESS_IDENTITY_UNKNOWN") throw error;
    }
    await new Promise((yes) => setTimeout(yes, 100));
  }
  assert.fail("Owned controller did not exit with a confirmed identity");
}
await stopOwnedController();
