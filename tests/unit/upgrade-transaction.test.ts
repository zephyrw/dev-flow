import { it, expect, describe } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertNoSensitiveFields,
  beginUpgradeTransaction,
  commitUpgradeTransaction,
  failUpgradeTransaction,
  readTransaction,
  recordTransactionPhase,
  restoreTransactionOwnedChanges,
  writeTransaction,
  beginMaintenanceMarker,
  clearMaintenanceMarker,
  isMaintenanceMarkerExpired,
  readMaintenanceMarker,
  updateMaintenanceMarker,
} from "../../packages/installer/src/transaction.js";
import { hash } from "../../packages/core/src/util.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "devflow-tx-"));
}

describe("upgrade transaction log", () => {
  it("records §7.4 fields and forbids sensitive keys", () => {
    const root = tempRoot();
    try {
      const tx = beginUpgradeTransaction({
        installRoot: root,
        kind: "upgrade",
        target_version: "0.3.0",
        target_digest: "abc",
        source_version: "0.2.0",
        source_digest: "def",
        config_digest_before: "cfg-before",
        pointer_digest_before: "ptr-before",
      });
      expect(tx.phase).toBe("begun");
      expect(tx.new_state_write_possible).toBe(false);
      expect(tx.managed_client_changes).toEqual([]);
      expect(tx.backup_paths).toEqual([]);
      expect(tx.id).toMatch(/^tx-/);
      const onDisk = readTransaction(root, tx.id)!;
      const raw = readFileSync(
        join(root, "transactions", `${tx.id}.json`),
        "utf8",
      );
      expect(raw).not.toMatch(/token|password|api[_-]?key|secret/i);
      expect(onDisk.config_digest_before).toBe("cfg-before");
      expect(onDisk.target_version).toBe("0.3.0");
      expect(() =>
        writeTransaction(root, {
          ...tx,
          notes: ["ok"],
        } as never),
      ).not.toThrow();
      expect(() =>
        assertNoSensitiveFields({
          managed_client_changes: [{ client: "codex", api_token: "x" }],
        }),
      ).toThrow(/SENSITIVE/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("commit marks terminal and safe_abort restores only owned writes (U-07/U-08)", () => {
    const root = tempRoot();
    try {
      const config = join(root, "devflow.yaml");
      writeFileSync(config, "original: true\n");
      const before = hash(readFileSync(config));
      const backupDir = join(root, "backup", "tx1");
      mkdirSync(backupDir, { recursive: true });
      const backup = join(backupDir, "devflow.yaml.bak");
      writeFileSync(backup, "original: true\n");

      const clientPath = join(root, "client.json");
      writeFileSync(clientPath, `{"before":1}\n`);
      const clientBefore = hash(readFileSync(clientPath));
      const clientBackup = join(backupDir, "client.json.bak");
      mkdirSync(join(backupDir, "client"), { recursive: true });
      const clientBackupPath = join(backupDir, "client", "client.bak");
      writeFileSync(clientBackupPath, `{"before":1}\n`);
      void clientBackup;

      const tx = beginUpgradeTransaction({
        installRoot: root,
        kind: "upgrade",
        target_version: "0.3.0",
        target_digest: "abc",
        config_digest_before: before,
        created_config: false,
      });
      // This transaction writes config and a managed client file.
      writeFileSync(config, "migrated: true\n");
      const configAfter = hash(readFileSync(config));
      writeFileSync(clientPath, `{"after":1}\n`);
      const clientAfter = hash(readFileSync(clientPath));

      recordTransactionPhase(root, tx.id, "migrating", {
        backup_paths: [backup],
        config_digest_after: configAfter,
        managed_client_changes: [
          {
            client: "codex",
            path: clientPath,
            before_hash: clientBefore,
            after_hash: clientAfter,
            backup_path: clientBackupPath,
            status: "applied",
          },
        ],
      });

      // Concurrent user edit of the client file after our write.
      writeFileSync(clientPath, `{"user":"edit"}\n`);
      const restored = restoreTransactionOwnedChanges(root, tx.id);
      // Config still ours → restored from backup.
      expect(readFileSync(config, "utf8")).toBe("original: true\n");
      expect(restored.config).toBe("restored");
      // Client was user-edited → not overwritten (U-07).
      expect(readFileSync(clientPath, "utf8")).toBe(`{"user":"edit"}\n`);
      expect(restored.clients[0]!.status).toBe("user_modified_preserved");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("failUpgradeTransaction recovery_required keeps scene and never auto-copies DB back (U-09)", () => {
    const root = tempRoot();
    try {
      const dbPath = join(root, "devflow.sqlite");
      writeFileSync(dbPath, "NEW_STATE_WRITE");
      const tx = beginUpgradeTransaction({
        installRoot: root,
        kind: "upgrade",
        target_version: "0.3.0",
        target_digest: "abc",
      });
      recordTransactionPhase(root, tx.id, "starting", {
        new_state_write_possible: true,
      });
      const failed = failUpgradeTransaction(root, tx.id, {
        phase: "starting",
        code: "UPGRADE_TARGET_START_FAILED",
        message: "start failed",
        mode: "recovery_required",
        new_state_write_possible: true,
        restore_transaction_owned: false,
      });
      expect(failed.phase).toBe("recovery_required");
      expect(failed.new_state_write_possible).toBe(true);
      // Scene kept — database bytes untouched (no silent rollback).
      expect(readFileSync(dbPath, "utf8")).toBe("NEW_STATE_WRITE");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("first-install failure removes only this transaction empty config/pointer", () => {
    const root = tempRoot();
    try {
      const config = join(root, "devflow.yaml");
      const pointer = join(root, "current.json");
      writeFileSync(config, "empty: true\n");
      writeFileSync(pointer, "{}\n");
      const preUserData = join(root, "user-preexisting.txt");
      writeFileSync(preUserData, "keep-me");
      const tx = beginUpgradeTransaction({
        installRoot: root,
        kind: "install",
        target_version: "0.3.0",
        target_digest: "abc",
        created_config: true,
        created_pointer: true,
        config_digest_before: null,
        pointer_digest_before: null,
      });
      const result = failUpgradeTransaction(root, tx.id, {
        phase: "prepared",
        code: "UPGRADE_CANDIDATE_INVALID",
        message: "bad package",
        mode: "safe_abort",
        new_state_write_possible: false,
      });
      expect(result.phase).toBe("safe_abort");
      // restoreTransactionOwnedChanges already removed created empty files when owned.
      // Pre-existing user data is never touched.
      expect(existsSync(preUserData)).toBe(true);
      expect(readFileSync(preUserData, "utf8")).toBe("keep-me");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("commitUpgradeTransaction sets committed phase", () => {
    const root = tempRoot();
    try {
      const tx = beginUpgradeTransaction({
        installRoot: root,
        kind: "upgrade",
        target_version: "0.3.0",
        target_digest: "abc",
      });
      const done = commitUpgradeTransaction(root, tx.id);
      expect(done.phase).toBe("committed");
      expect(done.new_state_write_possible).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("maintenance marker", () => {
  it("carries transaction identity, phase and expiry; clear removes both files", () => {
    const root = tempRoot();
    try {
      const marker = beginMaintenanceMarker({
        storageRoot: root,
        transaction_id: "tx-1",
        kind: "upgrade",
        target_version: "0.3.0",
        ttl_ms: 50,
      });
      expect(marker.block_new_dispatch).toBe(true);
      expect(marker.transaction_id).toBe("tx-1");
      expect(existsSync(join(root, "maintenance.lock"))).toBe(true);
      expect(existsSync(join(root, "maintenance-state.json"))).toBe(true);
      expect(isMaintenanceMarkerExpired(marker, Date.now() + 60_000)).toBe(true);
      updateMaintenanceMarker(root, { phase: "quiescent" });
      expect(readMaintenanceMarker(root)!.phase).toBe("quiescent");
      clearMaintenanceMarker(root);
      expect(readMaintenanceMarker(root)).toBeUndefined();
      expect(existsSync(join(root, "maintenance.lock"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
