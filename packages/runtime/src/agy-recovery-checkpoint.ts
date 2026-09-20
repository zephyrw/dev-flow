import type { Store } from "../../store/src/store.js";
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
}
