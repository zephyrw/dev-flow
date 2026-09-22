import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { resolve, join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type {
  AuthHostPort,
  AuthHostCapabilities,
  ActiveCredentialInspection,
} from "./ports.js";
import type { AgyAccountAuth } from "../../contracts/src/agy-account.js";

type Pending = {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Resolve the credential-worker.js entry point.
 * In dist mode: dist/packages/agy-accounts/src/credential-worker.js
 * In source mode: packages/agy-accounts/src/credential-worker.js
 */
function resolveCredentialWorker(): string {
  // Try dist layout first (production)
  const distPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "credential-worker.js",
  );
  if (existsSync(distPath)) return distPath;

  // Try source layout (development) - require tsx loader
  const srcPath = join(
    process.cwd(),
    "packages",
    "agy-accounts",
    "src",
    "credential-worker.ts",
  );
  if (existsSync(srcPath)) return srcPath;

  throw new Error("credential_worker_not_found");
}

/**
 * Credential host using Node subprocess (replaces C# DevFlowAuthHost).
 *
 * Spawns credential-worker.js as an isolated Node process. Raw credentials
 * only exist inside that subprocess — the main process never sees them.
 *
 * Protocol: JSONL over stdin/stdout (same as old C# host for compatibility).
 */
export class DevFlowAuthHost implements AuthHostPort {
  private readonly workerScript: string;
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private counter = 0;
  private realm?: string;
  private lockId?: string;
  private starting?: Promise<void>;
  private lostListeners = new Set<() => void>();
  constructor(workerScript?: string) {
    this.workerScript = workerScript ?? resolveCredentialWorker();
  }
  onLockLost(listener: () => void): () => void {
    this.lostListeners.add(listener);
    return () => this.lostListeners.delete(listener);
  }
  isDomainLockHeld(realmId: string): boolean {
    return (
      this.realm === realmId &&
      !!this.lockId &&
      !!this.child &&
      this.child.exitCode === null &&
      !this.child.killed
    );
  }
  private disconnected(error: Error, child: ChildProcessWithoutNullStreams) {
    // Pipes and exit callbacks can arrive after a replacement daemon is started.
    if (this.child !== child) return;
    const held = !!this.lockId;
    this.child = undefined;
    this.lockId = undefined;
    this.realm = undefined;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
    if (child.exitCode === null && !child.killed) child.kill();
    if (held)
      for (const listener of this.lostListeners) {
        try {
          listener();
        } catch {
          /* loss remains fail closed */
        }
      }
  }
  async capabilities(): Promise<AuthHostCapabilities> {
    const unavailable = (version: string): AuthHostCapabilities => ({
      supported: false,
      platform: process.platform,
      dpapi_available: false,
      cred_manager_available: false,
      named_mutex_available: false,
      version,
    });
    if (process.platform !== "win32") return unavailable("unsupported");
    if (!existsSync(this.workerScript)) return unavailable("missing_worker");
    // Node credential worker is always available if the script exists
    return {
      supported: true,
      platform: "win32",
      dpapi_available: true,
      cred_manager_available: true,
      named_mutex_available: true,
      version: "3.0.0-node",
    };
  }
  private async ensureDaemon(): Promise<void> {
    if (this.child) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if (!(await this.capabilities()).supported)
        throw new Error("auth_host_capability_unavailable");

      // Spawn Node credential worker as isolated subprocess
      // Uses process.execPath (node) to run the worker script
      const isTypeScript = this.workerScript.endsWith(".ts");
      const child = isTypeScript
        ? spawn("node", ["--import", "tsx", this.workerScript], {
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
          })
        : spawn(process.execPath, [this.workerScript], {
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
          });
      this.child = child;
      const pipeError = () => this.disconnected(new Error("auth_host_disconnected"), child);
      child.stdin.on("error", pipeError);
      child.stdout.on("error", pipeError);
      child.stderr.on("error", pipeError);
      const lines = createInterface({ input: child.stdout });
      lines.on("error", pipeError);
      lines.on("line", (line) => {
        if (this.child !== child) return;
        if (line.length > 65536) {
          child.kill();
          this.disconnected(new Error("auth_host_invalid_response"), child);
          return;
        }
        try {
          const response = JSON.parse(line) as {
            id?: string;
            ok?: boolean;
            data?: unknown;
            error?: string;
          };
          const item = response.id ? this.pending.get(response.id) : undefined;
          if (!item) return;
          this.pending.delete(response.id!);
          clearTimeout(item.timer);
          if (response.ok === true) item.resolve(response.data);
          else
            item.reject(
              new Error(
                typeof response.error === "string" &&
                /^[a-zA-Z0-9_ :.-]{1,200}$/.test(response.error)
                  ? response.error
                  : "auth_host_action_failed",
              ),
            );
        } catch {
          child.kill();
          this.disconnected(new Error("auth_host_invalid_response"), child);
        }
      });
      // Stderr is deliberately not forwarded into logs/HTTP.
      child.stderr.resume();
      child.once("error", () => {
        if (this.child === child)
          this.disconnected(new Error("auth_host_disconnected"), child);
      });
      child.once("exit", () => {
        lines.close();
        if (this.child === child)
          this.disconnected(new Error("auth_host_disconnected"), child);
      });
    })().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  private async call<T>(
    action: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const acquiring = action === "acquire-domain-lock";
    const jobAction = action.endsWith("-job");
    if (acquiring || jobAction) await this.ensureDaemon();
    else if (!this.isDomainLockHeld(String(args.realm_id)))
      throw new Error("domain_lock_not_held");
    const child = this.child;
    if (!child) throw new Error("auth_host_disconnected");
    const id = String(++this.counter);
    return new Promise<T>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        // An uncertain write may have reached the OS. Invalidate the whole owner.
        child.kill();
        this.disconnected(new Error("auth_host_timeout_state_unknown"), child);
      }, 15000);
      this.pending.set(id, {
        resolve: (value) => resolvePromise(value as T),
        reject,
        timer,
      });
      try { child.stdin.write(
        JSON.stringify({ id, action, args }) + "\n",
        (error) => {
          if (error) {
            child.kill();
            this.disconnected(new Error("auth_host_disconnected"), child);
          }
        },
      ); } catch { this.disconnected(new Error("auth_host_disconnected"), child); }
    });
  }
  async acquireDomainLock(realmId: string) {
    if (this.lockId) return { acquired: false, release: async () => {} };
    const result = await this.call<{ acquired: boolean; lock_id: string }>(
      "acquire-domain-lock",
      { realm_id: realmId },
    );
    if (!result.acquired || !result.lock_id)
      return { acquired: false, release: async () => {} };
    this.realm = realmId;
    this.lockId = result.lock_id;
    return {
      acquired: true,
      release: async () => {
        if (!this.isDomainLockHeld(realmId)) return;
        await this.call("release-domain-lock", {
          realm_id: realmId,
          lock_id: result.lock_id,
        });
        this.lockId = undefined;
        this.realm = undefined;
        const child = this.child;
        if (child)
          await new Promise<void>((resolvePromise) => {
            child.once("exit", () => resolvePromise());
            child.stdin.end();
          });
      },
    };
  }
  inspectActive(realmId: string) {
    return this.call<ActiveCredentialInspection>("inspect-active", {
      realm_id: realmId,
    });
  }
  async compareActive(realmId: string, secretRef: string) {
    return (
      (
        await this.call<{ matches: boolean }>("compare-active", {
          realm_id: realmId,
          secret_ref: secretRef,
        })
      ).matches === true
    );
  }
  captureActive(realmId: string, accountId: string) {
    return this.call<{
      secret_ref: string;
      credential_revision: number;
      auth?: Partial<AgyAccountAuth>;
    }>("capture-active", { realm_id: realmId, account_id: accountId });
  }
  activateSaved(realmId: string, accountId: string, secretRef: string) {
    return this.call<{ credential_revision: number }>("activate-saved", {
      realm_id: realmId,
      account_id: accountId,
      secret_ref: secretRef,
    });
  }
  async restoreBackup(realmId: string, backupRef: string) {
    await this.call("restore-backup", {
      realm_id: realmId,
      backup_ref: backupRef,
    });
  }
  async clearActiveForLogin(realmId: string) {
    const result = await this.call<{ backup_ref: string }>(
      "clear-active-for-login",
      { realm_id: realmId },
    );
    return { backupRef: result.backup_ref };
  }
  async deleteSaved(realmId: string, secretRef: string) {
    await this.call("delete-saved", {
      realm_id: realmId,
      secret_ref: secretRef,
    });
  }
}
