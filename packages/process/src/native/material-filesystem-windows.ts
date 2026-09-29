import koffi from "koffi";
import { constants as bufferConstants } from "node:buffer";
import { parse, resolve } from "node:path";

// NT ABI: NtCreateFile / FILE_LINK_INFORMATION (Microsoft Learn).
// HANDLE-relative names, FILE_OPEN_REPARSE_POINT, and no FILE_SHARE_DELETE pin every directory.
export function openWindowsMaterialRoot(root: string) {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch)) throw new Error("MATERIAL_FS_UNSUPPORTED");
  const nt = koffi.load("ntdll.dll"), kernel = koffi.load("kernel32.dll");
  const unicode = koffi.struct({ Length: "uint16", MaximumLength: "uint16", Buffer: "void *" });
  const attributes = koffi.struct({ Length: "uint32", RootDirectory: "uintptr_t", ObjectName: koffi.pointer(unicode), Attributes: "uint32", SecurityDescriptor: "void *", SecurityQualityOfService: "void *" });
  const create = nt.func("NtCreateFile", "int32", ["void *", "uint32", koffi.pointer(attributes), "void *", "void *", "uint32", "uint32", "uint32", "uint32", "void *", "uint32"]);
  const set = nt.func("NtSetInformationFile", "int32", ["uintptr_t", "void *", "void *", "uint32", "uint32"]);
  const openRoot = kernel.func("CreateFileW", "uintptr_t", ["str16", "uint32", "uint32", "void *", "uint32", "uint32", "uintptr_t"]);
  const close = kernel.func("CloseHandle", "int", ["uintptr_t"]);
  const info = kernel.func("GetFileInformationByHandle", "int", ["uintptr_t", "void *"]);
  const read = kernel.func("ReadFile", "int", ["uintptr_t", "void *", "uint32", "void *", "void *"]);
  const write = kernel.func("WriteFile", "int", ["uintptr_t", "void *", "uint32", "void *", "void *"]);
  const flush = kernel.func("FlushFileBuffers", "int", ["uintptr_t"]);
  const lastError = kernel.func("GetLastError", "uint32", []);
  const held: bigint[] = [];
  const fail = (status?: number) => Object.assign(new Error("MATERIAL_FS_OPERATION_FAILED"), { native_status: status === undefined ? lastError() : status >>> 0 });
  function details(handle: bigint) {
    const data = Buffer.alloc(52);
    if (!info(handle, data)) throw fail();
    if (data.readUInt32LE(0) & 0x400) throw new Error("MATERIAL_FS_REPARSE_POINT");
    return { identity: `${data.readUInt32LE(28)}:${data.readUInt32LE(44)}:${data.readUInt32LE(48)}`, directory: Boolean(data.readUInt32LE(0) & 0x10), size: data.readUInt32LE(36) + data.readUInt32LE(32) * 0x100000000 };
  }
  function child(parent: bigint, name: string, directory: boolean, disposition = 1, writable = false): bigint {
    const text = Buffer.from(name, "utf16le"), out = Buffer.alloc(8), io = Buffer.alloc(16);
    const status = create(out, writable ? 0xc0110000 : 0x80100000,
      { Length: koffi.sizeof(attributes), RootDirectory: parent, ObjectName: { Length: text.length, MaximumLength: text.length, Buffer: text }, Attributes: 0x40, SecurityDescriptor: null, SecurityQualityOfService: null },
      io, null, directory ? 0x10 : 0x80, 1 | (directory ? 2 : 0), disposition,
      0x00200000 | 0x20 | (directory ? 1 : 0x40), null, 0);
    if (status < 0) throw fail(status);
    const h = out.readBigUInt64LE();
    try { if (details(h).directory !== directory) throw new Error("MATERIAL_FS_INVALID_TYPE"); return h; }
    catch (e) { close(h); throw e; }
  }
  const missing = (e: unknown) => [0xc0000034, 0xc000003a].includes((e as { native_status?: number }).native_status ?? 0);
  function bytes(handle: bigint): Buffer {
    const size = details(handle).size;
    if (!Number.isSafeInteger(size) || size > bufferConstants.MAX_LENGTH) throw new Error("MATERIAL_FS_TOO_LARGE");
    const data = Buffer.alloc(size), count = Buffer.alloc(4);
    for (let offset = 0; offset < size;) {
      const length = Math.min(size - offset, 1024 * 1024);
      if (!read(handle, data.subarray(offset, offset + length), length, count, null)) throw fail();
      const received = count.readUInt32LE();
      if (!received || received > length) throw new Error("MATERIAL_FS_READ_INCOMPLETE");
      offset += received;
    }
    return data;
  }
  try {
    const absolute = resolve(root), volume = parse(absolute).root;
    // UNC/device roots are unsupported, not passed through a path-following fallback.
    if (!/^[A-Za-z]:\\$/.test(volume)) throw new Error("MATERIAL_FS_UNSUPPORTED");
    let h = BigInt(openRoot(volume, 0x80100000, 3, null, 3, 0x02200000, 0));
    if (h === -1n || h === 0xffffffffffffffffn) throw fail();
    held.push(h); details(h);
    for (const part of absolute.slice(volume.length).split(/[\\/]/).filter(Boolean)) { h = child(h, part, true); held.push(h); }
    const rootHandle = h, rootIdentity = details(h).identity;
    function parent(path: string, createDirs: boolean) {
      const parts = path.split("/"), leaf = parts.pop()!; let current = rootHandle; const opened: bigint[] = [];
      try { for (const part of parts) { current = child(current, part, true, createDirs ? 3 : 1); opened.push(current); } }
      catch (e) { opened.reverse().forEach((fd) => close(fd)); throw e; }
      // Keep every traversed directory pinned until the DB authority callback completes.
      held.push(...opened);
      return { handle: current, leaf, opened: [] as bigint[] };
    }
    return {
      identity: rootIdentity,
      validate() { /* All traversed directories deny FILE_SHARE_DELETE until close(). */ },
      read(path: string): Buffer | undefined {
        let p: ReturnType<typeof parent>; try { p = parent(path, false); } catch (e) { if (missing(e)) return undefined; throw e; }
        try { let file: bigint; try { file = child(p.handle, p.leaf, false); } catch (e) { if (missing(e)) return undefined; throw e; }
          try { return bytes(file); } finally { close(file); }
        } finally { p.opened.reverse().forEach((fd) => close(fd)); }
      },
      publish(path: string, data: Buffer, operationId: string): "created" | "exists" {
        if (!/^[a-zA-Z0-9_-]+$/.test(operationId)) throw new Error("MATERIAL_FS_BINDING_CONFLICT");
        const p = parent(path, true); let file: bigint | undefined;
        try {
          const temp = `.material-${operationId}.tmp`;
          try { file = child(p.handle, temp, false, 2, true);
            const count = Buffer.alloc(4);
            if (!write(file, data, data.length, count, null) || count.readUInt32LE() !== data.length || !flush(file)) throw fail();
          } catch (e) {
            if ((e as {native_status?: number}).native_status !== 0xc0000035) throw e;
            file = child(p.handle, temp, false, 1, true);
            if (!bytes(file).equals(data)) throw new Error("MATERIAL_FS_TEMP_CONFLICT");
          }
          // FILE_LINK_INFORMATION, 64-bit ABI: BOOLEAN@0, HANDLE@8, ULONG@16, WCHAR[]@20.
          const name = Buffer.from(p.leaf, "utf16le"), link = Buffer.alloc(20 + name.length);
          link.writeBigUInt64LE(p.handle, 8); link.writeUInt32LE(name.length, 16); name.copy(link, 20);
          const status = set(file, Buffer.alloc(16), link, link.length, 11);
          if (status < 0 && (status >>> 0) !== 0xc0000035) throw fail(status);
          if (status >= 0 && !flush(file)) throw fail();
          // Delete only the temporary link via its still-open handle, never the final object.
          const deleted = set(file, Buffer.alloc(16), Buffer.from([1]), 1, 13);
          if (deleted < 0) throw fail(deleted);
          return status >= 0 ? "created" : "exists";
        } finally { if (file !== undefined) close(file); p.opened.reverse().forEach((fd) => close(fd)); }
      },
      close() { held.splice(0).reverse().forEach((fd) => close(fd)); },
    };
  } catch (e) { held.reverse().forEach((fd) => close(fd)); throw e; }
}
