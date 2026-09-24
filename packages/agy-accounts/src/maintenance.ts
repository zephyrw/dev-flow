import { randomUUID } from "node:crypto";
import type {
  AgyAccount,
  AgyQuotaSnapshot,
  AgyRefreshObservation,
  RefreshEvidence,
} from "../../contracts/src/agy-account.js";
import type { AgyAccountRepository } from "./repository.js";
import type { AuthHostPort, AccountProbePort, ClockPort } from "./ports.js";
import { selectCandidates, nightWindow } from "./selector.js";

export interface MaintenanceReport {
  generated_at: string;
  evaluation_time: string;
  evaluated_night_start: string;
  evaluated_night_end: string;
  reauth_required_accounts: Array<{ id: string; alias: string; email: string }>;
  expiring_refresh_accounts: Array<{
    id: string;
    alias: string;
    expires_at?: string;
  }>;
  unverified_refresh_accounts: Array<{ id: string; alias: string }>;
  unknown_refresh_expiry_accounts: Array<{ id: string; alias: string }>;
  pending_quota_accounts: Array<{ id: string; alias: string }>;
  night_candidates: Array<{
    id: string;
    alias: string;
    weekly_remaining: number | null;
  }>;
  excluded_from_night: Array<{ id: string; alias: string; reason: string }>;
  account_details: Record<
    string,
    {
      last_authenticated_request_at?: string;
      last_refresh_verified_at?: string;
      snapshot_observed_at?: string;
    }
  >;
}

