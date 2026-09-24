import type { FastifyInstance, FastifyRequest } from "fastify";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { hash } from "../../../../packages/core/src/util.js";
import {
  beginMaintenanceMarker,
  clearMaintenanceMarker,
  isMaintenanceMarkerExpired,
  readMaintenanceMarker,
  updateMaintenanceMarker,
} from "../../../../packages/installer/src/transaction.js";
// inspectQuiesceState lives in upgrade.js (process/lease inspection).
import { inspectQuiesceState as inspectSqlite } from "../../../../packages/installer/src/upgrade.js";

export interface MaintenanceRouteOptions {
  human: (request: FastifyRequest) => void;
  storageRoot: string;
  storageInstance?: string;
  /** Optional hook so Stream E can pause the real scheduler. */
  onQuiesce?: (mode: "wait" | "pause-and-update") => Promise<void>;
  onPrepare?: (body: { transaction_id?: string; target_version?: string }) => Promise<void> | void;
}

const prepareBody = z.object({
  transaction_id: z.string().optional(),
  target_version: z.string().optional(),
  kind: z.enum(["install", "upgrade"]).optional(),
});

const quiesceBody = z.object({
  on_active_tasks: z.enum(["wait", "pause-and-update"]),
  transaction_id: z.string().optional(),
});

/**
 * §7.2 / 协调约定第 5 条: /api/maintenance/prepare|status|quiesce.
 * Reuses human/origin/CSRF protection from base-server. Never bypasses auth.
 */
export function registerMaintenanceRoutes(
  app: FastifyInstance,
  options: MaintenanceRouteOptions,
): void {
  const storageRoot = options.storageRoot;

  app.get("/api/maintenance/status", async (req) => {
    options.human(req);
    const marker = readMaintenanceMarker(storageRoot);
    const sqlitePath = join(storageRoot, "devflow.sqlite");
    const inspection = existsSync(sqlitePath)
      ? await inspectSqlite(sqlitePath)
      : {
          active_leases: 0,
          running_processes: 0,
          unknown_processes: 0,
          confirmed_exited: 0,
          can_quiesce: true,
          blockers: [] as string[],
        };
    return {
      ok: true,
      maintenance_active: !!marker,
      marker: marker
        ? {
            transaction_id: marker.transaction_id,
            kind: marker.kind,
            phase: marker.phase,
            target_version: marker.target_version,
            created_at: marker.created_at,
            updated_at: marker.updated_at,
            expires_at: marker.expires_at,
            expired: isMaintenanceMarkerExpired(marker),
            block_new_dispatch: marker.block_new_dispatch,
            on_active_tasks: marker.on_active_tasks,
            pause_requested: marker.pause_requested,
          }
        : null,
      quiesce: {
        can_quiesce: inspection.can_quiesce,
        active_leases: inspection.active_leases,
        running_processes: inspection.running_processes,
        unknown_processes: inspection.unknown_processes,
        blockers: inspection.blockers,
      },
    };
  });

  app.post("/api/maintenance/prepare", async (req) => {
    options.human(req);
    const body = prepareBody.parse(req.body ?? {});
    if (options.onPrepare) await options.onPrepare(body);
    const transaction_id = body.transaction_id ?? "unspecified";
    const existing = readMaintenanceMarker(storageRoot);
    if (existing) {
      updateMaintenanceMarker(storageRoot, {
        block_new_dispatch: true,
        phase: "requested",
        target_version: body.target_version ?? existing.target_version,
      });
    } else {
      beginMaintenanceMarker({
        storageRoot,
        transaction_id,
        kind: body.kind ?? "upgrade",
        target_version: body.target_version,
      });
    }
    return {
      ok: true,
      transaction_id,
      block_new_dispatch: true,
    };
  });

  app.post("/api/maintenance/quiesce", async (req) => {
    options.human(req);
    const body = quiesceBody.parse(req.body ?? {});
    const marker = readMaintenanceMarker(storageRoot);
    if (!marker) {
      const transaction_id = body.transaction_id ?? "unspecified";
      beginMaintenanceMarker({
        storageRoot,
        transaction_id,
        kind: "upgrade",
        on_active_tasks: body.on_active_tasks,
      });
    } else {
      updateMaintenanceMarker(storageRoot, {
        block_new_dispatch: true,
        on_active_tasks: body.on_active_tasks,
        pause_requested: body.on_active_tasks === "pause-and-update",
        phase: "waiting_for_idle",
      });
    }
    if (options.onQuiesce) await options.onQuiesce(body.on_active_tasks);
    const sqlitePath = join(storageRoot, "devflow.sqlite");
    const inspection = await inspectSqlite(sqlitePath);
    return {
      ok: true,
      on_active_tasks: body.on_active_tasks,
      can_quiesce: inspection.can_quiesce,
      blockers: inspection.blockers,
    };
  });

  // Explicit maintenance end (recovery / successful handover cleanup).
  app.delete("/api/maintenance/status", async (req) => {
    options.human(req);
    clearMaintenanceMarker(storageRoot);
    return { ok: true, maintenance_active: false };
  });
}

export function maintenanceInstanceKey(storageInstance?: string): string {
  return hash((storageInstance ?? ".devflow").toLowerCase());
}
