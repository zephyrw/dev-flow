import { existsSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import {
  applyMigration,
  dryRunMigration,
} from "../../contracts/src/config-migration.js";
import { observeProcessRecord } from "../../process/src/process-protocol.js";
import Database from "better-sqlite3";
import { atomicWrite } from "../../core/src/util.js";
export interface UpgradeOptions {
  installDir: string;
  targetVersion: string;
  backupDir?: string;
}
export class UpgradeManager {
  constructor(private options: UpgradeOptions) {}
  async assertQuiescent(sqlitePath: string): Promise<void> {
    if (!existsSync(sqlitePath)) return;
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
        if ((await observeProcessRecord(record)).state !== "confirmed_exited")
          throw new Error(
            "UPGRADE_PROCESS_STATE_UNKNOWN: 请先完成旧进程停止和恢复对账",
          );
      }
      const leases = db
        .prepare("SELECT data FROM entities WHERE kind='lease'")
        .all() as { data: string }[];
      if (
        leases.some((row) =>
          ["active", "suspect"].includes(JSON.parse(row.data).status),
        )
      )
        throw new Error("UPGRADE_ACTIVE_LEASE: 请先完成任务停止和资源对账");
    } finally {
      db.close();
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
}

/**
 * Migrate account configuration for Node runtime.
 *
 * Uses the same v1 validation and YAML transformation as the CLI.
 */
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
