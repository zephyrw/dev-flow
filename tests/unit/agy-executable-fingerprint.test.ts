import { afterEach, expect, it, vi } from "vitest";
import { createReadStream, mkdtempSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { resolveAgyExecutable, resolveFingerprintedAgyExecutable, assertAgyExecutableUnchanged } from "../../packages/adapters/agy/src/executable-resolver.js";

vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, createReadStream: vi.fn(fs.createReadStream) };
});
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); vi.clearAllMocks(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "devflow-fingerprint-")); roots.push(root);
  const path = join(root, "agy.exe"); writeFileSync(path, "version-one"); return { root, path };
}
it("resolves paths without reading file contents and shares concurrent and warm fingerprint work", async () => {
  const { path } = fixture();
  expect(resolveAgyExecutable(path).resolvedPath).toBe(path);
  expect(createReadStream).not.toHaveBeenCalled();
  const results = await Promise.all(Array.from({ length: 8 }, () => resolveFingerprintedAgyExecutable(path)));
  expect(new Set(results.map(result => result.fingerprint))).toEqual(new Set([createHash("sha256").update("version-one").digest("hex")]));
  expect(createReadStream).toHaveBeenCalledTimes(1);
  expect((await resolveFingerprintedAgyExecutable(path)).fingerprint).toBe(results[0]!.fingerprint);
  expect(createReadStream).toHaveBeenCalledTimes(1);
  await expect(assertAgyExecutableUnchanged(results[0]!)).resolves.toBeUndefined();
});
it("invalidates a replaced executable and prevents starting the previously verified descriptor", async () => {
  const { root, path } = fixture(); const old = await resolveFingerprintedAgyExecutable(path);
  const next = join(root, "next.exe"); writeFileSync(next, "version-two"); renameSync(next, path);
  await expect(assertAgyExecutableUnchanged(old)).rejects.toThrow("agy_executable_changed");
  const current = await resolveFingerprintedAgyExecutable(path);
  expect(current.fingerprint).not.toBe(old.fingerprint);
  expect(createReadStream).toHaveBeenCalledTimes(2);
});
it("rejects non-files and missing explicit programs without fallback", async () => {
  const { root } = fixture();
  expect(await resolveFingerprintedAgyExecutable(root)).toMatchObject({ error: expect.any(String) });
  expect(await resolveFingerprintedAgyExecutable(join(root, "missing.exe"))).toMatchObject({ error: expect.any(String), source: "explicit_file" });
});
