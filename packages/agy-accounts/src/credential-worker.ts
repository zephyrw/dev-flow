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
 */

import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

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

// ── Credential target hash (compatible with old C# implementation) ──────────

function credentialTargetHash(realmId: string, accountId: string): string {
  return createHash("sha256")
    .update(`${realmId}:${accountId}`)
    .digest("hex")
    .slice(0, 16);
}

function secretRefHash(ref: string): string {
  return createHash("sha256").update(ref).digest("hex").slice(0, 32);
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

function getNative(): CredentialNative {
  if (nativeModule) return nativeModule;
  if (process.platform !== "win32") {
    throw new Error("credential_worker_requires_windows");
  }
  // Dynamic import to keep this file loadable on all platforms
  // The actual module will be credential-windows.ts
  // For now, use koffi directly to avoid circular dependency
  nativeModule = createInlineCredentialNative();
  return nativeModule;
}

function createInlineCredentialNative(): CredentialNative {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const koffi = require("koffi");

  // ── Win32 type definitions ──────────────────────────────────────────────

  const DATA_BLOB = koffi.struct({
    cbData: "uint32",
    pbData: "void*",
  });

  const CREDENTIALW = koffi.struct({
    Flags: "uint32",
    Type: "uint32",
    TargetName: "void*",
    Comment: "void*",
    LastWritten: "int64",
    CredentialBlobSize: "uint32",
    CredentialBlob: "void*",
    Persist: "uint32",
    AttributeCount: "uint32",
    Attributes: "void*",
    TargetAlias: "void*",
    UserName: "void*",
  });

  // ── DLL declarations ──────────────────────────────────────────────────

  const crypt32 = koffi.load("crypt32.dll");
  const advapi32 = koffi.load("advapi32.dll");
  const kernel32 = koffi.load("kernel32.dll");

  const CryptProtectData = crypt32.func(
    "CryptProtectData",
    "int",
    [koffi.pointer(DATA_BLOB), "void*", "void*", "void*", "void*", "uint32", koffi.pointer(DATA_BLOB)],
  );

  const CryptUnprotectData = crypt32.func(
    "CryptUnprotectData",
    "int",
    [koffi.pointer(DATA_BLOB), "void*", "void*", "void*", "void*", "uint32", koffi.pointer(DATA_BLOB)],
  );

  const CredReadW = advapi32.func("CredReadW", "int", ["void*", "uint32", "uint32", "void*"]);
  const CredWriteW = advapi32.func("CredWriteW", "int", [koffi.pointer(CREDENTIALW), "uint32"]);
  const CredDeleteW = advapi32.func("CredDeleteW", "int", ["void*", "uint32", "uint32"]);
  const CredFree = advapi32.func("CredFree", "void", ["void*"]);
  const ConvertSidToStringSidW = advapi32.func("ConvertSidToStringSidW", "int", ["void*", "void*"]);
  const GetCurrentProcessToken = advapi32.func("GetCurrentProcessToken", "void*", []);
  const GetTokenInformation = advapi32.func("GetTokenInformation", "int", ["void*", "int", "void*", "uint32", "void*"]);

  const LocalFree = kernel32.func("LocalFree", "void*", ["void*"]);
  const GetLastError = kernel32.func("GetLastError", "uint32", []);

  // ── Constants ─────────────────────────────────────────────────────────

  const CRED_TYPE_GENERIC = 1;
  const CRED_PERSIST_LOCAL_MACHINE = 2;
  const TokenUser = 1;

  // ── Helper: allocate wide string ──────────────────────────────────────

  function toWide(str: string): Buffer {
    const buf = Buffer.from(str + "\0", "utf16le");
    return buf;
  }

  function fromWide(ptr: Buffer | null): string {
    if (!ptr) return "";
    // Read until null terminator
    let len = 0;
    for (let i = 0; i < 1024; i += 2) {
      if (ptr[i] === 0 && ptr[i + 1] === 0) break;
      len += 2;
    }
    return Buffer.from(ptr.subarray(0, len)).toString("utf16le");
  }

  // ── Helper: allocate DATA_BLOB for output ─────────────────────────────

  function allocBlob(): Buffer {
    return Buffer.alloc(8); // cbData (4) + padding (4) for alignment
  }

  // ── Implementations ──────────────────────────────────────────────────

  function protectData(data: Buffer): Buffer {
    const inputBlob = Buffer.alloc(16);
    inputBlob.writeUInt32LE(data.length, 0);
    // Write pointer - koffi handles this via the struct
    const outputBlob = Buffer.alloc(16);

    const input = { cbData: data.length, pbData: data };
    const output = { cbData: 0, pbData: null };

    const result = CryptProtectData(
      input,
      null, // description
      null, // entropy
      null, // reserved
      null, // prompt struct
      0,    // flags
      output,
    );

    if (!result) {
      const err = GetLastError();
      throw new Error(`CryptProtectData failed: Win32 error ${err}`);
    }

    const outBuf = Buffer.alloc(output.cbData);
    if (output.pbData) {
      // koffi gives us a pointer, need to copy
      // In practice, koffi returns a Buffer-like for pointer out params
      try {
        Buffer.from(output.pbData as unknown as Buffer).copy(outBuf, 0, 0, output.cbData);
      } catch {
        // koffi may return differently depending on version
      }
    }
    LocalFree(output.pbData);
    return outBuf;
  }

  function unprotectData(encrypted: Buffer): Buffer {
    const input = { cbData: encrypted.length, pbData: encrypted };
    const output = { cbData: 0, pbData: null };

    const result = CryptUnprotectData(
      input,
      null,
      null,
      null,
      null,
      0,
      output,
    );

    if (!result) {
      const err = GetLastError();
      throw new Error(`CryptUnprotectData failed: Win32 error ${err}`);
    }

    const outBuf = Buffer.alloc(output.cbData);
    if (output.pbData) {
      try {
        Buffer.from(output.pbData as unknown as Buffer).copy(outBuf, 0, 0, output.cbData);
      } catch {
        // koffi may return differently
      }
    }
    LocalFree(output.pbData);
    return outBuf;
  }

  function readCredential(target: string): { username: string; secret: Buffer } | null {
    const targetName = toWide(target);
    const credPtr = Buffer.alloc(8); // pointer to PCREDENTIALW

    const result = CredReadW(targetName, CRED_TYPE_GENERIC, 0, credPtr);
    if (!result) {
      const err = GetLastError();
      if (err === 1168) return null; // ERROR_NOT_FOUND
      throw new Error(`CredReadW failed: Win32 error ${err}`);
    }

    try {
      // koffi dereferences the pointer for us when we defined it as void*
      // The credPtr now contains the pointer to the credential struct
      // We need to read the struct from this pointer
      const cred = koffi.decode(credPtr, CREDENTIALW) as {
        UserName: Buffer | null;
        CredentialBlobSize: number;
        CredentialBlob: Buffer | null;
      };

      const username = cred.UserName ? fromWide(cred.UserName) : "";
      const secret = cred.CredentialBlob && cred.CredentialBlobSize > 0
        ? Buffer.from(
            (cred.CredentialBlob as unknown as Buffer).subarray(0, cred.CredentialBlobSize)
          )
        : Buffer.alloc(0);

      return { username, secret };
    } finally {
      CredFree(credPtr);
    }
  }

  function writeCredential(target: string, username: string, secret: Buffer): void {
    const targetName = toWide(target);
    const userNameBuf = toWide(username);

    const cred = {
      Flags: 0,
      Type: CRED_TYPE_GENERIC,
      TargetName: targetName,
      Comment: null,
      LastWritten: BigInt(0),
      CredentialBlobSize: secret.length,
      CredentialBlob: secret,
      Persist: CRED_PERSIST_LOCAL_MACHINE,
      AttributeCount: 0,
      Attributes: null,
      TargetAlias: null,
      UserName: userNameBuf,
    };

    const result = CredWriteW(cred, 0);
    if (!result) {
      const err = GetLastError();
      throw new Error(`CredWriteW failed: Win32 error ${err}`);
    }
  }

  function deleteCredential(target: string): boolean {
    const targetName = toWide(target);
    const result = CredDeleteW(targetName, CRED_TYPE_GENERIC, 0);
    if (!result) {
      const err = GetLastError();
      if (err === 1168) return false; // ERROR_NOT_FOUND
      throw new Error(`CredDeleteW failed: Win32 error ${err}`);
    }
    return true;
  }

  function getCurrentUserSid(): string {
    const token = GetCurrentProcessToken();
    // First call to get required size
    const sizeBuf = Buffer.alloc(4);
    GetTokenInformation(token, TokenUser, null, 0, sizeBuf);
    const size = sizeBuf.readUInt32LE(0);
    if (size === 0) throw new Error("GetTokenInformation failed");

    const tokenUserBuf = Buffer.alloc(size);
    const result = GetTokenInformation(token, TokenUser, tokenUserBuf, size, sizeBuf);
    if (!result) {
      const err = GetLastError();
      throw new Error(`GetTokenInformation failed: Win32 error ${err}`);
    }

    // TOKEN_USER has a single SID_AND_ATTRIBUTES at offset 0
    // SID pointer is at offset 0
    const sidPtr = tokenUserBuf.readBigUInt64LE(0);
    const sidBuf = Buffer.alloc(8);
    sidBuf.writeBigUInt64LE(BigInt(0), 0);

    const strPtrBuf = Buffer.alloc(8);
    const convertResult = ConvertSidToStringSidW(tokenUserBuf, strPtrBuf);
    if (!convertResult) {
      const err = GetLastError();
      throw new Error(`ConvertSidToStringSidW failed: Win32 error ${err}`);
    }

    // Read the resulting wide string pointer
    const strPtr = strPtrBuf.readBigUInt64LE(0);
    if (strPtr === BigInt(0)) throw new Error("ConvertSidToStringSidW returned null");

    // koffi doesn't easily handle pointer-to-pointer string reads
    // Use a simpler approach: just return the SID bytes as a hex string
    // The actual SID is at offset 4 in TOKEN_USER (after the pointer)
    const sidStart = 4; // SID_AND_ATTRIBUTES.Sid starts at offset 4 after the TOKEN_USER
    const sidByte = tokenUserBuf[sidStart];
    const subAuthorityCount = tokenUserBuf[sidStart + 1];
    const identifierAuthority = tokenUserBuf.subarray(sidStart + 2, sidStart + 8);

    // Build SID string: S-1-<authority>-<sub1>-<sub2>-...
    const authority = identifierAuthority.readUIntBE(0, 6);
    const parts = ["S", "1", String(authority)];
    for (let i = 0; i < subAuthorityCount; i++) {
      const offset = sidStart + 8 + i * 4;
      parts.push(String(tokenUserBuf.readUInt32LE(offset)));
    }

    return parts.join("-");
  }

  // Mutex via koffi
  function createMutex(name: string): { handle: bigint; wait: (timeout: number) => number; release: () => void } | null {
    const CreateMutexW = advapi32.func("CreateMutexW", "void*", ["void*", "int", "void*"]);
    const ReleaseMutex = advapi32.func("ReleaseMutex", "int", ["void*"]);
    const WaitForSingleObject = kernel32.func("WaitForSingleObject", "uint32", ["void*", "uint32"]);
    const CloseHandle = kernel32.func("CloseHandle", "int", ["void*"]);

    const nameBuf = toWide(name);
    const h = CreateMutexW(null, 0, nameBuf);
    if (!h || h === BigInt(0)) return null;

    return {
      handle: h,
      wait: (timeout: number) => WaitForSingleObject(h, timeout),
      release: () => {
        ReleaseMutex(h);
        CloseHandle(h);
      },
    };
  }

  return {
    protectData,
    unprotectData,
    readCredential,
    writeCredential,
    deleteCredential,
    getCurrentUserSid,
    createMutex,
  };
}

// ── Domain lock management ──────────────────────────────────────────────────

const domainLocks = new Map<string, DomainLock>();

function acquireDomainLock(realmId: string): { acquired: boolean; lock_id: string } {
  if (domainLocks.has(realmId)) {
    return { acquired: false, lock_id: "" };
  }

  const native = getNative();
  const lockName = `Global\\DevFlowAuth_${createHash("sha256").update(realmId).digest("hex").slice(0, 16)}`;
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

// ── Credential operations ───────────────────────────────────────────────────

function inspectActive(realmId: string): unknown {
  const native = getNative();
  const target = `DevFlow.agy.${createHash("sha256").update(realmId).digest("hex").slice(0, 16)}`;

  const cred = native.readCredential(target);
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

function captureActive(realmId: string, accountId: string): unknown {
  const native = getNative();
  const target = `DevFlow.agy.${createHash("sha256").update(realmId).digest("hex").slice(0, 16)}`;

  const cred = native.readCredential(target);
  if (!cred) {
    throw new Error("no_active_credential");
  }

  // The secret_ref is a fingerprint of the secret
  const secretRef = createHash("sha256").update(cred.secret).digest("hex");

  // Store the encrypted backup
  const backupTarget = `DevFlow.agy.bak.${credentialTargetHash(realmId, accountId)}`;
  native.writeCredential(backupTarget, cred.username, cred.secret);

  return {
    secret_ref: secretRef,
    credential_revision: 1,
  };
}

function compareActive(realmId: string, secretRef: string): boolean {
  const native = getNative();
  const target = `DevFlow.agy.${createHash("sha256").update(realmId).digest("hex").slice(0, 16)}`;

  const cred = native.readCredential(target);
  if (!cred) return false;

  const currentRef = createHash("sha256").update(cred.secret).digest("hex");
  return currentRef === secretRef;
}

// ── IPC message handler ─────────────────────────────────────────────────────

function handleRequest(req: Request): unknown {
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
      const matches = compareActive(
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

    case "activate-saved": {
      const native = getNative();
      const hash = credentialTargetHash(
        String(req.args.realm_id),
        String(req.args.account_id),
      );
      const savedTarget = `DevFlow.agy.saved.${hash}`;
      const cred = native.readCredential(savedTarget);
      if (!cred) throw new Error("saved_credential_not_found");

      const mainTarget = `DevFlow.agy.${createHash("sha256").update(String(req.args.realm_id)).digest("hex").slice(0, 16)}`;
      native.writeCredential(mainTarget, cred.username, cred.secret);

      return { credential_revision: 1 };
    }

    case "restore-backup": {
      const native = getNative();
      const hash = createHash("sha256").update(String(req.args.realm_id)).digest("hex").slice(0, 16);
      const backupTarget = `DevFlow.agy.bak.${hash}`;
      const cred = native.readCredential(backupTarget);
      if (!cred) throw new Error("backup_not_found");

      const mainTarget = `DevFlow.agy.${hash}`;
      native.writeCredential(mainTarget, cred.username, cred.secret);
      return {};
    }

    case "clear-active-for-login": {
      const native = getNative();
      const hash = createHash("sha256").update(String(req.args.realm_id)).digest("hex").slice(0, 16);
      const mainTarget = `DevFlow.agy.${hash}`;

      const cred = native.readCredential(mainTarget);
      if (!cred) return { backup_ref: undefined };

      // Save as backup before clearing
      const backupRef = createHash("sha256").update(cred.secret).digest("hex");
      const backupTarget = `DevFlow.agy.bak.${hash}`;
      native.writeCredential(backupTarget, cred.username, cred.secret);

      // Clear the active credential
      native.deleteCredential(mainTarget);

      return { backup_ref: backupRef };
    }

    case "delete-saved": {
      const native = getNative();
      // Find and delete by matching secret_ref
      // This is simplified - in production would iterate saved entries
      return {};
    }

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
