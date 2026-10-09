import koffi from "koffi";

let api: ReturnType<typeof load> | undefined;
function load() {
  if (process.platform !== "darwin")
    throw new Error("PROCESS_INVENTORY_UNSUPPORTED");
  const library = koffi.load("/usr/lib/libproc.dylib");
  return {
    list: library.func(
      "int proc_listpids(uint32 type, uint32 typeinfo, void *buffer, int size)",
    ),
    info: library.func(
      "int proc_pidinfo(int pid, int flavor, uint64 arg, void *buffer, int size)",
    ),
    path: library.func("int proc_pidpath(int pid, void *buffer, uint32 size)"),
  };
}
export interface DarwinProcessInfo {
  pid: number;
  parent: number;
  uid: number;
  pgid: number;
  name: string;
  creation_time: string;
  create_time: number;
}
export function darwinProcessInfo(pid: number): DarwinProcessInfo | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("INVALID_PID");
  api ??= load();
  // proc_bsdinfo from the macOS SDK: 12 uint32, 16+32 name bytes,
  // 6 uint32, then the two uint64 creation-time fields (136 bytes total).
  const buffer = Buffer.alloc(136);
  if (api.info(pid, 3, 0, buffer, buffer.length) !== buffer.length) {
    // A zombie still answers kill(0), but cannot execute or modify credentials.
    // macOS may no longer expose its full BSD record; require kernel proof.
    const short = Buffer.alloc(64);
    if (
      api.info(pid, 13, 0, short, short.length) === short.length &&
      short.readUInt32LE(0) === pid &&
      short.readUInt32LE(12) === 5
    )
      return undefined;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return undefined;
    }
    throw new Error("PROCESS_IDENTITY_UNKNOWN");
  }
  if (buffer.readUInt32LE(12) !== pid)
    throw new Error("PROCESS_IDENTITY_UNKNOWN");
  if (buffer.readUInt32LE(4) === 5) return undefined;
  const seconds = buffer.readBigUInt64LE(120),
    micros = buffer.readBigUInt64LE(128);
  const text = (from: number, to: number) =>
    buffer.subarray(from, to).toString("utf8").split("\0")[0]!;
  return {
    pid,
    parent: buffer.readUInt32LE(16),
    uid: buffer.readUInt32LE(20),
    pgid: buffer.readUInt32LE(100),
    name: text(64, 96) || text(48, 64),
    creation_time: seconds + ":" + micros,
    create_time: Number(seconds) * 1000 + Number(micros) / 1000,
  };
}
export function darwinProcessPath(pid: number): string {
  api ??= load();
  const buffer = Buffer.alloc(4096);
  if (api.path(pid, buffer, buffer.length) <= 0)
    throw new Error("PROCESS_PATH_UNKNOWN");
  return buffer.toString("utf8").split("\0")[0]!;
}
export function listDarwinProcesses(): DarwinProcessInfo[] {
  api ??= load();
  // Reserve extra slots for processes created between size query and enumeration.
  const uid = process.getuid!();
  const size = api.list(4, uid, null, 0);
  if (size <= 0 || size > 16 * 1024 * 1024)
    throw new Error("PROCESS_INVENTORY_UNKNOWN");
  const buffer = Buffer.alloc(size + 4096);
  const used = api.list(4, uid, buffer, buffer.length);
  if (used <= 0 || used >= buffer.length || used % 4)
    throw new Error("PROCESS_INVENTORY_UNKNOWN");
  const result: DarwinProcessInfo[] = [];
  for (let offset = 0; offset < used; offset += 4) {
    const pid = buffer.readInt32LE(offset);
    if (pid <= 0) continue;
    const info = darwinProcessInfo(pid);
    if (info) result.push(info);
  }
  return result;
}