export function evaluateRefreshObservation(
  account: AgyAccount,
  observation: AgyRefreshObservation,
  nowMs: number,
  options: { clockSkewMs?: number; realmAuthEpoch?: number } = {},
): { is_verified_refresh: boolean; reason?: string } {
  const clockSkewMs = options.clockSkewMs ?? 60_000;
  // 1. 同一已核实活动身份，期间无登录/账号代次变化
  if (observation.account_id !== account.id) {
    return { is_verified_refresh: false, reason: "account_mismatch" };
  }
  const expectedAuthEpoch = options.realmAuthEpoch ?? account.credential_revision;
  if (
    expectedAuthEpoch !== undefined &&
    observation.auth_epoch !== expectedAuthEpoch
  ) {
    return { is_verified_refresh: false, reason: "auth_epoch_mismatch" };
  }
  // 2. 先前观察的 access 到期已自然经过（含允许时钟偏差）
  if (!observation.before_access_expires_at) {
    return {
      is_verified_refresh: false,
      reason: "missing_before_access_expiry",
    };
  }
  const beforeExpiryMs = Date.parse(observation.before_access_expires_at);
  if (Number.isNaN(beforeExpiryMs)) {
    return {
      is_verified_refresh: false,
      reason: "invalid_before_access_expiry",
    };
  }
  if (nowMs < beforeExpiryMs - clockSkewMs) {
    return { is_verified_refresh: false, reason: "access_not_yet_expired" };
  }
  // 3. 官方无交互请求成功，新的 access expiry 明确推进
  if (!observation.success) {
    return { is_verified_refresh: false, reason: "observation_unsuccessful" };
  }
  if (!observation.after_access_expires_at) {
    return {
      is_verified_refresh: false,
      reason: "missing_after_access_expiry",
    };
  }
  const afterExpiryMs = Date.parse(observation.after_access_expires_at);
  if (Number.isNaN(afterExpiryMs)) {
    return {
      is_verified_refresh: false,
      reason: "invalid_after_access_expiry",
    };
  }
  if (afterExpiryMs <= beforeExpiryMs) {
    return {
      is_verified_refresh: false,
      reason: "access_expiry_not_advanced",
    };
  }
  // 4. capture 新完整凭据成功，来源/版本仍有效
  return { is_verified_refresh: true };
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
    const unknownRefreshExpiry: MaintenanceReport["unknown_refresh_expiry_accounts"] =
      [];
    const pendingQuota: MaintenanceReport["pending_quota_accounts"] = [];
    const nightCandidates: MaintenanceReport["night_candidates"] = [];
    const excludedNight: MaintenanceReport["excluded_from_night"] = [];
    const accountDetails: MaintenanceReport["account_details"] = {};

    const snapMap = new Map<string, AgyQuotaSnapshot>();
    for (const s of snapshots) {
      snapMap.set(s.account_id, s);
    }

    const now = this.clock.now();
    const settings = this.repository.getSettings(realmId);
    const nw = settings
      ? nightWindow(settings.maintenance, now)
      : {
          is_night: false,
          night_start_at: now,
          night_end_at: now + 12 * 3600_000,
        };

    const evaluationTime = Math.max(now, nw.night_start_at);
    const selection = settings?.standalone_model_id
      ? selectCandidates(accounts, snapshots, ["global"], evaluationTime, {
          required_model_ids: [settings.standalone_model_id],
          is_night: true,
          night_pool: "strict",
          night_end_at: nw.night_end_at,
          refresh_verified_max_age_hours:
            settings.maintenance.refresh_verified_max_age_hours,
        })
      : undefined;

    for (const acc of accounts) {
      const snap = snapMap.get(acc.id);
      accountDetails[acc.id] = {
        last_authenticated_request_at:
          acc.auth.last_authenticated_request_at,
        last_refresh_verified_at: acc.auth.last_refresh_verified_at,
        snapshot_observed_at: snap?.observed_at,
      };

      if (!acc.auth.refresh_expires_at) {
        unknownRefreshExpiry.push({ id: acc.id, alias: acc.alias });
      }

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
        evaluationTime - Date.parse(acc.auth.last_refresh_verified_at) >
          (settings?.maintenance.refresh_verified_max_age_hours ?? 24) *
            3600_000
      ) {
        unverifiedRefresh.push({ id: acc.id, alias: acc.alias });
      }

      if (acc.auth.refresh_expires_at) {
        const exp = Date.parse(acc.auth.refresh_expires_at);
        if (!Number.isNaN(exp) && exp < nw.night_end_at) {
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
      evaluation_time: new Date(evaluationTime).toISOString(),
      evaluated_night_start: new Date(nw.night_start_at).toISOString(),
      evaluated_night_end: new Date(nw.night_end_at).toISOString(),
      reauth_required_accounts: reauthReq,
      expiring_refresh_accounts: expiringRefresh,
      unverified_refresh_accounts: unverifiedRefresh,
      unknown_refresh_expiry_accounts: unknownRefreshExpiry,
      pending_quota_accounts: pendingQuota,
      night_candidates: nightCandidates,
      excluded_from_night: excludedNight,
      account_details: accountDetails,
    };
  }

  recordRefreshEvidence(
    realmId: string,
    account: AgyAccount,
    observation: AgyRefreshObservation & {
      permit_id?: string;
      lease_id?: string;
      secret_ref: string;
      protocol_verified?: boolean;
      non_interactive?: boolean;
    },
    nowMs: number,
  ): { recorded: boolean; evidence?: RefreshEvidence; reason?: string } {
    const evalRes = evaluateRefreshObservation(account, observation, nowMs, {
      realmAuthEpoch: account.credential_revision,
    });
    if (!evalRes.is_verified_refresh) {
      return { recorded: false, reason: evalRes.reason };
    }
    if (observation.protocol_verified === false) {
      return { recorded: false, reason: "protocol_unverified" };
    }
    if (observation.non_interactive === false) {
      return { recorded: false, reason: "interactive_request" };
    }
    const evidence: RefreshEvidence = {
      evidence_id: randomUUID(),
      realm_id: realmId,
      account_id: account.id,
      auth_epoch: account.credential_revision ?? 0,
      credential_revision: account.credential_revision,
      permit_id: observation.permit_id,
      lease_id: observation.lease_id,
      observed_at: this.clock.toISOString(),
      previous_expiry: observation.before_access_expires_at,
      new_expiry: observation.after_access_expires_at,
      protocol_verified: observation.protocol_verified ?? true,
      non_interactive: observation.non_interactive ?? true,
      secret_ref: observation.secret_ref,
      evidence_version: 1,
    };
    this.repository.saveRefreshEvidence(evidence);

    // 投影到账号实体
    account.auth.last_refresh_verified_at = evidence.observed_at;
    account.auth.last_authenticated_request_at = evidence.observed_at;
    if (observation.after_access_expires_at) {
      account.auth.access_expires_at = observation.after_access_expires_at;
    }
    account.revision++;
    this.repository.saveAccount(account);

    return { recorded: true, evidence };
  }

  // Network maintenance is executed only by AccountService's persisted operation consumer.
}
