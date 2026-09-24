import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  copyFileSync,
  rmSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  applyMigration,
  dryRunMigration,
} from "../../contracts/src/config-migration.js";
import { observeProcessRecord } from "../../process/src/process-protocol.js";
import { acquireControllerLock } from "../../process/src/controller-lock.js";
import Database from "better-sqlite3";
import { atomicWrite, hash, now } from "../../core/src/util.js";
import {
  assertNoSensitiveFields,
  assertOldVersionSafeToClean,
  beginMaintenanceMarker,
  beginUpgradeTransaction,
  backupFileCopy,
  clearMaintenanceMarker,
  commitUpgradeTransaction,
  failUpgradeTransaction,
  digestFile,
  planUninstallRetention,
  readMaintenanceMarker,
  readTransaction,
  recordTransactionPhase,
  updateMaintenanceMarker,
  writeTransaction,
  type ManagedClientChange,
  type UpgradePhase,
  type UpgradeTransaction,
} from "./transaction.js";

export interface UpgradeOptions {
  installDir: string;
  targetVersion: string;
  backupDir?: string;
  /** Where `current.json` and versions/ live. Defaults to installDir. */
  installRoot?: string;
  storageRoot?: string;
  transactionsDir?: string;
  /** Local service identity endpoint used by requestMaintenance. */
  serviceOrigin?: string;
}

export class UpgradeManager {
  constructor(private options: UpgradeOptions) {}

  private get installRoot(): string {
    return this.options.installRoot ?? this.options.installDir;
  }

  async assertQuiescent(sqlitePath: string): Promise<void> {
    const inspection = await inspectQuiesceState(sqlitePath);
    if (!inspection.can_quiesce) {
      if (inspection.unknown_processes > 0)
        throw new Error(
          "UPGRADE_PROCESS_STATE_UNKNOWN: 请先完成旧进程停止和恢复对账（勿把 unknown 批量改成 exited）",
        );
      if (inspection.active_leases > 0)
        throw new Error("UPGRADE_ACTIVE_LEASE: 请先完成任务停止和资源对账");
      throw new Error(
        "UPGRADE_NOT_QUIESCENT: " + (inspection.blockers.join("; ") || "未静默"),
      );
    }
  }

  async backupData(sqlitePath: string): Promise<string | undefined> {
    if (!existsSync(sqlitePath)) return undefined;
    const target = join(
      this.options.backupDir ?? join(this.options.installDir, "backup"),
      "devflow-" + Date.now() + ".db",
    );
    mkdirSync(dirname(target), { recursive: true });
    const db = new Database(sqlitePath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      await db.backup(target);
      return target;
    } finally {
      db.close();
    }
  }

