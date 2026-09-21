import { describe, it, expect } from "vitest";
import {
  evaluateRefreshObservation,
} from "../../packages/agy-accounts/src/maintenance.js";
import {
  nightWindow,
  localTimeToUtc,
} from "../../packages/agy-accounts/src/selector.js";
import {
  evaluateAccountAvailability,
  planRecoveryBatch,
} from "../../packages/agy-accounts/src/recovery-batch.js";
import {
  AgyAccountSettingsSchema,
  type AgyAccount,
  type AgyQuotaSnapshot,
  type AgyRefreshObservation,
  type AgyPendingDemand,
  type AgyAccountSettings,
} from "../../packages/contracts/src/agy-account.js";

describe("AGF-D04: 刷新事实判定 (AGF-U04)", () => {
  const account: AgyAccount = {
    id: "acc_1",
    realm_id: "default",
    revision: 1,
    alias: "Account 1",
    identity: {
      email: "user@example.com",
      verified_at: "2026-09-01T00:00:00.000Z",
    },
    secret_ref: "sec_1",
    credential_revision: 2,
    state: "ready",
    enrolled_at: "2026-09-01T00:00:00.000Z",
    auth: {
      has_refresh_credential: true,
      metadata_status: "verified",
      refresh_expiry_source: "not_provided",
      access_expires_at: "2026-09-21T10:00:00.000Z",
    },
  };

  it("当同一身份且 access 自然到期、请求成功且新 access expiry 推进时，判定为已验证刷新", () => {
    const observation: AgyRefreshObservation = {
      observation_id: "obs_1",
      account_id: "acc_1",
      auth_epoch: 2,
      cli_version: "1.2.7",
      parser_revision: 1,
      before_access_expires_at: "2026-09-21T10:00:00.000Z",
      after_access_expires_at: "2026-09-21T11:00:00.000Z",
      success: true,
      observed_at: "2026-09-21T10:05:00.000Z",
    };

    const nowMs = Date.parse("2026-09-21T10:05:00.000Z");
    const result = evaluateRefreshObservation(account, observation, nowMs);
    expect(result.is_verified_refresh).toBe(true);
  });

  it("当 access 尚未自然到期时，不能认定为刷新事实", () => {
    const observation: AgyRefreshObservation = {
      observation_id: "obs_2",
      account_id: "acc_1",
      auth_epoch: 2,
      cli_version: "1.2.7",
      parser_revision: 1,
      before_access_expires_at: "2026-09-21T12:00:00.000Z", // 还在未来
      after_access_expires_at: "2026-09-21T13:00:00.000Z",
      success: true,
      observed_at: "2026-09-21T10:05:00.000Z",
    };

    const nowMs = Date.parse("2026-09-21T10:05:00.000Z");
    const result = evaluateRefreshObservation(account, observation, nowMs);
    expect(result.is_verified_refresh).toBe(false);
    expect(result.reason).toBe("access_not_yet_expired");
  });

  it("当 auth_epoch 不匹配（期间登录或换代）时拒绝认定", () => {
    const observation: AgyRefreshObservation = {
      observation_id: "obs_3",
      account_id: "acc_1",
      auth_epoch: 1, // 旧代次
      cli_version: "1.2.7",
      parser_revision: 1,
      before_access_expires_at: "2026-09-21T10:00:00.000Z",
      after_access_expires_at: "2026-09-21T11:00:00.000Z",
      success: true,
      observed_at: "2026-09-21T10:05:00.000Z",
    };

    const nowMs = Date.parse("2026-09-21T10:05:00.000Z");
    const result = evaluateRefreshObservation(account, observation, nowMs);
    expect(result.is_verified_refresh).toBe(false);
    expect(result.reason).toBe("auth_epoch_mismatch");
  });

  it("当新的 access_expires_at 没有明确推进时拒绝认定", () => {
    const observation: AgyRefreshObservation = {
      observation_id: "obs_4",
      account_id: "acc_1",
      auth_epoch: 2,
      cli_version: "1.2.7",
      parser_revision: 1,
      before_access_expires_at: "2026-09-21T10:00:00.000Z",
      after_access_expires_at: "2026-09-21T10:00:00.000Z", // 未推进
      success: true,
      observed_at: "2026-09-21T10:05:00.000Z",
    };

    const nowMs = Date.parse("2026-09-21T10:05:00.000Z");
    const result = evaluateRefreshObservation(account, observation, nowMs);
    expect(result.is_verified_refresh).toBe(false);
    expect(result.reason).toBe("access_expiry_not_advanced");
  });
});

