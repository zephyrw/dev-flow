import { dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ProcessManager,
  type ManagedProcess,
} from "../../process/src/manager.js";
import type {
  AuthHostPort,
  AuthHostCapabilities,
  ActiveCredentialInspection,
} from "./ports.js";
import type { AgyAccountAuth } from "../../contracts/src/agy-account.js";

const AuthSchema = z
  .object({
    has_refresh_credential: z.boolean().nullable().optional(),
    metadata_status: z
      .enum(["verified", "unverified", "unrecognized"])
      .optional(),
    access_expires_at: z.string().datetime().optional(),
    refresh_expires_at: z.string().datetime().optional(),
    refresh_expiry_source: z
      .enum(["not_provided", "provider_reported"])
      .optional(),
    email: z.string().optional(),
    subject: z.string().optional(),
  })
  .strict();
const ref = z.string().regex(/^(sec|bak)_[a-f0-9]{32}$/);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const capabilitiesSchema = z
  .object({
    supported: z.boolean(),
    platform: z.string(),
    dpapi_available: z.boolean(),
    cred_manager_available: z.boolean(),
    named_mutex_available: z.boolean(),
    version: z.literal("3.0.0-node"),
  })
  .strict();
const results: Record<string, z.ZodType> = {
  capabilities: capabilitiesSchema,
  "acquire-domain-lock": z
    .object({ acquired: z.boolean(), lock_id: z.string().max(36) })
    .strict()
    .refine((value) =>
      value.acquired
        ? /^[a-f0-9-]{36}$/.test(value.lock_id)
        : value.lock_id === "",
    ),
  "release-domain-lock": z.object({}).strict(),
  "inspect-active": z
    .object({
      exists: z.boolean(),
      auth: AuthSchema.optional(),
      secret_ref: ref.optional(),
      account_id: z.string().max(150).optional(),
    })
    .strict(),
  "compare-active": z.object({ matches: z.boolean() }).strict(),
  "capture-active": z
    .object({
      secret_ref: ref,
      credential_revision: revision,
      auth: AuthSchema.optional(),
    })
    .strict(),
  "activate-saved": z.object({ credential_revision: revision }).strict(),
  "restore-backup": z.object({}).strict(),
  "clear-active-for-login": z.object({ backup_ref: ref }).strict(),
  "delete-saved": z.object({}).strict(),
};
type Pending = {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  schema: z.ZodType;
};
function resolveCredentialWorker(): string {
  const candidates = [
    new URL("./credential-worker.js", import.meta.url),
    new URL(
      "../../../dist/packages/agy-accounts/src/credential-worker.js",
      import.meta.url,
    ),
  ];
  const path = candidates.map((url) => fileURLToPath(url)).find(existsSync);
  if (!path) throw new Error("credential_worker_not_built");
  return path;
}

