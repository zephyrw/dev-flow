import { AgyAccountRepository } from "../../../packages/agy-accounts/src/repository.js";
import { AgyAccountService } from "../../../packages/agy-accounts/src/service.js";
import type { Store } from "../../../packages/store/src/store.js";
import type {
  AuthHostPort,
  AccountProbePort,
  ProcessHostPort,
  ExternalProcessInfo,
} from "../../../packages/agy-accounts/src/ports.js";
import {
  AgyAccountSchema,
  AgyQuotaSnapshotSchema,
} from "../../../packages/contracts/src/agy-account.js";
export function accountFixture(store: Store) {
  const repository = new AgyAccountRepository(store);
  let held = false;
  let active = "a";
  let credentialRevision = 1;
  let calls = 0;
  const vault = new Map<string, string>([
    ["saved-a", "a"],
    ["saved-b", "b"],
    ["saved-c", "c"],
  ]);
  let external: ExternalProcessInfo[] = [];
  const authHost: AuthHostPort = {
    capabilities: async () => ({
      supported: true,
      platform: "win32",
      dpapi_available: true,
      cred_manager_available: true,
      named_mutex_available: true,
      version: "2.0.0",
    }),
    isDomainLockHeld: () => held,
    acquireDomainLock: async () => {
      held = true;
      return {
        acquired: true,
        release: async () => {
          held = false;
        },
      };
    },
    compareActive: async (_realm, ref) => vault.get(ref) === active,
    inspectActive: async () => ({
      exists: !!active,
      account_id: active,
      secret_ref: `saved-${active}`,
    }),
    captureActive: async () => {
      const ref = `capture-${credentialRevision++}`;
      vault.set(ref, active);
      return {
        secret_ref: ref,
        credential_revision: credentialRevision,
        auth: {
          has_refresh_credential: true,
          refresh_expiry_source: "not_provided",
        },
      };
    },
    activateSaved: async (_realm, _account, ref) => {
      const identity = vault.get(ref);
      if (!identity) throw new Error("fixture reference missing");
      active = identity;
      return { credential_revision: credentialRevision++ };
    },
    restoreBackup: async (_realm, ref) => {
      active = vault.get(ref) ?? "";
    },
    clearActiveForLogin: async () => {
      const ref = `backup-${credentialRevision++}`;
      vault.set(ref, active);
      active = "";
      return { backupRef: ref };
    },
    deleteSaved: async (_realm, ref) => {
      vault.delete(ref);
    },
  };
  const windows = (weekly: number) => [
    {
      kind: "weekly" as const,
      duration_minutes: 10080 as const,
      remaining_fraction: weekly,
      reset_at: new Date(Date.now() + 86400000).toISOString(),
      observed_at: new Date().toISOString(),
      status: "observed" as const,
    },
    {
      kind: "five_hour" as const,
      duration_minutes: 300 as const,
      remaining_fraction: 0.7,
      reset_at: new Date(Date.now() + 3600000).toISOString(),
      observed_at: new Date().toISOString(),
      status: "observed" as const,
    },
  ];
  const probe: AccountProbePort = {
    probeUsage: async () => {
      calls++;
      const observed = windows(active === "b" ? 0.9 : 0.5);
      return {
        email: `${active}@example.com`,
        cli_version: "2.0.0",
        windows: observed,
        raw_output: "",
        pools: [
          {
            pool_id: "fixture-pool",
            model_ids: ["fixture-model"],
            windows: observed,
          },
        ],
        executable_fingerprint: "fixture-fingerprint",
        capability_verified: true,
      };
    },
    probeModelAccess: async () => true,
  };
  const processHost: ProcessHostPort = {
    listManagedProcesses: async () => [],
    findExternalAgyProcesses: async () => external,
    stopProcess: async () => true,
    confirmProcessesStopped: async () => true,
  };
  const service = new AgyAccountService(
    repository,
    authHost,
    probe,
    processHost,
  );
  service.initializeSettings("default-agy-realm", {
    standalone_model_id: "fixture-model",
    switch_gap_seconds: 1,
  });
  function seedAccounts() {
    const now = new Date().toISOString();
    for (const id of ["a", "b", "c"]) {
      repository.saveAccount(
        AgyAccountSchema.parse({
          id,
          realm_id: "default-agy-realm",
          alias: `Account ${id.toUpperCase()}`,
          identity: { email: `${id}@example.com`, verified_at: now },
          secret_ref: `saved-${id}`,
          credential_revision: 1,
          state: "ready",
          enrolled_at: now,
          enrollment_completed_at: now,
          auth: {
            has_refresh_credential: true,
            refresh_expiry_source: "not_provided",
            last_refresh_verified_at: now,
          },
        }),
      );
      repository.saveQuotaSnapshot(
        AgyQuotaSnapshotSchema.parse({
          id: `snapshot-${id}`,
          realm_id: "default-agy-realm",
          account_id: id,
          auth_epoch: 1,
          pool_id: "fixture-pool",
          model_ids: ["fixture-model"],
          source: "official_cli_usage",
          cli_version: "2.0.0",
          parser_revision: 1,
          capability_verified: true,
          executable_fingerprint: "fixture-fingerprint",
          observed_at: now,
          windows: windows(id === "b" ? 0.9 : 0.5),
        }),
      );
    }
  }
  return {
    service,
    repository,
    seedAccounts,
    authHost,
    probe,
    processHost,
    probeCalls: () => calls,
    setExternal: (value: ExternalProcessInfo[]) => {
      external = value;
    },
    active: () => active,
  };
}
