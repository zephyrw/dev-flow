import { existsSync, mkdirSync, readFileSync, copyFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { parseDocument } from "yaml";
import Database from "better-sqlite3";
import { atomicWrite } from "../../core/src/util.js";
export interface UpgradeOptions {
  installDir: string;
  targetVersion: string;
  backupDir?: string;
}
export class UpgradeManager {
  constructor(private options: UpgradeOptions) {}
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

/** Add only account defaults; preserve comments and all existing user choices. */
export function migrateAccountConfiguration(
  configPath: string,
  authHost: string,
  previousManagedHost?: string,
) {
  const original = readFileSync(configPath, "utf8");
  const document = parseDocument(original);
  if (document.errors.length) throw document.errors[0];
  let changed = false;
  if (document.getIn(["agy_accounts", "enabled"]) === undefined) {
    document.setIn(["agy_accounts", "enabled"], false);
    changed = true;
  }
  const configured = document.getIn(["agy_accounts", "auth_host_executable"]);
  const oldManaged =
    typeof configured === "string" &&
    previousManagedHost &&
    resolve(dirname(configPath), configured).toLowerCase() ===
      resolve(previousManagedHost).toLowerCase();
  const defaultRelative =
    configured === "dist/host/devflow-auth-host.exe" ||
    configured === join("dist", "host", "devflow-auth-host.exe");
  if (!configured || oldManaged || defaultRelative) {
    if (configured !== authHost) {
      document.setIn(["agy_accounts", "auth_host_executable"], authHost);
      changed = true;
    }
  }
  if (!changed) return { changed: false, backup: undefined };
  const backup =
    configPath + ".agy-backup-" + Date.now() + "-" + crypto.randomUUID();
  copyFileSync(configPath, backup);
  atomicWrite(configPath, document.toString());
  return { changed: true, backup };
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
