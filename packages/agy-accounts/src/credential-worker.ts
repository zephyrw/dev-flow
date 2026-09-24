import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CredentialVault,
  equalCredential,
  newReference,
  validateRealm,
  type VaultCredential,
} from "./credential-store.js";
import { extractSafeAuthMetadata } from "./auth-metadata.js";

const TARGET = "gemini:antigravity";
const generation = process.argv
  .find((value) => value.startsWith("--generation="))
  ?.slice(13);
if (
  !process.argv.includes("--managed") ||
  !generation ||
  !/^[a-f0-9-]{36}$/.test(generation)
)
  process.exit(1);
const RequestSchema = z
  .object({
    id: z.string().regex(/^[0-9]{1,16}$/),
    generation: z.literal(generation),
    action: z.enum([
      "capabilities",
      "acquire-domain-lock",
      "release-domain-lock",
      "inspect-active",
      "compare-active",
      "capture-active",
      "activate-saved",
      "restore-backup",
      "clear-active-for-login",
      "delete-saved",
    ]),
    args: z.record(z.string(), z.unknown()),
  })
  .strict();
let native:
  | ReturnType<typeof import("./credential-windows.js").createCredentialWindows>
  | undefined;
let vault: CredentialVault;
let lock: { realm: string; id: string; release: () => void } | undefined;
let active: { realm: string; ref: string; account: string } | undefined;
async function initialize() {
  if (native) return native;
  if (process.platform !== "win32") throw new Error("unsupported_platform");
  native = (await import("./credential-windows.js")).createCredentialWindows();
  vault = new CredentialVault(native);
  return native;
}
function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length > 200 || value.includes("\0"))
    throw new Error("invalid_argument");
  return value;
}
function metadata(credential: VaultCredential) {
  const bytes = Buffer.from(credential.Secret ?? "", "base64");
  try {
    return extractSafeAuthMetadata(bytes);
  } finally {
    bytes.fill(0);
  }
}
async function handle(
  request: z.infer<typeof RequestSchema>,
): Promise<unknown> {
  const win = await initialize();
  const { action, args } = request;
  if (action === "capabilities") {
    const probe = Buffer.from("DevFlow DPAPI capability");
    let decrypted: Buffer | undefined;
    let release: (() => void) | null = null;
    try {
      decrypted = win.unprotectData(win.protectData(probe));
      if (!decrypted.equals(probe)) throw new Error("capability_unavailable");
      win.readCredential("DevFlow-capability-" + randomUUID());
      release = win.acquireMutex("Local\\DevFlowAuthProbe_" + randomUUID());
      if (!release) throw new Error("capability_unavailable");
      return {
        supported: true,
        platform: process.platform,
        dpapi_available: true,
        cred_manager_available: true,
        named_mutex_available: true,
        version: "3.0.0-node",
      };
    } finally {
      probe.fill(0);
      decrypted?.fill(0);
      release?.();
    }
  }
  const realm = stringArg(args, "realm_id");
  validateRealm(realm);
  if (action === "acquire-domain-lock") {
    if (lock) return { acquired: false, lock_id: "" };
    const hash = createHash("sha256")
      .update(win.getCurrentUserSid() + ":" + TARGET)
      .digest("hex");
    const release = win.acquireMutex("Global\\DevFlowAuth_" + hash);
    if (!release) return { acquired: false, lock_id: "" };
    lock = { realm, id: randomUUID(), release };
    return { acquired: true, lock_id: lock.id };
  }
  if (!lock || lock.realm !== realm || lock.id !== stringArg(args, "lock_id"))
    throw new Error("domain_lock_not_held");
  if (action === "release-domain-lock") {
    lock.release();
    lock = undefined;
    active = undefined;
    return {};
  }
  if (action === "inspect-active") {
    const credential = win.readCredential(TARGET);
    const saved =
      active?.realm === realm ? vault.load(realm, active.ref) : undefined;
    const matches = saved && equalCredential(saved.Credential, credential);
    if (!matches) active = undefined;
    return {
      exists: credential.Exists,
      auth: metadata(credential),
      ...(matches && active
        ? { secret_ref: active.ref, account_id: active.account }
        : {}),
    };
  }
  if (action === "capture-active" || action === "clear-active-for-login") {
    const backup = action === "clear-active-for-login";
    const account = backup ? "" : stringArg(args, "account_id");
    if (!backup && !/^[A-Za-z0-9_-]{1,150}$/.test(account))
      throw new Error("invalid_account");
    const credential = win.readCredential(TARGET);
    const ref = newReference(backup ? "bak" : "sec");
    const revision = vault.allocateRevision(realm);
    vault.save(realm, ref, {
      Version: 2,
      RealmID: realm,
      AccountID: account,
      Revision: revision,
      Credential: credential,
    });
    // Persist and read back the backup before changing the official credential target.
    if (!equalCredential(vault.load(realm, ref).Credential, credential))
      throw new Error("vault_readback_failed");
    if (backup) {
      win.deleteCredential(TARGET);
      if (win.readCredential(TARGET).Exists)
        throw new Error("credential_readback_failed");
      active = undefined;
      return { backup_ref: ref };
    }
    active = { realm, ref, account };
    return {
      secret_ref: ref,
      credential_revision: revision,
      auth: metadata(credential),
    };
  }
  const restore = action === "restore-backup";
  const ref = stringArg(args, restore ? "backup_ref" : "secret_ref");
  // Account operations also use capture-active snapshots as rollback backups.
  if (restore && !/^(bak|sec)_[a-f0-9]{32}$/.test(ref)) throw new Error("invalid_reference");
  if (action === "delete-saved") {
    if (active?.realm === realm && active.ref === ref)
      throw new Error("cannot_delete_active");
    vault.delete(realm, ref);
    return {};
  }
  const saved = vault.load(realm, ref);
  if (action === "compare-active")
    return {
      matches: equalCredential(win.readCredential(TARGET), saved.Credential),
    };
  if (action === "activate-saved" || restore) {
    if (!restore && saved.AccountID !== stringArg(args, "account_id"))
      throw new Error("account_reference_mismatch");
    win.writeCredential(TARGET, saved.Credential);
    if (!equalCredential(win.readCredential(TARGET), saved.Credential))
      throw new Error("credential_readback_failed");
    active = { realm, ref, account: saved.AccountID };
    return restore ? {} : { credential_revision: saved.Revision };
  }
  throw new Error("invalid_action");
}