/** The controller receives metadata only. All native credential access stays in the owned worker. */
export class DevFlowAuthHost implements AuthHostPort {
  private readonly processes = new ProcessManager();
  private child?: ManagedProcess;
  private generation?: string;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private pending = new Map<string, Pending>();
  private counter = 0;
  private acquiring = false;
  private realm?: string;
  private lockId?: string;
  private lostListeners = new Set<() => void>();
  onLockLost(listener: () => void): () => void {
    this.lostListeners.add(listener);
    return () => this.lostListeners.delete(listener);
  }
  isDomainLockHeld(realmId: string): boolean {
    return this.realm === realmId && !!this.lockId && !!this.child;
  }
  private disconnected(error: Error, child: ManagedProcess) {
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
    // Keep an unconfirmed stop as a rejected barrier; do not create a replacement owner.
    this.stopping = child.stop();
    void this.stopping.catch(() => {});
    if (held)
      for (const listener of this.lostListeners) {
        try {
          listener();
        } catch {}
      }
  }
  private response(
    id: string,
    schema: z.ZodType,
    child: ManagedProcess,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.disconnected(
            new Error("auth_host_timeout_state_unknown"),
            child,
          ),
        15000,
      );
      this.pending.set(id, { resolve, reject, timer, schema });
    });
  }
  private async ensureDaemon(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.child) return;
    this.starting = (async () => {
      await this.stopping;
      if (process.platform !== "win32")
        throw new Error("auth_host_capability_unavailable");
      const path = resolveCredentialWorker(),
        generation = randomUUID();
      const child = this.processes.start({
        id: "credential_" + generation,
        executable: process.execPath,
        args: [path, "--managed", "--generation=" + generation],
        cwd: dirname(path),
        env: {},
        timeout_ms: 0,
        keep_stdin_open: true,
      });
      this.child = child;
      this.generation = generation;
      let buffer = "";
      const ready = this.response(
        "ready",
        z
          .object({
            version: z.literal("3.0.0-node"),
            pid: z.number().int().positive(),
          })
          .strict(),
        child,
      );
      void ready.catch(() => {});
      child.on("channel_error", () =>
        this.disconnected(new Error("auth_host_disconnected"), child),
      );
      child.on("stdout", (bytes: Buffer) => {
        if (this.child !== child) return;
        buffer += bytes.toString("utf8");
        if (Buffer.byteLength(buffer) > 65536) {
          this.disconnected(new Error("auth_host_invalid_response"), child);
          return;
        }
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const result = z
              .object({
                id: z.string(),
                generation: z.literal(generation),
                ok: z.boolean(),
                data: z.unknown().optional(),
                error: z
                  .string()
                  .regex(/^[a-z_]{1,80}$/)
                  .optional(),
              })
              .strict()
              .parse(JSON.parse(line));
            const item = this.pending.get(result.id);
            if (!item) throw new Error("unexpected_response");
            // Validate before removing the waiter so malformed responses reject it too.
            const data = result.ok ? item.schema.parse(result.data) : undefined;
            this.pending.delete(result.id);
            clearTimeout(item.timer);
            if (result.ok) item.resolve(data);
            else
              item.reject(
                new Error(result.error ?? "credential_action_failed"),
              );
          } catch {
            this.disconnected(new Error("auth_host_invalid_response"), child);
            return;
          }
        }
      });
      void child.completion.then(
        () => this.disconnected(new Error("auth_host_disconnected"), child),
        () => this.disconnected(new Error("auth_host_disconnected"), child),
      );
      try {
        await Promise.all([child.ready, ready]);
      } catch (error) {
        this.disconnected(new Error("auth_host_disconnected"), child);
        throw error;
      }
    })().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  async capabilities(): Promise<AuthHostCapabilities> {
    const unavailable: AuthHostCapabilities = {
      supported: false,
      platform: process.platform,
      dpapi_available: false,
      cred_manager_available: false,
      named_mutex_available: false,
      version: "unavailable",
    };
    try {
      const result = await this.call<AuthHostCapabilities>("capabilities", {});
      return {
        ...result,
        supported:
          result.supported &&
          result.dpapi_available &&
          result.cred_manager_available &&
          result.named_mutex_available,
      };
    } catch {
      return unavailable;
    }
  }
  private async call<T>(
    action: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    if (action === "acquire-domain-lock" || action === "capabilities")
      await this.ensureDaemon();
    else if (!this.isDomainLockHeld(String(args.realm_id)))
      throw new Error("domain_lock_not_held");
    const child = this.child;
    if (!child) throw new Error("auth_host_disconnected");
    const id = String(++this.counter);
    const schema = results[action];
    if (!schema) throw new Error("invalid_action");
    const result = this.response(id, schema, child);
    try {
      child.writeStdin(
        JSON.stringify({
          id,
          generation: this.generation,
          action,
          args: { ...args, ...(this.lockId ? { lock_id: this.lockId } : {}) },
        }) + "\n",
      );
    } catch {
      this.disconnected(new Error("auth_host_disconnected"), child);
    }
    return result as Promise<T>;
  }
  async acquireDomainLock(realmId: string) {
    if (this.lockId || this.acquiring)
      return { acquired: false, release: async () => {} };
    this.acquiring = true;
    try {
      const result = await this.call<{ acquired: boolean; lock_id: string }>(
        "acquire-domain-lock",
        { realm_id: realmId },
      );
      if (!result.acquired || !/^[a-f0-9-]{36}$/.test(result.lock_id))
        return { acquired: false, release: async () => {} };
      this.realm = realmId;
      this.lockId = result.lock_id;
      const owner = this.child;
      return {
        acquired: true,
        release: async () => {
          if (
            this.child !== owner ||
            this.lockId !== result.lock_id ||
            !this.isDomainLockHeld(realmId)
          )
            return;
          await this.call("release-domain-lock", { realm_id: realmId });
          this.lockId = undefined;
          this.realm = undefined;
          // A racing reacquisition must wait until the previous process has exited.
          this.disconnected(new Error("auth_host_released"), owner!);
          await this.stopping;
        },
      };
    } finally {
      this.acquiring = false;
    }
  }
  inspectActive(realmId: string) {
    return this.call<ActiveCredentialInspection>("inspect-active", {
      realm_id: realmId,
    });
  }
  async compareActive(realmId: string, secretRef: string) {
    return (
      await this.call<{ matches: boolean }>("compare-active", {
        realm_id: realmId,
        secret_ref: secretRef,
      })
    ).matches;
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
  async close() {
    if (this.child)
      this.disconnected(new Error("auth_host_closed"), this.child);
    await this.stopping;
    await this.processes.close();
  }
}