  atomicSwitchCurrent(meta: Record<string, unknown>) {
    try {
      atomicWrite(
        join(this.options.installDir, "current.json"),
        JSON.stringify(meta, null, 2),
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * §7.2 / U-04: stage and verify the candidate package without touching
   * current.json, config, or the database.
   */
  async prepareCandidate(meta: {
    sourceDir: string;
    targetVersion: string;
  }): Promise<{ targetDir: string; digest: string }> {
    const source = meta.sourceDir;
    if (!existsSync(join(source, "package.json")))
      throw new Error("UPGRADE_CANDIDATE_INVALID: 候选包缺少 package.json");
    const pkg = JSON.parse(
      readFileSync(join(source, "package.json"), "utf8"),
    ) as { version?: string };
    if (pkg.version && pkg.version !== meta.targetVersion)
      throw new Error(
        `UPGRADE_CANDIDATE_VERSION_MISMATCH: package.json ${pkg.version} != ${meta.targetVersion}`,
      );

    const identityFiles = [
      "package.json",
      "build-info.json",
      "compatibility.json",
    ];
    const present = identityFiles.filter((p) => existsSync(join(source, p)));
    if (!present.length)
      throw new Error("UPGRADE_CANDIDATE_INVALID: 候选包缺少身份文件");
    const digest = hash(
      present
        .map((p) => p + ":" + createHash("sha256").update(readFileSync(join(source, p))).digest("hex"))
        .join("\n"),
    );

    const versionsDir = join(this.installRoot, "versions");
    const targetDir = join(versionsDir, meta.targetVersion);
    const receiptPath = join(targetDir, "install-source.json");

    if (existsSync(receiptPath)) {
      const receipt = JSON.parse(
        readFileSync(receiptPath, "utf8"),
      ) as { digest?: string; version?: string };
      if (receipt.digest && receipt.digest !== digest) {
        // U-04: same version + different digest must refuse overwrite.
        throw new Error(
          "UPGRADE_SAME_VERSION_DIGEST_MISMATCH: 现有版本内容不同，不能覆盖正在使用的安装目录",
        );
      }
      return { targetDir, digest: receipt.digest ?? digest };
    }

    if (existsSync(targetDir) && !existsSync(receiptPath))
      throw new Error(
        "UPGRADE_TARGET_DIR_CONFLICT: 目标版本目录已存在但缺少收据，拒绝覆盖",
      );

    mkdirSync(targetDir, { recursive: true });
    copyTreeShallow(source, targetDir);
    atomicWrite(
      receiptPath,
      JSON.stringify(
        {
          version: meta.targetVersion,
          digest,
          source: "prepareCandidate",
          created_at: now(),
        },
        null,
        2,
      ),
    );
    return { targetDir, digest };
  }

  /**
   * §7.2: request maintenance preparation. Does NOT take the controller lock
   * (lock-order red line: service still owns it until it exits).
   */
  async requestMaintenance(): Promise<void> {
    const storageRoot = this.options.storageRoot ?? this.installRoot;
    // Best-effort local identity check via health endpoint when provided.
    if (this.options.serviceOrigin) {
      try {
        const health = await fetch(
          new URL("/api/health", this.options.serviceOrigin),
          { method: "GET", headers: { accept: "application/json" } },
        );
        if (health.ok) {
          const body = (await health.json()) as Record<string, unknown>;
          if (body.service === "devflow") {
            await fetch(
              new URL("/api/maintenance/prepare", this.options.serviceOrigin),
              {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  origin: this.options.serviceOrigin,
                },
                body: JSON.stringify({
                  transaction_id: readLatestTransactionId(this.installRoot),
                  target_version: this.options.targetVersion,
                }),
              },
            ).catch(() => undefined);
          }
        }
      } catch {
        /* Offline service: marker alone is still valid for a cold upgrade. */
      }
    }
    const txId = readLatestTransactionId(this.installRoot);
    if (!txId)
      throw new Error(
        "UPGRADE_TX_REQUIRED: requestMaintenance 需要先 beginUpgradeTransaction",
      );
    if (!readMaintenanceMarker(storageRoot)) {
      beginMaintenanceMarker({
        storageRoot,
        transaction_id: txId,
        kind: "upgrade",
        target_version: this.options.targetVersion,
      });
    } else {
      updateMaintenanceMarker(storageRoot, {
        block_new_dispatch: true,
        phase: "requested",
      });
    }
  }

  /**
   * §7.2 / U-05 / U-10: block new dispatch, optionally pause, wait for exit.
   * Never force-pauses under "wait". Never batch-converts unknown → exited.
   */
  async waitForQuiescent(options: {
    onActiveTasks: "wait" | "pause-and-update";
    sqlitePath?: string;
    timeoutMs?: number;
    pauseCallback?: () => Promise<void>;
    pollIntervalMs?: number;
  }): Promise<void> {
    const storageRoot = this.options.storageRoot ?? this.installRoot;
    const sqlitePath =
      options.sqlitePath ?? join(storageRoot, "devflow.sqlite");
    const marker = readMaintenanceMarker(storageRoot);
    if (!marker) throw new Error("MAINTENANCE_MARKER_MISSING");
    updateMaintenanceMarker(storageRoot, {
      block_new_dispatch: true,
      on_active_tasks: options.onActiveTasks,
      phase: "waiting_for_idle",
      pause_requested: options.onActiveTasks === "pause-and-update",
    });

    if (options.onActiveTasks === "pause-and-update" && options.pauseCallback)
      await options.pauseCallback();

    const timeout = options.timeoutMs ?? 120_000;
    const interval = options.pollIntervalMs ?? 200;
    const deadline = Date.now() + timeout;
    for (;;) {
      const inspection = await inspectQuiesceState(sqlitePath);
      if (inspection.can_quiesce) break;
      if (inspection.unknown_processes > 0) {
        // U-10: unknown is a blocker with reconciliation guidance, not a bulk edit.
        throw new Error(
          "UPGRADE_PROCESS_STATE_UNKNOWN: " +
            inspection.blockers.join("; ") +
            "；请运行恢复对账（勿将 unknown 批量改为 exited）",
        );
      }
      if (options.onActiveTasks === "wait" && Date.now() > deadline)
        throw new Error(
          "UPGRADE_QUIESCE_TIMEOUT: 等待任务结束超时（未选择暂停并更新，不强制打断）",
        );
      await new Promise((r) => setTimeout(r, interval));
    }
    await this.assertQuiescent(sqlitePath);
    updateMaintenanceMarker(storageRoot, { phase: "quiescent" });
  }

  /**
   * §7.3 state machine: Prepared→(WaitingForIdle)→Quiescent→BackedUp→Migrating→Starting→Verified
   * Failure branches: SafeAbort (no business state written) / RecoveryRequired.
   */
  async runUpgradeStateMachine(options: UpgradeStateMachineOptions): Promise<UpgradeResult> {
    const installRoot = options.installRoot ?? this.installRoot;
    const storageRoot = options.storageRoot ?? this.options.storageRoot ?? installRoot;
    const sqlitePath = options.sqlitePath ?? join(storageRoot, "devflow.sqlite");
    const configPath = options.configPath ?? join(installRoot, "devflow.yaml");
    const pointerPath = join(installRoot, "current.json");
    const acquire = options.acquireControllerLock ?? acquireControllerLock;

    const sourceVersion =
      options.sourceVersion ??
      (existsSync(pointerPath)
        ? (JSON.parse(readFileSync(pointerPath, "utf8")) as {
            application_version?: string;
            version?: string;
          }).application_version
        : undefined);

    const created_config = !existsSync(configPath);
    const created_pointer = !existsSync(pointerPath);
    const config_digest_before = digestFile(configPath);
    const pointer_digest_before = digestFile(pointerPath);

    let phase: UpgradePhase = "begun";
    let tx: UpgradeTransaction | undefined;
    let targetDir: string | undefined;
    let digest: string | undefined;
    let backupPaths: string[] = [];
    let new_state_write_possible = false;
    let release: (() => Promise<void>) | undefined;
    let markerHeld = false;

    try {
      // Prepared: candidate first — must not change current state.
      phase = "prepared";
      const candidate = await this.prepareCandidate({
        sourceDir: options.sourceDir,
        targetVersion: options.targetVersion,
      });
      targetDir = candidate.targetDir;
      digest = candidate.digest;

      tx = beginUpgradeTransaction({
        installRoot,
        kind: options.kind ?? (created_config && created_pointer ? "install" : "upgrade"),
        target_version: options.targetVersion,
        target_digest: digest,
        source_version: sourceVersion,
        source_digest: options.sourceDigest,
        config_digest_before,
        pointer_digest_before,
        created_config,
        created_pointer,
      });
      recordTransactionPhase(installRoot, tx.id, "prepared", {
        target_digest: digest,
      });

      // Maintenance handover BEFORE controller lock (§7.2 red line).
      phase = "waiting_for_idle";
      await this.requestMaintenance();
      markerHeld = true;
      await this.waitForQuiescent({
        onActiveTasks: options.onActiveTasks ?? "wait",
        sqlitePath,
        timeoutMs: options.timeoutMs,
        pauseCallback: options.pauseActiveTasks,
        pollIntervalMs: options.pollIntervalMs,
      });
      recordTransactionPhase(installRoot, tx.id, "quiescent");

      // Only after confirmed stop: take controller lock and switch.
      phase = "backed_up";
      release = await acquire(storageRoot);
      const backup = await this.backupData(sqlitePath);
      if (backup) backupPaths.push(backup);
      const configBackup = backupFileCopyIf(configPath, join(installRoot, "backup", "tx", tx.id), "devflow.yaml");
      if (configBackup) backupPaths.push(configBackup);
      const pointerBackup = backupFileCopyIf(pointerPath, join(installRoot, "backup", "tx", tx.id), "current.json");
      if (pointerBackup) backupPaths.push(pointerBackup);
      recordTransactionPhase(installRoot, tx.id, "backed_up", {
        backup_paths: backupPaths,
      });

      phase = "migrating";
      if (existsSync(configPath)) {
        try {
          migrateAccountConfiguration(configPath);
        } catch (error) {
          // Illegal/custom historical Host: explicit report, never silent rewrite.
          throw Object.assign(
            new Error(
              "UPGRADE_CONFIG_MIGRATION: " +
                (error as Error).message +
                "（历史 Host/自定义项按既有校验策略拒绝，不静默恢复旧架构）",
            ),
            { code: "UPGRADE_CONFIG_MIGRATION" },
          );
        }
      }
      recordTransactionPhase(installRoot, tx.id, "migrating");

      // Managed client changes (U-08): each with before/after hash + backup.
      const clientChanges: ManagedClientChange[] = [];
      for (const change of options.managedClients ?? []) {
        const before_hash = digestFile(change.path);
        const backup_path = before_hash
          ? backupFileCopy(change.path, join(installRoot, "backup", "tx", tx.id, "client"), change.client)
          : undefined;
        const applied = await change.apply();
        const after_hash = digestFile(change.path);
        clientChanges.push({
          client: change.client,
          path: change.path,
          before_hash: before_hash ?? undefined,
          after_hash: after_hash ?? undefined,
          backup_path,
          status: "applied",
          note: applied?.note,
        });
        // Leave no entry pointing at a nonexistent version (U-08).
        if (after_hash && targetDir && change.checkTargetRef) {
          const text = readFileSync(change.path, "utf8");
          if (text.includes(options.targetVersion) && !existsSync(targetDir))
            throw new Error(
              `UPGRADE_CLIENT_REF_MISSING: ${change.client} 指向不存在的版本目录`,
            );
        }
      }

      // Pointer write: after this, business state may become writable.
      const pointerMeta = {
        version: options.targetVersion,
        application_version: options.targetVersion,
        root: targetDir,
        config: configPath,
        node: options.nodePath ?? join(targetDir, "node", "node.exe"),
        build_revision: digest,
        updated_at: now(),
      };
      if (!this.atomicSwitchCurrent(pointerMeta))
        throw new Error("UPGRADE_POINTER_WRITE_FAILED");
      new_state_write_possible = true;
      const pointer_digest_after = digestFile(pointerPath);
      const config_digest_after = digestFile(configPath);
      recordTransactionPhase(installRoot, tx.id, "starting", {
        new_state_write_possible: true,
        managed_client_changes: clientChanges,
        pointer_digest_after,
        config_digest_after,
      });

      phase = "starting";
      if (release) {
        await release();
        release = undefined;
      }
      if (options.startTargetService) {
        const started = await options.startTargetService();
        if (!started.ok)
          throw new Error("UPGRADE_TARGET_START_FAILED: 目标版本服务启动失败");
        if (
          started.application_version &&
          started.application_version !== options.targetVersion
        )
          throw new Error(
            `UPGRADE_TARGET_VERSION_MISMATCH: 服务报告 ${started.application_version} != ${options.targetVersion}`,
          );
      }

      phase = "verified";
      recordTransactionPhase(installRoot, tx.id, "verified", {
        new_state_write_possible: true,
      });
      if (options.writeAccountsLauncher !== false)
        writeAccountsLauncher(installRoot);
      commitUpgradeTransaction(installRoot, tx.id);
      if (markerHeld) clearMaintenanceMarker(storageRoot);

      // U-11: keep at least one known-good version; report safe clean targets.
      const cleanup = listSafeOldVersions(installRoot, options.targetVersion);

      return {
        status: "verified",
        transaction_id: tx.id,
        phase: "verified",
        target_version: options.targetVersion,
        target_digest: digest,
        target_dir: targetDir,
        backup_paths: backupPaths,
        new_state_write_possible: true,
        cleanup_candidates: cleanup,
        recovery_actions: [],
      };
    } catch (error) {
      const message = (error as Error).message || String(error);
      const code =
        (error as { code?: string }).code ??
        classifyUpgradeErrorCode(message);
      const safeAbort = !new_state_write_possible;
      try {
        failUpgradeTransaction(installRoot, tx?.id ?? "", {
          phase,
          code,
          message,
          mode: safeAbort ? "safe_abort" : "recovery_required",
          new_state_write_possible,
        });
      } catch {
        /* transaction may not exist if prepareCandidate failed first */
      }
      if (markerHeld) {
        try {
          if (safeAbort) clearMaintenanceMarker(storageRoot);
          else
            updateMaintenanceMarker(storageRoot, {
              phase: "recovery_required",
            });
        } catch {
          /* marker cleanup is best-effort on the failure path */
        }
      }
      // First-install failure: remove only this transaction's empty config/pointer.
      if (safeAbort && created_config && existsSync(configPath)) {
        try {
          rmSync(configPath, { force: true });
        } catch {
          /* leave if not removable */
        }
      }
      if (safeAbort && created_pointer && existsSync(pointerPath)) {
        try {
          rmSync(pointerPath, { force: true });
        } catch {
          /* leave if not removable */
        }
      }
      return {
        status: safeAbort ? "safe_abort" : "recovery_required",
        transaction_id: tx?.id,
        phase,
        target_version: options.targetVersion,
        target_digest: digest,
        target_dir: targetDir,
        backup_paths: backupPaths,
        new_state_write_possible,
        error: { code, message },
        recovery_actions: safeAbort
          ? ["repair_current_version", "retry_upgrade"]
          : [
              "repair_current_version",
              "export_diagnostics",
              "retry_target_service",
              "review_then_restore_by_matching_snapshot",
            ],
      };
    } finally {
      if (release) await release();
    }
  }
}

// Keep the historical free functions (Stream E / main.ts depend on these names).
export function migrateAccountConfiguration(configPath: string) {
  const preview = dryRunMigration(configPath);
  if (!preview.can_apply) throw new Error(preview.errors.join(","));
  const result = applyMigration(configPath, preview.input_hash);
  if (!result.success) throw new Error(result.errors.join(","));
  return {
    changed: result.input_hash !== result.output_hash,
    backup: result.backup_path,
  };
}

/** This stable entry resolves current.json each time instead of pinning a version. */
export function writeAccountsLauncher(
  installRoot: string,
  platform = process.platform,
) {
  if (platform !== "win32") return;
  const script = `param()
$ErrorActionPreference = 'Stop'
try {
  $devflowCurrent = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'current.json') | ConvertFrom-Json
  $env:DEVFLOW_CONFIG = [string]$devflowCurrent.config
  $devflowEntry = Join-Path ([string]$devflowCurrent.root) 'dist/packages/service/src/open.js'
  if (!(Test-Path -LiteralPath $devflowEntry)) { throw 'Account entry is missing. Complete the DevFlow update first.' }
  Set-Location -LiteralPath ([string]$devflowCurrent.root)
  & ([string]$devflowCurrent.node) $devflowEntry --accounts
  if ($LASTEXITCODE -ne 0) { throw 'Account service could not start. See the controller log; an incompatible service may already own the port.' }
} catch {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show($_.Exception.Message, 'DevFlow AGY Accounts') | Out-Null
  exit 1
}
`;
  atomicWrite(join(installRoot, "open-accounts.ps1"), script);
  atomicWrite(
    join(installRoot, "打开 AGY 账号管理.vbs"),
    `Option Explicit
Dim shell, fs, script
Set shell = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
script = fs.BuildPath(fs.GetParentFolderName(WScript.ScriptFullName), "open-accounts.ps1")
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & script & """", 0, False
`,
  );
}

// ---------------------------------------------------------------------------
// Supporting types and helpers
// ---------------------------------------------------------------------------

export interface UpgradeResult {
  status: "verified" | "safe_abort" | "recovery_required";
  transaction_id?: string;
  phase: UpgradePhase;
  target_version: string;
  target_digest?: string;
  target_dir?: string;
  backup_paths: string[];
  new_state_write_possible: boolean;
  error?: { code: string; message: string };
  recovery_actions: string[];
  cleanup_candidates?: Array<{ version: string; safe: boolean; references: string[] }>;
}

export interface UpgradeStateMachineOptions {
  sourceDir: string;
  targetVersion: string;
  onActiveTasks?: "wait" | "pause-and-update";
  kind?: "install" | "upgrade";
  installRoot?: string;
  storageRoot?: string;
  configPath?: string;
  sqlitePath?: string;
  nodePath?: string;
  sourceVersion?: string;
  sourceDigest?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  writeAccountsLauncher?: boolean;
  startTargetService?: () => Promise<{
    ok: boolean;
    application_version?: string;
    build_revision?: string;
  }>;
  pauseActiveTasks?: () => Promise<void>;
  managedClients?: Array<{
    client: string;
    path: string;
    checkTargetRef?: boolean;
    apply: () => Promise<{ note?: string } | void> | { note?: string } | void;
  }>;
  acquireControllerLock?: (
    root: string,
  ) => Promise<() => Promise<void>>;
}

export interface QuiesceInspection {
  active_leases: number;
  running_processes: number;
  unknown_processes: number;
  confirmed_exited: number;
  can_quiesce: boolean;
  blockers: string[];
}

/**
 * Inspect process_record / lease rows the same way assertQuiescent does.
 * U-10: unknown is reported, never rewritten.
 */
export async function inspectQuiesceState(
  sqlitePath: string,
): Promise<QuiesceInspection> {
  const blockers: string[] = [];
  let active_leases = 0;
  let running_processes = 0;
  let unknown_processes = 0;
  let confirmed_exited = 0;
  if (!existsSync(sqlitePath))
    return {
      active_leases: 0,
      running_processes: 0,
      unknown_processes: 0,
      confirmed_exited: 0,
      can_quiesce: true,
      blockers,
    };
  const db = new Database(sqlitePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const rows = db
      .prepare("SELECT data FROM entities WHERE kind='process_record'")
      .all() as { data: string }[];
    for (const row of rows) {
      const record = JSON.parse(row.data) as Record<string, unknown>;
      const observed = await observeProcessRecord(record);
      if (observed.state === "confirmed_exited") confirmed_exited += 1;
      else if (observed.state === "unknown") {
        unknown_processes += 1;
        blockers.push(
          `unknown process id=${String(record.id ?? "?")} 需恢复对账`,
        );
      } else {
        running_processes += 1;
        blockers.push(`running process id=${String(record.id ?? "?")}`);
      }
    }
    const leases = db
      .prepare("SELECT data FROM entities WHERE kind='lease'")
      .all() as { data: string }[];
    for (const row of leases) {
      const lease = JSON.parse(row.data) as { status?: string; id?: string };
      if (["active", "suspect"].includes(lease.status ?? "")) {
        active_leases += 1;
        blockers.push(`lease ${lease.id ?? "?"} status=${lease.status}`);
      }
    }
  } finally {
    db.close();
  }
  return {
    active_leases,
    running_processes,
    unknown_processes,
    confirmed_exited,
    can_quiesce: blockers.length === 0,
    blockers,
  };
}

export function listSafeOldVersions(
  installRoot: string,
  keepVersion: string,
): Array<{ version: string; safe: boolean; references: string[] }> {
  const versionsDir = join(installRoot, "versions");
  if (!existsSync(versionsDir)) return [];
  const results: Array<{ version: string; safe: boolean; references: string[] }> = [];
  for (const name of readdirSync(versionsDir)) {
    if (name === keepVersion) continue;
    results.push({ version: name, ...assertOldVersionSafeToClean({ installRoot, version: name }) });
  }
  return results;
}

function copyTreeShallow(source: string, target: string): void {
  for (const name of readdirSync(source)) {
    if (name === "node_modules" || name === ".git" || name === "versions")
      continue;
    const from = join(source, name);
    const to = join(target, name);
    const st = statSync(from);
    if (st.isDirectory()) {
      mkdirSync(to, { recursive: true });
      copyTreeShallow(from, to);
    } else copyFileSync(from, to);
  }
}

function backupFileCopyIf(
  sourcePath: string,
  backupDir: string,
  label: string,
): string | undefined {
  if (!existsSync(sourcePath)) return undefined;
  return backupFileCopy(sourcePath, backupDir, label);
}

function readLatestTransactionId(installRoot: string): string | undefined {
  try {
    const dir = join(installRoot, "transactions");
    if (!existsSync(dir)) return undefined;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    const last = files[files.length - 1];
    if (!last) return undefined;
    return (JSON.parse(readFileSync(join(dir, last), "utf8")) as UpgradeTransaction)
      .id;
  } catch {
    return undefined;
  }
}

function classifyUpgradeErrorCode(message: string): string {
  if (message.startsWith("UPGRADE_")) return message.split(":")[0] ?? "UPGRADE_FAILED";
  if (message.includes("DIGEST")) return "UPGRADE_DIGEST_MISMATCH";
  if (message.includes("MIGRATION")) return "UPGRADE_CONFIG_MIGRATION";
  return "UPGRADE_FAILED";
}

// Re-export transaction surface so E can import from upgrade.js if convenient.
// index.ts intentionally stays untouched (Stream E owns it).
export {
  beginUpgradeTransaction,
  recordTransactionPhase,
  commitUpgradeTransaction,
  failUpgradeTransaction,
  readTransaction,
  writeTransaction,
  beginMaintenanceMarker,
  clearMaintenanceMarker,
  readMaintenanceMarker,
  updateMaintenanceMarker,
  planUninstallRetention,
  assertOldVersionSafeToClean,
  assertNoSensitiveFields,
};
