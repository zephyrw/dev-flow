import {
  type AgyAccount,
  type AgyQuotaSnapshot,
  type AgyRealm,
  type AgyAccountSettings,
  type AgyUsagePermit,
  type AgyAccountOperation,
  type AgyDomainWait,
  type AgyAccountAudit,
  type AgyAccountPolicy,
  type AgyRecoveryBatch,
  type FinalAccountCommit,
  type AgyPendingDemand,
  type RefreshEvidence,
  AgyAccountSchema,
  AgyQuotaSnapshotSchema,
  AgyRealmSchema,
  AgyAccountSettingsSchema,
  AgyUsagePermitSchema,
  AgyAccountOperationSchema,
  AgyDomainWaitSchema,
  AgyAccountAuditSchema,
  AgyAccountPolicySchema,
  AgyPendingDemandSchema,
  AgyRecoveryBatchSchema,
  FinalAccountCommitSchema,
  RefreshEvidenceSchema,
} from "../../contracts/src/agy-account.js";
import type { Store } from "../../store/src/store.js";
import type { z } from "zod";

export class AgyAccountRepository {
  constructor(private store: Store) {}

  transaction<T>(fn: () => T): T {
    return this.store.transaction(fn);
  }
  getRecord<T>(kind: string, key: string): T | undefined {
    return this.store.get<T>(kind, key);
  }
  putRecord<T>(kind: string, key: string, owner: string, value: T): void {
    this.store.put(kind, key, owner, value);
  }
  listRealms(): AgyRealm[] {
    return this.store
      .list<unknown>("agy_realm")
      .map((r) => AgyRealmSchema.parse(r));
  }

  getRealm(realmId: string): AgyRealm | undefined {
    const raw = this.store.get<unknown>("agy_realm", realmId);
    if (!raw) return undefined;
    return AgyRealmSchema.parse(raw);
  }

  saveRealm(realm: AgyRealm): void {
    const validated = AgyRealmSchema.parse(realm);
    const current = this.getRealm(validated.realm_id);
    if (current && current.control_generation > validated.control_generation)
      throw new Error("control_generation_conflict");
    this.store.put(
      "agy_realm",
      validated.realm_id,
      validated.realm_id,
      validated,
    );
  }

  getSettings(realmId: string): AgyAccountSettings | undefined {
    const raw = this.store.get<unknown>("agy_account_settings", realmId);
    if (!raw) return undefined;
    return AgyAccountSettingsSchema.parse(raw);
  }

  saveSettings(settings: AgyAccountSettings): void {
    const validated = AgyAccountSettingsSchema.parse(settings);
    this.store.put(
      "agy_account_settings",
      validated.realm_id,
      validated.realm_id,
      validated,
    );
  }

  getAccount(realmId: string, accountId: string): AgyAccount | undefined {
    const raw = this.store.get<unknown>("agy_account", accountId);
    if (!raw) return undefined;
    const acc = AgyAccountSchema.parse(raw);
    if (acc.realm_id !== realmId) return undefined;
    return acc;
  }

  listAccounts(realmId: string): AgyAccount[] {
    const rows = this.store.list<unknown>("agy_account", realmId);
    return rows.map((r) => AgyAccountSchema.parse(r));
  }

  saveAccount(account: AgyAccount): void {
    const validated = AgyAccountSchema.parse(account);
    this.store.put("agy_account", validated.id, validated.realm_id, validated);
  }

  deleteAccount(accountId: string): void {
    this.store.remove("agy_account", accountId);
  }

  getQuotaSnapshot(
    realmId: string,
    accountId: string,
    poolId: string,
  ): AgyQuotaSnapshot | undefined {
    const key = `${accountId}:${poolId}`;
    const raw = this.store.get<unknown>("agy_quota", key);
    if (!raw) return undefined;
    const parsed = AgyQuotaSnapshotSchema.parse(raw);
    return parsed.realm_id === realmId ? parsed : undefined;
  }

  listQuotaSnapshots(realmId: string, accountId?: string): AgyQuotaSnapshot[] {
    const rows = this.store.list<unknown>("agy_quota", realmId);
    const parsed = rows.map((r) => AgyQuotaSnapshotSchema.parse(r));
    if (accountId) {
      return parsed.filter((s) => s.account_id === accountId);
    }
    return parsed;
  }

  retainQuotaPools(realmId: string, accountId: string, poolIds: string[]): void {
    const allowed = new Set(poolIds);
    for (const snapshot of this.listQuotaSnapshots(realmId, accountId)) {
      if (!allowed.has(snapshot.pool_id)) {
        this.store.remove("agy_quota", accountId + ":" + snapshot.pool_id);
      }
    }
  }