describe("AGF-D04: 夜间健康与时区边界 (AGF-U05)", () => {
  it("跨午夜配置消除秒偏移，且精准返回本地日期起止", () => {
    // 假设上海时间 2026-09-21 14:30:45 UTC (对应北京时间 22:30:45)
    // 此时北京时间处于 22:00-08:00 的夜间
    const nowMs = Date.parse("2026-09-21T14:30:45.123Z");
    const nw = nightWindow(
      { timezone: "Asia/Shanghai", night_start: "22:00", night_end: "08:00" },
      nowMs,
    );

    expect(nw.is_night).toBe(true);
    // 起止时间秒与毫秒必须清零
    expect(nw.night_start_at % 60_000).toBe(0);
    expect(nw.night_end_at % 60_000).toBe(0);

    // 本夜开始应该是北京时间 22:00 -> UTC 14:00
    expect(new Date(nw.night_start_at).toISOString()).toBe(
      "2026-09-21T14:00:00.000Z",
    );
    // 本夜结束应该是次日北京时间 08:00 -> UTC 00:00 (2026-09-22)
    expect(new Date(nw.night_end_at).toISOString()).toBe(
      "2026-09-22T00:00:00.000Z",
    );
  });

  it("日间访问时返回下一夜起的明确起止", () => {
    // 北京时间 2026-09-21 10:00 (UTC 02:00)，处于日间
    const nowMs = Date.parse("2026-09-21T02:00:00.000Z");
    const nw = nightWindow(
      { timezone: "Asia/Shanghai", night_start: "22:00", night_end: "08:00" },
      nowMs,
    );

    expect(nw.is_night).toBe(false);
    // 下一夜开始为今晚 22:00 (UTC 14:00)
    expect(new Date(nw.night_start_at).toISOString()).toBe(
      "2026-09-21T14:00:00.000Z",
    );
    // 结束为明早 08:00 (UTC 2026-09-22T00:00:00.000Z)
    expect(new Date(nw.night_end_at).toISOString()).toBe(
      "2026-09-22T00:00:00.000Z",
    );
  });
});

