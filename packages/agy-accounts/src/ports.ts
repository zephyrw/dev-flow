import type {
  AgyAccount,
  AgyQuotaSnapshot,
  AgyRealm,
  AgyAccountSettings,
  AgyUsagePermit,
  AgyAccountOperation,
  AgyDomainWait,
  AgyAccountAudit,
  QuotaWindow,
  AgyAccountAuth,
} from "../../contracts/src/agy-account.js";

export interface ActiveCredentialInspection {
  exists: boolean;
  username?: string;
  secret_fingerprint?: string;
  last_modified?: string;
  account_id?: string;
  secret_ref?: string;
  auth?: Partial<AgyAccountAuth>;
}

export interface AuthHostCapabilities {
  supported: boolean;
  platform: string;
  dpapi_available: boolean;
  cred_manager_available: boolean;
  named_mutex_available: boolean;
  version: string;
}

export interface AuthHostPort {
  isDomainLockHeld(realmId: string): boolean;
  compareActive(realmId: string, secretRef: string): Promise<boolean>;
  capabilities(): Promise<AuthHostCapabilities>;
  inspectActive(realmId: string): Promise<ActiveCredentialInspection>;
  captureActive(
    realmId: string,
    accountId: string,
  ): Promise<{
    secret_ref: string;
    credential_revision: number;
    auth?: Partial<AgyAccountAuth>;
  }>;
  activateSaved(
    realmId: string,
    accountId: string,
    secretRef: string,
  ): Promise<{ credential_revision: number }>;
  restoreBackup(realmId: string, backupRef: string): Promise<void>;
  clearActiveForLogin(realmId: string): Promise<{ backupRef?: string }>;
  deleteSaved(realmId: string, secretRef: string): Promise<void>;
  acquireDomainLock(
    realmId: string,
  ): Promise<{ acquired: boolean; release: () => Promise<void> }>;
}

export interface AccountProbeResult {
  email?: string;
  plan_tier?: string;
  cli_version: string;
  windows: QuotaWindow[];
  raw_output: string;
  pools: Array<{
    pool_id: string;
    model_ids: string[];
    windows: QuotaWindow[];
  }>;
  executable_fingerprint: string;
  capability_verified: boolean;
}

export interface AccountProbeOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  account_id?: string;
  credential_revision?: number;
  model_id?: string;
}

export interface AccountProbePort {
  probeUsage(options?: AccountProbeOptions): Promise<AccountProbeResult>;
  probeModelAccess(
    modelId: string,
    options?: AccountProbeOptions,
  ): Promise<boolean>;
}

export interface ManagedProcessInfo {
  pid: number;
  permit_id?: string;
  account_id?: string;
  auth_epoch?: number;
}

export interface ExternalProcessInfo {
  pid: number;
  exe_path: string;
  sid?: string;
  create_time?: number;
}

export interface ProcessHostPort {
  listManagedProcesses(realmId: string): Promise<ManagedProcessInfo[]>;
  findExternalAgyProcesses(): Promise<ExternalProcessInfo[]>;
  stopProcess(pid: number, reason: string): Promise<boolean>;
  confirmProcessesStopped(pids: number[], timeoutMs: number): Promise<boolean>;
}

export interface ConsumerOccupancy {
  consumer_id: string;
  permit_ids: string[];
  required_pool_ids: string[];
  required_model_ids?: string[];
  allowed_account_ids: string[] | null;
  can_pause: boolean;
  opaque_recovery_ref?: unknown;
}

export interface AccountCommittedEvent {
  realm_id: string;
  operation_id: string;
  account_id: string;
  auth_epoch: number;
  saved_ref?: unknown;
  outcome?: "switched" | "restored";
}

export interface AccountConsumerPort {
  listOccupancy(): Promise<ConsumerOccupancy[]>;
  prepareSwitch(operationId: string): Promise<{ savedRef: unknown }>;
  quiesce(operationId: string): Promise<void>;
  confirmStopped(operationId: string): Promise<boolean>;
  onAccountCommitted(event: AccountCommittedEvent): Promise<void>;
}

export interface ClockPort {
  now(): number;
  toISOString(): string;
}

export interface AuditPort {
  record(entry: {
    realm_id: string;
    account_id?: string;
    operation_id?: string;
    action: string;
    details?: Record<string, unknown>;
  }): void;
}
