import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const fixture = vi.hoisted(() => ({
  home: "",
  keychain: new Map<string, Buffer>(),
  outputs: new WeakMap<object, unknown>(),
  denied: false,
  accessTargets: [] as string[],
  grants: new Map<string, { apps: string[]; partitions: string[] }>(),
}));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  homedir: () => fixture.home,
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawnSync: (path: string, args: string[], options: any) => {
    if (path !== "/usr/bin/security") return actual.spawnSync(path, args, options);
    // Credentials must not enter argv or a shell. Simulate Apple's partition
    // reset on EVERY value update, which a native-only mock would miss.
    expect(args).not.toContain("token");
    expect(options.shell).toBeUndefined();
    if (fixture.denied) return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("denied") };
    const target = "gemini:antigravity";
    if (args[0] === "find-generic-password") {
      const value = fixture.keychain.get(target);
      if (!value) return { status: 44, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      expect(fixture.grants.get(target)?.partitions).toContain("apple-tool:");
      return { status: 0, stdout: Buffer.concat([value, Buffer.from("\n")]), stderr: Buffer.alloc(0) };
    }
    expect(args).toEqual(["-i"]);
    const command = options.input.toString();
    const value = JSON.parse(command.match(/-w (.*)\n$/)![1]!);
    fixture.keychain.set(target, Buffer.from(value));
    fixture.grants.set(target, { apps: fixture.grants.get(target)?.apps ?? ["/usr/bin/security"], partitions: ["apple-tool:"] });
    return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  } };
});
vi.mock("koffi", async (original) => {
  const actual = (await original<typeof import("koffi")>()).default;
  const target = (query: Map<string, unknown>) =>
    String(query.get("kSecAttrService")) +
    ":" +
    String(query.get("kSecAttrAccount"));
  const functions: Record<string, (...args: any[]) => any> = {
    CFRelease: () => {},
    CFStringCreateWithCString: (_a, value) => value,
    CFDictionaryCreateMutable: () => new Map(),
    CFDictionarySetValue: (map, key, value) => map.set(key, value),
    CFDataCreate: (_a, data) => Buffer.from(data),
    CFDataGetLength: (data) => data.length,
    CFDataGetBytePtr: (data) => data,
    SecItemCopyMatching: (query, output) => {
      expect(target(query)).not.toBe("gemini:antigravity");
      if (fixture.denied) return -25293;
      const value = fixture.keychain.get(target(query));
      if (!value) return -25300;
      fixture.outputs.set(output, query.has("kSecReturnRef") ? target(query) : Buffer.from(value));
      return 0;
    },
    SecItemAdd: (query) => {
      expect(target(query)).not.toBe("gemini:antigravity");
      expect(query.has("kSecAttrAccess")).toBe(false);
      if (fixture.keychain.has(target(query))) return -25299;
      fixture.keychain.set(
        target(query),
        Buffer.from(query.get("kSecValueData")),
      );
      return 0;
    },
    SecItemUpdate: (query, data) => {
      expect(target(query)).not.toBe("gemini:antigravity");
      expect(data.has("kSecAttrAccess")).toBe(false);
      if (!fixture.keychain.has(target(query))) return -25300;
      fixture.keychain.set(
        target(query),
        Buffer.from(data.get("kSecValueData")),
      );
      return 0;
    },
    SecItemDelete: (query) =>
      fixture.keychain.delete(target(query)) ? 0 : -25300,
  };
  return {
    default: {
      ...actual,
      load: (path: string) =>
        /\/(?:Security|CoreFoundation)$/.test(path)
          ? {
              symbol: (name: string) => ({ name }),
              func: (declaration: string) =>
                functions[declaration.match(/(\w+)\(/)![1]!],
            }
          : actual.load(path),
      decode: (value: any, ...args: any[]) =>
        value?.name
          ? value.name
          : fixture.outputs.has(value)
            ? fixture.outputs.get(value)
            : args[0] === "uint8"
              ? Buffer.from(value)
              : actual.decode(value, ...(args as [any])),
    },
  };
});
import { createCredentialDarwin } from "../../packages/agy-accounts/src/credential-darwin.js";
import {
  CredentialVault,
  equalCredential,
} from "../../packages/agy-accounts/src/credential-store.js";
import { extractSafeAuthMetadata } from "../../packages/agy-accounts/src/auth-metadata.js";

describe.skipIf(process.platform !== "darwin")(
  "macOS credential operations with a synthetic Keychain",
  () => {
    beforeEach(() => {
      fixture.home = mkdtempSync(join(realpathSync(tmpdir()), "darwin-vault-"));
      mkdirSync(join(fixture.home, "Library/Application Support"), {
        recursive: true,
      });
      fixture.keychain.clear();
      fixture.denied = false;
      fixture.accessTargets.length = 0;
      fixture.grants.clear();
    });
    afterEach(() => rmSync(fixture.home, { recursive: true, force: true }));
    it("round trips the exact native credential, clears and restores it, and reports only metadata", () => {
      const native = createCredentialDarwin();
      const raw = Buffer.from(
        "go-keyring-base64:" +
          Buffer.from(
            JSON.stringify({
              token: {
                access_token: "private-access",
                refresh_token: "private-refresh",
                expiry: "2030-01-01T00:00:00Z",
              },
              id_token:
                "header." +
                Buffer.from(
                  JSON.stringify({
                    sub: "account-a",
                    email: "fixture@example.invalid",
                  }),
                ).toString("base64url") +
                ".signature",
            }),
          ).toString("base64"),
      );
      fixture.keychain.set("gemini:antigravity", raw);
      fixture.grants.set("gemini:antigravity", { apps: ["user-permanent-grant", "/usr/bin/security"], partitions: ["apple-tool:"] });
      const original = native.readCredential("gemini:antigravity");
      const auth = extractSafeAuthMetadata(
        Buffer.from(original.Secret!, "base64"),
      );
      expect(auth.has_refresh_credential).toBe(true);
      expect(auth.subject).toBe("account-a");
      expect(JSON.stringify(auth)).not.toContain("private-access");
      expect(native.deleteCredential("gemini:antigravity")).toBe(true);
      expect(native.readCredential("gemini:antigravity").Exists).toBe(false);
      expect(fixture.keychain.get("gemini:antigravity")).toEqual(Buffer.alloc(0));
      native.writeCredential("gemini:antigravity", original);
      expect(
        equalCredential(native.readCredential("gemini:antigravity"), original),
      ).toBe(true);
      expect(fixture.keychain.get("gemini:antigravity")).toEqual(raw);
      expect(fixture.accessTargets).toEqual([]);
      // Restarting a worker must not reset the item's permanent grants either.
      createCredentialDarwin().writeCredential("gemini:antigravity", original);
      expect(fixture.accessTargets).toEqual([]);
      expect(fixture.grants.get("gemini:antigravity")).toEqual({ apps: ["user-permanent-grant", "/usr/bin/security"], partitions: ["apple-tool:"] });
    });
    it("creates the official item through the stable Apple helper and never resets its grants from Node", () => {
      const native = createCredentialDarwin();
      const original = { ...native.readCredential("gemini:antigravity"), Exists: true, Secret: Buffer.from("token").toString("base64") };
      native.writeCredential("gemini:antigravity", original);
      expect(fixture.accessTargets).toEqual([]);
      native.deleteCredential("gemini:antigravity");
      native.writeCredential("gemini:antigravity", original);
      expect(fixture.accessTargets).toEqual([]);
      expect(fixture.grants.get("gemini:antigravity")).toEqual({ apps: ["/usr/bin/security"], partitions: ["apple-tool:"] });
      expect(fixture.keychain.get("gemini:antigravity")).toEqual(Buffer.from("token"));
    });
    it("does not change the login or report success when the official helper denies access", () => {
      fixture.keychain.set("gemini:antigravity", Buffer.from("token"));
      fixture.grants.set("gemini:antigravity", { apps: ["user-permanent-grant", "/usr/bin/security"], partitions: ["apple-tool:"] });
      const native = createCredentialDarwin();
      const original = native.readCredential("gemini:antigravity");
      const replacement = { ...original, Secret: Buffer.from("replacement").toString("base64") };
      fixture.denied = true;
      expect(() => native.readCredential("gemini:antigravity")).toThrow("keychain_action_failed");
      expect(() => native.writeCredential("gemini:antigravity", replacement)).toThrow("keychain_action_failed");
      expect(fixture.keychain.get("gemini:antigravity")).toEqual(Buffer.from("token"));
      fixture.denied = false;
      native.writeCredential("gemini:antigravity", replacement);
      createCredentialDarwin().writeCredential("gemini:antigravity", replacement);
      expect(equalCredential(native.readCredential("gemini:antigravity"), replacement)).toBe(true);
      expect(fixture.grants.get("gemini:antigravity")).toEqual({ apps: ["user-permanent-grant", "/usr/bin/security"], partitions: ["apple-tool:"] });
    });
    it("encrypts persisted snapshots and rejects tampered ciphertext", () => {
      const native = createCredentialDarwin(),
        vault = new CredentialVault(native);
      const ref = "sec_" + "a".repeat(32);
      const credential = {
        Exists: true,
        Flags: 0,
        Username: "antigravity",
        Comment: "",
        Persist: 0,
        TargetAlias: "",
        Attributes: null,
        Secret: Buffer.from("private-account-token").toString("base64"),
      };
      const envelope = {
        Version: 2 as const,
        RealmID: "realm",
        AccountID: "a",
        Revision: vault.allocateRevision("realm"),
        Credential: credential,
      };
      vault.save("realm", ref, envelope);
      expect(fixture.accessTargets).toEqual([]);
      const path = join(
        fixture.home,
        "Library/Application Support/DevFlow/agy-accounts/realm",
        ref + ".bin",
      );
      const encrypted = readFileSync(path);
      expect(encrypted.includes(Buffer.from("private-account-token"))).toBe(
        false,
      );
      expect(encrypted.includes(Buffer.from(credential.Secret))).toBe(false);
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
      expect(vault.load("realm", ref)).toEqual(envelope);
      encrypted[20] = encrypted[20]! ^ 1;
      expect(() => native.unprotectData(encrypted)).toThrow(
        "vault_decryption_failed",
      );
      fixture.denied = true;
      expect(() => vault.load("realm", ref)).toThrow("keychain_action_failed");
    });
    it("rejects commands exceeding the official helper limit or containing control bytes before changing the login", () => {
      const native = createCredentialDarwin();
      const absent = native.readCredential("gemini:antigravity");
      for (const raw of ["x".repeat(4096), "token\ninvalid-command", "token\0suffix"]) {
        expect(() => native.writeCredential("gemini:antigravity", {
          ...absent, Exists: true, Secret: Buffer.from(raw).toString("base64"),
        })).toThrow("keychain_data_invalid");
        expect(fixture.keychain.has("gemini:antigravity")).toBe(false);
      }
    });
    it("serializes the same credential domain across owners and refuses symlink paths", () => {
      const one = createCredentialDarwin(),
        two = createCredentialDarwin();
      const first = one.acquireMutex("account-domain");
      expect(first).not.toBeNull();
      expect(two.acquireMutex("account-domain")).toBeNull();
      first!();
      const next = two.acquireMutex("account-domain");
      expect(next).not.toBeNull();
      next!();
      const link = join(fixture.home, "linked");
      symlinkSync(join(fixture.home, "Library"), link);
      expect(() => one.assertSafePath(link)).toThrow("vault_reparse_path");
      expect(existsSync(link)).toBe(true);
    });
  },
);
