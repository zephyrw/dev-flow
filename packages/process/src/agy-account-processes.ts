import { observeProcessRecord } from "./process-protocol.js";
import { getNativeAsync } from "./native/index.js";
import { basename, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
    for (const r of this.records().filter(
      (r) => r.agy_account?.realm_id === realmId,
    )) {
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

  private async inventory(): Promise<ProcessEntry[]> {
    if (process.platform !== "win32")
      throw new Error("AGY_PROCESS_INVENTORY_UNSUPPORTED");
    const script =
      "$ErrorActionPreference='SilentlyContinue'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $items=@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object { $p=$_; if ($p.Name -match '(?i)agy|antigravity|language_server') { try { $owner=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -ErrorAction Stop; if ($owner.ReturnValue -eq 0 -and $owner.Sid -eq $sid) { $cTime=0; try { $cTime=([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() } catch {}; [PSCustomObject]@{pid=[int]$p.ProcessId;parent=[int]$p.ParentProcessId;exe_path=[string]$p.ExecutablePath;name=$p.Name;sid=$sid;create_time=$cTime} } } catch {} } else { [PSCustomObject]@{pid=[int]$p.ProcessId;parent=[int]$p.ParentProcessId;exe_path='';name=$p.Name} } }); ConvertTo-Json -InputObject $items -Compress";
    const configuredName = basename(this.options.agyExecutable).replace(
      /'/g,
      "''",
    );
    const program = script.replace(
      "$p.Name -match '(?i)agy|antigravity|language_server'",
      `($p.Name -match '(?i)agy|antigravity|language_server' -or $p.Name -eq '${configuredName}')`,
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
    if (!("openJob" in native))
      throw new Error("AGY_PROCESS_INVENTORY_UNSUPPORTED");
    for (const record of this.records().filter(
      (r) => r.agy_account && this.options.processManager?.get(r.id),
    )) {
      const managed = this.options.processManager!.get(record.id)!;
      if (
        !record.identity?.job_name ||
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
