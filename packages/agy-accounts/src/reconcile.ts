import type { AgyAccountRepository } from "./repository.js";
import type {
  AuthHostPort,
  AccountProbePort,
  ProcessHostPort,
} from "./ports.js";

export class AgyReconciler {
  constructor(
    private repository: AgyAccountRepository,
    private authHost: AuthHostPort,
    private probe: AccountProbePort,
    private processHost: ProcessHostPort,
  ) {}

  async reconcileStartup(realmId: string): Promise<void> {
    const realm = this.repository.getRealm(realmId);
    if (!realm) return;

    if (!this.authHost.isDomainLockHeld(realmId))
      throw new Error("domain_lock_lost");
    if (!realm.pending_operation_id) return;
    const op = this.repository.getOperation(realm.pending_operation_id);
    if (!op) throw new Error("operation_journal_missing");
    if (["completed", "cancelled", "failed"].includes(op.phase)) {
      realm.pending_operation_id = null;
      realm.phase = "idle";
      realm.revision++;
      this.repository.saveRealm(realm);
      return;
    }
    if (["committed", "recovering"].includes(op.phase)) return; // Delivery is durable and must not switch again.
    const managed = await this.processHost.listManagedProcesses(realmId);
    if (
      (await this.processHost.findExternalAgyProcesses()).length ||
      (managed.length &&
        !(await this.processHost.confirmProcessesStopped(
          managed.map((p) => p.pid),
          30_000,
        )))
    ) {
      op.phase = "blocked";
      op.error = "process_state_unconfirmed";
      op.revision++;
      this.repository.saveOperation(op);
      realm.phase = "blocked";
      realm.revision++;
      this.repository.saveRealm(realm);
      return;
    }
    if (!op.before_secret_ref) {
      if (
        ["queued", "waiting_external_exit", "quiescing", "capturing"].includes(
          op.phase,
        )
      ) {
        op.phase = "queued";
        op.revision++;
        this.repository.saveOperation(op);
        return;
      }
      throw new Error("operation_backup_missing");
    }
    let matched = false;
    for (const ref of [
      op.before_secret_ref,
      op.installed_secret_ref,
      op.install_target_ref,
    ])
      if (ref && (await this.authHost.compareActive(realmId, ref))) {
        matched = true;
        break;
      }
    if (!matched) {
      op.phase = "blocked";
      op.error = "external_change";
      op.revision++;
      this.repository.saveOperation(op);
      realm.phase = "blocked";
      realm.revision++;
      this.repository.saveRealm(realm);
      return;
    }
    if (!(await this.authHost.compareActive(realmId, op.before_secret_ref))) {
      op.phase = "rollback_required";
      op.revision++;
      this.repository.saveOperation(op);
      await this.authHost.restoreBackup(realmId, op.before_secret_ref);
      if (!(await this.authHost.compareActive(realmId, op.before_secret_ref)))
        throw new Error("rollback_verification_failed");
      realm.auth_epoch = Math.max(realm.auth_epoch, op.install_epoch ?? 0) + 1;
    }
    realm.active_account_id = op.before_account_id ?? null;
    realm.active_secret_ref = op.before_secret_ref;
    realm.phase = "queued";
    realm.revision++;
    this.repository.saveRealm(realm);
    op.phase = "queued";
    op.before_auth_epoch = realm.auth_epoch;
    op.installed_secret_ref = undefined;
    op.install_target_ref = undefined;
    op.attempted_account_ids = [];
    op.candidate_results = [];
    op.revision++;
    this.repository.saveOperation(op);
  }
}
