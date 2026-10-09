import koffi from "koffi";
import { spawnSync } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  tryAcquireFlock,
  releaseFlock,
} from "../../process/src/native/posix.js";
import type { CredentialNative } from "./credential-native.js";
import type { VaultCredential } from "./credential-store.js";

/** Keychain access stays inside the owned worker; helper secrets use pipes, never argv. */
export function createCredentialDarwin(): CredentialNative {
  if (process.platform !== "darwin") throw new Error("unsupported_platform");
  const security = koffi.load(
    "/System/Library/Frameworks/Security.framework/Security",
  );
  const cf = koffi.load(
    "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation",
  );
  const release = cf.func("void CFRelease(void *value)");
  const string = cf.func(
    "void *CFStringCreateWithCString(void *allocator, str value, uint32 encoding)",
  );
  const dictionary = cf.func(
    "void *CFDictionaryCreateMutable(void *allocator, long capacity, void *keys, void *values)",
  );
  const set = cf.func(
    "void CFDictionarySetValue(void *dictionary, void *key, void *value)",
  );
  const data = cf.func(
    "void *CFDataCreate(void *allocator, void *bytes, long length)",
  );
  const length = cf.func("long CFDataGetLength(void *data)");
  const bytes = cf.func("void *CFDataGetBytePtr(void *data)");
  const copy = security.func(
    "int32 SecItemCopyMatching(void *query, void *result)",
  );
  const add = security.func("int32 SecItemAdd(void *attributes, void *result)");
  const update = security.func(
    "int32 SecItemUpdate(void *query, void *attributes)",
  );
  const remove = security.func("int32 SecItemDelete(void *query)");
  const constant = (name: string, library = security) =>
    koffi.decode(library.symbol(name), "void *");
  const missing = -25300;
  const check = (status: number) => {
    if (status !== 0) throw new Error("keychain_action_failed");
  };
  const targetParts = (target: string) => {
    if (!target || target.includes("\0"))
      throw new Error("invalid_credential_target");
    const separator = target.indexOf(":");
    return separator < 0
      ? [target, "DevFlow"]
      : [target.slice(0, separator), target.slice(separator + 1)];
  };
  function withQuery<T>(target: string, fn: (query: unknown) => T): T {
    const query = dictionary(
      null,
      0,
      cf.symbol("kCFTypeDictionaryKeyCallBacks"),
      cf.symbol("kCFTypeDictionaryValueCallBacks"),
    );
    if (!query) throw new Error("keychain_allocation_failed");
    try {
      set(query, constant("kSecClass"), constant("kSecClassGenericPassword"));
      for (const [name, value] of ["kSecAttrService", "kSecAttrAccount"].map(
        (name, i) => [name, targetParts(target)[i]!],
      )) {
        const text = string(null, value, 0x08000100);
        if (!text) throw new Error("keychain_allocation_failed");
        try {
          set(query, constant(name!), text);
        } finally {
          release(text);
        }
      }
      return fn(query);
    } finally {
      release(query);
    }
  }
  function officialHelper(args: string[], input?: Buffer): Buffer | undefined {
    const result = spawnSync("/usr/bin/security", args, {
      input, timeout: 120000, maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    try {
      if (!result.error && result.status === 44 && args[0] === "find-generic-password") return undefined;
      if (result.error || result.status !== 0) throw new Error("keychain_action_failed");
      const output = result.stdout;
      return Buffer.from(output.subarray(0, output.at(-1) === 10 ? -1 : undefined));
    } finally {
      input?.fill(0);
      result.stdout?.fill(0);
      result.stderr?.fill(0);
    }
  }
  function readSecret(target: string): Buffer | undefined {
    if (target === "gemini:antigravity") {
      return officialHelper(["find-generic-password", "-s", "gemini", "-wa", "antigravity"]);
    }
    return withQuery(target, (query) => {
      set(query, constant("kSecReturnData"), constant("kCFBooleanTrue", cf));
      set(query, constant("kSecMatchLimit"), constant("kSecMatchLimitOne"));
      const output = Buffer.alloc(koffi.sizeof("void *"));
      const status = copy(query, output);
      if (status === missing) return undefined;
      check(status);
      const value = koffi.decode(output, "void *");
      if (!value) throw new Error("keychain_data_invalid");
      try {
        const size = Number(length(value));
        if (!Number.isSafeInteger(size) || size < 0 || size > 16 * 1024 * 1024)
          throw new Error("keychain_data_invalid");
        return size
          ? Buffer.from(koffi.decode(bytes(value), "uint8", size))
          : Buffer.alloc(0);
      } finally {
        release(value);
      }
    });
  }
  function writeSecret(target: string, secret: Buffer, onlyAdd = false): void {
    if (target === "gemini:antigravity") {
      // macOS re-creates the signature partition even on a value-only update.
      // Use the same stable Apple helper as AGY for BOTH reads and writes.
      // go-keyring itself uses this ASCII command format and 4096-byte limit.
      const raw = secret.toString("utf8");
      if (!Buffer.from(raw).equals(secret) || /[^\x20-\x7e]/.test(raw))
        throw new Error("keychain_data_invalid");
      const command = Buffer.from(`add-generic-password -U -s gemini -a antigravity -w ${JSON.stringify(raw)}\n`);
      if (command.length > 4096) {
        command.fill(0);
        throw new Error("keychain_data_invalid");
      }
      try {
        officialHelper(["-i"], command)?.fill(0);
      } finally { command.fill(0); }
      return;
    }
    withQuery(target, (query) => {
      const attributes = dictionary(
        null,
        0,
        cf.symbol("kCFTypeDictionaryKeyCallBacks"),
        cf.symbol("kCFTypeDictionaryValueCallBacks"),
      );
      const value = data(null, secret, secret.length);
      if (!attributes || !value) {
        if (attributes) release(attributes);
        if (value) release(value);
        throw new Error("keychain_allocation_failed");
      }
      try {
        set(attributes, constant("kSecValueData"), value);
        // Update only the value. Replacing SecAccess discards Always Allow
        // grants and may itself require a password on every account switch.
        const status = onlyAdd ? missing : update(query, attributes);
        if (status !== missing) {
          check(status);
          return;
        }
        set(query, constant("kSecValueData"), value);
        check(add(query, null));
      } finally {
        release(value);
        release(attributes);
      }
    });
  }
  const uid = process.getuid!();
  function assertSafePath(path: string): void {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
      throw new Error("vault_reparse_path");
    if (stat.uid !== uid) throw new Error("vault_owner_mismatch");
  }
  const lockRoot = join(
    homedir(),
    "Library",
    "Application Support",
    "DevFlow",
    "auth-locks",
  );
  function lockDirectory(): void {
    for (const path of [
      join(homedir(), "Library"),
      join(homedir(), "Library", "Application Support"),
      join(homedir(), "Library", "Application Support", "DevFlow"),
      lockRoot,
    ]) {
      try {
        lstatSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        mkdirSync(path, { mode: 0o700 });
      }
      assertSafePath(path);
      if (!lstatSync(path).isDirectory())
        throw new Error("vault_directory_invalid");
    }
    chmodSync(lockRoot, 0o700);
  }
  const masterTarget = "DevFlow.vault:uid-" + uid;
  function masterKey(): Buffer {
    let key = readSecret(masterTarget);
    if (!key) {
      key = randomBytes(32);
      try {
        writeSecret(masterTarget, key, true);
      } catch (error) {
        key.fill(0);
        const existing = readSecret(masterTarget);
        if (!existing) throw error;
        key = existing;
      }
    }
    if (key.length !== 32) {
      key.fill(0);
      throw new Error("vault_key_invalid");
    }
    return key;
  }
  return {
    getCurrentUserSid: () => "uid:" + uid,
    assertSafePath,
    restrictPath(path) {
      assertSafePath(path);
      chmodSync(path, lstatSync(path).isDirectory() ? 0o700 : 0o600);
    },
    acquireMutex(name) {
      lockDirectory();
      const path = join(
        lockRoot,
        createHash("sha256").update(name).digest("hex") + ".lock",
      );
      try {
        assertSafePath(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const handle = tryAcquireFlock(path);
      return handle ? () => releaseFlock(handle) : null;
    },
    protectData(plain) {
      const key = masterKey(),
        nonce = randomBytes(12);
      try {
        const cipher = createCipheriv("aes-256-gcm", key, nonce);
        cipher.setAAD(Buffer.from("DevFlow vault v1"));
        return Buffer.concat([
          Buffer.from("DFKC1"),
          nonce,
          cipher.update(plain),
          cipher.final(),
          cipher.getAuthTag(),
        ]);
      } finally {
        key.fill(0);
      }
    },
    unprotectData(encrypted) {
      if (
        encrypted.length < 33 ||
        encrypted.subarray(0, 5).toString() !== "DFKC1"
      )
        throw new Error("vault_ciphertext_invalid");
      const key = masterKey();
      let partial: Buffer | undefined;
      try {
        const cipher = createDecipheriv(
          "aes-256-gcm",
          key,
          encrypted.subarray(5, 17),
        );
        cipher.setAAD(Buffer.from("DevFlow vault v1"));
        cipher.setAuthTag(encrypted.subarray(-16));
        partial = cipher.update(encrypted.subarray(17, -16));
        return Buffer.concat([partial, cipher.final()]);
      } catch {
        throw new Error("vault_decryption_failed");
      } finally {
        partial?.fill(0);
        key.fill(0);
      }
    },
    readCredential(target): VaultCredential {
      const secret = readSecret(target);
      try {
        return {
          Exists: !!secret?.length,
          Flags: 0,
          Username: targetParts(target)[1]!,
          Comment: "",
          Persist: 0,
          TargetAlias: "",
          Attributes: null,
          Secret: secret?.length ? secret.toString("base64") : null,
        };
      } finally {
        secret?.fill(0);
      }
    },
    writeCredential(target, credential) {
      if (!credential.Exists) {
        this.deleteCredential(target);
        return;
      }
      const secret = Buffer.from(credential.Secret ?? "", "base64");
      try {
        writeSecret(target, secret);
      } finally {
        secret.fill(0);
      }
    },
    deleteCredential(target) {
      if (target === "gemini:antigravity") {
        // An empty value carries no login credential. Keep the Keychain item
        // so AGY's subsequent add-generic-password -U preserves its ACL and
        // the user's permanent grants across login, cancellation and restore.
        const previous = readSecret(target);
        try {
          if (!previous) return false;
          writeSecret(target, Buffer.alloc(0));
          return previous.length > 0;
        } finally { previous?.fill(0); }
      }
      return withQuery(target, (query) => {
        const status = remove(query);
        if (status === missing) return false;
        check(status);
        return true;
      });
    },
  };
}