describe("AGF-D05: 账号可用性与 FIFO 批次规划 (AGF-U06 & AGF-U07)", () => {
  const settings: AgyAccountSettings = AgyAccountSettingsSchema.parse({
    realm_id: "default",
    standalone_model_id: "gemini-2.5-pro",
    reset_clock_skew_seconds: 60,
    updated_at: new Date().toISOString(),
    maintenance: {
      timezone: "Asia/Shanghai",
      night_start: "22:00",
      night_end: "08:00",
      local_report_time: "09:00",
      refresh_verified_max_age_hours: 24,
      auto_network_check: false,
    },
  });

  const accountA: AgyAccount = {
    id: "acc_A",
    realm_id: "default",
    revision: 1,
    alias: "Account A",
    identity: { email: "a@example.com", verified_at: "2026-09-01T00:00:00.000Z" },
    secret_ref: "sec_a",
    credential_revision: 1,
    state: "ready",
    enrolled_at: "2026-09-01T00:00:00.000Z",
    auth: {
      has_refresh_credential: true,
      metadata_status: "verified",
      refresh_expiry_source: "not_provided",
      last_refresh_verified_at: "2026-09-21T00:00:00.000Z",
    },
  };

  const accountB: AgyAccount = {
    id: "acc_B",
    realm_id: "default",
    revision: 1,
    alias: "Account B",
    identity: { email: "b@example.com", verified_at: "2026-09-01T00:00:00.000Z" },
    secret_ref: "sec_b",
    credential_revision: 1,
    state: "ready",
    enrolled_at: "2026-09-01T00:00:00.000Z",
    auth: {
      has_refresh_credential: true,
      metadata_status: "verified",
      refresh_expiry_source: "not_provided",
      last_refresh_verified_at: "2026-09-21T00:00:00.000Z",
    },
  };

  const snapA: AgyQuotaSnapshot = {
    id: "snap_a",
    realm_id: "default",
    account_id: "acc_A",
    auth_epoch: 1,
    pool_id: "pool_1",
    model_ids: ["gemini-2.5-pro"],
    source: "official_cli_usage",
    cli_version: "1.2.7",
    parser_revision: 1,
    observed_at: "2026-09-21T00:00:00.000Z",
    capability_verified: true,
    windows: [
      {
        kind: "weekly",
        duration_minutes: 10080,
        remaining_fraction: 0.8,
        reset_at: null,
        observed_at: "2026-09-21T00:00:00.000Z",
        status: "observed",
      },
      {
        kind: "five_hour",
        duration_minutes: 300,
        remaining_fraction: 0.5,
        reset_at: null,
        observed_at: "2026-09-21T00:00:00.000Z",
        status: "observed",
      },
    ],
  };

  const snapB: AgyQuotaSnapshot = {
    id: "snap_b",
    realm_id: "default",
    account_id: "acc_B",
    auth_epoch: 1,
    pool_id: "pool_2",
    model_ids: ["gemini-2.5-pro"],
    source: "official_cli_usage",
    cli_version: "1.2.7",
    parser_revision: 1,
    observed_at: "2026-09-21T00:00:00.000Z",
    capability_verified: true,
    windows: [
      {
        kind: "weekly",
        duration_minutes: 10080,
        remaining_fraction: 0.9,
        reset_at: null,
        observed_at: "2026-09-21T00:00:00.000Z",
        status: "observed",
      },
      {
        kind: "five_hour",
        duration_minutes: 300,
        remaining_fraction: 0.7,
        reset_at: null,
        observed_at: "2026-09-21T00:00:00.000Z",
        status: "observed",
      },
    ],
  };

  it("当账号配额耗尽且有明确 reset 时，可信唤醒时间取其重置时刻", () => {
    const futureReset = new Date(Date.now() + 1800_000).toISOString();
    const snapExhausted: AgyQuotaSnapshot = {
      ...snapA,
      windows: [
        {
          kind: "weekly",
          duration_minutes: 10080,
          remaining_fraction: 0,
          reset_at: futureReset,
          observed_at: new Date().toISOString(),
          status: "observed",
        },
        {
          kind: "five_hour",
          duration_minutes: 300,
          remaining_fraction: 0.5,
          reset_at: null,
          observed_at: new Date().toISOString(),
          status: "observed",
        },
      ],
    };

    const res = evaluateAccountAvailability(
      accountA,
      [snapExhausted],
      ["pool_1"],
      Date.now(),
      { reset_clock_skew_seconds: 60 },
    );
    expect(res.eligible).toBe(false);
    expect(res.credible_wake_at).not.toBeNull();
    expect(res.credible_wake_at).toBeGreaterThan(Date.now());
  });

  it("当无共同候选时，采用就绪需求 FIFO，最早可运行的成为 anchor，不被不相容需求阻塞", () => {
    // Demand 1 要求 pool_1 (只有 account A 满足)，first_wait_at 较早
    const demand1: AgyPendingDemand = {
      demand_id: "dem_1",
      consumer_id: "run_1",
      first_wait_at: "2026-09-21T08:00:00.000Z",
      fairness_key: "wf_1",
      status: "waiting",
      required_model_keys: ["gemini-2.5-pro"],
      required_pool_ids: ["pool_1"],
      night_pool: "normal",
      allowed_account_ids: null,
      revision: 1,
      demand_generation: 1,
      source_revision: 1,
      policy_revision: 1,
      settings_revision: 1,
      control_generation: 0,
      wake_at: null,
    };

    // Demand 2 要求 pool_2 (只有 account B 满足)，first_wait_at 较晚
    const demand2: AgyPendingDemand = {
      demand_id: "dem_2",
      consumer_id: "run_2",
      first_wait_at: "2026-09-21T09:00:00.000Z",
      fairness_key: "wf_2",
      status: "waiting",
      required_model_keys: ["gemini-2.5-pro"],
      required_pool_ids: ["pool_2"],
      night_pool: "normal",
      allowed_account_ids: null,
      revision: 1,
      demand_generation: 1,
      source_revision: 1,
      policy_revision: 1,
      settings_revision: 1,
      control_generation: 0,
      wake_at: null,
    };

    const { batch } = planRecoveryBatch(
      [demand1, demand2],
      [accountA, accountB],
      [snapA, snapB],
      Date.parse("2026-09-21T10:00:00.000Z"),
      settings,
    );

    expect(batch).not.toBeNull();
    // 最早等待的 demand1 成为 anchor
    expect(batch?.anchor_demand_id).toBe("dem_1");
    expect(batch?.selected_demand_ids).toContain("dem_1");
    // 不满足 accountA 的 demand2 顺延至 deferred
    expect(batch?.deferred_demand_ids).toContain("dem_2");
    expect(batch?.committed_account_id).toBe("acc_A");
  });
});
