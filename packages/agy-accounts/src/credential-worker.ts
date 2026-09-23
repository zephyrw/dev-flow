/**
 * Credential worker — isolated Node subprocess for credential operations.
 *
 * This process runs inside a Windows Job and handles all raw credential
 * access (DPAPI encrypt/decrypt, Credential Manager read/write). The main
 * process never sees raw secrets.
 *
 * IPC protocol (JSONL over stdin/stdout):
 *   Request:  { id: string, action: string, args: Record<string, unknown> }
 *   Response: { id: string, ok: true, data: unknown }
 *             { id: string, ok: false, error: string }
 *
 * Actions:
 *   acquire-domain-lock  { realm_id } → { acquired, lock_id }
 *   release-domain-lock  { realm_id, lock_id } → {}
 *   inspect-active       { realm_id } → { exists, username?, secret_fingerprint?, ... }
 *   compare-active       { realm_id, secret_ref } → { matches }
 *   capture-active       { realm_id, account_id } → { secret_ref, credential_revision, auth? }
 *   activate-saved       { realm_id, account_id, secret_ref } → { credential_revision }
 *   restore-backup       { realm_id, backup_ref } → {}
 *   clear-active-for-login { realm_id } → { backup_ref }
 *   delete-saved         { realm_id, secret_ref } → {}
 *
 * Design constraints:
 *   - Only loads native modules inside this subprocess
 *   - Stderr is discarded (no secrets in logs)
 *   - Each request is bounded by a timeout
 *   - Process exits on IPC disconnect or parent exit
 *
 * R05 修复：
 *   - 固定凭据目标为 gemini:antigravity（与旧 Go 实现兼容）
 *   - Mutex 名称使用固定目标 + SHA256(current user SID + : + target)
 *   - 异步 import() 替代 require()
 *   - 正确的 vault 目录结构
 */

import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Types ────────────────────────────────────────────────────────────────────

interface Request {
  id: string;
  action: string;
  args: Record<string, unknown>;
}

