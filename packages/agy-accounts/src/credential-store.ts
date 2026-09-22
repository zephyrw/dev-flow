/**
 * Credential vault (envelope v2 format) for AGY accounts.
 *
 * Reads/writes encrypted credential files in the old Go format.
 * Vault location: %LOCALAPPDATA%/DevFlow/agy-accounts/<realm>/
 * Files: sec_<hash>.bin, bak_<hash>.bin, each with a companion .revision file.
 *
 * The `encrypt` callback is injected so the store does not depend on DPAPI
 * directly — the caller decides the encryption backend.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  renameSync,
  fsyncSync,
  openSync,
  closeSync,
  lstatSync,
} from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

// ── Types ────────────────────────────────────────────────────────────────────

export interface VaultEnvelope {
  /** Envelope version — always 2 */
  Version: number;
  RealmID: string;
  AccountID: string;
  Revision: number;
  Credential: VaultCredential;
}

export interface VaultCredential {
  Exists: boolean;
  Flags: number;
  Username: string;
  Comment: string;
  Persist: number;
  TargetAlias: string;
  Attributes: Record<string, unknown>;
  /** Base64-encoded bytes (Go JSON `[]byte` format) */
  Secret: string;
}

export interface VaultPaths {
  /** `%LOCALAPPDATA%/DevFlow/agy-accounts/<realm>/` */
  baseDir: string;
  /** `sec_<hash>.bin` — active credential file */
  activeFile: string;
  /** `bak_<hash>.bin` — backup credential file */
  backupFile: string;
  /** `sec_<hash>.bin.revision` — companion revision for active file */
  revisionFile: string;
  /** `bak_<hash>.bin.revision` — companion revision for backup file */
  backupRevisionFile: string;
}

// ── Hashing ──────────────────────────────────────────────────────────────────

/**
 * Compute the hash used in vault filenames.
 *
 * SHA-256 of `realmId + ":" + accountId`, hex-encoded, truncated to 16 chars.
 */
export function hashVaultTarget(realmId: string, accountId: string): string {
  const digest = createHash("sha256")
    .update(`${realmId}:${accountId}`)
    .digest("hex");
  return digest.slice(0, 16);
}

// ── Paths ────────────────────────────────────────────────────────────────────

/**
 * Derive all vault file paths for a given realm/account pair.
 *
 * The base directory is `%LOCALAPPDATA%/DevFlow/agy-accounts/<realm>/`.
 * The hash portion is the first 16 hex chars of SHA-256(realm:account).
 */
export function getVaultPaths(realmId: string, accountId: string): VaultPaths {
  const localAppData =
    process.env.LOCALAPPDATA ??
    join(process.env.HOME ?? "", "AppData", "Local");
  const baseDir = join(localAppData, "DevFlow", "agy-accounts", realmId);
  const hash = hashVaultTarget(realmId, accountId);
  const activeName = `sec_${hash}.bin`;
  const backupName = `bak_${hash}.bin`;

  return {
    baseDir,
    activeFile: join(baseDir, activeName),
    backupFile: join(baseDir, backupName),
    revisionFile: join(baseDir, `${activeName}.revision`),
    backupRevisionFile: join(baseDir, `${backupName}.revision`),
  };
}

// ── Reparse-point guard ─────────────────────────────────────────────────────

/**
 * Throw if `filePath` exists and is a reparse point (symlink / junction).
 *
 * This prevents an attacker from redirecting a vault write to an arbitrary
 * location via a planted symlink.
 */
function assertNotReparsePoint(filePath: string): void {
  if (!existsSync(filePath)) return;

  let st;
  try {
    st = lstatSync(filePath);
  } catch {
    // If lstat fails the file disappeared — that is fine.
    return;
  }

  if (st.isSymbolicLink()) {
    throw new Error(
      `Refusing to write: ${filePath} is a reparse point (symlink/junction)`
    );
  }
}

// ── Read ─────────────────────────────────────────────────────────────────────

/**
 * Read and parse the active vault file.
 *
 * Returns the parsed `VaultEnvelope`, or `null` when the file does not exist
 * or cannot be read.
 */
export function readVaultEnvelope(paths: VaultPaths): VaultEnvelope | null {
  if (!existsSync(paths.activeFile)) return null;

  let raw: Buffer;
  try {
    raw = readFileSync(paths.activeFile);
  } catch {
    return null;
  }

  if (raw.length === 0) return null;

  try {
    const text = raw.toString("utf-8");
    const envelope: VaultEnvelope = JSON.parse(text);

    // Basic shape validation
    if (envelope.Version !== 2) {
      throw new Error(
        `Unexpected envelope version ${envelope.Version} (expected 2)`
      );
    }
    if (
      typeof envelope.RealmID !== "string" ||
      typeof envelope.AccountID !== "string" ||
      typeof envelope.Revision !== "number" ||
      !envelope.Credential
    ) {
      throw new Error("Malformed vault envelope");
    }

    return envelope;
  } catch {
    // Corrupt / unparseable file — treat as missing.
    return null;
  }
}

// ── Write ────────────────────────────────────────────────────────────────────

