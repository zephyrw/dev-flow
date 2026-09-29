import koffi from "koffi";
import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync, fsyncSync } from "node:fs";
import { resolve } from "node:path";

// openat/linkat ABI: https://pubs.opengroup.org/onlinepubs/9799919799/functions/open.html
// Flags come from this Node build's OS, never from another platform's numeric table.
export function openPosixMaterialRoot(root: string) {
  if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("MATERIAL_FS_UNSUPPORTED");
  const libc = koffi.load(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6");
  // A real variadic declaration is essential on Darwin ARM64 (mode is a promoted int).
  const openat = libc.func("openat", "int", ["int", "str", "int", "..."]);
  const mkdirat = libc.func("mkdirat", "int", ["int", "str", process.platform === "darwin" ? "uint16" : "uint32"]);
  const linkat = libc.func("linkat", "int", ["int", "str", "int", "str", "int"]);
  const unlinkat = libc.func("unlinkat", "int", ["int", "str", "int"]);
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  if (!constants.O_DIRECTORY || !constants.O_NOFOLLOW) throw new Error("MATERIAL_FS_UNSUPPORTED");
  const held: number[] = [];
  const failure = () => Object.assign(new Error("MATERIAL_FS_OPERATION_FAILED"), { errno: koffi.errno() });
  const identity = (fd: number) => { const s = fstatSync(fd, { bigint: true }); return `${s.dev}:${s.ino}`; };
  function child(parent: number, name: string, directory: boolean, create = false): number {
    let fd = openat(parent, name, directory ? directoryFlags : constants.O_RDONLY | constants.O_NOFOLLOW);
    if (fd < 0 && directory && create && koffi.errno() === 2) {
      if (mkdirat(parent, name, 0o700) !== 0 && koffi.errno() !== 17) throw failure();
      fd = openat(parent, name, directoryFlags);
    }
    if (fd < 0) throw failure();
    try {
      const stat = fstatSync(fd);
      if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error("MATERIAL_FS_INVALID_TYPE");
      return fd;
    } catch (error) { closeSync(fd); throw error; }
  }
  try {
    let fd = openSync("/", directoryFlags); held.push(fd);
    for (const part of resolve(root).split("/").filter(Boolean)) { fd = child(fd, part, true); held.push(fd); }
    const rootFd = fd;
    const rootIdentity = identity(rootFd);
    const directoryIdentities = new Map<string, string>();
    function parent(path: string, create: boolean) {
      const parts = path.split("/"); const leaf = parts.pop()!;
      let current = rootFd; const opened: number[] = [];
      try { for (const part of parts) { current = child(current, part, true, create); opened.push(current); } }
      catch (e) { opened.reverse().forEach(closeSync); throw e; }
      try {
        const parentIdentity = identity(current);
        if (!directoryIdentities.has(path)) directoryIdentities.set(path, parentIdentity);
        return { fd: current, leaf, opened, identity: parentIdentity };
      } catch (error) { opened.reverse().forEach(closeSync); throw error; }
    }
    function check(path: string, parentIdentity: string) {
      // Re-open through the bound root. A renamed/replaced directory must never become a DB authority.
      const p = parent(path, false); try { if (p.identity !== parentIdentity) throw new Error("MATERIAL_FS_BINDING_CHANGED"); }
      finally { p.opened.reverse().forEach(closeSync); }
    }
    return {
      identity: rootIdentity,
      validate() { for (const [path, expected] of directoryIdentities) check(path, expected); },
      read(path: string): Buffer | undefined {
        let p: ReturnType<typeof parent>;
        try { p = parent(path, false); } catch (e) { if ((e as {errno?: number}).errno === 2) return undefined; throw e; }
        try {
          let file: number;
          try { file = child(p.fd, p.leaf, false); } catch (e) { if ((e as {errno?: number}).errno === 2) return undefined; throw e; }
          try { const data = readFileSync(file); check(path, p.identity); return data; } finally { closeSync(file); }
        } finally { p.opened.reverse().forEach(closeSync); }
      },
      publish(path: string, data: Buffer, operationId: string): "created" | "exists" {
        if (!/^[a-zA-Z0-9_-]+$/.test(operationId)) throw new Error("MATERIAL_FS_BINDING_CONFLICT");
        const p = parent(path, true); const temp = `.material-${operationId}.tmp`;
        let file = -1;
        try {
          file = openat(p.fd, temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, "int", 0o600);
          if (file < 0) {
            if (koffi.errno() !== 17) throw failure();
            const prior = child(p.fd, temp, false);
            try { if (!readFileSync(prior).equals(data)) throw new Error("MATERIAL_FS_TEMP_CONFLICT"); } finally { closeSync(prior); }
          } else { writeFileSync(file, data); fsyncSync(file); closeSync(file); file = -1; }
          const rc = linkat(p.fd, temp, p.fd, p.leaf, 0);
          if (rc !== 0 && koffi.errno() !== 17) throw failure();
          fsyncSync(p.fd);
          check(path, p.identity);
          // Only remove our own temporary link after durable publication. Never remove a final object.
          if (unlinkat(p.fd, temp, 0) !== 0) throw failure();
          return rc === 0 ? "created" : "exists";
        } finally { if (file >= 0) closeSync(file); p.opened.reverse().forEach(closeSync); }
      },
      close() { held.splice(0).reverse().forEach(closeSync); },
    };
  } catch (e) { held.reverse().forEach(closeSync); throw e; }
}
