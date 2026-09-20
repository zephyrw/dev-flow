import type { AgyRecoveryCheckpoint } from "./agy-recovery-checkpoint.js";
import type { AccountCommittedEvent } from "../../agy-accounts/src/index.js";
import type { ActiveManagedRun } from "./agy-workflow-bridge.js";

export interface RecoveryPlan {
  recovery_id: string;
  workflow_id: string;
  target_account_id: string;
  target_auth_epoch: number;
  tasks_to_resume: string[];
}

export class AgyWorkflowRecoveryCoordinator {
  async planRecovery(
    event: AccountCommittedEvent,
    affectedRuns: ActiveManagedRun[],
  ): Promise<RecoveryPlan[]> {
    const plans: RecoveryPlan[] = [];
    for (const run of affectedRuns) {
      plans.push({
        recovery_id: `rec_${run.run_id}_${event.auth_epoch}`,
        workflow_id: run.workflow_id,
        target_account_id: event.account_id,
        target_auth_epoch: event.auth_epoch,
        tasks_to_resume: [run.run_id],
      });
    }
    return plans;
  }
}
