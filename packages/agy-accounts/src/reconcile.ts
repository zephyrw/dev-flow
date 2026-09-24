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

    // desired_enabled=false 现场处理 (AGF-D06, CR11)
    if (!realm.desired_enabled) {
      if (!realm.pending_operation_id) {
        realm.phase = "stopped";
        realm.revision++;
        this.repository.saveRealm(realm);
        return;
      }
      // cleanup_only 模式：只收尾回滚或结算取消，不准入、不选号
      const op = this.repository.getOperation(realm.pending_operation_id);
      if (op && !["completed", "cancelled", "failed"].includes(op.phase)) {
        // 先确认受管进程与外部进程已停止，未停止时不得动凭据 (Q08)
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
          realm.service_state = "blocked";
          realm.revision++;
          this.repository.saveRealm(realm);
          return;
        }

        if (op.before_secret_ref) {
          // 检查凭据归属：必须匹配当前操作相关的凭据引用，外部已改动时禁止覆盖 (Q08)
          let matched = false;
          for (const ref of [
            op.before_secret_ref,
            op.installed_secret_ref,
            op.install_target_ref,
          ]) {
            if (ref && (await this.authHost.compareActive(realmId, ref))) {
              matched = true;
              break;
            }
          }
          if (!matched) {
            op.phase = "blocked";
            op.error = "external_change";
            op.revision++;
            this.repository.saveOperation(op);
            realm.phase = "blocked";
            realm.service_state = "blocked";
            realm.revision++;
            this.repository.saveRealm(realm);
            return;
          }

          const alreadyBefore = await this.authHost.compareActive(realmId, op.before_secret_ref);
          if (!alreadyBefore) {
            try {
              await this.authHost.restoreBackup(realmId, op.before_secret_ref);
              const matches = await this.authHost.compareActive(realmId, op.before_secret_ref);
              if (!matches) {
                op.phase = "blocked";
                op.error = "rollback_verification_failed";
                op.revision++;
                this.repository.saveOperation(op);
                realm.phase = "blocked";
                realm.service_state = "blocked";
                realm.revision++;
                this.repository.saveRealm(realm);
                return;
              }
              // 实际备份恢复成功后再更新活动账号/epoch (Q08)
              realm.auth_epoch = Math.max(realm.auth_epoch, op.install_epoch ?? 0) + 1;
              realm.active_account_id = op.before_account_id ?? null;
              realm.active_secret_ref = op.before_secret_ref;
            } catch {
              op.phase = "blocked";
              op.error = "cleanup_rollback_failed";
              op.revision++;
              this.repository.saveOperation(op);
              realm.phase = "blocked";
              realm.service_state = "blocked";
              realm.revision++;
              this.repository.saveRealm(realm);
              return;
            }
          }
        }
        op.phase = "cancelled";
        op.error = "cleaned_up_on_shutdown";
        op.revision++;
        this.repository.saveOperation(op);
      }
      realm.pending_operation_id = null;
      realm.phase = "stopped";
      realm.revision++;
      this.repository.saveRealm(realm);
      return;
    }

    if (!realm.pending_operation_id) return;
    const op = this.repository.getOperation(realm.pending_operation_id);
    if (!op || ["completed", "cancelled", "failed", "blocked"].includes(op.phase) ||
        (op.deadline_at && new Date(op.deadline_at).getTime() < Date.now())) {
      if (op && !["completed", "cancelled", "failed"].includes(op.phase)) {
        op.phase = "cancelled";
        op.error = op.error ?? "operation_cancelled_on_startup_reconcile";
        op.revision++;
        this.repository.saveOperation(op);
      }
      realm.pending_operation_id = null;
      realm.phase = "idle";
      realm.revision++;
      this.repository.saveRealm(realm);
      return;
    }

    // committed/recovering 对账：核验活动项与旧进程 (AGF-D06 / R10)
    if (["committed", "recovering"].includes(op.phase)) {
      const finalCommit = this.repository.getFinalAccountCommit(op.operation_id);
      const targetRef =
        finalCommit?.secret_ref ??
        (op.result?.outcome === "restored"
          ? op.before_secret_ref
          : (op.installed_secret_ref ?? op.install_target_ref));
      if (targetRef) {
        const matchesTarget = await this.authHost.compareActive(realmId, targetRef);
        if (!matchesTarget) {
          op.phase = "blocked";
          op.error = "external_change";
          op.revision++;
          this.repository.saveOperation(op);
          realm.phase = "blocked";
          realm.service_state = "blocked";
          realm.revision++;
          this.repository.saveRealm(realm);
          return;
        }
      }
      // 保持 committed/recovering，供后续补投递
      return;
    }
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
      realm.service_state = "blocked";
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
      realm.service_state = "blocked";
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
