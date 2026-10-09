// Internal candidate-only cleanup helper; refuses missing or mismatched persistent process identity.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
  if (process.platform === "win32") {
    // Anchor termination to a process handle; a recycled PID cannot redirect this action.
    const handle = native.openProcess(owned.pid, 0x00101001);
    if (!handle) return;
    try {
      assert.equal(String(native.getProcessCreationTime(owned.pid)), owned.creation_time);
      const { default: koffi } = await import(pathToFileURL(join(source, "node_modules/koffi/index.js")));
      const terminate = koffi.load("kernel32.dll").func("__stdcall", "TerminateProcess", "int", ["void *", "uint32"]);
      assert(terminate(handle, 0), "Owned controller termination failed");
    } finally { native.closeHandle(handle); }
  } else {
    assert.equal(String(native.getProcessCreationTime(owned.pid)), owned.creation_time);
    process.kill(owned.pid, "SIGTERM");
  }
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