  saveQuotaSnapshot(snapshot: z.input<typeof AgyQuotaSnapshotSchema>): void {
    const validated = AgyQuotaSnapshotSchema.parse(snapshot);
    const key = `${validated.account_id}:${validated.pool_id}`;
    this.transaction(() => {
      const current = this.store.get<AgyQuotaSnapshot>("agy_quota", key);
      const realm = this.getRealm(validated.realm_id);
      if (realm && validated.auth_epoch !== realm.auth_epoch) return;
      if (
        current &&
        (current.auth_epoch > validated.auth_epoch ||
          Date.parse(current.observed_at) > Date.parse(validated.observed_at))
      )
        return;
      this.store.put("agy_quota", key, validated.realm_id, validated);
      this.store.put(
        "agy_quota_history",
        validated.id,
        validated.account_id,
        validated,
      );
    });
    this.pruneHistory(validated.account_id, validated.pool_id);
  }

  private pruneHistory(accountId: string, poolId: string): void {
    const allHistory = this.store
      .list<AgyQuotaSnapshot>("agy_quota_history", accountId)
      .filter((s) => s.pool_id === poolId);
    const cutoff = Date.now() - 90 * 24 * 3600_000;
    const latest = this.store.get<AgyQuotaSnapshot>(
      "agy_quota",
      `${accountId}:${poolId}`,
    )?.id;
    for (const s of allHistory) {
      if (s.id !== latest && Date.parse(s.observed_at) < cutoff)
        this.store.remove("agy_quota_history", s.id);
    }
    if (allHistory.length > 1000) {
      const sorted = allHistory.sort(
        (a, b) =>
          new Date(b.observed_at).getTime() - new Date(a.observed_at).getTime(),
      );
      const toDelete = sorted.slice(1000);
      for (const item of toDelete) {
        this.store.remove("agy_quota_history", item.id);
      }
    }
  }

  listQuotaHistory(accountId: string, limit = 100): AgyQuotaSnapshot[] {
    const all = this.store.list<AgyQuotaSnapshot>(
      "agy_quota_history",
      accountId,
    );
    return all
      .sort(
        (a, b) =>
          new Date(b.observed_at).getTime() - new Date(a.observed_at).getTime(),
      )
      .slice(0, limit);
  }

  getOperation(operationId: string): AgyAccountOperation | undefined {
    const raw = this.store.get<unknown>("agy_account_operation", operationId);
    if (!raw) return undefined;
    return AgyAccountOperationSchema.parse(raw);
  }

  listOperations(realmId: string): AgyAccountOperation[] {
    const rows = this.store.list<unknown>("agy_account_operation", realmId);
    return rows.map((r) => AgyAccountOperationSchema.parse(r));
  }

  saveOperation(op: z.input<typeof AgyAccountOperationSchema>): void {
    const validated = AgyAccountOperationSchema.parse(op);
    this.store.put(
      "agy_account_operation",
      validated.operation_id,
      validated.realm_id,
      validated,
    );
  }

  getDomainWait(realmId: string): AgyDomainWait | undefined {
    const raw = this.store.get<unknown>("agy_domain_wait", realmId);
    if (!raw) return undefined;
    return AgyDomainWaitSchema.parse(raw);
  }

  saveDomainWait(wait: AgyDomainWait): void {
    const validated = AgyDomainWaitSchema.parse(wait);
    this.store.put(
      "agy_domain_wait",
      validated.realm_id,
      validated.realm_id,
      validated,
    );
  }

  clearDomainWait(realmId: string): void {
    this.store.remove("agy_domain_wait", realmId);
  }

  getPermit(permitId: string): AgyUsagePermit | undefined {
    const raw = this.store.get<unknown>("agy_usage", permitId);
    if (!raw) return undefined;
    return AgyUsagePermitSchema.parse(raw);
  }

  listPermits(realmId: string): AgyUsagePermit[] {
    const rows = this.store.list<unknown>("agy_usage", realmId);
    return rows.map((r) => AgyUsagePermitSchema.parse(r));
  }

  savePermit(permit: AgyUsagePermit): void {
    const validated = AgyUsagePermitSchema.parse(permit);
    this.store.put(
      "agy_usage",
      validated.permit_id,
      validated.realm_id,
      validated,
    );
  }

