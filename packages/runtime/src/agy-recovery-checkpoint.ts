import type { Store } from "../../store/src/store.js";
import type {
  AgySourceCheckpoint,
  AgyRecoveryManifest,
  AgyRecoveryProgress,
} from "../../contracts/src/agy-recovery.js";
import {
  AgySourceCheckpointSchema,
  AgyRecoveryManifestSchema,
  AgyRecoveryProgressSchema,
} from "../../contracts/src/agy-recovery.js";

export interface SubagentRecord {
  logical_id: string;
  parent_id?: string;
  native_session_id?: string;
  role: string;
  prompt: string;
  status: "completed" | "cancelled" | "interrupted" | "unknown";
  workspace_checkpoint_ref?: string;
  created_at: string;
  completed_at?: string;
}

export interface AgyRecoveryCheckpoint {
  recovery_id: string;
  workflow_id: string;
  source_run_id: string;
  source_account_id: string;
  source_auth_epoch: number;
  reason: "account_switch";
  root_purpose: string;
  root_conversation_id?: string;
  effective_model_id: string;
  workflow_version?: number;
  plan_revision?: number;
  plan_hash?: string;
  profile_id?: string;
  account_policy_revision?: number;
  subagents: SubagentRecord[];
  created_at: string;
}

export class AgyRecoveryCheckpointManager {
  constructor(private store: Store) {}

  createCheckpoint(data: AgyRecoveryCheckpoint): void {
    const prior = this.getCheckpoint(data.recovery_id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(data))
      throw new Error("AGY_RECOVERY_CHECKPOINT_CONFLICT");
    this.store.put(
      "agy_recovery_checkpoint",
      data.recovery_id,
      data.workflow_id,
      data,
    );
  }

  getCheckpoint(recoveryId: string): AgyRecoveryCheckpoint | undefined {
    return this.store.get<AgyRecoveryCheckpoint>(
      "agy_recovery_checkpoint",
      recoveryId,
    );
  }

  saveSourceCheckpoint(checkpoint: AgySourceCheckpoint): void {
    const validated = AgySourceCheckpointSchema.parse(checkpoint);
    const prior = this.getSourceCheckpoint(validated.checkpoint_id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(validated)) {
      throw new Error("SOURCE_CHECKPOINT_IMMUTABLE_CONFLICT");
    }
    this.store.put(
      "agy_source_checkpoint",
      validated.checkpoint_id,
      validated.workflow_id,
      validated,
    );
  }

  getSourceCheckpoint(checkpointId: string): AgySourceCheckpoint | undefined {
    const raw = this.store.get<unknown>("agy_source_checkpoint", checkpointId);
    if (!raw) return undefined;
    return AgySourceCheckpointSchema.parse(raw);
  }

  saveRecoveryManifest(manifest: AgyRecoveryManifest): void {
    const validated = AgyRecoveryManifestSchema.parse(manifest);
    const prior = this.getRecoveryManifest(validated.manifest_id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(validated)) {
      throw new Error("RECOVERY_MANIFEST_IMMUTABLE_CONFLICT");
    }
    this.store.put(
      "agy_recovery_manifest",
      validated.manifest_id,
      validated.operation_id,
      validated,
    );
  }

  getRecoveryManifest(manifestId: string): AgyRecoveryManifest | undefined {
    const raw = this.store.get<unknown>("agy_recovery_manifest", manifestId);
    if (!raw) return undefined;
    return AgyRecoveryManifestSchema.parse(raw);
  }

  saveRecoveryProgress(progress: AgyRecoveryProgress, workflowId?: string): void {
    const validated = AgyRecoveryProgressSchema.parse(progress);
    this.store.put(
      "agy_recovery_progress",
      validated.recovery_id,
      validated.operation_id,
      validated,
    );
    if (workflowId) {
      this.store.put(
        "agy_recovery_workflow_index",
        validated.recovery_id,
        workflowId,
        {
          recovery_id: validated.recovery_id,
          workflow_id: workflowId,
          operation_id: validated.operation_id,
        },
      );
      // 同时兼容旧视图读取键
      this.store.put(
        "agy_recovery_progress_by_workflow",
        validated.recovery_id,
        workflowId,
        { ...validated, workflow_id: workflowId },
      );
    }
  }

  getRecoveryProgress(recoveryId: string): AgyRecoveryProgress | undefined {
    const raw = this.store.get<unknown>("agy_recovery_progress", recoveryId);
    if (!raw) return undefined;
    return AgyRecoveryProgressSchema.parse(raw);
  }

  listRecoveryProgress(operationId?: string): AgyRecoveryProgress[] {
    const owner = operationId ?? "default";
    const rows = this.store.list<unknown>("agy_recovery_progress", owner);
    return rows.map((r) => AgyRecoveryProgressSchema.parse(r));
  }

  listRecoveryProgressForWorkflow(workflowId: string): Array<AgyRecoveryProgress & { workflow_id: string }> {
    const progressMap = new Map<string, AgyRecoveryProgress & { workflow_id: string }>();

    // 1. 从索引表读取 canonical progress
    const indexRows = this.store.list<{ recovery_id: string; workflow_id: string }>(
      "agy_recovery_workflow_index",
      workflowId,
    );
    for (const row of indexRows) {
      const canonical = this.getRecoveryProgress(row.recovery_id);
      if (canonical) {
        progressMap.set(canonical.recovery_id, { ...canonical, workflow_id: workflowId });
      }
    }

    // 2. 从兼容表读取
    const legacyDirect = this.store.list<unknown>("agy_recovery_progress_by_workflow", workflowId);
    for (const raw of legacyDirect) {
      const parsed = raw as AgyRecoveryProgress & { workflow_id: string };
      if (parsed?.recovery_id && !progressMap.has(parsed.recovery_id)) {
        const canonical = this.getRecoveryProgress(parsed.recovery_id);
        progressMap.set(parsed.recovery_id, {
          ...(canonical ?? parsed),
          workflow_id: workflowId,
        });
      }
    }

    // 3. 补齐扫描：通过 source checkpoint 真实关联反查，杜绝部分索引漏项 (CR27/R2-D10 修复)
    const sourceCheckpoints = this.store.list<unknown>("agy_source_checkpoint", workflowId);
    for (const rawSrc of sourceCheckpoints) {
      const src = AgySourceCheckpointSchema.parse(rawSrc);
      // 遍历所有 manifest 查找真实关联
      const allManifests = this.store.list<unknown>("agy_recovery_manifest");
      for (const rawM of allManifests) {
        try {
          const m = AgyRecoveryManifestSchema.parse(rawM);
          if (m.source_checkpoint_id === src.checkpoint_id || m.source_run_id === src.source_run_id) {
            const canonicalList = this.listRecoveryProgress(m.operation_id);
            for (const p of canonicalList) {
              if (p.manifest_id === m.manifest_id || p.source_run_id === src.source_run_id) {
                if (!progressMap.has(p.recovery_id)) {
                  progressMap.set(p.recovery_id, { ...p, workflow_id: workflowId });
                }
              }
            }
          }
        } catch {}
      }
    }

    return Array.from(progressMap.values()).sort(
      (a, b) => (Date.parse(b.started_at ?? "") || 0) - (Date.parse(a.started_at ?? "") || 0),
    );
  }
}
