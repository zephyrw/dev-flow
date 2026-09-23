import koffi from "koffi";
import type { VaultCredential } from "./credential-store.js";

const BLOB = koffi.struct({ size: "uint32", data: "void *" });
const ATTRIBUTE = koffi.struct({
  keyword: "void *",
  flags: "uint32",
  size: "uint32",
  value: "void *",
});
const CREDENTIAL = koffi.struct({
  flags: "uint32",
  type: "uint32",
  target: "void *",
  comment: "void *",
  lastWritten: "uint64",
  size: "uint32",
  secret: "void *",
  persist: "uint32",
  count: "uint32",
  attributes: "void *",
  alias: "void *",
  username: "void *",
});
const SECURITY_ATTRIBUTES = koffi.struct({
  length: "uint32",
  descriptor: "void *",
  inherit: "int",
});
export function emptyCredential(): VaultCredential {
  return {
    Exists: false,
    Flags: 0,
    Username: "",
    Comment: "",
    Persist: 0,
    TargetAlias: "",
    Attributes: null,
    Secret: null,
  };
}
export function createCredentialWindows() {
  const kernel = koffi.load("kernel32.dll"),
    advapi = koffi.load("advapi32.dll"),
    crypt = koffi.load("crypt32.dll");
  const lastError = kernel.func("uint32 __stdcall GetLastError()");
  const closeHandle = kernel.func("int __stdcall CloseHandle(void *handle)");
  const localFree = kernel.func("void * __stdcall LocalFree(void *value)");
  const protect = crypt.func("__stdcall", "CryptProtectData", "int", [
    "void *",
    "str16",
    "void *",
    "void *",
    "void *",
    "uint32",
    "void *",
  ]);
  const unprotect = crypt.func("__stdcall", "CryptUnprotectData", "int", [
    "void *",
    "void *",
    "void *",
    "void *",
    "void *",
    "uint32",
    "void *",
  ]);
  const read = advapi.func("__stdcall", "CredReadW", "int", [
    "str16",
    "uint32",
    "uint32",
    "void *",
  ]);
  const write = advapi.func("__stdcall", "CredWriteW", "int", [
    "void *",
    "uint32",
  ]);
  const remove = advapi.func("__stdcall", "CredDeleteW", "int", [
    "str16",
    "uint32",
    "uint32",
  ]);
  const freeCredential = advapi.func("void __stdcall CredFree(void *value)");
  const getProcess = kernel.func("void * __stdcall GetCurrentProcess()");
  const openToken = advapi.func("__stdcall", "OpenProcessToken", "int", [
    "void *",
    "uint32",
    "void *",
  ]);
  const tokenInfo = advapi.func("__stdcall", "GetTokenInformation", "int", [
    "void *",
    "uint32",
    "void *",
    "uint32",
    "void *",
  ]);
  const sidToString = advapi.func(
    "__stdcall",
    "ConvertSidToStringSidW",
    "int",
    ["void *", "void *"],
  );
  const toDescriptor = advapi.func(
    "__stdcall",
    "ConvertStringSecurityDescriptorToSecurityDescriptorW",
    "int",
    ["str16", "uint32", "void *", "void *"],
  );
  const setSecurity = advapi.func("__stdcall", "SetFileSecurityW", "int", [
    "str16",
    "uint32",
    "void *",
  ]);
  const fileAttributes = kernel.func(
    "__stdcall",
    "GetFileAttributesW",
    "uint32",
    ["str16"],
  );
  const createMutex = kernel.func("__stdcall", "CreateMutexW", "void *", [
    "void *",
    "int",
    "str16",
  ]);
  const wait = kernel.func("__stdcall", "WaitForSingleObject", "uint32", [
    "void *",
    "uint32",
  ]);
  const releaseMutex = kernel.func("int __stdcall ReleaseMutex(void *handle)");
  const fail = (operation: string, code = Number(lastError())): never => {
    throw new Error(`${operation}:${code}`);
  };
  const pointerSlot = () => Buffer.alloc(koffi.sizeof("void *"));
  const ptr = (slot: Buffer): bigint | null => koffi.decode(slot, "void *");
  const wide = (value: string) => {
    if (value.includes("\0")) throw new Error("invalid_credential_string");
    return Buffer.from(value + "\0", "utf16le");
  };
  const stringAt = (pointer: bigint | null): string => {
    if (!pointer) return "";
    const values: number[] = [];
    for (let offset = 0; offset < 131072; offset += 2) {
      const value = koffi.decode(pointer, offset, "uint16") as number;
      if (value === 0)
        return Buffer.from(new Uint16Array(values).buffer).toString("utf16le");
      values.push(value);
    }
    throw new Error("credential_string_unterminated");
  };
  const bytesAt = (pointer: bigint | null, length: number): Buffer => {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > 16 * 1024 * 1024 ||
      (length > 0 && !pointer)
    )
      throw new Error("credential_buffer_invalid");
    return length
      ? Buffer.from(koffi.decode(pointer, "uint8", length))
      : Buffer.alloc(0);
  };
  function cryptData(data: Buffer, encrypt: boolean): Buffer {
    const input = Buffer.alloc(koffi.sizeof(BLOB)),
      output = Buffer.alloc(koffi.sizeof(BLOB));
    koffi.encode(input, BLOB, {
      size: data.length,
      data: data.length ? koffi.address(data) : null,
    });
    let outputPointer: bigint | null = null;
    try {
      if (
        !(encrypt ? protect : unprotect)(
          input,
          null,
          null,
          null,
          null,
          1,
          output,
        )
      )
        fail("dpapi_failed");
      const blob = koffi.decode(output, BLOB);
      outputPointer = blob.data;
      return bytesAt(outputPointer, blob.size);
    } finally {
      if (outputPointer) {
        try {
          if (!encrypt)
            new Uint8Array(
              koffi.view(outputPointer, koffi.decode(output, BLOB).size),
            ).fill(0);
        } finally {
          localFree(outputPointer);
        }
      }
    }
  }
  function getCurrentUserSid(): string {
    const slot = pointerSlot();
    if (!openToken(getProcess(), 8, slot)) fail("token_open_failed");
    const token = ptr(slot);
    if (!token) throw new Error("token_invalid");
    let sidString: bigint | null = null;
    try {
      const size = Buffer.alloc(4);
      tokenInfo(token, 1, null, 0, size);
      const length = size.readUInt32LE();
      if (!length || length > 65536) fail("token_size_failed");
      const user = Buffer.alloc(length);
      if (!tokenInfo(token, 1, user, length, size)) fail("token_query_failed");
      const result = pointerSlot();
      if (!sidToString(ptr(user), result)) fail("sid_conversion_failed");
      sidString = ptr(result);
      const sid = stringAt(sidString);
      if (!/^S-1-(?:\d+-)*\d+$/.test(sid)) throw new Error("sid_invalid");
      return sid;
    } finally {
      if (sidString) localFree(sidString);
      closeHandle(token);
    }
  }
  function descriptor(): bigint {
    const slot = pointerSlot();
    if (
      !toDescriptor(
        `D:P(A;OICI;GA;;;SY)(A;OICI;GA;;;${getCurrentUserSid()})`,
        1,
        slot,
        null,
      )
    )
      fail("acl_descriptor_failed");
    const value = ptr(slot);
    if (!value) throw new Error("acl_descriptor_invalid");
    return value;
  }
  function assertSafePath(path: string): void {
    const attributes = Number(fileAttributes(path));
    if (attributes === 0xffffffff) fail("vault_path_query_failed");
    if (attributes & 0x400) throw new Error("vault_reparse_path");
  }
  function deleteCredential(target: string): boolean {
    if (remove(target, 1, 0)) return true;
    const code = Number(lastError());
    if (code === 1168) return false;
    return fail("credential_delete_failed", code);
  }
  return {
    protectData: (data: Buffer) => cryptData(data, true),
    unprotectData: (data: Buffer) => cryptData(data, false),
    getCurrentUserSid,
    assertSafePath,
    restrictPath(path: string) {
      assertSafePath(path);
      const sd = descriptor();
      try {
        if (!setSecurity(path, 0x80000004, sd)) fail("vault_acl_failed");
      } finally {
        localFree(sd);
      }
    },
    acquireMutex(name: string): (() => void) | null {
      const sd = descriptor();
      const attributes = Buffer.alloc(koffi.sizeof(SECURITY_ATTRIBUTES));
      koffi.encode(attributes, SECURITY_ATTRIBUTES, {
        length: attributes.length,
        descriptor: sd,
        inherit: 0,
      });
      let handle: bigint | null;
      try {
        handle = createMutex(attributes, 0, name);
      } finally {
        localFree(sd);
      }
      if (!handle) fail("domain_mutex_create_failed");
      const result = Number(wait(handle, 0));
      if (result !== 0 && result !== 0x80) {
        const code = Number(lastError());
        closeHandle(handle);
        if (result === 258) return null;
        return fail("domain_mutex_wait_failed", code);
      }
      let released = false;
      return () => {
        if (released) return;
        if (!releaseMutex(handle)) fail("domain_mutex_release_failed");
        released = true;
        closeHandle(handle);
      };
    },
    readCredential(target: string): VaultCredential {
      const slot = pointerSlot();
      if (!read(target, 1, 0, slot)) {
        const code = Number(lastError());
        if (code === 1168) return emptyCredential();
        return fail("credential_read_failed", code);
      }
      const pointer = ptr(slot);
      if (!pointer) throw new Error("credential_pointer_invalid");
      try {
        const credential = koffi.decode(pointer, CREDENTIAL);
        if (credential.count > 64)
          throw new Error("credential_attributes_invalid");
        const attributes: NonNullable<VaultCredential["Attributes"]> = [];
        for (let i = 0; i < credential.count; i++) {
          const attr = koffi.decode(
            credential.attributes,
            i * koffi.sizeof(ATTRIBUTE),
            ATTRIBUTE,
          );
          const bytes = bytesAt(attr.value, attr.size);
          attributes.push({
            Keyword: stringAt(attr.keyword),
            Flags: attr.flags,
            Value: bytes.length ? bytes.toString("base64") : null,
          });
          bytes.fill(0);
        }
        const bytes = bytesAt(credential.secret, credential.size);
        try {
          return {
            Exists: true,
            Flags: credential.flags,
            Username: stringAt(credential.username),
            Comment: stringAt(credential.comment),
            Persist: credential.persist,
            TargetAlias: stringAt(credential.alias),
            Attributes: attributes.length ? attributes : null,
            Secret: bytes.length ? bytes.toString("base64") : null,
          };
        } finally {
          bytes.fill(0);
        }
      } finally {
        freeCredential(pointer);
      }
    },
    writeCredential(target: string, credential: VaultCredential): void {
      if (!credential.Exists) {
        deleteCredential(target);
        return;
      }
      const buffers: Buffer[] = [];
      const address = (buffer: Buffer) => {
        buffers.push(buffer);
        return buffer.length ? koffi.address(buffer) : null;
      };
      try {
        const secret = Buffer.from(credential.Secret ?? "", "base64");
        const attributes = credential.Attributes ?? [];
        const attrBuffer = Buffer.alloc(
          attributes.length * koffi.sizeof(ATTRIBUTE),
        );
        for (let i = 0; i < attributes.length; i++) {
          const attr = attributes[i]!;
          const value = Buffer.from(attr.Value ?? "", "base64");
          koffi.encode(attrBuffer, i * koffi.sizeof(ATTRIBUTE), ATTRIBUTE, {
            keyword: address(wide(attr.Keyword)),
            flags: attr.Flags,
            size: value.length,
            value: address(value),
          });
        }
        const input = Buffer.alloc(koffi.sizeof(CREDENTIAL));
        koffi.encode(input, CREDENTIAL, {
          flags: credential.Flags,
          type: 1,
          target: address(wide(target)),
          comment: address(wide(credential.Comment)),
          lastWritten: 0n,
          size: secret.length,
          secret: address(secret),
          persist: credential.Persist,
          count: attributes.length,
          attributes: address(attrBuffer),
          alias: address(wide(credential.TargetAlias)),
          username: address(wide(credential.Username)),
        });
        if (!write(input, 0)) fail("credential_write_failed");
      } finally {
        for (const buffer of buffers) buffer.fill(0);
      }
    },
    deleteCredential,
  };
}
