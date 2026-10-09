import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  copyFileSync,
  renameSync,
  rmSync,
  readdirSync,
  statSync,
  lstatSync,
  realpathSync,
  chmodSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { acquireInstallTransactionLock, macAppPlist } from "./launchers.js";
import { isWithinRoot } from "./download.js";
import {
  readRuntimeFilesManifest,
  requiredEntries,
  resolveEntryPath,
} from "./runtime-files.js";
import { cleanProcessEnvironment } from "../../process/src/manager.js";
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
        "UPGRADE_NOT_QUIESCENT: " +
          (inspection.blockers.join("; ") || "未静默"),
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
        join(this.installRoot, "current.json"),
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
    const source = resolve(meta.sourceDir);
    if (
      !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
        meta.targetVersion,
      )
    )
      throw new Error("UPGRADE_CANDIDATE_VERSION_INVALID");
    if (isWithinRoot(source, this.installRoot))
      throw new Error("UPGRADE_SOURCE_CONTAINS_INSTALL_ROOT");
    if (!existsSync(join(source, "package.json")))
      throw new Error("UPGRADE_CANDIDATE_INVALID: 候选包缺少 package.json");
    const pkg = JSON.parse(
      readFileSync(join(source, "package.json"), "utf8"),
    ) as { version?: string };
    if (pkg.version && pkg.version !== meta.targetVersion)
      throw new Error(
        `UPGRADE_CANDIDATE_VERSION_MISMATCH: package.json ${pkg.version} != ${meta.targetVersion}`,
      );

    const manifest = readRuntimeFilesManifest(source);
    for (const entry of requiredEntries(manifest)) {
      const file = join(source, resolveEntryPath(source, entry));
      if (
        !isWithinRoot(source, file) ||
        !existsSync(file) ||
        (entry.kind === "directory"
          ? !statSync(file).isDirectory()
          : !statSync(file).isFile())
      )
        throw new Error("UPGRADE_CANDIDATE_INVALID: " + entry.path);
    }
    const digest = payloadDigest(source);

    const versionsDir = join(this.installRoot, "versions");
    const targetDir = join(versionsDir, meta.targetVersion);
    if (
      existsSync(versionsDir) &&
      !isWithinRoot(realpathSync(this.installRoot), realpathSync(versionsDir))
    )
      throw new Error("UPGRADE_VERSION_ROOT_ESCAPE");
    if (existsSync(targetDir) && lstatSync(targetDir).isSymbolicLink())
      throw new Error("UPGRADE_TARGET_DIR_CONFLICT");
    if (source !== resolve(targetDir) && isWithinRoot(source, targetDir))
      throw new Error("UPGRADE_SOURCE_CONTAINS_TARGET");
    const receiptPath = join(targetDir, "install-source.json");

    if (existsSync(receiptPath)) {
      if (payloadDigest(targetDir) !== digest)
        throw new Error(
          "UPGRADE_SAME_VERSION_DIGEST_MISMATCH: 现有版本内容不同，拒绝覆盖",
        );
      return { targetDir, digest };
    }

    if (existsSync(targetDir) && !existsSync(receiptPath))
      throw new Error(
        "UPGRADE_TARGET_DIR_CONFLICT: 目标版本目录已存在但缺少收据，拒绝覆盖",
      );

    const staging =
      targetDir + ".staging." + hash(String(Date.now())).slice(0, 8);
    mkdirSync(staging, { recursive: true });
    try {
      copyTreeFull(source, staging);
      if (payloadDigest(staging) !== digest)
        throw new Error("UPGRADE_CANDIDATE_CHANGED_DURING_COPY");
      atomicWrite(
        join(staging, "install-source.json"),
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
      renameSync(staging, targetDir);
    } catch (error) {
      try {
        rmSync(staging, { recursive: true, force: true });
      } catch {}
      throw error;
    }
    return { targetDir, digest };
  }

  /**
   * §7.2: request maintenance preparation. Does NOT take the controller lock
   * (lock-order red line: service still owns it until it exits).
   */
  private serviceOnline = false;

  async requestMaintenance(transactionId?: string): Promise<void> {
    const storageRoot = this.options.storageRoot ?? this.installRoot;
    const txId = transactionId ?? readLatestTransactionId(this.installRoot);
    if (!txId)
      throw new Error("UPGRADE_TX_REQUIRED: requestMaintenance 需要事务");
    const existing = readMaintenanceMarker(storageRoot);
    if (existing && existing.transaction_id !== txId)
      throw new Error("UPGRADE_MAINTENANCE_CONFLICT: 先恢复已有维护事务");
    if (!existing)
      beginMaintenanceMarker({
        storageRoot,
        transaction_id: txId,
        kind: "upgrade",
        target_version: this.options.targetVersion,
      });
    this.serviceOnline = false;
    if (!this.options.serviceOrigin) return;
    let health: Response;
    try {
      health = await fetch(new URL("/api/health", this.options.serviceOrigin), {
        signal: AbortSignal.timeout(3000),
        redirect: "error",
      });
    } catch {
      // The controller lock still rejects an unreachable but live controller.
      return;
    }
    const body = (await health.json()) as Record<string, unknown>;
    if (
      !health.ok ||
      body.service !== "devflow" ||
      body.instance !== hash(resolve(storageRoot).toLowerCase())
    )
      throw new Error("UPGRADE_SERVICE_IDENTITY_MISMATCH");
    this.serviceOnline = true;
    await this.maintenanceRequest("prepare", {
      transaction_id: txId,
      target_version: this.options.targetVersion,
    });
  }

  private async maintenanceRequest(
    action: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(
      new URL("/api/maintenance/" + action, this.options.serviceOrigin),
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          "content-type": "application/json",
          origin: this.options.serviceOrigin!,
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok)
      throw new Error("UPGRADE_MAINTENANCE_REQUEST_FAILED: " + response.status);
    return (await response.json()) as Record<string, unknown>;
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

    if (options.onActiveTasks === "pause-and-update") {
      if (options.pauseCallback) await options.pauseCallback();
      else if (this.serviceOnline)
        await this.maintenanceRequest("quiesce", {
          transaction_id: marker.transaction_id,
          on_active_tasks: options.onActiveTasks,
        });
      else if (!(await inspectQuiesceState(sqlitePath)).can_quiesce)
        throw new Error("UPGRADE_PAUSE_UNAVAILABLE");
    }

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
      if (Date.now() > deadline)
        throw new Error(
          "UPGRADE_QUIESCE_TIMEOUT: 等待任务结束超时（未选择暂停并更新，不强制打断）",
        );
      await new Promise((r) => setTimeout(r, interval));
    }
    await this.assertQuiescent(sqlitePath);
    updateMaintenanceMarker(storageRoot, { phase: "quiescent" });
  }

  async acquireQuiescentController(
    transactionId: string,
    acquire = acquireControllerLock,
    timeoutMs?: number,
  ): Promise<() => Promise<void>> {
    const storageRoot = this.options.storageRoot ?? this.installRoot;
    if (this.serviceOnline) {
      const stopped = await this.maintenanceRequest("quiesce", {
        transaction_id: transactionId,
        on_active_tasks: "wait",
        shutdown: true,
      });
      if (!stopped.can_quiesce) throw new Error("UPGRADE_NOT_QUIESCENT");
    }
    const stopDeadline = Date.now() + (timeoutMs ?? 15000);
    for (;;) {
      try {
        return await acquire(storageRoot);
      } catch (error) {
        if (
          !this.serviceOnline ||
          (error as Error).message !== "CONTROLLER_ALREADY_ACTIVE" ||
          Date.now() >= stopDeadline
        )
          throw error;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }

  /**
   * §7.3 state machine: Prepared→(WaitingForIdle)→Quiescent→BackedUp→Migrating→Starting→Verified
   * Failure branches: SafeAbort (no business state written) / RecoveryRequired.
   */
  async runUpgradeStateMachine(
    options: UpgradeStateMachineOptions,
  ): Promise<UpgradeResult> {
    const installRoot = options.installRoot ?? this.installRoot;
    const storageRoot =
      options.storageRoot ?? this.options.storageRoot ?? installRoot;
    const sqlitePath =
      options.sqlitePath ?? join(storageRoot, "devflow.sqlite");
    const configPath = options.configPath ?? join(installRoot, "devflow.yaml");
    const pointerPath = join(installRoot, "current.json");
    this.options = {
      ...this.options,
      installRoot,
      storageRoot,
      targetVersion: options.targetVersion,
      serviceOrigin: options.serviceOrigin ?? this.options.serviceOrigin,
    };
    const acquire = options.acquireControllerLock ?? acquireControllerLock;

    const sourceVersion =
      options.sourceVersion ??
      (existsSync(pointerPath)
        ? (
            JSON.parse(readFileSync(pointerPath, "utf8")) as {
              application_version?: string;
              version?: string;
            }
          ).application_version
        : undefined);

    let created_config = !existsSync(configPath);
    let created_pointer = !existsSync(pointerPath);
    let config_digest_before = digestFile(configPath);
    let pointer_digest_before = digestFile(pointerPath);

    let phase: UpgradePhase = "begun";
    let tx: UpgradeTransaction | undefined;
    let targetDir: string | undefined;
    let digest: string | undefined;
    let backupPaths: string[] = [];
    let new_state_write_possible = false;
    let release: (() => Promise<void>) | undefined;
    let markerHeld = false;
    let releaseInstall: (() => Promise<void>) | undefined;

    try {
      releaseInstall = await acquireInstallTransactionLock(installRoot);
      created_config = !existsSync(configPath);
      created_pointer = !existsSync(pointerPath);
      config_digest_before = digestFile(configPath);
      pointer_digest_before = digestFile(pointerPath);
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
        kind:
          options.kind ??
          (created_config && created_pointer ? "install" : "upgrade"),
        target_version: options.targetVersion,
        target_digest: digest,
        source_version: sourceVersion,
        source_digest: options.sourceDigest,
        config_path: configPath,
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
      const existingMarker = readMaintenanceMarker(storageRoot);
      if (existingMarker && existingMarker.transaction_id !== tx.id)
        throw new Error("UPGRADE_MAINTENANCE_CONFLICT");
      markerHeld = true;
      await this.requestMaintenance(tx.id);
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
      release = await this.acquireQuiescentController(
        tx.id,
        acquire,
        options.timeoutMs,
      );
      await this.assertQuiescent(sqlitePath);
      const backup = await this.backupData(sqlitePath);
      if (backup) backupPaths.push(backup);
      const configBackup = backupFileCopyIf(
        configPath,
        join(installRoot, "backup", "tx", tx.id),
        "devflow.yaml",
      );
      if (configBackup) backupPaths.push(configBackup);
      const pointerBackup = backupFileCopyIf(
        pointerPath,
        join(installRoot, "backup", "tx", tx.id),
        "current.json",
      );
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
      let config_digest_after = digestFile(configPath);
      recordTransactionPhase(installRoot, tx.id, "migrating", {
        config_digest_after,
      });

      // Managed client changes (U-08): each with before/after hash + backup.
      const clientChanges: ManagedClientChange[] = [];
      for (const change of options.managedClients ?? []) {
        const before_hash = digestFile(change.path);
        const backup_path = before_hash
          ? backupFileCopy(
              change.path,
              join(installRoot, "backup", "tx", tx.id, "client"),
              change.client,
            )
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
        // Immediately persist client change progress so SafeAbort can restore partial changes (DFP-R10)
        recordTransactionPhase(installRoot, tx.id, "migrating", {
          managed_client_changes: [...clientChanges],
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
      let resolvedNode = options.nodePath;
      if (!resolvedNode) {
        const binName = process.platform === "win32" ? "node.exe" : "node";
        const inVersion = join(targetDir, "runtime", binName);
        const inBootstrap = join(installRoot, "bootstrap", "runtime", binName);
        if (existsSync(inVersion)) resolvedNode = inVersion;
        else if (existsSync(inBootstrap)) resolvedNode = inBootstrap;
        else throw new Error("UPGRADE_TARGET_RUNTIME_MISSING");
      }
      const pointerMeta = {
        version: options.targetVersion,
        application_version: options.targetVersion,
        root: targetDir,
        config: configPath,
        node: resolvedNode,
        build_revision: JSON.parse(
          readFileSync(join(targetDir, "build-info.json"), "utf8"),
        ).build_revision,
        updated_at: now(),
      };
      if (!this.atomicSwitchCurrent(pointerMeta))
        throw new Error("UPGRADE_POINTER_WRITE_FAILED");
      new_state_write_possible = true;
      const pointer_digest_after = digestFile(pointerPath);
      config_digest_after = digestFile(configPath);
      recordTransactionPhase(installRoot, tx.id, "starting", {
        new_state_write_possible: true,
        managed_client_changes: clientChanges,
        pointer_digest_after,
        config_digest_after,
      });

      phase = "starting";
      updateMaintenanceMarker(storageRoot, { phase: "starting" });
      if (release) {
        await release();
        release = undefined;
      }
      if (options.startTargetService) {
        const started = await options.startTargetService();
        if (!started || !started.ok)
          throw new Error("UPGRADE_TARGET_START_FAILED: 目标版本服务启动失败");
        if (started.application_version !== options.targetVersion)
          throw new Error(
            `UPGRADE_TARGET_VERSION_MISMATCH: 服务报告 ${started.application_version} != ${options.targetVersion}`,
          );
      } else if (this.options.serviceOrigin) {
        const launcher = join(
          targetDir,
          "dist/packages/service/src/launcher.js",
        );
        await promisify(execFile)(
          resolvedNode,
          [
            "--input-type=module",
            "-e",
            "const m=await import(process.argv[1]);await m.ensureService();",
            pathToFileURL(launcher).href,
          ],
          {
            cwd: targetDir,
            windowsHide: true,
            timeout: 150000,
            env: cleanProcessEnvironment({
              DEVFLOW_CONFIG: configPath,
              DEVFLOW_INSTALL_ROOT: installRoot,
              DEVFLOW_VERSION_ROOT: targetDir,
              DEVFLOW_UPGRADE_TRANSACTION: tx.id,
            }),
          },
        );
        let verifiedHealth = false;
        for (let i = 0; i < 20; i++) {
          try {
            const healthResp = await fetch(
              new URL("/api/health", this.options.serviceOrigin),
              {
                signal: AbortSignal.timeout(1500),
              },
            );
            if (healthResp.ok) {
              const body = (await healthResp.json()) as Record<string, unknown>;
              if (
                body.service === "devflow" &&
                body.instance === hash(resolve(storageRoot).toLowerCase()) &&
                typeof body.runtime_root === "string" &&
                resolve(body.runtime_root) === resolve(targetDir) &&
                body.build_revision === pointerMeta.build_revision
              ) {
                const liveVersion = body.application_version ?? body.version;
                if (liveVersion && liveVersion === options.targetVersion) {
                  verifiedHealth = true;
                  break;
                }
              }
            }
          } catch {
            /* retry */
          }
          await new Promise((r) => setTimeout(r, 200));
        }
        if (!verifiedHealth) {
          throw new Error(
            `UPGRADE_TARGET_HEALTH_FAILED: 无法验证目标版本 ${options.targetVersion} 服务健康接口`,
          );
        }
      }

      if (!options.startTargetService && !this.options.serviceOrigin)
        throw new Error("UPGRADE_TARGET_VERIFICATION_REQUIRED");
      phase = "verified";
      recordTransactionPhase(installRoot, tx.id, "verified", {
        new_state_write_possible: true,
      });
      if (options.writeAccountsLauncher !== false)
        writeAccountsLauncher(installRoot);
      commitUpgradeTransaction(installRoot, tx.id);
      if (
        markerHeld &&
        readMaintenanceMarker(storageRoot)?.transaction_id === tx.id
      )
        clearMaintenanceMarker(storageRoot);

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
        (error as { code?: string }).code ?? classifyUpgradeErrorCode(message);
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
      if (
        markerHeld &&
        readMaintenanceMarker(storageRoot)?.transaction_id === tx?.id
      ) {
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
      try {
        if (release) await release();
      } finally {
        await releaseInstall?.();
      }
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
  if (platform === "darwin") {
    const bundle = join(installRoot, "打开 AGY 账号管理.app");
    const executable = join(bundle, "Contents", "MacOS", "DevFlowAccounts");
    const plist = join(bundle, "Contents", "Info.plist");
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const entries = [
      [executable, "#!/bin/sh\nexec " + quote(join(installRoot, "bin", "devflow")) + " accounts\n"],
      [plist, macAppPlist("DevFlowAccounts", "accounts")],
    ];
    let prior: Array<{ path: string; hash?: string }> = [];
    try { prior = JSON.parse(readFileSync(join(installRoot, "entry-receipt.json"), "utf8")).installed_entries ?? []; } catch {}
    if (existsSync(bundle) && (!existsSync(executable) || !existsSync(plist)))
      throw new Error("ACCOUNT_LAUNCHER_CONFLICT");
    for (const [file, content] of entries) {
      if (!existsSync(file!)) continue;
      const stat = lstatSync(file!);
      if (!stat.isFile() || stat.isSymbolicLink() ||
          (readFileSync(file!, "utf8") !== content && prior.find(entry => resolve(entry.path) === resolve(file!))?.hash !== hash(readFileSync(file!))))
        throw new Error("ACCOUNT_LAUNCHER_CONFLICT");
    }
    mkdirSync(dirname(executable), { recursive: true });
    for (const [file, content] of entries) atomicWrite(file!, content!);
    chmodSync(executable, 0o755);
    return [executable, plist];
  }
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
  return [join(installRoot, "open-accounts.ps1"), join(installRoot, "打开 AGY 账号管理.vbs")];
}

// ---------------------------------------------------------------------------
// Supporting types and helpers
// ---------------------------------------------------------------------------

export interface UpgradeResult {
  status:
    | "verified"
    | "safe_abort"
    | "recovery_required"
    | "no_update"
    | "blocked";
  transaction_id?: string;
  phase: UpgradePhase;
  target_version: string;
  target_digest?: string;
  target_dir?: string;
  backup_paths: string[];
  new_state_write_possible: boolean;
  error?: { code: string; message: string };
  recovery_actions: string[];
  cleanup_candidates?: Array<{
    version: string;
    safe: boolean;
    references: string[];
  }>;
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
  serviceOrigin?: string;
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
  acquireControllerLock?: (root: string) => Promise<() => Promise<void>>;
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
  const results: Array<{
    version: string;
    safe: boolean;
    references: string[];
  }> = [];
  for (const name of readdirSync(versionsDir)) {
    if (name === keepVersion) continue;
    results.push({
      version: name,
      ...assertOldVersionSafeToClean({ installRoot, version: name }),
    });
  }
  return results;
}

function payloadDigest(root: string): string {
  const digest = createHash("sha256");
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (!prefix && name === "install-source.json") continue;
      const file = join(dir, name);
      const rel = prefix + name;
      const st = lstatSync(file);
      if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile()))
        throw new Error("UPGRADE_UNSAFE_PAYLOAD_ENTRY: " + rel);
      digest.update(
        JSON.stringify([rel, st.isDirectory() ? "directory" : "file"]),
      );
      if (st.isDirectory()) walk(file, rel + "/");
      else
        digest.update(createHash("sha256").update(readFileSync(file)).digest());
    }
  };
  walk(root, "");
  return digest.digest("hex");
}

function copyTreeFull(source: string, target: string, top = true): void {
  for (const name of readdirSync(source)) {
    if (top && name === "install-source.json") continue;
    const from = join(source, name);
    const to = join(target, name);
    const st = lstatSync(from);
    if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile()))
      throw new Error("UPGRADE_UNSAFE_PAYLOAD_ENTRY: " + from);
    if (st.isDirectory()) {
      mkdirSync(to, { recursive: true });
      copyTreeFull(from, to, false);
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
      .sort(
        (a, b) =>
          statSync(join(dir, a)).mtimeMs - statSync(join(dir, b)).mtimeMs,
      );
    const last = files[files.length - 1];
    if (!last) return undefined;
    return (
      JSON.parse(readFileSync(join(dir, last), "utf8")) as UpgradeTransaction
    ).id;
  } catch {
    return undefined;
  }
}

function classifyUpgradeErrorCode(message: string): string {
  if (message.startsWith("UPGRADE_"))
    return message.split(":")[0] ?? "UPGRADE_FAILED";
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