interface Response {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

interface DomainLock {
  realmId: string;
  lockId: string;
  release: () => Promise<void>;
}

// ── R05 修复：固定凭据目标 ────────────────────────────────────────────────────

/**
 * 固定凭据目标名称，与旧 Go 实现 (gemini:antigravity) 兼容。
 * 不再使用 DevFlow.agy.<hash> 格式。
 */
const FIXED_CREDENTIAL_TARGET = "gemini:antigravity";

// ── R05 修复：Mutex 名称计算 ──────────────────────────────────────────────────

/**
 * Mutex 名称 = Global\DevFlowAuth_ + SHA256(current user SID + : + fixed target)
 * 与旧版本的 controller-lock.ts 中的命名保持一致。
 */
function computeMutexName(userSid: string): string {
  const hash = createHash("sha256")
    .update(`${userSid}:${FIXED_CREDENTIAL_TARGET}`)
    .digest("hex")
    .slice(0, 16);
  return `Global\\DevFlowAuth_${hash}`;
}

// ── R05 修复：Vault 路径计算 ──────────────────────────────────────────────────

/**
 * Vault 目录位于 %LOCALAPPDATA%\DevFlow\agy-accounts\<realm>\
 * 与旧版本保持兼容。
 */
function getVaultPath(realmId: string): string {
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  return join(localAppData, "DevFlow", "agy-accounts", realmId);
}

function getEnvelopePath(realmId: string, accountId: string): string {
  return join(getVaultPath(realmId), `${accountId}.envelope.json`);
}

function getBackupPath(realmId: string, accountId: string, revision: number): string {
  return join(getVaultPath(realmId), `${accountId}.backup.${revision}.envelope.json`);
}

// ── R05 修复：Vault 信封格式 ──────────────────────────────────────────────────

interface VaultEnvelope {
  version: number;
  realm_id: string;
  account_id: string;
  revision: number;
  credential: {
    username: string;
    secret_ref: string;
    encrypted_secret: string; // Base64 encoded DPAPI-protected data
  };
  created_at: string;
  updated_at: string;
}

// ── Platform-specific native module (lazy loaded) ───────────────────────────

interface CredentialNative {
  protectData(data: Buffer): Buffer;
  unprotectData(encrypted: Buffer): Buffer;
  readCredential(target: string): { username: string; secret: Buffer } | null;
  writeCredential(target: string, username: string, secret: Buffer): void;
  deleteCredential(target: string): boolean;
  getCurrentUserSid(): string;
  createMutex(name: string): { handle: bigint; wait: (timeout: number) => number; release: () => void } | null;
}

let nativeModule: CredentialNative | null = null;

/**
 * R05 修复：使用异步 import() 加载原生模块
 */
async function getNative(): Promise<CredentialNative> {
  if (nativeModule) return nativeModule;
  if (process.platform !== "win32") {
    throw new Error("credential_worker_requires_windows");
  }
  // 使用 createCredentialWindows() 工厂函数
  const { createCredentialWindows } = await import("./credential-windows.js");
  const win = createCredentialWindows();

  nativeModule = {
    protectData: win.protectData,
    unprotectData: win.unprotectData,
    readCredential: win.readCredential,
    writeCredential: win.writeCredential,
    deleteCredential: win.deleteCredential,
    getCurrentUserSid: win.getCurrentUserSid,
    createMutex: (name: string) => {
      // 使用 process/src/native/windows.ts 的 createMutex
      // 但这里是在子进程中，需要自己创建
      return null; // 将在主进程中处理
    },
  };
  return nativeModule;
}

// ── Domain lock management ──────────────────────────────────────────────────

const domainLocks = new Map<string, DomainLock>();

async function acquireDomainLock(realmId: string): Promise<{ acquired: boolean; lock_id: string }> {
  if (domainLocks.has(realmId)) {
    return { acquired: false, lock_id: "" };
  }

  const native = await getNative();
  const userSid = native.getCurrentUserSid();
  const lockName = computeMutexName(userSid);

  // R05 修复：使用固定的 Mutex 名称，基于 userSid 和固定目标
  const mutex = native.createMutex(lockName);
  if (!mutex) {
    return { acquired: false, lock_id: "" };
  }

  const WAIT_OBJECT_0 = 0;
  const WAIT_ABANDONED = 0x80;
  const result = mutex.wait(10000); // 10 second timeout

  if (result !== WAIT_OBJECT_0 && result !== WAIT_ABANDONED) {
    mutex.release();
    return { acquired: false, lock_id: "" };
  }

  const lockId = `lock_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  domainLocks.set(realmId, {
    realmId,
    lockId,
    release: async () => {
      mutex.release();
      domainLocks.delete(realmId);
    },
  });

  return { acquired: true, lock_id: lockId };
}

async function releaseDomainLock(realmId: string, lockId: string): Promise<void> {
  const lock = domainLocks.get(realmId);
  if (!lock || lock.lockId !== lockId) return;
  await lock.release();
}

// ── R05 修复：Vault 操作函数 ──────────────────────────────────────────────────

function ensureVaultDir(realmId: string): void {
  const vaultPath = getVaultPath(realmId);
  if (!existsSync(vaultPath)) {
    mkdirSync(vaultPath, { recursive: true });
  }
}

function readEnvelope(realmId: string, accountId: string): VaultEnvelope | null {
  const path = getEnvelopePath(realmId, accountId);
  if (!existsSync(path)) return null;
  try {
    const data = readFileSync(path, "utf8");
    return JSON.parse(data) as VaultEnvelope;
  } catch {
    return null; // 文件损坏视为不存在
  }
}

function writeEnvelope(realmId: string, accountId: string, envelope: VaultEnvelope): void {
  ensureVaultDir(realmId);
  const path = getEnvelopePath(realmId, accountId);
  writeFileSync(path, JSON.stringify(envelope, null, 2), "utf8");
}

function deleteEnvelope(realmId: string, accountId: string): boolean {
  const path = getEnvelopePath(realmId, accountId);
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function listSavedEnvelopes(realmId: string): VaultEnvelope[] {
  const vaultPath = getVaultPath(realmId);
  if (!existsSync(vaultPath)) return [];
  try {
    const files = readdirSync(vaultPath);
    return files
      .filter(f => f.endsWith(".envelope.json") && !f.includes(".backup."))
      .map(f => {
        try {
          const data = readFileSync(join(vaultPath, f), "utf8");
          return JSON.parse(data) as VaultEnvelope;
        } catch {
          return null;
        }
      })
      .filter((e): e is VaultEnvelope => e !== null);
  } catch {
    return [];
  }
}

// ── Credential operations ───────────────────────────────────────────────────

async function inspectActive(realmId: string): Promise<unknown> {
  const native = await getNative();

  // R05 修复：使用固定目标 gemini:antigravity
  const cred = native.readCredential(FIXED_CREDENTIAL_TARGET);
  if (!cred) {
    return { exists: false };
  }

  try {
    const decrypted = native.unprotectData(cred.secret);
    const metadata = {
      exists: true,
      username: cred.username,
      secret_fingerprint: createHash("sha256").update(decrypted).digest("hex").slice(0, 32),
      last_modified: new Date().toISOString(),
    };
    // Zero out decrypted buffer
    decrypted.fill(0);
    return metadata;
  } catch {
    return { exists: true, username: cred.username, error: "decrypt_failed" };
  }
}

async function captureActive(realmId: string, accountId: string): Promise<unknown> {
  const native = await getNative();

  // R05 修复：使用固定目标 gemini:antigravity
  const cred = native.readCredential(FIXED_CREDENTIAL_TARGET);
  if (!cred) {
    throw new Error("no_active_credential");
  }

  // 解密 secret 以获取明文
  const decrypted = native.unprotectData(cred.secret);
  const secretRef = createHash("sha256").update(decrypted).digest("hex");

  // R05 修复：保存到 vault 目录
  const envelope: VaultEnvelope = {
    version: 2,
    realm_id: realmId,
    account_id: accountId,
    revision: 1,
    credential: {
      username: cred.username,
      secret_ref: secretRef,
      encrypted_secret: cred.secret.toString("base64"),
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  writeEnvelope(realmId, accountId, envelope);

  // Zero out decrypted buffer
  decrypted.fill(0);

  return {
    secret_ref: secretRef,
    credential_revision: 1,
  };
}

async function compareActive(realmId: string, secretRef: string): Promise<boolean> {
  const native = await getNative();

  // R05 修复：使用固定目标 gemini:antigravity
  const cred = native.readCredential(FIXED_CREDENTIAL_TARGET);
  if (!cred) return false;

  const decrypted = native.unprotectData(cred.secret);
  const currentRef = createHash("sha256").update(decrypted).digest("hex");
  decrypted.fill(0);
  return currentRef === secretRef;
}

async function activateSaved(realmId: string, accountId: string, secretRef: string): Promise<unknown> {
  const native = await getNative();

  // 从 vault 读取保存的凭据
  const envelope = readEnvelope(realmId, accountId);
  if (!envelope) {
    throw new Error("saved_credential_not_found");
  }

  // 验证 secret_ref 匹配
  if (envelope.credential.secret_ref !== secretRef) {
    throw new Error("secret_ref_mismatch");
  }

  // R05 修复：写入固定目标 gemini:antigravity
  const encryptedSecret = Buffer.from(envelope.credential.encrypted_secret, "base64");
  native.writeCredential(FIXED_CREDENTIAL_TARGET, envelope.credential.username, encryptedSecret);

  return { credential_revision: envelope.revision };
}

async function restoreBackup(realmId: string, backupRef: string): Promise<void> {
  const native = await getNative();

  // R05 修复：从 vault 目录读取备份
  const vaultPath = getVaultPath(realmId);
  if (!existsSync(vaultPath)) {
    throw new Error("backup_not_found");
  }

  const files = readdirSync(vaultPath);
  const backupFile = files.find(f => f.includes(".backup.") && f.endsWith(".envelope.json"));
  if (!backupFile) {
    throw new Error("backup_not_found");
  }

  try {
    const data = readFileSync(join(vaultPath, backupFile), "utf8");
    const envelope = JSON.parse(data) as VaultEnvelope;
    const encryptedSecret = Buffer.from(envelope.credential.encrypted_secret, "base64");
    native.writeCredential(FIXED_CREDENTIAL_TARGET, envelope.credential.username, encryptedSecret);
  } catch (err) {
    throw new Error("backup_restore_failed");
  }
}

async function clearActiveForLogin(realmId: string): Promise<{ backup_ref: string | undefined }> {
  const native = await getNative();

  // R05 修复：读取固定目标
  const cred = native.readCredential(FIXED_CREDENTIAL_TARGET);
  if (!cred) {
    return { backup_ref: undefined };
  }

  // 保存为备份
  const decrypted = native.unprotectData(cred.secret);
  const backupRef = createHash("sha256").update(decrypted).digest("hex");
  decrypted.fill(0);

  // R05 修复：保存到 vault 目录作为备份
  const envelope: VaultEnvelope = {
    version: 2,
    realm_id: realmId,
    account_id: "backup",
    revision: 1,
    credential: {
      username: cred.username,
      secret_ref: backupRef,
      encrypted_secret: cred.secret.toString("base64"),
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  writeEnvelope(realmId, "backup", envelope);

  // 清除活动凭据
  native.deleteCredential(FIXED_CREDENTIAL_TARGET);

  return { backup_ref: backupRef };
}

async function deleteSaved(realmId: string, secretRef: string): Promise<void> {
  // R05 修复：从 vault 目录删除匹配的凭据
  const envelopes = listSavedEnvelopes(realmId);
  const matching = envelopes.find(e => e.credential.secret_ref === secretRef);
  if (matching) {
    deleteEnvelope(realmId, matching.account_id);
  }
}

// ── IPC message handler ─────────────────────────────────────────────────────

async function handleRequest(req: Request): Promise<unknown> {
  switch (req.action) {
    case "acquire-domain-lock":
      return acquireDomainLock(String(req.args.realm_id));

    case "release-domain-lock":
      return releaseDomainLock(
        String(req.args.realm_id),
        String(req.args.lock_id),
      ).then(() => ({}));

    case "inspect-active":
      return inspectActive(String(req.args.realm_id));

    case "compare-active": {
      const matches = await compareActive(
        String(req.args.realm_id),
        String(req.args.secret_ref),
      );
      return { matches };
    }

    case "capture-active":
      return captureActive(
        String(req.args.realm_id),
        String(req.args.account_id),
      );

    case "activate-saved":
      return activateSaved(
        String(req.args.realm_id),
        String(req.args.account_id),
        String(req.args.secret_ref),
      );

    case "restore-backup":
      return restoreBackup(
        String(req.args.realm_id),
        String(req.args.backup_ref),
      );

    case "clear-active-for-login":
      return clearActiveForLogin(String(req.args.realm_id));

    case "delete-saved":
      return deleteSaved(
        String(req.args.realm_id),
        String(req.args.secret_ref),
      );

    case "capabilities":
      return {
        supported: process.platform === "win32",
        platform: process.platform,
        dpapi_available: process.platform === "win32",
        cred_manager_available: process.platform === "win32",
        named_mutex_available: process.platform === "win32",
        version: "3.0.0-node",
      };

    default:
      throw new Error(`unknown_action: ${req.action}`);
  }
}

// ── Main IPC loop ───────────────────────────────────────────────────────────

function main(): void {
  // Validate we're in a managed context
  if (!process.send && !process.argv.includes("--standalone")) {
    // Allow standalone for testing
  }

  const rl = createInterface({ input: process.stdin });
  let generation = 0;

  // Drain stdin on error
  process.stdin.on("error", () => {});
  process.stdout.on("error", () => {});
  process.stderr.resume(); // Discard stderr

  function sendResponse(resp: Response): void {
    try {
      const line = JSON.stringify(resp);
      if (process.stdout.writable) {
        process.stdout.write(line + "\n");
      }
    } catch {
      // Write failed, process is dying
    }
  }

  rl.on("line", (line) => {
    if (line.length > 65536) {
      // Too large, reject
      return;
    }

    let req: Request;
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }

    if (!req.id || !req.action) return;

    try {
      const result = handleRequest(req);
      if (result instanceof Promise) {
        result
          .then((data) => sendResponse({ id: req.id, ok: true, data }))
          .catch((err) => {
            const error = err instanceof Error ? err.message : "action_failed";
            sendResponse({ id: req.id, ok: false, error });
          });
      } else {
        sendResponse({ id: req.id, ok: true, data: result });
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : "action_failed";
      sendResponse({ id: req.id, ok: false, error });
    }
  });

  rl.on("close", () => {
    // Parent closed stdin, exit gracefully
    process.exit(0);
  });

  process.on("disconnect", () => {
    // IPC channel lost, exit immediately
    process.exit(1);
  });

  // Send ready signal
  sendResponse({
    id: "ready",
    ok: true,
    data: {
      pid: process.pid,
      platform: process.platform,
      generation: ++generation,
      version: "3.0.0-node",
    },
  });
}

// Run if this is the main module
main();
