import koffi from "koffi";

let api: ReturnType<typeof load> | undefined;
type QueryFailureReason = "library_load_failed" | "bsd_read_unconfirmed" | "bsd_pid_mismatch" | "inventory_size_failed" | "inventory_read_failed";
class DarwinProcessQueryError extends Error {
  readonly code = "DARWIN_PROCESS_QUERY_FAILED";
  constructor(readonly reason: QueryFailureReason, readonly facts: Record<string, number>) {
    super(reason.startsWith("inventory") ? "PROCESS_INVENTORY_UNKNOWN" : "PROCESS_IDENTITY_UNKNOWN");
  }
}
export function darwinProcessQueryDiagnostic(error: unknown): { reason: string; facts: Record<string, number> } | undefined {
  if (!(error instanceof DarwinProcessQueryError)) return undefined;
  return { reason: error.reason, facts: { ...error.facts } };
}
function load() {
  if (process.platform !== "darwin")
    throw new Error("PROCESS_INVENTORY_UNSUPPORTED");
  let library: ReturnType<typeof koffi.load>;
  try { library = koffi.load("/usr/lib/libproc.dylib"); }
  catch { throw new DarwinProcessQueryError("library_load_failed", {}); }
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
  // proc_listpids includes zombproc. XNU's proc_pidinfo requires arg != 0
  // to consult proc_find_zombref; arg=0 cannot prove a listed zombie's state.
  const bytes = api.info(pid, 3, 1, buffer, buffer.length);
  const errno = koffi.errno();
  if (bytes !== buffer.length) {
    // A zombie still answers kill(0), but cannot execute or modify credentials.
    // macOS may no longer expose its full BSD record; require kernel proof.
    const short = Buffer.alloc(64);
    const shortBytes = api.info(pid, 13, 1, short, short.length);
    const shortErrno = koffi.errno();
    if (
      shortBytes === short.length &&
      short.readUInt32LE(0) === pid &&
      short.readUInt32LE(12) === 5
    )
      return undefined;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return undefined;
    }
    throw new DarwinProcessQueryError("bsd_read_unconfirmed", {
      pid, flavor: 3, arg: 1, bytes, errno,
      short_flavor: 13, short_bytes: shortBytes, short_errno: shortErrno,
      ...(shortBytes === short.length ? { observed_pid: short.readUInt32LE(0), status: short.readUInt32LE(12) } : {}),
    });
  }
  if (buffer.readUInt32LE(12) !== pid)
    throw new DarwinProcessQueryError("bsd_pid_mismatch", { pid, flavor: 3, arg: 1, bytes, observed_pid: buffer.readUInt32LE(12) });
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
  const sizeErrno = koffi.errno();
  if (size <= 0 || size > 16 * 1024 * 1024)
    throw new DarwinProcessQueryError("inventory_size_failed", { type: 4, typeinfo: uid, size, errno: sizeErrno });
  const buffer = Buffer.alloc(size + 4096);
  const used = api.list(4, uid, buffer, buffer.length);
  const readErrno = koffi.errno();
  if (used <= 0 || used >= buffer.length || used % 4)
    throw new DarwinProcessQueryError("inventory_read_failed", { type: 4, typeinfo: uid, size: buffer.length, used, errno: readErrno });
  const result: DarwinProcessInfo[] = [];
  for (let offset = 0; offset < used; offset += 4) {
    const pid = buffer.readInt32LE(offset);
    if (pid <= 0) continue;
    const info = darwinProcessInfo(pid);
    if (info) result.push(info);
  }
  return result;
}

/** Failure-only observation: never used to decide ownership or confirm exit. */
export function observeDarwinProcessGroup(pgid: number) {
  const counts = { listed: 0, live: 0, zombie: 0, unknown: 0 };
  if (!Number.isSafeInteger(pgid) || pgid <= 1)
    return { ...counts, complete: false, reason: "invalid_group" };
  try {
    api ??= load();
    const size = api.list(2, pgid, null, 0);
    const sizeErrno = koffi.errno();
    if (size <= 0 || size > 16 * 1024 * 1024)
      return { ...counts, complete: false, reason: "group_size_failed", errno: sizeErrno };
    const buffer = Buffer.alloc(size + 4096);
    koffi.errno(0);
    const used = api.list(2, pgid, buffer, buffer.length);
    const errno = koffi.errno();
    if (used < 0 || used >= buffer.length || used % 4 || (used === 0 && errno !== 0))
      return { ...counts, complete: false, reason: "group_list_failed", errno, bytes: used };
    for (let offset = 0; offset < used; offset += 4) {
      const pid = buffer.readInt32LE(offset);
      if (pid <= 0) { counts.unknown++; continue; }
      counts.listed++;
      const short = Buffer.alloc(64);
      const bytes = api.info(pid, 13, 1, short, short.length);
      if (bytes !== short.length || short.readUInt32LE(0) !== pid || short.readUInt32LE(8) !== pgid) {
        counts.unknown++;
        continue;
      }
      const status = short.readUInt32LE(12);
      if (status === 5) counts.zombie++;
      else if (status >= 1 && status <= 4) counts.live++;
      else counts.unknown++;
    }
    return { ...counts, complete: counts.unknown === 0, reason: "group_observed" };
  } catch {
    return { ...counts, complete: false, reason: "group_query_failed" };
  }
}
