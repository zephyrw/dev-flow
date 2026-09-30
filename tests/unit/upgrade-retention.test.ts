import { it, expect, describe } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  planUninstallRetention,
  assertOldVersionSafeToClean,
} from "../../packages/installer/src/transaction.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "devflow-retain-"));
}

describe("U-12 uninstall retention", () => {
  it("keeps task data, business projects and account vault by default", () => {
    const root = tempRoot();
    try {
      const plan = planUninstallRetention({
        installRoot: root,
        storageRoot: join(root, "state"),
        workspaceRoot: join(root, "workspace"),
        accountVaultPaths: [join(root, "home", ".devflow-agy")],
      });
      const removeReasons = plan.remove.map((e) => e.reason);
      expect(removeReasons.every((r) => r.startsWith("app_"))).toBe(true);
      const keepPaths = plan.keep.map((e) => e.path);
      expect(keepPaths).toContain(join(root, "state"));
      expect(keepPaths).toContain(join(root, "workspace"));
      expect(keepPaths).toContain(join(root, "home", ".devflow-agy"));
      expect(plan.requires_explicit_consent).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("extra cleanup requires explicit separate authorization", () => {
    const root = tempRoot();
    try {
      const plan = planUninstallRetention({
        installRoot: root,
        storageRoot: join(root, "state"),
        accountVaultPaths: [join(root, "vault")],
        includeTaskData: true,
        includeAccountVault: true,
      });
      const consentPaths = plan.requires_explicit_consent.map((e) => e.path);
      expect(consentPaths).toContain(join(root, "state"));
      expect(consentPaths).toContain(join(root, "vault"));
      expect(plan.keep.map((e) => e.path)).not.toContain(join(root, "vault"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("U-11 old-version cleanup reference check", () => {
  it("refuses to delete a version still referenced by pointer or launcher", () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, "versions", "0.2.0"), { recursive: true });
      writeFileSync(
        join(root, "current.json"),
        JSON.stringify({ root: join(root, "versions", "0.2.0") }),
      );
      const check = assertOldVersionSafeToClean({
        installRoot: root,
        version: "0.2.0",
      });
      expect(check.safe).toBe(false);
      expect(check.references.length).toBeGreaterThan(0);

      // Point at a newer version → old one becomes a safe cleanup candidate.
      writeFileSync(
        join(root, "current.json"),
        JSON.stringify({ root: join(root, "versions", "0.3.0") }),
      );
      const clean = assertOldVersionSafeToClean({
        installRoot: root,
        version: "0.2.0",
      });
      expect(clean.safe).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects open-accounts.ps1 bootstrap bridge references", () => {
    const root = tempRoot();
    try {
      writeFileSync(
        join(root, "open-accounts.ps1"),
        `$devflowEntry = Join-Path 'versions\\0.1.0' 'open.js'\n`,
      );
      const check = assertOldVersionSafeToClean({
        installRoot: root,
        version: "0.1.0",
      });
      expect(check.safe).toBe(false);
      expect(check.references.some((p) => p.includes("open-accounts"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
