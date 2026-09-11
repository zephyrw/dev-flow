import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { FlowError, requireCondition } from "../../contracts/src/index.js";
import { JsonLines } from "../../adapters/agy/src/protocol.js";
import { id } from "../../core/src/util.js";
export interface ProcessSpec {
  id: string;
  workflow_id?: string;
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeout_ms: number;
  stdin?: string;
}
export interface ManagedProcess extends EventEmitter {
  id: string;
  completion: Promise<{ code: number | null; signal?: string }>;
  stop: () => Promise<void>;
}
export class ProcessManager {
  private active = new Map<string, ManagedProcess>();
  constructor(
    private hostExecutable: string,
    private requireHost = true,
    private lifecycle?: (
      spec: ProcessSpec,
      event: Record<string, unknown>,
    ) => void,
  ) {}
  start(spec: ProcessSpec): ManagedProcess {
    const existing = this.active.get(spec.id);
    if (existing) return existing;
    const isWindows = process.platform === "win32";
    requireCondition(
      !this.requireHost || (isWindows && existsSync(this.hostExecutable)),
      "HOST_REQUIRED",
      "Windows Host 尚未安装，不能执行受管进程",
      503,
    );
    const useHost = isWindows && existsSync(this.hostExecutable);
    this.lifecycle?.(spec, { status: "starting", job_id: spec.id });
    const events = new EventEmitter() as ManagedProcess;
    events.id = spec.id;
    let child: ChildProcessWithoutNullStreams;
    const inherited: Record<string, string> = {
      DOTNET_ROOT: process.env.DOTNET_ROOT ?? process.cwd() + "/.cache/dotnet",
    };
    for (const key of [
      "SystemRoot",
      "WINDIR",
      "PATH",
      "TEMP",
      "TMP",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
    ])
      if (process.env[key]) inherited[key] = process.env[key]!;
    if (useHost) {
      child = spawn(this.hostExecutable, ["run"], {
        windowsHide: true,
        stdio: "pipe",
        env: inherited,
      });
      // All children use the current Windows user and its existing login profile.
      child.stdin.write(
        JSON.stringify({
          ...spec,
          env: { ...inherited, ...spec.env },
        }) + "\n",
      );
    } else {
      child = spawn(spec.executable, spec.args, {
        cwd: spec.cwd,
        env: { ...inherited, ...spec.env },
        windowsHide: true,
        shell: false,
        stdio: "pipe",
      });
      if (spec.stdin) child.stdin.end(spec.stdin);
      else child.stdin.end();
    }
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = new Promise<{ code: number | null; signal?: string }>(
      (resolve, reject) => {
        const settle = (code: number | null, signal?: string) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          this.active.delete(spec.id);
          this.lifecycle?.(spec, {
            status: "exited",
            code,
            confirmed: useHost,
          });
          resolve({ code, ...(signal ? { signal } : {}) });
        };
        child.on("error", (e) => {
          if (timer) clearTimeout(timer);
          this.active.delete(spec.id);
          settled = true;
          this.lifecycle?.(spec, { status: "failed", confirmed: false });
          reject(e);
        });
        if (useHost) {
          const lines = new JsonLines((e) => {
            if (e.type === "stdout" || e.type === "stderr")
              events.emit(e.type, Buffer.from(String(e.data), "base64"));
            else if (e.type === "exit") settle(Number(e.code));
            else if (e.type === "error") {
              events.emit("diagnostic", String(e.message));
              settle(-1);
            } else {
              this.lifecycle?.(spec, { ...e, status: "running" });
              events.emit("host", e);
            }
          });
          child.stdout.on("data", (b: Buffer) => {
            try {
              lines.push(b);
            } catch (err) {
              events.emit("diagnostic", String(err));
              child.kill();
            }
          });
          child.stderr.on("data", (b) => events.emit("stderr", b));
          child.on("close", (code, signal) => {
            try {
              lines.finish();
            } catch {}
            settle(code === 0 ? -1 : code, signal ?? undefined);
          });
        } else {
          child.stdout.on("data", (b) => events.emit("stdout", b));
          child.stderr.on("data", (b) => events.emit("stderr", b));
          child.on("close", (code, signal) =>
            settle(code, signal ?? undefined),
          );
        }
      },
    );
    events.completion = done;
    events.stop = async () => {
      if (settled) return;
      if (useHost) child.stdin.write(JSON.stringify({ action: "stop" }) + "\n");
      else child.kill();
      await done;
    };
    if (spec.timeout_ms > 0)
      timer = setTimeout(() => void events.stop(), spec.timeout_ms);
    this.active.set(spec.id, events);
    return events;
  }
  get(key: string) {
    return this.active.get(key);
  }
  async stop(key: string) {
    const p = this.active.get(key);
    if (p) await p.stop();
  }
  list() {
    return [...this.active.keys()];
  }
  async close() {
    await Promise.all([...this.active.values()].map((p) => p.stop()));
  }
}
