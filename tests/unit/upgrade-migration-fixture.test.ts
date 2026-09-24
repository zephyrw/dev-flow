import { it, expect, describe } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateAccountConfiguration } from "../../packages/installer/src/upgrade.js";
import { dryRunMigration } from "../../packages/contracts/src/config-migration.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "devflow-mig-"));
}

/** Synthetic schema 1 fixture (not a real release package). */
const SCHEMA1 = `# 用户注释必须保留
schema_version: 1
storage_root: .devflow
server:
  port: 24832
  human_origin: http://localhost:24832
host:
  executable: dist/host/devflow-host.exe
  required: true
  # host 注释
agy_accounts:
  auth_host_executable: dist/host/devflow-auth-host.exe
`;

describe("U-06 schema 1 config migration fixture", () => {
  it("backs up, preserves comments, removes legacy host fields, rejects illegal Host", () => {
    const root = tempRoot();
    try {
      const config = join(root, "devflow.yaml");
      writeFileSync(config, SCHEMA1);

      // dryRun must report can_apply for this synthetic valid legacy file.
      const preview = dryRunMigration(config);
      expect(preview.can_apply).toBe(true);

      const result = migrateAccountConfiguration(config);
      expect(result.changed).toBe(true);
      // Backup produced by applyMigration.
      expect(result.backup).toBeTruthy();
      expect(existsSync(result.backup!)).toBe(true);

      const migrated = readFileSync(config, "utf8");
      // Comment preserved (§7.5 hash-check + comment protection).
      expect(migrated).toContain("用户注释必须保留");
      // schema bumped; legacy host keys removed (no hand-written second regex pass).
      expect(migrated).toMatch(/schema_version:\s*2/);
      expect(migrated).not.toMatch(/^\s*host:/m);
      expect(migrated).not.toContain("auth_host_executable");
      // No new Host fields invented.
      expect(migrated).not.toMatch(/^\s*host:/m);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("illegal/custom historical Host is explicitly rejected, not silently rewritten", () => {
    const root = tempRoot();
    try {
      const config = join(root, "devflow.yaml");
      writeFileSync(
        config,
        `schema_version: 1\nstorage_root: .devflow\nhost:\n  name: custom-evil\n  path: C:\\\\evil\\\\host.exe\n`,
      );
      const preview = dryRunMigration(config);
      // Custom/unknown Host must not be silently normalized into the new architecture.
      expect(preview.can_apply).toBe(false);
      expect(
        preview.errors.join(" ") + preview.warnings.join(" "),
      ).toMatch(/HOST|CUSTOM|LEGACY|UNSUPPORTED|INVALID/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
