/**
 * Windows Credential Manager and DPAPI operations via koffi@3.3.1.
 *
 * Uses koffi to call Win32 APIs for credential storage and data protection.
 * All koffi.load() calls are lazy (inside createCredentialWindows) so the
 * module is only loaded when actually required on win32.
 *
 * R06 修复：
 * - GetCurrentProcessToken 是宏（返回伪句柄 -4），改用 GetCurrentProcess + OpenProcessToken
 * - CREDENTIALW 结构体正确处理指针字段
 * - Mutex 函数从 kernel32.dll 正确加载
 */

import koffi from 'koffi';

// ── Win32 type aliases ─────────────────────────────────────────────────────

type HANDLE = bigint;
type DWORD = number;
type BOOL = number;
type LPWSTR = string;

// ── Constants ──────────────────────────────────────────────────────────────

const CRED_TYPE_GENERIC = 1;
const CRED_PERSIST_LOCAL_MACHINE = 2;
const CRED_MAX_CREDENTIAL_BLOB_SIZE = 512;

const ERROR_SUCCESS = 0;
const ERROR_NOT_FOUND = 1168;
const ERROR_NO_SUCH_LOGON_SESSION = 1312;
const ERROR_INVALID_FLAGS = 1004;

const TOKEN_QUERY = 0x0008;

// ── Structures ─────────────────────────────────────────────────────────────

/** DATA_BLOB for CryptProtectData / CryptUnprotectData */
const DATA_BLOB = koffi.struct({
  cbData: 'uint32',
  pbData: 'void *',
});

/** CREDENTIALW for Credential Manager */
const CREDENTIALW = koffi.struct({
  Flags: 'uint32',
  Type: 'uint32',
  TargetName: 'void *',
  Comment: 'void *',
  LastWritten: 'uint64', // FILETIME as int64
  CredentialBlobSize: 'uint32',
  CredentialBlob: 'void *',
  Persist: 'uint32',
  AttributeCount: 'uint32',
  Attributes: 'void *',
  TargetAlias: 'void *',
  UserName: 'void *',
});

// ── Module factory ─────────────────────────────────────────────────────────

