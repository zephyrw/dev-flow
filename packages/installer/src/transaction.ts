import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  copyFileSync,
  statSync,
  readdirSync,
} from "node:fs";
import { join, dirname, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWrite, hash, now } from "../../core/src/util.js";

/** §7.3 phases. Terminal failure branches are SafeAbort / RecoveryRequired. */
export type UpgradePhase =
  | "begun"
  | "prepared"
  | "waiting_for_idle"
  | "quiescent"
  | "backed_up"
  | "migrating"
  | "starting"
  | "verified"
  | "committed"
  | "safe_abort"
  | "recovery_required";

export type ManagedClientChangeStatus =
  | "planned"
  | "applied"
  | "restored"
  | "user_modified_preserved"
  | "conflict"
  | "skipped";

export interface ManagedClientChange {
  client: string;
  path: string;
  before_hash?: string;
  after_hash?: string;
  backup_path?: string;
  status: ManagedClientChangeStatus;
  note?: string;
}

/** §7.4 / 协调约定第 4 条. Never stores secrets, tokens or raw credentials. */
export interface UpgradeTransaction {
  id: string;
  kind: "install" | "upgrade";
  source_version?: string;
  source_digest?: string;
  target_version: string;
  target_digest: string;
  config_digest_before?: string | null;
  pointer_digest_before?: string | null;
  /** Extra ownership hashes so SafeAbort can restore only this transaction's writes. */
  config_digest_after?: string | null;
  pointer_digest_after?: string | null;
  created_config?: boolean;
  created_pointer?: boolean;
  backup_paths: string[];
  phase: UpgradePhase;
  new_state_write_possible: boolean;
  managed_client_changes: ManagedClientChange[];
  created_at: string;
  updated_at: string;
  /** Recovery expiry: a marker past this time is reclaimable after identity checks. */
  expires_at: string;
  error?: { code: string; message: string; phase: UpgradePhase };
  notes?: string[];
}

export interface MaintenanceMarker {
  transaction_id: string;
  kind: "install" | "upgrade";
  phase: UpgradePhase | "requested";
  target_version?: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
  block_new_dispatch: boolean;
  on_active_tasks?: "wait" | "pause-and-update";
  pause_requested?: boolean;
}

const SENSITIVE_KEY =
  /secret|token|password|passwd|api[_-]?key|authorization|credential|private[_-]?key/i;

export function assertNoSensitiveFields(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoSensitiveFields(item, `${path}[${index}]`),
    );
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key))
        throw new Error(`UPGRADE_TX_SENSITIVE_FIELD: ${path}.${key}`);
      assertNoSensitiveFields(item, `${path}.${key}`);
    }
  }
}

export function transactionsDir(installRoot: string): string {
  return join(installRoot, "transactions");
}

export function transactionPath(
  installRoot: string,
  id: string,
): string {
  return join(transactionsDir(installRoot), `${id}.json`);
}

export function readTransaction(
  installRoot: string,
  id: string,
): UpgradeTransaction | undefined {
  const file = transactionPath(installRoot, id);
  if (!existsSync(file)) return undefined;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as UpgradeTransaction;
  assertNoSensitiveFields(parsed);
  return parsed;
}

export function writeTransaction(
  installRoot: string,
  record: UpgradeTransaction,
): UpgradeTransaction {
  assertNoSensitiveFields(record);
  const file = transactionPath(installRoot, record.id);
  mkdirSync(dirname(file), { recursive: true });
  atomicWrite(file, JSON.stringify(record, null, 2));
  return record;
}

export interface BeginUpgradeTransactionInput {
  installRoot: string;
  kind: "install" | "upgrade";
  target_version: string;
  target_digest: string;
  source_version?: string;
  source_digest?: string;
  config_digest_before?: string | null;
  pointer_digest_before?: string | null;
  created_config?: boolean;
  created_pointer?: boolean;
  ttl_ms?: number;
}

