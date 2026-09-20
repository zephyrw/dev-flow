import type {
  AgyAccount,
  AgyQuotaSnapshot,
} from "../../contracts/src/agy-account.js";
import type { AgyAccountRepository } from "./repository.js";
import type { AuthHostPort, AccountProbePort, ClockPort } from "./ports.js";
import { selectCandidates, nightWindow } from "./selector.js";

export interface MaintenanceReport {
  generated_at: string;
  reauth_required_accounts: Array<{ id: string; alias: string; email: string }>;
  expiring_refresh_accounts: Array<{
    id: string;
    alias: string;
    expires_at?: string;
  }>;
  unverified_refresh_accounts: Array<{ id: string; alias: string }>;
  pending_quota_accounts: Array<{ id: string; alias: string }>;
  night_candidates: Array<{
    id: string;
    alias: string;
    weekly_remaining: number | null;
  }>;
  excluded_from_night: Array<{ id: string; alias: string; reason: string }>;
}

export class AgyMaintenanceService {
  constructor(
    private repository: AgyAccountRepository,
    private authHost: AuthHostPort,
    private probe: AccountProbePort,
    private clock: ClockPort,
  ) {}

  generateLocalReport(realmId: string): MaintenanceReport {
    const accounts = this.repository.listAccounts(realmId);
    const snapshots = this.repository.listQuotaSnapshots(realmId);

    const reauthReq: MaintenanceReport["reauth_required_accounts"] = [];
    const expiringRefresh: MaintenanceReport["expiring_refresh_accounts"] = [];
    const unverifiedRefresh: MaintenanceReport["unverified_refresh_accounts"] =
      [];
    const pendingQuota: MaintenanceReport["pending_quota_accounts"] = [];
    const nightCandidates: MaintenanceReport["night_candidates"] = [];
    const excludedNight: MaintenanceReport["excluded_from_night"] = [];

    const snapMap = new Map<string, AgyQuotaSnapshot>();
    for (const s of snapshots) {
      snapMap.set(s.account_id, s);
    }

    const now = this.clock.now();
    const settings = this.repository.getSettings(realmId);
    const pools = [
      ...new Set(
        snapshots
          .filter(
            (s) =>
              !!settings?.standalone_model_id &&
              s.model_ids.includes(settings.standalone_model_id) &&
              s.capability_verified,
          )
          .map((s) => s.pool_id),
      ),
    ];
    const selection = pools.length
      ? selectCandidates(accounts, snapshots, pools, now, {
          is_night: true,
          night_pool: "strict",
          night_end_at: settings
            ? nightWindow(settings.maintenance, now).night_end_at
            : now + 12 * 3600_000,
          refresh_verified_max_age_hours:
            settings?.maintenance.refresh_verified_max_age_hours ?? 24,
        })
      : undefined;

    for (const acc of accounts) {
      if (acc.state === "reauth_required") {
        reauthReq.push({
          id: acc.id,
          alias: acc.alias,
          email: acc.identity.email,
        });
        excludedNight.push({
          id: acc.id,
          alias: acc.alias,
          reason: "reauth_required",
        });
        continue;
      }
      if (acc.state === "pending_quota") {
        pendingQuota.push({ id: acc.id, alias: acc.alias });
        excludedNight.push({
          id: acc.id,
          alias: acc.alias,
          reason: "pending_quota",
        });
        continue;
      }
      if (acc.state === "disabled" || acc.state === "incompatible") {
        excludedNight.push({ id: acc.id, alias: acc.alias, reason: acc.state });
        continue;
      }

      if (
        !acc.auth.last_refresh_verified_at ||
        now - Date.parse(acc.auth.last_refresh_verified_at) >
          (settings?.maintenance.refresh_verified_max_age_hours ?? 24) *
            3600_000
      ) {
        unverifiedRefresh.push({ id: acc.id, alias: acc.alias });
      }

      if (acc.auth.refresh_expires_at) {
        const exp = Date.parse(acc.auth.refresh_expires_at);
        if (!Number.isNaN(exp) && exp < now + 24 * 3600 * 1000) {
          expiringRefresh.push({
            id: acc.id,
            alias: acc.alias,
            expires_at: acc.auth.refresh_expires_at,
          });
        }
      }

      const candidate = selection?.ranked_candidates.find(
        (c) => c.account_id === acc.id,
      );
      if (candidate)
        nightCandidates.push({
          id: acc.id,
          alias: acc.alias,
          weekly_remaining: candidate.projected_weekly,
        });
      else
        excludedNight.push({
          id: acc.id,
          alias: acc.alias,
          reason:
            selection?.excluded_accounts.find((c) => c.account_id === acc.id)
              ?.reason ?? "target_model_uninitialized",
        });
    }

    return {
      generated_at: this.clock.toISOString(),
      reauth_required_accounts: reauthReq,
      expiring_refresh_accounts: expiringRefresh,
      unverified_refresh_accounts: unverifiedRefresh,
      pending_quota_accounts: pendingQuota,
      night_candidates: nightCandidates,
      excluded_from_night: excludedNight,
    };
  }

  // Network maintenance is executed only by AccountService's persisted operation consumer.
}
