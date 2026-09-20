import { describe, it, expect } from "vitest";
import {
  AgyAccountSchema,
  AccountStateSchema,
  OperationSelectionSchema,
  AgyQuotaSnapshotSchema,
  AgyAccountPolicySchema,
  AgyAccountSettingsSchema,
  AgyAccountSettingsPatchSchema,
  AgyAccountPolicyPatchSchema,
} from "../../packages/contracts/src/agy-account.js";

describe("AGY Account Contracts & DTOs (AC-U02)", () => {
  it("preserves absent policy and settings patch fields without materializing defaults", () => {
    expect(AgyAccountPolicyPatchSchema.parse({ auto_switch: false })).toEqual({ auto_switch: false });
    expect(AgyAccountSettingsPatchSchema.parse({ standalone_model_id: "model" })).toEqual({ standalone_model_id: "model" });
    expect(AgyAccountSettingsPatchSchema.parse({ maintenance: { night_start: "21:00" } })).toEqual({ maintenance: { night_start: "21:00" } });
  });

  it("rejects unknown nested maintenance fields and private patch properties", () => {
    expect(AgyAccountSettingsPatchSchema.safeParse({ maintenance: { token: "forbidden" } }).success).toBe(false);
    expect(AgyAccountSettingsPatchSchema.safeParse({ auth_host_executable: "forbidden" }).success).toBe(false);
    expect(AgyAccountPolicyPatchSchema.safeParse({ workflow_id: "other" }).success).toBe(false);
  });
  it("validates a fully populated valid account", () => {
    const validAccount = {
      id: "acc-12345678",
      realm_id: "default",
      revision: 1,
      alias: "Work Account",
      identity: {
        email: "alice@company.com",
        verified_at: "2026-09-20T10:00:00.000Z",
      },
      secret_ref: "vault-ref-001",
      credential_revision: 1,
      state: "ready",
      enrolled_at: "2026-09-20T10:00:00.000Z",
      auth: {
        has_refresh_credential: true,
        refresh_expiry_source: "not_provided",
      },
    };

    const parsed = AgyAccountSchema.safeParse(validAccount);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.alias).toBe("Work Account");
      expect(parsed.data.state).toBe("ready");
    }
  });

  it("rejects account with invalid email or missing mandatory fields", () => {
    const invalidAccount = {
      id: "acc-invalid",
      realm_id: "default",
      alias: "Broken Account",
      identity: {
        email: "not-an-email",
        verified_at: "2026-09-20T10:00:00.000Z",
      },
      // missing secret_ref, enrolled_at, auth
    };

    const parsed = AgyAccountSchema.safeParse(invalidAccount);
    expect(parsed.success).toBe(false);
  });

  it("validates discriminated union for operation selection (auto vs explicit)", () => {
    const autoSel = { mode: "auto" };
    const autoParsed = OperationSelectionSchema.safeParse(autoSel);
    expect(autoParsed.success).toBe(true);

    const explicitValid = { mode: "explicit", account_id: "acc-target-99" };
    const explicitParsed = OperationSelectionSchema.safeParse(explicitValid);
    expect(explicitParsed.success).toBe(true);

    const explicitMissingAccount = { mode: "explicit" };
    const missingParsed = OperationSelectionSchema.safeParse(explicitMissingAccount);
    expect(missingParsed.success).toBe(false);
  });

  it("validates account states enum strictly", () => {
    expect(AccountStateSchema.safeParse("ready").success).toBe(true);
    expect(AccountStateSchema.safeParse("waiting_quota").success).toBe(true);
    expect(AccountStateSchema.safeParse("reauth_required").success).toBe(true);
    expect(AccountStateSchema.safeParse("disabled").success).toBe(true);
    expect(AccountStateSchema.safeParse("non_existent_state").success).toBe(false);
  });

  it("validates quota snapshot and calculates bounds correctly", () => {
    const validSnapshot = {
      id: "snap-001",
      realm_id: "default",
      account_id: "acc-100",
      auth_epoch: 1,
      pool_id: "default",
      model_ids: ["gemini-2.5-pro"],
      source: "official_cli_usage",
      cli_version: "1.2.7",
      parser_revision: 1,
      observed_at: "2026-09-20T12:00:00.000Z",
      windows: [
        {
          kind: "weekly",
          duration_minutes: 10080,
          remaining_fraction: 0.9,
          reset_at: "2026-09-27T00:00:00.000Z",
          observed_at: "2026-09-20T12:00:00.000Z",
          status: "observed",
        },
      ],
    };

    const parsed = AgyQuotaSnapshotSchema.safeParse(validSnapshot);
    expect(parsed.success).toBe(true);
  });

  it("applies defaults for workflow account policy and settings", () => {
    const defaultPolicy = {
      workflow_id: "wf-123",
      created_at: "2026-09-20T12:00:00.000Z",
    };
    const parsedPolicy = AgyAccountPolicySchema.parse(defaultPolicy);
    expect(parsedPolicy.auto_switch).toBeNull();
    expect(parsedPolicy.recreation_policy).toBe("exact_only");
    expect(parsedPolicy.night_pool).toBe("normal");

    const defaultSettings = {
      realm_id: "default",
      updated_at: "2026-09-20T12:00:00.000Z",
    };
    const parsedSettings = AgyAccountSettingsSchema.parse(defaultSettings);
    expect(parsedSettings.workflow_auto_switch).toBe(true);
    expect(parsedSettings.switch_gap_seconds).toBe(3);
    expect(parsedSettings.reset_clock_skew_seconds).toBe(60);
  });
});