export function beginUpgradeTransaction(
  input: BeginUpgradeTransactionInput,
): UpgradeTransaction {
  const created_at = now();
  const ttl = input.ttl_ms ?? 30 * 60 * 1000;
  const record: UpgradeTransaction = {
    id: `tx-${randomUUID()}`,
    kind: input.kind,
    source_version: input.source_version,
    source_digest: input.source_digest,
    target_version: input.target_version,
    target_digest: input.target_digest,
    config_digest_before: input.config_digest_before ?? null,
    pointer_digest_before: input.pointer_digest_before ?? null,
    config_digest_after: null,
    pointer_digest_after: null,
    created_config: input.created_config ?? false,
    created_pointer: input.created_pointer ?? false,
    backup_paths: [],
    phase: "begun",
    new_state_write_possible: false,
    managed_client_changes: [],
    created_at,
    updated_at: created_at,
    expires_at: new Date(Date.parse(created_at) + ttl).toISOString(),
  };
  return writeTransaction(input.installRoot, record);
}

export function recordTransactionPhase(
  installRoot: string,
  id: string,
  phase: UpgradePhase,
  patch?: Partial<
    Pick<
      UpgradeTransaction,
      | "backup_paths"
      | "new_state_write_possible"
      | "managed_client_changes"
      | "config_digest_after"
      | "pointer_digest_after"
      | "error"
      | "notes"
      | "target_digest"
      | "target_version"
    >
  >,
): UpgradeTransaction {
  const current = readTransaction(installRoot, id);
  if (!current) throw new Error(`UPGRADE_TX_NOT_FOUND: ${id}`);
  const next: UpgradeTransaction = {
    ...current,
    ...patch,
    phase,
    updated_at: now(),
  };
  if (patch?.managed_client_changes)
    next.managed_client_changes = patch.managed_client_changes;
  return writeTransaction(installRoot, next);
}

export function commitUpgradeTransaction(
  installRoot: string,
  id: string,
): UpgradeTransaction {
  return recordTransactionPhase(installRoot, id, "committed", {
    new_state_write_possible: true,
  });
}

export interface FailUpgradeTransactionOptions {
  phase: UpgradePhase;
  code: string;
  message: string;
  /**
   * SafeAbort restores only transaction-owned writes.
   * RecoveryRequired keeps the scene and never rolls the database back.
   */
  mode: "safe_abort" | "recovery_required";
  new_state_write_possible: boolean;
  restore_transaction_owned?: boolean;
}

function fileDigest(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return hash(readFileSync(path));
  } catch {
    return undefined;
  }
}

function restoreOwnedFile(
  livePath: string,
  backupPath: string | undefined,
  ownedAfterHash: string | null | undefined,
  created: boolean | undefined,
  beforeHash: string | null | undefined,
): "restored" | "removed" | "user_modified_preserved" | "missing_backup" | "left" {
  const current = fileDigest(livePath);
  if (current === undefined) return "missing_backup";
  const owned =
    (ownedAfterHash && current === ownedAfterHash) ||
    (created && beforeHash == null);
  if (!owned) return "user_modified_preserved";
  if (backupPath && existsSync(backupPath)) {
    copyFileSync(backupPath, livePath);
    return "restored";
  }
  if (created && beforeHash == null) {
    unlinkSync(livePath);
    return "removed";
  }
  return "left";
}

/**
 * §7.4 / U-07 / U-08: restore only files this transaction changed.
 * Concurrent user edits are never overwritten.
 */
export function restoreTransactionOwnedChanges(
  installRoot: string,
  id: string,
): {
  config: string;
  pointer: string;
  clients: ManagedClientChange[];
} {
  const record = readTransaction(installRoot, id);
  if (!record) throw new Error(`UPGRADE_TX_NOT_FOUND: ${id}`);
  const configPath = join(installRoot, "devflow.yaml");
  const pointerPath = join(installRoot, "current.json");
  const config = restoreOwnedFile(
    configPath,
    record.backup_paths.find((p) => p.includes("devflow.yaml")),
    record.config_digest_after,
    record.created_config,
    record.config_digest_before,
  );
  const pointer = restoreOwnedFile(
    pointerPath,
    record.backup_paths.find((p) => p.includes("current.json")),
    record.pointer_digest_after,
    record.created_pointer,
    record.pointer_digest_before,
  );
  const clients: ManagedClientChange[] = record.managed_client_changes.map(
    (change) => {
      if (change.status !== "applied") return change;
      const current = fileDigest(change.path);
      if (current === undefined)
        return { ...change, status: "skipped", note: "missing" };
      if (change.after_hash && current !== change.after_hash)
        return {
          ...change,
          status: "user_modified_preserved",
          note: "user_concurrent_edit",
        };
      if (change.backup_path && existsSync(change.backup_path)) {
        copyFileSync(change.backup_path, change.path);
        return { ...change, status: "restored" };
      }
      return { ...change, status: "skipped", note: "no_backup" };
    },
  );
  recordTransactionPhase(installRoot, id, "safe_abort", {
    managed_client_changes: clients,
    notes: [
      `config_restore=${config}`,
      `pointer_restore=${pointer}`,
    ],
  });
  return { config, pointer, clients };
}

