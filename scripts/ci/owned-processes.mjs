import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

// Only identity and parent/group metadata are read: never process arguments or env.
export async function readPosixProcesses() {
  if (process.platform === "linux") {
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const records = [];
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (!/^\d+$/.test(fields[19] ?? "")) throw new Error("PROCESS_IDENTITY_INVALID");
        records.push({ pid: Number(entry), parent: Number(fields[1]), group: Number(fields[2]),
          creation: `${boot}:${fields[19]}`, zombie: fields[0] === "Z" });
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
      }
    }
    return records;
  }
  const output = await new Promise((resolve, reject) => {
    execFile("/bin/ps", ["-axo", "pid=,ppid=,pgid=,lstart=,stat="], {
      encoding: "utf8", timeout: 1500, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C" },
    }, (error, stdout) => error ? reject(new Error("PROCESS_SNAPSHOT_FAILED")) : resolve(stdout));
  });
  return output.split("\n").filter(line => line.trim()).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) throw new Error("PROCESS_SNAPSHOT_INVALID");
    return { pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]),
      creation: match[4].trim(), zombie: match[5].startsWith("Z") };
  });
}

/** The SDK owns the launcher's group; this retains detached descendants by birth identity. */
export class OwnedProcessTracker {
  constructor(read = readPosixProcesses, signal = pid => process.kill(pid, "SIGKILL")) {
    this.read = read;
    this.signal = signal;
    this.owned = new Map();
    this.root = null;
    this.error = null;
    this.pending = null;
  }

  setRoot(pid, creation) {
    if (!Number.isSafeInteger(pid) || pid <= 1 || !creation) throw new Error("PROCESS_IDENTITY_UNKNOWN");
    if (this.root && (this.root.pid !== pid || this.root.creation !== creation))
      throw new Error("PROCESS_ROOT_CHANGED");
    this.root = { pid, creation };
    this.owned.set(pid, { pid, creation, group: pid });
  }

  remember(records) {
    if (!this.root) return;
    const current = new Map(records.map(record => [record.pid, record]));
    const anchors = new Set();
    for (const known of this.owned.values()) {
      const record = current.get(known.pid);
      if (record?.creation !== known.creation) continue;
      // Birth identity establishes ownership; parent and group can change later.
      this.owned.set(record.pid, { ...record });
      anchors.add(record.pid);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const record of records) {
        if (anchors.has(record.pid)) continue;
        // Group members remain attributable even after the tool (but not launcher) exits.
        if (anchors.has(record.parent) ||
            (anchors.has(this.root.pid) && record.group === this.root.pid)) {
          const known = this.owned.get(record.pid);
          if (known && known.creation !== record.creation) continue;
          this.owned.set(record.pid, { ...record });
          anchors.add(record.pid);
          changed = true;
        }
      }
    }
  }

  capture() {
    if (!this.root) return Promise.resolve([]);
    if (!this.pending) {
      this.pending = Promise.resolve().then(() => this.read()).then(records => {
        this.remember(records);
        return records;
      }).catch(() => {
        this.error = "PROCESS_SNAPSHOT_FAILED";
        return null;
      }).finally(() => { this.pending = null; });
    }
    return this.pending;
  }

  async cleanup(deadline) {
    if (!this.root) return { confirmed: true, error: null };
    while (Date.now() < deadline) {
      const records = await this.capture();
      if (!records) return { confirmed: false, error: this.error };
      const live = new Map(records.map(record => [record.pid, record]));
      const detached = [...this.owned.values()].reverse().filter(record => {
        const current = live.get(record.pid);
        return current?.creation === record.creation && current.group !== this.root.pid &&
          !current.zombie;
      });
      if (!detached.length) return { confirmed: !this.error, error: this.error };
      for (const record of detached) {
        if (Date.now() >= deadline) break;
        // Re-read immediately before signalling: a remembered PID may now be unrelated.
        const fresh = await this.capture();
        if (!fresh) return { confirmed: false, error: this.error };
        const candidate = fresh.find(item => item.pid === record.pid);
        if (!candidate || candidate.creation !== record.creation || candidate.zombie ||
            candidate.group === this.root.pid) continue;
        try { this.signal(record.pid); }
        catch (error) {
          if (error.code !== "ESRCH") return { confirmed: false, error: "PROCESS_CLEANUP_FAILED" };
        }
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return { confirmed: false, error: "PROCESS_CLEANUP_UNCONFIRMED" };
  }
}