// Serial execution is essential: Windows mutex ownership is thread-recursive and
// concurrent lock requests must not both report acquisition.
let queue = Promise.resolve();
let buffer = "";
let queued = 0;
function send(value: Record<string, unknown>) {
  process.stdout.write(JSON.stringify({ ...value, generation }) + "\n");
}
function shutdown(code: number) {
  try {
    lock?.release();
  } finally {
    lock = undefined;
    process.exit(code);
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  if (Buffer.byteLength(buffer) > 65536) {
    shutdown(1);
    return;
  }
  let newline: number;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    let request: z.infer<typeof RequestSchema>;
    try {
      request = RequestSchema.parse(JSON.parse(line));
    } catch {
      shutdown(1);
      return;
    }
    if (++queued > 64) {
      shutdown(1);
      return;
    }
    queue = queue
      .then(async () => {
        try {
          send({ id: request.id, ok: true, data: await handle(request) });
        } catch (error) {
          // Native/JSON parse errors can include sensitive input. Only send known codes.
          const message = error instanceof Error ? error.message : "";
          send({
            id: request.id,
            ok: false,
            error: /^[a-z_]{1,80}$/.test(message)
              ? message
              : "credential_action_failed",
          });
        } finally {
          queued--;
        }
      })
      .catch(() => shutdown(1));
  }
});
process.stdin.on("end", () => {
  void queue.finally(() => shutdown(buffer.trim() ? 1 : 0));
});
process.stdin.on("error", () => shutdown(1));
process.stdout.on("error", () => shutdown(1));
process.on("SIGTERM", () => shutdown(1));
process.on("SIGINT", () => shutdown(1));
send({
  id: "ready",
  ok: true,
  data: { version: "3.0.0-node", pid: process.pid },
});
