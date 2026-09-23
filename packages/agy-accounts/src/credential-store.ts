import { z } from "zod";
import {
  lstatSync,
  readFileSync,
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const integer = z.number().int().min(0).max(0xffffffff);
const base64 = z
  .string()
  .max(24 * 1024 * 1024)
  .refine((value) => Buffer.from(value, "base64").toString("base64") === value)
  .nullable();
export const VaultCredentialSchema = z
  .object({
    Exists: z.boolean(),
    Flags: integer,
    Username: z.string(),
    Comment: z.string(),
    Persist: integer,
    TargetAlias: z.string(),
    Attributes: z
      .array(
        z
          .object({ Keyword: z.string(), Flags: integer, Value: base64 })
          .strict(),
      )
      .max(64)
      .nullable(),
    Secret: base64,
  })
  .strict();
export type VaultCredential = z.infer<typeof VaultCredentialSchema>;
const EnvelopeSchema = z
  .object({
    Version: z.literal(2),
    RealmID: z.string(),
    AccountID: z.string(),
    Revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    Credential: VaultCredentialSchema,
  })
  .strict();
export type VaultEnvelope = z.infer<typeof EnvelopeSchema>;
export interface VaultNative {
  protectData(data: Buffer): Buffer;
  unprotectData(data: Buffer): Buffer;
  restrictPath(path: string): void;
  assertSafePath(path: string): void;
}
export function validateRealm(value: string): void {
  if (!/^[A-Za-z0-9_-]{1,150}$/.test(value)) throw new Error("invalid_realm");
}
export function validateReference(value: string): void {
  if (!/^(sec|bak)_[a-f0-9]{32}$/.test(value))
    throw new Error("invalid_reference");
}
export function newReference(prefix: "sec" | "bak"): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}
export function equalCredential(
  a: VaultCredential,
  b: VaultCredential,
): boolean {
  return (
    a.Exists === b.Exists &&
    a.Flags === b.Flags &&
    a.Username === b.Username &&
    a.Comment === b.Comment &&
    a.Persist === b.Persist &&
    a.TargetAlias === b.TargetAlias &&
    (a.Secret ?? "") === (b.Secret ?? "") &&
    JSON.stringify(a.Attributes ?? []) === JSON.stringify(b.Attributes ?? [])
  );
}
// This object is used only by the credential worker while its OS domain mutex is held.
export class CredentialVault {
  constructor(
    private native: VaultNative,
    private localAppData = process.env.LOCALAPPDATA,
  ) {}
  private exists(path: string): boolean {
    try {
      if (lstatSync(path).isSymbolicLink())
        throw new Error("vault_reparse_path");
      this.native.assertSafePath(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  private directory(realm: string): string {
    validateRealm(realm);
    if (!this.localAppData) throw new Error("local_appdata_unavailable");
    this.native.assertSafePath(this.localAppData);
    let path = this.localAppData;
    for (const part of ["DevFlow", "agy-accounts", realm]) {
      path = join(path, part);
      if (!this.exists(path)) mkdirSync(path);
      if (!lstatSync(path).isDirectory())
        throw new Error("vault_directory_invalid");
      this.native.restrictPath(path);
    }
    return path;
  }
  private path(realm: string, ref: string): string {
    validateReference(ref);
    return join(this.directory(realm), ref + ".bin");
  }
  private writeAtomic(path: string, bytes: Buffer) {
    this.exists(path); // Reject reparse targets; propagate access errors.
    const temp = path + ".tmp." + randomBytes(16).toString("hex");
    let fd: number | undefined;
    try {
      fd = openSync(temp, "wx", 0o600);
      this.native.restrictPath(temp);
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      this.exists(path);
      renameSync(temp, path);
    } finally {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(temp);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  allocateRevision(realm: string): number {
    const path = join(this.directory(realm), "revision");
    let previous = 0;
    if (this.exists(path)) {
      const text = readFileSync(path, "utf8");
      if (!/^\d+$/.test(text)) throw new Error("invalid_vault_revision");
      previous = Number(text);
      if (!Number.isSafeInteger(previous) || previous < 0)
        throw new Error("invalid_vault_revision");
    }
    if (previous >= Number.MAX_SAFE_INTEGER)
      throw new Error("vault_revision_exhausted");
    const next = Math.max(Date.now(), previous + 1);
    this.writeAtomic(path, Buffer.from(String(next)));
    return next;
  }
  save(realm: string, ref: string, envelope: VaultEnvelope): void {
    const path = this.path(realm, ref);
    if (this.exists(path)) throw new Error("vault_reference_exists");
    const checked = EnvelopeSchema.safeParse(envelope);
    if (!checked.success || envelope.RealmID !== realm)
      throw new Error("invalid_vault_envelope");
    const plain = Buffer.from(JSON.stringify(checked.data));
    try {
      this.writeAtomic(path, this.native.protectData(plain));
    } finally {
      plain.fill(0);
    }
  }
  load(realm: string, ref: string): VaultEnvelope {
    const path = this.path(realm, ref);
    if (!this.exists(path)) throw new Error("vault_item_missing");
    if (lstatSync(path).size > 16 * 1024 * 1024)
      throw new Error("vault_item_too_large");
    const plain = this.native.unprotectData(readFileSync(path));
    try {
      let value: unknown;
      try {
        value = JSON.parse(plain.toString("utf8"));
      } catch {
        throw new Error("invalid_vault_envelope");
      }
      const parsed = EnvelopeSchema.safeParse(value);
      if (!parsed.success || parsed.data.RealmID !== realm)
        throw new Error("incompatible_vault_envelope");
      return parsed.data;
    } finally {
      plain.fill(0);
    }
  }
  delete(realm: string, ref: string): void {
    const path = this.path(realm, ref);
    if (!this.exists(path)) return;
    unlinkSync(path);
  }
}
