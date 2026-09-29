import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { removeDirWithBoundedRetry } from "../fixtures/isolation.js";
const identity = vi.hoisted(() => ({ creation: "native-start-identity" as string | null }));
vi.mock("../../packages/process/src/native/index.js", async (original) => ({
  ...await original<typeof import("../../packages/process/src/native/index.js")>(),
  getNative: () => ({ getProcessCreationTime: () => identity.creation }),
}));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  execFileSync: () => "2026-09-28T00:00:00.0000000Z",
}));
import { recordController } from "../../apps/api/src/controller-descriptor.js";

describe("controller descriptor ownership", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) removeDirWithBoundedRetry(root); identity.creation = "native-start-identity"; });
  it.each(["full", "accounts"] as const)("persists the %s controller identity with exact entry and executable on every platform", (mode) => {
    const root = mkdtempSync(join(tmpdir(), "controller-descriptor-")); roots.push(root);
    const entry = join(root, mode === "full" ? "main.js" : "accounts-main.js");
    recordController(root, entry, mode);
    expect(JSON.parse(readFileSync(join(root, "controller-process.json"), "utf8"))).toMatchObject({
      pid: process.pid, creation_time: identity.creation, executable: process.execPath, entry, mode,
      started: process.platform === "win32" ? "2026-09-28T00:00:00.0000000Z" : identity.creation,
    });
  });
  it("refuses a record without a native identity", () => {
    const root = mkdtempSync(join(tmpdir(), "controller-descriptor-")); roots.push(root);
    identity.creation = null;
    expect(() => recordController(root, join(root, "main.js"))).toThrow("CONTROLLER_IDENTITY_UNAVAILABLE");
    expect(existsSync(join(root, "controller-process.json"))).toBe(false);
  });
  it("preserves the existing record when native identity is unavailable", () => {
    const root = mkdtempSync(join(tmpdir(), "controller-descriptor-")); roots.push(root);
    const path = join(root, "controller-process.json");
    const previous = JSON.stringify({ pid: 123, creation_time: "previous-identity" });
    writeFileSync(path, previous);
    identity.creation = null;
    expect(() => recordController(root, join(root, "main.js"))).toThrow("CONTROLLER_IDENTITY_UNAVAILABLE");
    expect(readFileSync(path, "utf8")).toBe(previous);
  });
});