/**
 * Atomically write an encrypted vault envelope to the active file.
 *
 * Procedure:
 * 1. Ensure the base directory exists.
 * 2. Reject reparse points on the active file and its revision companion.
 * 3. Serialize the envelope, call the injected `encrypt` callback.
 * 4. Write to a temporary file (random suffix) in the same directory.
 * 5. `fsync` the temporary file to flush data to disk.
 * 6. Atomically `rename` the temp file over the active file.
 * 7. Rotate the previous active file to the backup position.
 *
 * The `encrypt` callback receives the plaintext buffer and must return the
 * ciphertext buffer.  The caller decides the encryption backend (DPAPI, etc.).
 */
export function writeVaultEnvelope(
  paths: VaultPaths,
  envelope: VaultEnvelope,
  encrypt: (data: Buffer) => Buffer
): void {
  // 1. Ensure directory
  mkdirSync(paths.baseDir, { recursive: true });

  // 2. Reparse-point checks
  assertNotReparsePoint(paths.activeFile);
  assertNotReparsePoint(paths.revisionFile);

  // 3. Serialize and encrypt
  const plaintext = Buffer.from(JSON.stringify(envelope), "utf-8");
  const ciphertext = encrypt(plaintext);

  // 4. Rotate current active -> backup (best-effort)
  if (existsSync(paths.activeFile)) {
    try {
      // Remove existing backup first
      if (existsSync(paths.backupFile)) {
        assertNotReparsePoint(paths.backupFile);
        unlinkSync(paths.backupFile);
      }
      if (existsSync(paths.backupRevisionFile)) {
        assertNotReparsePoint(paths.backupRevisionFile);
        unlinkSync(paths.backupRevisionFile);
      }
      renameSync(paths.activeFile, paths.backupFile);
      // Rotate companion revision if present
      if (existsSync(paths.revisionFile)) {
        renameSync(paths.revisionFile, paths.backupRevisionFile);
      }
    } catch {
      // Rotation is best-effort; a failure here is not fatal.
    }
  }

  // 5. Write to temp file in same directory
  const tmpSuffix = randomBytes(8).toString("hex");
  const tmpFile = `${paths.activeFile}.tmp.${tmpSuffix}`;

  try {
    writeFileSync(tmpFile, ciphertext);
    fsyncFile(tmpFile);

    // 6. Atomic rename over active file
    renameSync(tmpFile, paths.activeFile);
  } catch (err) {
    // Clean up temp file on failure
    try {
      if (existsSync(tmpFile)) unlinkSync(tmpFile);
    } catch {
      // Ignore cleanup failure
    }
    throw err;
  } finally {
    // Zero out plaintext from memory (best-effort)
    plaintext.fill(0);
  }
}

// ── Revision management ──────────────────────────────────────────────────────

/**
 * Read the current revision number from the `.revision` companion file.
 *
 * Returns `0` when the file does not exist or cannot be parsed.
 */
export function readRevision(paths: VaultPaths): number {
  if (!existsSync(paths.revisionFile)) return 0;

  try {
    const text = readFileSync(paths.revisionFile, "utf-8").trim();
    const n = Number(text);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

/**
 * Atomically allocate the next revision number.
 *
 * Reads the current value from disk, increments by one, writes the new value
 * to a temporary file, fsyncs, and renames over the `.revision` file.
 *
 * **Must be called under the domain lock** — concurrent callers would race on
 * the read-modify-write sequence.
 */
export function allocateRevision(paths: VaultPaths): number {
  const current = readRevision(paths);
  const next = current + 1;

  // Ensure directory
  mkdirSync(paths.baseDir, { recursive: true });

  // Reparse-point guard
  assertNotReparsePoint(paths.revisionFile);

  // Atomic write: tmp -> fsync -> rename
  const tmpSuffix = randomBytes(8).toString("hex");
  const tmpFile = `${paths.revisionFile}.tmp.${tmpSuffix}`;

  try {
    writeFileSync(tmpFile, String(next), "utf-8");
    fsyncFile(tmpFile);
    renameSync(tmpFile, paths.revisionFile);
  } catch (err) {
    try {
      if (existsSync(tmpFile)) unlinkSync(tmpFile);
    } catch {
      // Ignore cleanup failure
    }
    throw err;
  }

  return next;
}

// ── Deletion ─────────────────────────────────────────────────────────────────

/**
 * Remove all vault files for an account (active, backup, and revisions).
 *
 * Each removal is individually guarded — a missing file is silently skipped.
 * Reparse points are checked before deletion to avoid following symlinks.
 */
export function deleteVault(paths: VaultPaths): void {
  const files = [
    paths.activeFile,
    paths.backupFile,
    paths.revisionFile,
    paths.backupRevisionFile,
  ];

  for (const file of files) {
    if (!existsSync(file)) continue;
    assertNotReparsePoint(file);
    try {
      unlinkSync(file);
    } catch {
      // Best-effort; file may have been removed concurrently.
    }
  }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Open a file, call fsync on it, then close the descriptor.
 *
 * This is extracted so callers do not need to manage file descriptors
 * manually — `fsyncSync` requires a numeric fd, not a path.
 */
function fsyncFile(filePath: string): void {
  const fd = openSync(filePath, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
