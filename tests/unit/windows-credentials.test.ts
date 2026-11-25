import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "win32")("reads the Windows user SID without crashing the credential worker", () => {
  // A native access violation would otherwise take down the Vitest worker.
  expect(() => execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { createCredentialWindows } from "./packages/agy-accounts/src/credential-windows.ts";
    const native = createCredentialWindows();
    assert.match(native.getCurrentUserSid(), /^S-1-(?:\\d+-)*\\d+$/);
  `], { timeout: 5000, windowsHide: true })).not.toThrow();
});

it.skipIf(process.platform !== "win32")("enumerates Windows processes after reading the current user SID", () => {
  expect(() => execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { createWindowsNative } from "./packages/process/src/native/windows.ts";
    const inventory = createWindowsNative().listProcessInventory([]);
    assert.ok(inventory.some(item => item.pid === process.pid));
  `], { timeout: 5000, windowsHide: true })).not.toThrow();
});
