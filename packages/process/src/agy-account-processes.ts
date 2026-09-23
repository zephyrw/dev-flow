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
type StopConfirmationStatus = "running" | "confirmed_exited" | "unknown" | "not_owned";

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
    // With Node native module, capabilities are always available
    // (koffi on Windows, built-in on POSIX)
    return;
  }

  /**
   * R03 修复：确认单个进程记录的停止状态。
   * 返回四态：running | confirmed_exited | unknown | not_owned
   * 不再吞掉异常导致活进程返回 stopped=true
   */
  private async confirmRecordStopped(record: RecordEntry): Promise<StopConfirmationStatus> {
    if (!record.pid) {
      // 无 PID 记录视为已确认退出
      return "confirmed_exited";
    }

    // 检查是否由当前管理器拥有
    const managedProcess = this.options.processManager?.get(record.id);
    if (managedProcess && managedProcess.pid !== record.pid) {
      // PID 不匹配，说明管理器已重启，旧进程不属于当前管理器
      return "not_owned";
    }

    try {
      if (process.platform === "win32") {
        const { getNativeAsync } = await import("./native/index.js");
        const native = await getNativeAsync();
        const h = native.openProcess(record.pid);
        if (h) {
          native.closeHandle(h);
          return "running";
        }
        // openProcess 返回 null，进程不存在
        return "confirmed_exited";
      } else {
        // POSIX：使用 signal 0 探测
        process.kill(record.pid, 0);
        return "running";
      }
    } catch (err: unknown) {
      // R03 修复：不再吞掉异常，返回 unknown 阻塞切换
      if (isErrnoException(err) && err.code === "ESRCH") {
        // ESRCH 明确表示进程不存在
        return "confirmed_exited";
      }
      // 其他异常（EPERM 等）视为未知状态
      return "unknown";
    }
  }

  async confirmJobsStopped(ids: string[]): Promise<boolean> {
    for (const id of ids) {
      if (!/^[A-Za-z0-9_-]{1,150}$/.test(id)) return false;
      const record = this.records().find(r => r.id === id);
      if (!record) continue;
      const status = await this.confirmRecordStopped(record);
      if (status === "running" || status === "unknown" || status === "not_owned") {
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
      if (status === "unknown") {
        // R03 修复：unknown 状态必须抛出错误，阻塞切换
        throw new Error("AGY_MANAGED_PROCESS_IDENTITY_UNKNOWN");
      }
      if (status === "not_owned") {
        // 不属于当前管理器的进程不加入列表
        continue;
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
      "$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $items=@(Get-CimInstance Win32_Process | ForEach-Object { $p=$_; if ($p.Name -match '(?i)agy|antigravity|language_server') { $owner=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid; if ($owner.ReturnValue -ne 0) { throw 'Cannot establish AGY process owner' }; if ($owner.Sid -eq $sid) { [PSCustomObject]@{pid=[int]$p.ProcessId;parent=[int]$p.ParentProcessId;exe_path=[string]$p.ExecutablePath;name=$p.Name;sid=$sid;create_time=([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()} } } else { [PSCustomObject]@{pid=[int]$p.ProcessId;parent=[int]$p.ParentProcessId;exe_path='';name=$p.Name} } }); ConvertTo-Json -InputObject $items -Compress";
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
    const owned = new Set(
      this.records()
        .filter((r) => r.agy_account && this.options.processManager?.get(r.id))
        .map((r) => r.pid)
        .filter((p): p is number => !!p),
    );
    let changed = true;
    while (changed) {
      changed = false;
      for (const r of rows)
        if (owned.has(r.parent) && !owned.has(r.pid)) {
          owned.add(r.pid);
          changed = true;
        }
    }
    const configuredName = basename(this.options.agyExecutable).toLowerCase();
    return rows
      .filter(
        (r) =>
          !owned.has(r.pid) &&
          (r.name.toLowerCase() === configuredName ||
            /agy|antigravity|language_server/i.test(r.name)) &&
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