export function createCredentialWindows() {
  // Load DLLs (lazy)
  const crypt32 = koffi.load('crypt32.dll');
  const advapi32 = koffi.load('advapi32.dll');
  const kernel32 = koffi.load('kernel32.dll');

  // ── Win32 function declarations ──────────────────────────────────────────

  const GetLastError: () => DWORD =
    kernel32.func('__stdcall', 'GetLastError', 'uint32', []);

  const LocalFree: (hMem: HANDLE) => HANDLE =
    kernel32.func('__stdcall', 'LocalFree', 'void *', ['void *']);

  const CloseHandle: (hObject: HANDLE) => BOOL =
    kernel32.func('__stdcall', 'CloseHandle', 'int', ['void *']);

  // ── crypt32.dll: DPAPI ──────────────────────────────────────────────────

  const CryptProtectData: (
    pDataIn: any, szDataDescr: string | null, pOptionalEntropy: any,
    pvReserved: any, pPromptStruct: any, dwFlags: number, pDataOut: any
  ) => BOOL =
    crypt32.func('__stdcall', 'CryptProtectData', 'int',
      ['void *', 'str16', 'void *', 'void *', 'void *', 'uint32', 'void *']);

  const CryptUnprotectData: (
    pDataIn: any, ppszDataDescr: any, pOptionalEntropy: any,
    pvReserved: any, pPromptStruct: any, dwFlags: number, pDataOut: any
  ) => BOOL =
    crypt32.func('__stdcall', 'CryptUnprotectData', 'int',
      ['void *', 'void *', 'void *', 'void *', 'void *', 'uint32', 'void *']);

  // ── advapi32.dll: Credential Manager ────────────────────────────────────

  const CredReadW: (
    TargetName: string, Type: DWORD, Flags: DWORD, Credential: any
  ) => BOOL =
    advapi32.func('__stdcall', 'CredReadW', 'int',
      ['str16', 'uint32', 'uint32', 'void *']);

  const CredWriteW: (Credential: any, Flags: DWORD) => BOOL =
    advapi32.func('__stdcall', 'CredWriteW', 'int', ['void *', 'uint32']);

  const CredDeleteW: (TargetName: string, Type: DWORD, Flags: DWORD) => BOOL =
    advapi32.func('__stdcall', 'CredDeleteW', 'int',
      ['str16', 'uint32', 'uint32']);

  const CredFree: (Buffer: HANDLE) => void =
    advapi32.func('__stdcall', 'CredFree', 'void', ['void *']);

  // ── advapi32.dll: User SID ──────────────────────────────────────────────

  // R06 修复：GetCurrentProcessToken 是宏（返回伪句柄 -4），
  // 改用 GetCurrentProcess() + OpenProcessToken() 获取实际 token
  const GetCurrentProcess: () => HANDLE =
    kernel32.func('__stdcall', 'GetCurrentProcess', 'void *', []);

  const OpenProcessToken: (
    ProcessHandle: HANDLE, DesiredAccess: DWORD, TokenHandle: any
  ) => BOOL =
    advapi32.func('__stdcall', 'OpenProcessToken', 'int',
      ['void *', 'uint32', 'void *']);

  const GetTokenInformation: (
    TokenHandle: HANDLE, TokenInformationClass: DWORD,
    TokenInformation: any, TokenInformationLength: DWORD, ReturnLength: any
  ) => BOOL =
    advapi32.func('__stdcall', 'GetTokenInformation', 'int',
      ['void *', 'uint32', 'void *', 'uint32', 'void *']);

  const ConvertSidToStringSidW: (Sid: any, StringSid: any) => BOOL =
    advapi32.func('__stdcall', 'ConvertSidToStringSidW', 'int',
      ['void *', 'void *']);

  // ── Helpers ──────────────────────────────────────────────────────────────

  const TokenUser = 1; // TOKEN_INFORMATION_CLASS

  /** Throw with Win32 error message */
  function throwWin32Error(operation: string): never {
    const code = GetLastError();
    throw new Error(`${operation} failed with Win32 error ${code}`);
  }

  /** Encode a Node Buffer into a DATA_BLOB pointer */
  function bufferToDataBlob(data: Buffer): any {
    const blob = koffi.alloc(DATA_BLOB, 1);
    const pbData = koffi.alloc('uint8', data.length);
    // Copy data into native memory
    const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    koffi.encode(pbData, 'uint8', view, data.length);
    koffi.encode(blob, DATA_BLOB, { cbData: data.length, pbData });
    return blob;
  }

  /** Decode a DATA_BLOB pointer into a Node Buffer, then free native memory */
  function dataBlobToBuffer(blobPtr: any, freeBlob: boolean = true): Buffer {
    const blob = koffi.decode(blobPtr, DATA_BLOB);
    const len = blob.cbData;
    if (len === 0 || blob.pbData === null) {
      if (freeBlob) koffi.free(blobPtr);
      return Buffer.alloc(0);
    }
    // Read raw bytes from native memory
    const raw = koffi.decode(blob.pbData, 'uint8', len);
    const buf = Buffer.from(raw);
    // Free the native data buffer
    LocalFree(blob.pbData as unknown as HANDLE);
    if (freeBlob) koffi.free(blobPtr);
    return buf;
  }

  /** Best-effort zero fill a Buffer */
  function secureZero(buf: Buffer): void {
    buf.fill(0);
  }

  /**
   * R06 修复：正确读取 CREDENTIALW 结构体。
   * 关键：先解码指针为 CREDENTIALW 结构体，再从结构体中读取字符串指针。
   */
  function decodeCredentialString(ptr: unknown): string {
    if (ptr === null || ptr === 0) return '';
    const chars: number[] = [];
    let byteOffset = 0;
    while (true) {
      const decoded = (koffi.decode as (ptr: unknown, type: string, count: number, offset?: number) => number[])(ptr, 'uint16', 1, byteOffset);
      const ch = decoded[0] ?? 0;
      if (ch === 0) break;
      chars.push(ch);
      byteOffset += 2;
      if (chars.length > 1024) break;
    }
    return String.fromCharCode(...chars);
  }

  // ── Implementation ──────────────────────────────────────────────────────

  return {
    /**
     * Encrypt data using Windows DPAPI (CryptProtectData).
     * Current user scope, no entropy, no UI.
     */
    protectData(data: Buffer): Buffer {
      const blobIn = bufferToDataBlob(data);
      const blobOut = koffi.alloc(DATA_BLOB, 1);

      const ok = CryptProtectData(
        blobIn, null, null, null, null, 0, blobOut
      );

      koffi.free(blobIn);

      if (!ok) {
        throwWin32Error('CryptProtectData');
      }

      return dataBlobToBuffer(blobOut);
    },

    /**
     * Decrypt data using Windows DPAPI (CryptUnprotectData).
     * Current user scope, no entropy.
     */
    unprotectData(encrypted: Buffer): Buffer {
      const blobIn = bufferToDataBlob(encrypted);
      const blobOut = koffi.alloc(DATA_BLOB, 1);

      const ok = CryptUnprotectData(
        blobIn, null, null, null, null, 0, blobOut
      );

      koffi.free(blobIn);

      if (!ok) {
        throwWin32Error('CryptUnprotectData');
      }

      return dataBlobToBuffer(blobOut);
    },

    /**
     * Read a generic credential from Windows Credential Manager.
     * Returns null if the credential does not exist.
     */
    readCredential(target: string): { username: string; secret: Buffer } | null {
      const ppCredential = koffi.alloc('void *', 1);

      const ok = CredReadW(target, CRED_TYPE_GENERIC, 0, ppCredential);
      if (!ok) {
        const err = GetLastError();
        koffi.free(ppCredential);
        if (err === ERROR_NOT_FOUND) return null;
        throw new Error(`CredReadW failed with Win32 error ${err}`);
      }

      // R06 修复：正确解码 CREDENTIALW 结构体指针
      const credPtr = koffi.decode(ppCredential, 'void *', 1)[0];
      koffi.free(ppCredential);

      if (credPtr === null || credPtr === 0) {
        return null;
      }

      // 先解码为 CREDENTIALW 结构体
      const cred = koffi.decode(credPtr, CREDENTIALW);

      // 从结构体中读取字符串指针
      const username = decodeCredentialString(cred.UserName);

      // Decode CredentialBlob
      let secret: Buffer;
      const blobSize = cred.CredentialBlobSize;
      if (blobSize > 0 && cred.CredentialBlob !== null && cred.CredentialBlob !== 0) {
        const raw = koffi.decode(cred.CredentialBlob, 'uint8', blobSize);
        secret = Buffer.from(raw);
      } else {
        secret = Buffer.alloc(0);
      }

      // Free the credential structure
      CredFree(credPtr as unknown as HANDLE);

      return { username, secret };
    },

    /**
     * Write a generic credential to Windows Credential Manager.
     * Persists as CRED_PERSIST_LOCAL_MACHINE.
     */
    writeCredential(target: string, username: string, secret: Buffer): void {
      // Allocate blob for secret
      const pbSecret = koffi.alloc('uint8', secret.length);
      if (secret.length > 0) {
        const view = new Uint8Array(secret.buffer, secret.byteOffset, secret.byteLength);
        koffi.encode(pbSecret, 'uint8', view, secret.length);
      }

      // Allocate UTF-16LE buffers for strings
      const targetBuf = Buffer.from(target + '\0', 'utf16le');
      const usernameBuf = Buffer.from(username + '\0', 'utf16le');
      const commentBuf = Buffer.from('\0', 'utf16le');

      const pTargetName = koffi.alloc('uint8', targetBuf.length);
      koffi.encode(pTargetName, 'uint8', new Uint8Array(targetBuf), targetBuf.length);

      const pUserName = koffi.alloc('uint8', usernameBuf.length);
      koffi.encode(pUserName, 'uint8', new Uint8Array(usernameBuf), usernameBuf.length);

      const pComment = koffi.alloc('uint8', commentBuf.length);
      koffi.encode(pComment, 'uint8', new Uint8Array(commentBuf), commentBuf.length);

      // Build CREDENTIALW
      const credPtr = koffi.alloc(CREDENTIALW, 1);
      koffi.encode(credPtr, CREDENTIALW, {
        Flags: 0,
        Type: CRED_TYPE_GENERIC,
        TargetName: pTargetName,
        Comment: pComment,
        LastWritten: 0n,
        CredentialBlobSize: secret.length,
        CredentialBlob: pbSecret,
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        AttributeCount: 0,
        Attributes: 0,
        TargetAlias: 0,
        UserName: pUserName,
      });

      const ok = CredWriteW(credPtr, 0);

      // Cleanup
      koffi.free(credPtr);
      koffi.free(pTargetName);
      koffi.free(pUserName);
      koffi.free(pComment);
      koffi.free(pbSecret);

      if (!ok) {
        throwWin32Error('CredWriteW');
      }
    },

    /**
     * Delete a generic credential from Windows Credential Manager.
     * Returns true if deleted, false if not found.
     */
    deleteCredential(target: string): boolean {
      const ok = CredDeleteW(target, CRED_TYPE_GENERIC, 0);
      if (!ok) {
        const err = GetLastError();
        if (err === ERROR_NOT_FOUND) return false;
        throw new Error(`CredDeleteW failed with Win32 error ${err}`);
      }
      return true;
    },

    /**
     * Get the current Windows user SID as a string (e.g., "S-1-5-21-...").
     * R06 修复：使用 GetCurrentProcess + OpenProcessToken 替代宏 GetCurrentProcessToken
     */
    getCurrentUserSid(): string {
      // R06 修复：GetCurrentProcessToken 是宏，改用 GetCurrentProcess + OpenProcessToken
      const hProcess = GetCurrentProcess();
      const pToken = koffi.alloc('void *', 1);
      const ok = OpenProcessToken(hProcess, TOKEN_QUERY, pToken);
      if (!ok) {
        throwWin32Error('OpenProcessToken');
      }
      const token = koffi.decode(pToken, 'void *', 1)[0];
      koffi.free(pToken);

      if (token === null || token === 0) {
        throw new Error('OpenProcessToken returned null token');
      }

      // First call to get required buffer size
      const returnLengthBuf = koffi.alloc('uint32', 1);
      koffi.encode(returnLengthBuf, 'uint32', [0]);

      // Probe size
      GetTokenInformation(token, TokenUser, 0, 0, returnLengthBuf);
      const requiredSize = koffi.decode(returnLengthBuf, 'uint32', 1)[0];

      if (requiredSize === 0) {
        koffi.free(returnLengthBuf);
        throwWin32Error('GetTokenInformation (size query)');
      }

      // Allocate and get TOKEN_USER
      const tokenUserBuf = koffi.alloc('uint8', requiredSize);
      const ok2 = GetTokenInformation(
        token, TokenUser, tokenUserBuf, requiredSize, returnLengthBuf
      );

      if (!ok2) {
        koffi.free(returnLengthBuf);
        koffi.free(tokenUserBuf);
        throwWin32Error('GetTokenInformation');
      }

      // TOKEN_USER contains a SID_AND_ATTRIBUTES with a pointer to SID
      // The SID pointer is at offset 0 of TOKEN_USER
      const sidPtr = koffi.decode(tokenUserBuf, 'void *', 1)[0];

      if (sidPtr === null || sidPtr === 0) {
        koffi.free(returnLengthBuf);
        koffi.free(tokenUserBuf);
        throw new Error('GetTokenInformation returned null SID');
      }

      // Convert SID to string
      const stringSidBuf = koffi.alloc('void *', 1);
      const convertOk = ConvertSidToStringSidW(sidPtr, stringSidBuf);

      if (!convertOk) {
        koffi.free(returnLengthBuf);
        koffi.free(tokenUserBuf);
        koffi.free(stringSidBuf);
        throwWin32Error('ConvertSidToStringSidW');
      }

      // Read the resulting string pointer
      const stringPtr = koffi.decode(stringSidBuf, 'void *', 1)[0];
      let sidString = '';

      if (stringPtr !== null && stringPtr !== 0) {
        // Read null-terminated UTF-16LE string
        sidString = decodeCredentialString(stringPtr);
      }

      // Free the string allocated by ConvertSidToStringSidW (uses LocalAlloc)
      if (stringPtr !== null && stringPtr !== 0) {
        LocalFree(stringPtr as unknown as HANDLE);
      }

      koffi.free(returnLengthBuf);
      koffi.free(tokenUserBuf);
      koffi.free(stringSidBuf);

      return sidString;
    },
  };
}
