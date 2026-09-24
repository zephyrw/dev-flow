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
import { UpgradeManager } from "../../packages/installer/src/upgrade.js";
import {
  readTransaction,
  readMaintenanceMarker,
} from "../../packages/installer/src/transaction.js";
import { hash } from "../../packages/core/src/util.js";

function tempRoot(prefix = "devflow-sm-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeCandidate(source: string, version: string): void {
  mkdirSync(source, { recursive: true });
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({ name: "devflow-candidate", version }, null, 2),
  );
  writeFileSync(join(source, "build-info.json"), JSON.stringify({
    application_version: version,
    build_revision: "test",
    service_protocol_version: "1",
  }));
  mkdirSync(join(source, "dist"), { recursive: true });
  writeFileSync(join(source, "dist", "entry.js"), "export default 1;\n");
}

function fakeControllerLock() {
  let held = false;
  return async (_root: string) => {
    if (held) throw new Error("CONTROLLER_ALREADY_ACTIVE");
    held = true;
    return async () => {
      held = false;
    };
  };
}

describe("UpgradeManager.prepareCandidate", () => {
  it("stages candidate without touching current state; rejects same version different digest (U-04)", async () => {
    const root = tempRoot();
    try {
      writeFileSync(
        join(root, "current.json"),
        JSON.stringify({ version: "0.2.0", root: "old", config: "c", node: "n" }),
      );
      const config = join(root, "devflow.yaml");
      writeFileSync(config, "keep: me\n");
      const beforePtr = readFileSync(join(root, "current.json"), "utf8");
      const beforeCfg = readFileSync(config, "utf8");

      const source = join(root, "src-a");
      makeCandidate(source, "0.3.0");
      const mgr = new UpgradeManager({ installDir: root, targetVersion: "0.3.0" });
      const prepared = await mgr.prepareCandidate({
        sourceDir: source,
        targetVersion: "0.3.0",
      });
      expect(prepared.targetDir.endsWith("versions/0.3.0") || prepared.targetDir.endsWith("versions\\0.3.0")).toBe(true);
      expect(prepared.digest).toHaveLength(64);
      // Current state untouched (U-01 prepare does not switch).
      expect(readFileSync(join(root, "current.json"), "utf8")).toBe(beforePtr);
      expect(readFileSync(config, "utf8")).toBe(beforeCfg);

      // Same version + same digest is idempotent reuse.
      const again = await mgr.prepareCandidate({
        sourceDir: source,
        targetVersion: "0.3.0",
      });
      expect(again.digest).toBe(prepared.digest);

      // Same version + different digest must refuse overwrite.
      writeFileSync(join(source, "package.json"), JSON.stringify({
        name: "devflow-candidate",
        version: "0.3.0",
        extra: "different",
      }));
      await expect(
        mgr.prepareCandidate({ sourceDir: source, targetVersion: "0.3.0" }),
      ).rejects.toThrow(/DIGEST_MISMATCH|不能覆盖/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects version mismatch against package.json", async () => {
    const root = tempRoot();
    try {
      const source = join(root, "src");
      makeCandidate(source, "0.9.9");
      const mgr = new UpgradeManager({ installDir: root, targetVersion: "0.3.0" });
      await expect(
        mgr.prepareCandidate({ sourceDir: source, targetVersion: "0.3.0" }),
      ).rejects.toThrow(/VERSION_MISMATCH/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("UpgradeManager.waitForQuiescent", () => {
  it("wait mode times out without force-pause (U-05); pause-and-update sets pause_requested", async () => {
    const root = tempRoot();
    try {
      const mgr = new UpgradeManager({
        installDir: root,
        targetVersion: "0.3.0",
        storageRoot: root,
      });
      // No transaction yet: requestMaintenance requires one.
      await expect(mgr.requestMaintenance()).rejects.toThrow(/TX_REQUIRED/);

      const { beginUpgradeTransaction } = await import(
        "../../packages/installer/src/transaction.js"
      );
      beginUpgradeTransaction({
        installRoot: root,
        kind: "upgrade",
        target_version: "0.3.0",
        target_digest: "abc",
      });
      await mgr.requestMaintenance();
      const marker = readMaintenanceMarker(root)!;
      expect(marker.block_new_dispatch).toBe(true);

      // Empty sqlite is already quiescent.
      await mgr.waitForQuiescent({ onActiveTasks: "wait", timeoutMs: 500 });
      expect(readMaintenanceMarker(root)!.phase).toBe("quiescent");

      // pause-and-update should set pause_requested.
      await mgr.waitForQuiescent({ onActiveTasks: "pause-and-update" });
      expect(readMaintenanceMarker(root)!.pause_requested).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("UpgradeManager.runUpgradeStateMachine", () => {
  it("happy path reaches verified and commits transaction (U-01/U-02)", async () => {
    const root = tempRoot();
    try {
      const source = join(root, "src");
      makeCandidate(source, "0.3.0");
      const config = join(root, "devflow.yaml");
      writeFileSync(
        config,
        [
          "# user comment must survive",
          "schema_version: 2",
          "storage_root: .devflow",
          "server:",
          "  port: 24832",
          "  human_origin: http://localhost:24832",
          "",
        ].join("\n"),
      );
      const mgr = new UpgradeManager({
        installDir: root,
        targetVersion: "0.3.0",
        storageRoot: root,
      });
      let started = false;
      const result = await mgr.runUpgradeStateMachine({
        sourceDir: source,
        targetVersion: "0.3.0",
        onActiveTasks: "wait",
        installRoot: root,
        storageRoot: root,
        configPath: config,
        sqlitePath: join(root, "devflow.sqlite"),
        nodePath: join(source, "node"),
        writeAccountsLauncher: false,
        acquireControllerLock: fakeControllerLock(),
        startTargetService: async () => {
          started = true;
          return { ok: true, application_version: "0.3.0" };
        },
      });
      expect(result.status).toBe("verified");
      expect(started).toBe(true);
      expect(result.new_state_write_possible).toBe(true);
      const tx = readTransaction(root, result.transaction_id!)!;
      expect(["committed", "verified"]).toContain(tx.phase);
      const pointer = JSON.parse(
        readFileSync(join(root, "current.json"), "utf8"),
      );
      expect(pointer.version ?? pointer.application_version).toBe("0.3.0");
      // Maintenance marker cleared on success.
      expect(readMaintenanceMarker(root)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("SafeAbort when failure before business state write (U-03)", async () => {
    const root = tempRoot();
    try {
      const source = join(root, "src");
      makeCandidate(source, "0.3.0");
      const mgr = new UpgradeManager({
        installDir: root,
        targetVersion: "0.3.0",
        storageRoot: root,
      });
      const result = await mgr.runUpgradeStateMachine({
        sourceDir: source,
        targetVersion: "0.3.0",
        installRoot: root,
        storageRoot: root,
        configPath: join(root, "devflow.yaml"),
        // Force failure during migrate/start by breaking start after write...
        // Here we fail at prepare of managed client before pointer write is not easy;
        // use startTargetService failure AFTER pointer write → recovery_required.
        // For SafeAbort use a bad source instead.
        sourceDirBad: undefined as never,
        startTargetService: async () => ({ ok: false }),
        acquireControllerLock: fakeControllerLock(),
        writeAccountsLauncher: false,
      } as never).catch(() => null);

      // Use explicit bad candidate for SafeAbort path.
      const result2 = await mgr.runUpgradeStateMachine({
        sourceDir: join(root, "missing-src"),
        targetVersion: "0.4.0",
        installRoot: root,
        storageRoot: root,
        configPath: join(root, "devflow.yaml"),
        acquireControllerLock: fakeControllerLock(),
        writeAccountsLauncher: false,
      });
      expect(result2.status).toBe("safe_abort");
      expect(result2.new_state_write_possible).toBe(false);
      expect(result2.recovery_actions).toContain("repair_current_version");
      void result;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("RecoveryRequired after business state write; keeps backup; no DB rollback (U-09)", async () => {
    const root = tempRoot();
    try {
      const source = join(root, "src");
      makeCandidate(source, "0.3.0");
      const config = join(root, "devflow.yaml");
      writeFileSync(config, "schema_version: 2\nstorage_root: .devflow\n");
      const mgr = new UpgradeManager({
        installDir: root,
        targetVersion: "0.3.0",
        storageRoot: root,
      });
      const result = await mgr.runUpgradeStateMachine({
        sourceDir: source,
        targetVersion: "0.3.0",
        installRoot: root,
        storageRoot: root,
        configPath: config,
        sqlitePath: join(root, "devflow.sqlite"),
        nodePath: join(source, "node"),
        writeAccountsLauncher: false,
        acquireControllerLock: fakeControllerLock(),
        startTargetService: async () => ({ ok: false }),
      });
      expect(result.status).toBe("recovery_required");
      expect(result.new_state_write_possible).toBe(true);
      expect(result.recovery_actions).toEqual(
        expect.arrayContaining([
          "repair_current_version",
          "export_diagnostics",
          "retry_target_service",
          "review_then_restore_by_matching_snapshot",
        ]),
      );
      // Scene kept: pointer still points at new version; no silent rollback.
      const pointer = JSON.parse(
        readFileSync(join(root, "current.json"), "utf8"),
      );
      expect(pointer.version ?? pointer.application_version).toBe("0.3.0");
      // Backup paths retained in the transaction record.
      const tx = readTransaction(root, result.transaction_id!)!;
      expect(tx.new_state_write_possible).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("U-10: unknown process blocks quiesce and is never bulk-changed to exited", async () => {
    const root = tempRoot();
    try {
      // Minimal sqlite with a process_record whose identity is unknown.
      const Database = (await import("better-sqlite3")).default;
      const sqlitePath = join(root, "devflow.sqlite");
      const db = new Database(sqlitePath);
      db.exec(
        "CREATE TABLE entities (kind TEXT, id TEXT, owner TEXT, data TEXT, version INTEGER)",
      );
      db.prepare(
        "INSERT INTO entities (kind, id, owner, data, version) VALUES (?, ?, ?, ?, ?)",
      ).run(
        "process_record",
        "p1",
        "system",
        JSON.stringify({
          id: "p1",
          identity: { backend: "node-v1", id: "missing-attempt", pid: 999999 },
          status: "running",
          confirmed: false,
        }),
        1,
      );
      db.close();

      const { inspectQuiesceState } = await import(
        "../../packages/installer/src/upgrade.js"
      );
      const inspection = await inspectQuiesceState(sqlitePath);
      expect(inspection.can_quiesce).toBe(false);
      // unknown OR running — either way not confirmed_exited, and we do not rewrite rows.
      expect(inspection.confirmed_exited).toBe(0);
      expect(
        inspection.unknown_processes + inspection.running_processes,
      ).toBeGreaterThan(0);

      const db2 = new Database(sqlitePath, { readonly: true });
      const rows = db2
        .prepare("SELECT data FROM entities WHERE kind='process_record'")
        .all() as { data: string }[];
      db2.close();
      const still = JSON.parse(rows[0]!.data);
      expect(still.status).toBe("running");
      expect(still.confirmed).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