  saveAudit(audit: AgyAccountAudit): void {
    const validated = AgyAccountAuditSchema.parse(audit);
    this.store.put(
      "agy_account_audit",
      validated.audit_id,
      validated.realm_id,
      validated,
    );
  }

  listAudits(realmId: string, limit = 100): AgyAccountAudit[] {
    const rows = this.store.list<unknown>("agy_account_audit", realmId);
    return rows
      .map((r) => AgyAccountAuditSchema.parse(r))
      .sort((a, b) => b.event_seq - a.event_seq)
      .slice(0, limit);
  }

  getPolicy(
    workflowId: string,
    revision?: number,
  ): AgyAccountPolicy | undefined {
    const raw = this.store.get<unknown>(
      revision === undefined
        ? "agy_account_policy"
        : "agy_account_policy_revision",
      revision === undefined ? workflowId : `${workflowId}:${revision}`,
    );
    if (!raw) return undefined;
    return AgyAccountPolicySchema.parse(raw);
  }

  savePolicy(policy: AgyAccountPolicy): void {
    const validated = AgyAccountPolicySchema.parse(policy);
    this.transaction(() => {
      const key = `${validated.workflow_id}:${validated.revision}`;
      const previous = this.store.get<AgyAccountPolicy>(
        "agy_account_policy_revision",
        key,
      );
      if (previous && JSON.stringify(previous) !== JSON.stringify(validated))
        throw new Error("policy_revision_conflict");
      this.store.put(
        "agy_account_policy_revision",
        key,
        validated.workflow_id,
        validated,
      );
      this.store.put(
        "agy_account_policy",
        validated.workflow_id,
        validated.workflow_id,
        validated,
      );
    });
  }

  getDemand(demandId: string): AgyPendingDemand | undefined {
    const raw = this.store.get<unknown>("agy_pending_demand", demandId);
    if (!raw) return undefined;
    return AgyPendingDemandSchema.parse(raw);
  }

  listDemands(owner = "default"): AgyPendingDemand[] {
    const rows = this.store.list<unknown>("agy_pending_demand", owner);
    return rows.map((r) => AgyPendingDemandSchema.parse(r));
  }

  saveDemand(demand: AgyPendingDemand, owner = "default"): void {
    const validated = AgyPendingDemandSchema.parse(demand);
    this.store.put("agy_pending_demand", validated.demand_id, owner, validated);
  }

  deleteDemand(demandId: string): void {
    this.store.remove("agy_pending_demand", demandId);
  }

  getRecoveryBatch(batchId: string): AgyRecoveryBatch | undefined {
    const raw = this.store.get<unknown>("agy_recovery_batch", batchId);
    if (!raw) return undefined;
    return AgyRecoveryBatchSchema.parse(raw);
  }

  listRecoveryBatches(owner = "default"): AgyRecoveryBatch[] {
    const rows = this.store.list<unknown>("agy_recovery_batch", owner);
    return rows.map((r) => AgyRecoveryBatchSchema.parse(r));
  }

  saveRecoveryBatch(batch: AgyRecoveryBatch, owner = "default"): void {
    const validated = AgyRecoveryBatchSchema.parse(batch);
    this.store.put("agy_recovery_batch", validated.batch_id, owner, validated);
  }

  getFinalAccountCommit(operationId: string): FinalAccountCommit | undefined {
    const raw = this.store.get<unknown>("agy_final_account_commit", operationId);
    if (!raw) return undefined;
    return FinalAccountCommitSchema.parse(raw);
  }

  saveFinalAccountCommit(commit: FinalAccountCommit): void {
    const validated = FinalAccountCommitSchema.parse(commit);
    this.store.put("agy_final_account_commit", validated.operation_id, validated.realm_id, validated);
  }

  saveRefreshEvidence(evidence: RefreshEvidence): void {
    const validated = RefreshEvidenceSchema.parse(evidence);
    this.store.put("agy_refresh_evidence", validated.evidence_id, validated.realm_id, validated);
  }

  listRefreshEvidences(realmId: string, accountId?: string): RefreshEvidence[] {
    const rows = this.store.list<unknown>("agy_refresh_evidence", realmId);
    const list = rows.map((r) => RefreshEvidenceSchema.parse(r));
    if (!accountId) return list;
    return list.filter((e) => e.account_id === accountId);
  }

  getLatestRefreshEvidence(realmId: string, accountId: string): RefreshEvidence | undefined {
    const list = this.listRefreshEvidences(realmId, accountId);
    if (!list.length) return undefined;
    list.sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at));
    return list[0];
  }
}