export function failUpgradeTransaction(
  installRoot: string,
  id: string,
  options: FailUpgradeTransactionOptions,
): UpgradeTransaction {
  const current = readTransaction(installRoot, id);
  if (!current) throw new Error(`UPGRADE_TX_NOT_FOUND: ${id}`);
  if (options.mode === "safe_abort" && options.restore_transaction_owned !== false) {
    restoreTransactionOwnedChanges(installRoot, id);
  }
  return recordTransactionPhase(
    installRoot,
    id,
    options.mode === "safe_abort" ? "safe_abort" : "recovery_required",
    {
      new_state_write_possible: options.new_state_write_possible,
      error: {
        code: options.code,
        message: options.message,
        phase: options.phase,
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Maintenance marker (§7.2): verifiable transaction identity, phase, expiry.
// ---------------------------------------------------------------------------

export function maintenanceStatePath(storageRoot: string): string {
  return join(storageRoot, "maintenance-state.json");
}

export function maintenanceLockPath(storageRoot: string): string {
  return join(storageRoot, "maintenance.lock");
}

export function readMaintenanceMarker(
  storageRoot: string,
): MaintenanceMarker | undefined {
  const file = maintenanceStatePath(storageRoot);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as MaintenanceMarker;
    assertNoSensitiveFields(parsed);
    return parsed;
  } catch {
    return undefined;
  }
}

export function writeMaintenanceMarker(
  storageRoot: string,
  marker: MaintenanceMarker,
): MaintenanceMarker {
  assertNoSensitiveFields(marker);
  mkdirSync(storageRoot, { recursive: true });
  atomicWrite(maintenanceStatePath(storageRoot), JSON.stringify(marker, null, 2));
  // Presence marker understood by the existing launcher (assertNotUpdating).
  // On Windows the installer additionally holds an exclusive handle; on other
  // platforms the state file plus expiry is the cross-platform identity check.
  // Never assume FileShare.None semantics outside Windows.
  if (!existsSync(maintenanceLockPath(storageRoot)))
    atomicWrite(maintenanceLockPath(storageRoot), `tx:${marker.transaction_id}\n`);
  return marker;
}

export function clearMaintenanceMarker(storageRoot: string): void {
  for (const file of [
    maintenanceStatePath(storageRoot),
    maintenanceLockPath(storageRoot),
  ]) {
    try {
      unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function isMaintenanceMarkerExpired(marker: MaintenanceMarker, at = Date.now()): boolean {
  return Date.parse(marker.expires_at) < at;
}

export function beginMaintenanceMarker(input: {
  storageRoot: string;
  transaction_id: string;
  kind: "install" | "upgrade";
  target_version?: string;
  on_active_tasks?: "wait" | "pause-and-update";
  ttl_ms?: number;
}): MaintenanceMarker {
  const created_at = now();
  const ttl = input.ttl_ms ?? 30 * 60 * 1000;
  return writeMaintenanceMarker(input.storageRoot, {
    transaction_id: input.transaction_id,
    kind: input.kind,
    phase: "requested",
    target_version: input.target_version,
    created_at,
    updated_at: created_at,
    expires_at: new Date(Date.parse(created_at) + ttl).toISOString(),
    block_new_dispatch: true,
    on_active_tasks: input.on_active_tasks,
    pause_requested: false,
  });
}

export function updateMaintenanceMarker(
  storageRoot: string,
  patch: Partial<MaintenanceMarker>,
): MaintenanceMarker {
  const current = readMaintenanceMarker(storageRoot);
  if (!current) throw new Error("MAINTENANCE_MARKER_MISSING");
  return writeMaintenanceMarker(storageRoot, {
    ...current,
    ...patch,
    updated_at: now(),
  });
}

// ---------------------------------------------------------------------------
// Retention rules (§7.6 / U-11 / U-12)
// ---------------------------------------------------------------------------

export interface RetentionEntry {
  path: string;
  reason: string;
}

export interface UninstallRetentionPlan {
  remove: RetentionEntry[];
  keep: RetentionEntry[];
  requires_explicit_consent: RetentionEntry[];
}

/**
 * U-12: uninstall removes only application-owned program/entry files.
 * Task data, business projects and the account vault stay unless explicitly chosen.
 */
export function planUninstallRetention(options: {
  installRoot: string;
  storageRoot?: string;
  workspaceRoot?: string;
  includeTaskData?: boolean;
  includeAccountVault?: boolean;
  accountVaultPaths?: string[];
}): UninstallRetentionPlan {
  const root = options.installRoot;
  const remove: RetentionEntry[] = [
    { path: join(root, "versions"), reason: "app_program" },
    { path: join(root, "bootstrap"), reason: "app_bootstrap" },
    { path: join(root, "bin"), reason: "app_entry" },
    { path: join(root, "current.json"), reason: "app_pointer" },
    { path: join(root, "state.json"), reason: "app_install_state" },
    { path: join(root, "transactions"), reason: "app_transactions" },
    { path: join(root, "open-accounts.ps1"), reason: "app_entry" },
    { path: join(root, "打开 AGY 账号管理.vbs"), reason: "app_entry" },
  ];
  const keep: RetentionEntry[] = [];
  const consent: RetentionEntry[] = [];
  if (options.storageRoot)
    keep.push({ path: options.storageRoot, reason: "task_data_default_keep" });
  if (options.workspaceRoot)
    keep.push({ path: options.workspaceRoot, reason: "business_projects" });
  for (const vault of options.accountVaultPaths ?? [])
    keep.push({ path: vault, reason: "account_vault_default_keep" });
  if (options.includeTaskData && options.storageRoot) {
    keep.pop();
    consent.push({
      path: options.storageRoot,
      reason: "task_data_requires_explicit_consent",
    });
  }
  if (options.includeAccountVault) {
    for (const vault of options.accountVaultPaths ?? []) {
      const index = keep.findIndex((e) => e.path === vault);
      if (index >= 0) keep.splice(index, 1);
      consent.push({
        path: vault,
        reason: "account_vault_requires_explicit_consent",
      });
    }
  }
  return { remove, keep, requires_explicit_consent: consent };
}

/**
 * U-11: refuse to delete an old version while bootstrap, pointer or client
 * bridges still reference it.
 */
export function assertOldVersionSafeToClean(options: {
  installRoot: string;
  version: string;
}): { safe: boolean; references: string[] } {
  const references: string[] = [];
  const needle = `versions/${options.version}`;
  const scan = (file: string) => {
    if (!existsSync(file)) return;
    try {
      const text = readFileSync(file, "utf8");
      const normalized = text.replace(/\\\\/g, "/").replace(/\\/g, "/");
      if (normalized.includes(needle))
        references.push(file);
    } catch {
      references.push(file);
    }
  };
  scan(join(options.installRoot, "current.json"));
  scan(join(options.installRoot, "open-accounts.ps1"));
  scan(join(options.installRoot, "bootstrap", "entry.mjs"));
  const bin = join(options.installRoot, "bin");
  if (existsSync(bin)) {
    try {
      for (const name of readdirSync(bin)) scan(join(bin, name));
    } catch {
      /* readdir failures leave references empty; caller still sees safe=false if scan recorded. */
    }
  }
  return { safe: references.length === 0, references };
}

export function backupFileCopy(
  sourcePath: string,
  backupDir: string,
  label: string,
): string {
  mkdirSync(backupDir, { recursive: true });
  const target = join(backupDir, `${label}.${randomUUID()}`);
  copyFileSync(sourcePath, target);
  return target;
}

export function digestFile(path: string): string | null {
  return fileDigest(path) ?? null;
}

export function isPathInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}

export function readJsonFile<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJsonFile(path: string, value: unknown): void {
  assertNoSensitiveFields(value);
  atomicWrite(path, JSON.stringify(value, null, 2));
}

export function touchReceipt(path: string, value: unknown): void {
  writeJsonFile(path, value);
}

export function safeStatMtime(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

export function writeTextFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
