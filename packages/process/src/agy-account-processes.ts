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
  async confirmJobsStopped(ids: string[]) {
    for (const id of ids) {
      if (!/^[A-Za-z0-9_-]{1,150}$/.test(id)) return false;
      // Check if the process is still alive using native module
      const record = this.records().find(r => r.id === id);
      if (!record || !record.pid) continue;
      try {
        if (process.platform === "win32") {
          const { getNative } = require("./native/index.js") as typeof import("./native/index.js");
          const native = getNative();
          const h = native.openProcess?.(record.pid);
          if (h) {
            native.closeHandle?.(h);
            return false; // Process still alive
          }
        } else {
          process.kill(record.pid, 0);
          return false; // Process still alive
        }
      } catch {
        // Process gone
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
      if (await this.confirmJobsStopped([r.id])) continue;
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
