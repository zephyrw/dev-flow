import { observeProcessRecord } from "./process-protocol.js";
import { getNativeAsync } from "./native/index.js";
import { basename, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { darwinProcessInfo, darwinProcessPath, listDarwinProcesses } from "./native/darwin-processes.js";
import type { Store } from "../../store/src/store.js";

const execFileAsync = promisify(execFile);
import type {
  ProcessHostPort,
  ExternalProcessInfo,
} from "../../agy-accounts/src/ports.js";
import type { ProcessManager } from "./manager.js";
type RecordEntry = {
  id: string;
  pid?: number;
  status?: string;
  confirmed?: boolean;
  identity?: import("./process-protocol.js").ProcessIdentity;
  agy_account?: {
    realm_id: string;
    account_id: string;
    auth_epoch: number;
    permit_id: string;
  };
};
type ProcessEntry = {
  pid: number;
  parent: number;
  exe_path: string;
  name: string;
  sid?: string;
  create_time?: number;
  pgid?: number;
  creation_time?: string;
};

/**
 * R03 修复：四态确认模型
 * - running:        进程仍在运行
 * - confirmed_exited: 已确认退出（进程不存在）
 * - unknown:        无法确定状态（异常），必须阻塞切换
 * - not_owned:      进程不属于当前管理器
 */
type StopConfirmationStatus =
  | "running"
  | "confirmed_exited"
  | "unknown"
  | "not_owned";

/** Local process facts only. Failure to establish ownership must block switching. */
export class AgyAccountProcessHost implements ProcessHostPort {
  constructor(
    private options: {
      store: Store;
      agyExecutable: string;
      processManager?: ProcessManager;
    },
  ) {}
  private records() {
    return this.options.store.list<RecordEntry>("process_record");
  }

  private async awaitOwnedStart(record: RecordEntry): Promise<RecordEntry> {
    if (record.status !== "starting") return record;
    const managed = this.options.processManager?.get(record.id);
    const attempt = record.identity?.attempt_id;
    const realm = record.agy_account?.realm_id;
    if (!managed || !attempt || managed.identity?.attempt_id !== attempt)
      throw new Error("AGY_MANAGED_PROCESS_IDENTITY_UNKNOWN");
    let readyFailed = false;
    try { await managed.ready; } catch { readyFailed = true; }
    const current = this.options.processManager?.get(record.id);
    const fresh = this.records().find((r) => r.id === record.id);
    const exited = fresh?.confirmed === true &&
      (fresh.status === "exited" || fresh.status === "failed");
    if (!fresh || fresh.identity?.attempt_id !== attempt ||
        fresh.agy_account?.realm_id !== realm ||
        (current && (current !== managed || current.identity?.attempt_id !== attempt)) ||
        (!current && !exited) || (readyFailed && !exited) || fresh.status === "starting")
      throw new Error("AGY_MANAGED_PROCESS_IDENTITY_UNKNOWN");
    return fresh;
  }

  async assertCapabilities() {
    await getNativeAsync();
  }
  private async confirmRecordStopped(
    record: RecordEntry,
  ): Promise<StopConfirmationStatus> {
    const managed = this.options.processManager?.get(record.id);
    if (
      managed?.identity &&
      record.identity?.attempt_id !== managed.identity.attempt_id
    )
      return "not_owned";
    return (
      await observeProcessRecord(record as unknown as Record<string, unknown>)
    ).state;
  }

  async confirmJobsStopped(ids: string[]): Promise<boolean> {
    for (const id of ids) {
      if (!/^[A-Za-z0-9_-]{1,150}$/.test(id)) return false;
      const record = this.records().find((r) => r.id === id);
      if (!record) return false;
      const status = await this.confirmRecordStopped(record);
      if (
        status === "running" ||
        status === "unknown" ||
        status === "not_owned"
      ) {
        return false;
      }
    }
    return true;
  }

  async listManagedProcesses(realmId: string) {
    await this.assertCapabilities();
    const out = [];
    for (const record of this.records().filter(
      (r) => r.agy_account?.realm_id === realmId,
    )) {
      const r = await this.awaitOwnedStart(record);
      const status = await this.confirmRecordStopped(r);
      if (status === "confirmed_exited") continue;
      if (status === "unknown" || status === "not_owned") {
        // R03 修复：unknown 状态必须抛出错误，阻塞切换
        throw new Error("AGY_MANAGED_PROCESS_IDENTITY_UNKNOWN");
      }
      if (!Number.isSafeInteger(r.pid) || r.pid! <= 0)
        throw new Error("AGY_MANAGED_PROCESS_IDENTITY_UNKNOWN");
      out.push({ pid: r.pid!, ...r.agy_account });
    }
    return out;
  }

  async confirmPermitStopped(
    permit: import("../../contracts/src/agy-account.js").AgyUsagePermit,
  ): Promise<boolean> {
    const records = this.records().filter(record => record.agy_account?.permit_id === permit.permit_id);
    // Absence from an inventory is not evidence of exit. The permit identifies
    // one attempt through its durable process binding, including startup failure.
    if (records.length !== 1) return false;
    const record = records[0]!;
    if (record.id !== permit.consumer_id || record.agy_account?.realm_id !== permit.realm_id ||
        record.agy_account.account_id !== permit.account_id || record.agy_account.auth_epoch !== permit.auth_epoch ||
        (permit.process_id !== undefined && record.pid !== permit.process_id)) return false;
    const current = await this.awaitOwnedStart(record);
    return await this.confirmRecordStopped(current) === "confirmed_exited";
  }

  private async inventory(): Promise<ProcessEntry[]> {
    if (process.platform === "darwin") {
      const configured = basename(this.options.agyExecutable);
      return listDarwinProcesses().map((info) => {
        const candidate = info.uid === process.getuid!() && (info.name === configured.slice(0, 31) || info.name === "agy");
        if (!candidate) return { ...info, exe_path: "" };
        try {
          const exe_path = darwinProcessPath(info.pid);
          const current = darwinProcessInfo(info.pid);
          if (!current) return { ...info, exe_path: "" };
          if (current.creation_time !== info.creation_time || current.uid !== info.uid)
            throw new Error("AGY_PROCESS_IDENTITY_UNKNOWN");
          return { ...info, name: basename(exe_path), exe_path, sid: "uid:" + info.uid };
        } catch (error) {
          if (!darwinProcessInfo(info.pid)) return { ...info, exe_path: "" };
          throw error;
        }
      });
    }
    if (process.platform !== "win32")
      throw new Error("AGY_PROCESS_INVENTORY_UNSUPPORTED");
    // A process can exit after enumeration but before GetOwnerSid. Ignore only
    // a freshly confirmed missing PID; live/reused PIDs and query errors fail closed.
    const script =
      "$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $items=@(Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { $p=$_; if ($p.Name -match '(?i)^agy(?:\\.exe)?$') { try { $owner=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -ErrorAction Stop; if ($owner.ReturnValue -ne 0) { throw 'Cannot establish AGY process owner' } } catch { $live=@(Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$p.ProcessId) -ErrorAction Stop); if ($live.Count -eq 0) { return }; throw }; if ($owner.Sid -eq $sid) { [PSCustomObject]@{pid=[int]$p.ProcessId;parent=[int]$p.ParentProcessId;exe_path=[string]$p.ExecutablePath;name=$p.Name;sid=$sid;create_time=([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()} } } else { [PSCustomObject]@{pid=[int]$p.ProcessId;parent=[int]$p.ParentProcessId;exe_path='';name=$p.Name} } }); ConvertTo-Json -InputObject $items -Compress";
    const configuredName = basename(this.options.agyExecutable).replace(
      /'/g,
      "''",
    );
    const program = script.replace(
      "$p.Name -match '(?i)^agy(?:\\.exe)?$'",
      () => `($p.Name -match '(?i)^agy(?:\\.exe)?$' -or $p.Name -eq '${configuredName}')`,
    );
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(program, "utf16le").toString("base64"),
      ],
      { windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
    );
    const rows: ProcessEntry[] = JSON.parse(stdout.trim());
    if (!Array.isArray(rows)) throw new Error("AGY_PROCESS_INVENTORY_INVALID");
    return rows;
  }
  async findExternalAgyProcesses(): Promise<ExternalProcessInfo[]> {
    await this.assertCapabilities();
    const records: RecordEntry[] = [];
    for (const entry of this.records().filter(
      (r) => r.agy_account && this.options.processManager?.get(r.id),
    )) {
      records.push(await this.awaitOwnedStart(entry));
    }
    // Startup may take seconds; enumerate the OS only after those waits so an
    // external CLI appearing meanwhile cannot be missed by an older snapshot.
    const rows = await this.inventory();
    const configuredName = basename(this.options.agyExecutable).toLowerCase();
    const isAgyCliProcess = (name: string) => {
      const lower = name.toLowerCase();
      if (/antigravity|language_server|code\.exe/i.test(lower)) {
        return false;
      }
      return (
        lower === configuredName ||
        lower === configuredName.replace(/\.exe$/, "") ||
        lower === "agy.exe" ||
        lower === "agy"
      );
    };
    const candidates = rows.filter(
      (r) => !!r.sid && isAgyCliProcess(r.name),
    );
    const owned = new Set<number>();
    const native = await getNativeAsync();
    if (!("openJob" in native) && process.platform === "darwin") {
      for (const record of records) {
        if ((record.status === "exited" || record.status === "failed") && record.confirmed) continue;
        const managed = this.options.processManager!.get(record.id);
        const identity = record.identity;
        if (!managed || !identity?.pgid || identity.pgid !== identity.launcher_pid ||
            !identity.launcher_creation_time || identity.attempt_id !== managed.identity?.attempt_id)
          throw new Error("AGY_MANAGED_PROCESS_IDENTITY_UNKNOWN");
        const leader = darwinProcessInfo(identity.launcher_pid);
        if (!leader || leader.creation_time !== identity.launcher_creation_time || leader.uid !== process.getuid!())
          throw new Error("AGY_MANAGED_PROCESS_IDENTITY_UNKNOWN");
        for (const candidate of candidates) {
          if (candidate.pgid !== identity.pgid) continue;
          const current = darwinProcessInfo(candidate.pid);
          if (current && current.creation_time === candidate.creation_time && current.pgid === identity.pgid && current.uid === leader.uid)
            owned.add(candidate.pid);
          else if (current) throw new Error("AGY_MANAGED_PROCESS_IDENTITY_UNKNOWN");
        }
      }
    } else {
      if (!("openJob" in native))
        throw new Error("AGY_PROCESS_INVENTORY_UNSUPPORTED");
      for (const record of records) {
        if ((record.status === "exited" || record.status === "failed") && record.confirmed) continue;
        const managed = this.options.processManager!.get(record.id)!;
        if (
          !managed || !record.identity?.job_name ||
          record.identity.attempt_id !== managed.identity?.attempt_id
        )
          throw new Error("AGY_MANAGED_PROCESS_IDENTITY_UNKNOWN");
        const job = native.openJob(record.identity.job_name);
        if (!job) continue;
        try {
          for (const candidate of candidates)
            if (native.isProcessInJob(candidate.pid, job))
              owned.add(candidate.pid);
        } finally {
          native.closeHandle(job);
        }
      }
    }
    return rows
      .filter(
        (r) =>
          !owned.has(r.pid) &&
          isAgyCliProcess(r.name) &&
          !!r.sid,
      )
      .map((r) => {
        if (!r.exe_path) throw new Error("AGY_EXTERNAL_PROCESS_PATH_UNKNOWN");
        return {
          pid: r.pid,
          exe_path: resolve(r.exe_path),
          sid: r.sid,
          create_time: r.create_time,
        };
      });
  }
  async stopProcess(pid: number, _reason: string) {
    const record = this.records().find(
      (r) =>
        r.pid === pid &&
        r.agy_account &&
        this.options.processManager?.get(r.id)?.pid === pid,
    );
    if (!record) return false;
    await this.options.processManager!.stop(record.id, "account_switch");
    return this.confirmJobsStopped([record.id]);
  }
  async confirmProcessesStopped(pids: number[], _timeoutMs: number) {
    const records = this.records();
    const selected = pids.map((pid) =>
      records.find((r) => r.pid === pid && r.agy_account),
    );
    if (selected.some((r) => !r)) return false;
    return this.confirmJobsStopped(selected.map((r) => r!.id));
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as NodeJS.ErrnoException).code === "string"
  );
}
