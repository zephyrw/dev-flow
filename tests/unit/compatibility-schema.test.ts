import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const repoRoot = join(import.meta.dirname, "..", "..");
const compatibilityPath = join(repoRoot, "compatibility.json");
const raw = readFileSync(compatibilityPath, "utf8");
const doc = JSON.parse(raw) as unknown;

const EvidenceSchema = z
  .object({
    application_commit: z.string().min(1),
    platform: z.string().min(1),
    tool_version: z.string().min(1).nullable(),
    model_id: z.string().min(1).nullable(),
    test_date: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
    test_type: z.enum([
      "package_build_native_load",
      "install_workbench_smoke",
      "tool_access",
      "real_workflow",
    ]),
    result: z.enum(["passed", "failed", "blocked"]),
    report_location: z.string().min(1),
  })
  .strict();

const VerificationRecordSchema = z
  .object({
    status: z.enum([
      "unverified",
      "local_regression_tested",
      "smoke_verified",
      "access_verified",
      "live_workflow_verified",
    ]),
    evidence: z.array(EvidenceSchema),
  })
  .strict()
  .refine(
    (value) =>
      value.status !== "live_workflow_verified" || value.evidence.length > 0,
    {
      message: "live_workflow_verified requires at least one evidence record",
    },
  );

const InstallVerificationSchema = z
  .object({
    package_build_native_load: VerificationRecordSchema,
    install_workbench_smoke: VerificationRecordSchema,
    tool_access: VerificationRecordSchema,
    real_workflow: VerificationRecordSchema,
  })
  .strict();

const PlatformSchema = z
  .object({
    status: z.enum(["unverified", "local_regression_tested"]),
    status_scope: z.string().min(1),
    install_verification: InstallVerificationSchema,
  })
  .strict();

const ToolSchema = z
  .object({
    status: z.enum(["adapter_implemented"]),
    live_workflow_verified: z.boolean(),
    evidence: z.array(EvidenceSchema),
    roles: z.array(
      z.enum(["planner", "executor", "tester", "reviewer"]),
    ).nonempty(),
    modes: z.array(z.enum(["single", "composite"])).nonempty(),
  })
  .strict()
  .refine(
    (value) => !value.live_workflow_verified || value.evidence.length > 0,
    {
      message: "live_workflow_verified true requires evidence records",
    },
  );

const AgyVerificationSchema = z
  .object({
    type: z.enum([
      "capability_probe",
      "official_cli_dual_window",
      "cross_account_resume",
      "account_switch_serial_safety",
    ]),
    status: z.enum([
      "unverified",
      "local_regression_tested",
      "smoke_verified",
      "access_verified",
      "live_workflow_verified",
    ]),
    evidence: z.array(EvidenceSchema),
    notes: z.string().min(1),
  })
  .strict()
  .refine(
    (value) =>
      value.status !== "live_workflow_verified" || value.evidence.length > 0,
    {
      message: "live_workflow_verified requires at least one evidence record",
    },
  );

const ProcessCapabilitySchema = z.enum([
  "managed_runner_spawn",
  "suspended_spawn_resume",
  "job_object_kill_on_close",
  "job_object_assign",
  "job_object_terminate",
  "job_object_active_query",
  "process_group_terminate",
  "named_mutex",
  "controller_flock",
  "clean_process_environment",
  "credential_native_probe",
]);

const CompatibilitySchema = z
  .object({
    matrix_version: z.string().regex(/^\d+\.\d+\.\d+$/),
    verification_policy: z.string().min(1),
    layers: z
      .object({
        application_build: z
          .object({
            authority: z.literal("build-info.json"),
            description: z.string().min(1),
            fields_bound_at_build: z.array(z.string().min(1)).nonempty(),
          })
          .strict(),
        runtime_backend: z.literal("node-v1"),
        runner_protocol: z
          .object({
            version: z.literal("1.0.0"),
            source: z.string().min(1),
          })
          .strict(),
        credential_worker_protocol: z
          .object({
            version: z.literal("3.0.0-node"),
            source: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
    platforms: z
      .object({
        "win32-x64": PlatformSchema,
        "win32-arm64": PlatformSchema,
        "darwin-x64": PlatformSchema,
        "darwin-arm64": PlatformSchema,
        "linux-x64": PlatformSchema,
        "linux-arm64": PlatformSchema,
      })
      .strict(),
    tools: z
      .object({
        codex: ToolSchema,
        agy: ToolSchema,
        "grok-build": ToolSchema,
        "claude-code": ToolSchema,
        "kimi-code": ToolSchema,
        qoder: ToolSchema,
        opencode: ToolSchema,
        "cursor-agent": ToolSchema,
      })
      .strict(),
    agy_accounts: z
      .object({
        platform_scope: z.literal("win32"),
        feature_boundary: z
          .object({
            serial_operations_required: z.literal(true),
            dual_quota_enrollment_required: z.literal(true),
            unused_account_background_probe_allowed: z.literal(false),
            fail_closed_off_platform: z.literal(true),
          })
          .strict(),
        credential_worker_protocol: z.literal("3.0.0-node"),
        process_capability_model: z
          .object({
            source_files: z.array(z.string().min(1)).nonempty(),
            capabilities: z.array(ProcessCapabilitySchema).nonempty(),
            by_platform: z
              .object({
                win32: z.array(ProcessCapabilitySchema).nonempty(),
                posix: z.array(ProcessCapabilitySchema).nonempty(),
              })
              .strict(),
            capability_notes: z.record(
              ProcessCapabilitySchema,
              z.string().min(1),
            ),
            legacy_host_commands_removed: z.string().min(1),
          })
          .strict(),
        verifications: z
          .array(AgyVerificationSchema)
          .min(4)
          .refine(
            (list) =>
              new Set(list.map((item) => item.type)).size === list.length,
            { message: "verification types must be unique" },
          ),
        notes: z.string().min(1),
      })
      .strict(),
  })
  .strict();

function walkKeys(value: unknown, out: string[] = []): string[] {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) walkKeys(item, out);
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    out.push(key);
    walkKeys(child, out);
  }
  return out;
}

describe("compatibility.json schema (DFP-08)", () => {
  it("UT-COMPAT-01: repository compatibility.json satisfies the separated-layer schema", () => {
    const parsed = CompatibilitySchema.parse(doc);
    expect(parsed.layers.runtime_backend).toBe("node-v1");
    expect(parsed.layers.runner_protocol.version).toBe("1.0.0");
    expect(parsed.layers.credential_worker_protocol.version).toBe(
      "3.0.0-node",
    );
    expect(parsed.layers.application_build.authority).toBe("build-info.json");
    expect(parsed.agy_accounts.credential_worker_protocol).toBe(
      "3.0.0-node",
    );
  });

  it("UT-COMPAT-02: rejects missing required fields and illegal enum values", () => {
    const base = JSON.parse(raw) as Record<string, unknown>;
    expect(
      CompatibilitySchema.safeParse({ ...base, matrix_version: undefined })
        .success,
    ).toBe(false);
    expect(
      CompatibilitySchema.safeParse({
        ...base,
        layers: {
          ...(base.layers as Record<string, unknown>),
          runtime_backend: "go-host",
        },
      }).success,
    ).toBe(false);
    expect(
      CompatibilitySchema.safeParse({
        ...base,
        layers: {
          ...(base.layers as Record<string, unknown>),
          credential_worker_protocol: { version: "2.0.0" },
        },
      }).success,
    ).toBe(false);
    const platforms = base.platforms as Record<string, Record<string, unknown>>;
    expect(
      CompatibilitySchema.safeParse({
        ...base,
        platforms: {
          ...platforms,
          "win32-x64": { ...platforms["win32-x64"], status: "certified" },
        },
      }).success,
    ).toBe(false);
  });

  it("UT-COMPAT-03: live_workflow_verified cannot be true without evidence", () => {
    expect(
      ToolSchema.safeParse({
        status: "adapter_implemented",
        live_workflow_verified: true,
        evidence: [],
        roles: ["planner"],
        modes: ["single"],
      }).success,
    ).toBe(false);
    expect(
      ToolSchema.safeParse({
        status: "adapter_implemented",
        live_workflow_verified: true,
        evidence: [
          {
            application_commit: "a".repeat(40),
            platform: "win32-x64",
            tool_version: "1.0.0",
            model_id: "fixture-model",
            test_date: "2026-09-23",
            test_type: "real_workflow",
            result: "passed",
            report_location: "docs/test/evidence/fixture/report.md",
          },
        ],
        roles: ["planner"],
        modes: ["single"],
      }).success,
    ).toBe(true);
    expect(
      VerificationRecordSchema.safeParse({
        status: "live_workflow_verified",
        evidence: [],
      }).success,
    ).toBe(false);

    const parsed = CompatibilitySchema.parse(doc);
    for (const [toolId, tool] of Object.entries(parsed.tools)) {
      if (tool.live_workflow_verified)
        expect(tool.evidence.length, toolId).toBeGreaterThan(0);
      else expect(tool.evidence, toolId).toEqual([]);
    }
  });

  it("UT-COMPAT-04: legacy Host field names are gone from compatibility.json", () => {
    const keys = walkKeys(doc);
    for (const legacyKey of [
      "auth_host_protocol",
      "required_process_capabilities",
      "official_cli_dual_window_verified",
      "cross_account_resume_verified",
    ])
      expect(keys, legacyKey).not.toContain(legacyKey);

    for (const legacyToken of [
      '"auth_host_protocol"',
      '"required_process_capabilities"',
      '"official_cli_dual_window_verified"',
      '"cross_account_resume_verified"',
      "disabled_until_runtime_capabilities_verified",
    ])
      expect(raw, legacyToken).not.toContain(legacyToken);

    const parsed = CompatibilitySchema.parse(doc);
    expect(parsed.agy_accounts.verifications.map((v) => v.type).sort()).toEqual(
      [
        "account_switch_serial_safety",
        "capability_probe",
        "cross_account_resume",
        "official_cli_dual_window",
      ],
    );
    for (const verification of parsed.agy_accounts.verifications) {
      expect(verification.status).toBe("unverified");
      expect(verification.evidence).toEqual([]);
    }

    // Old Host command strings must not appear as live capability identifiers.
    const capabilityValues = parsed.agy_accounts.process_capability_model
      .capabilities as string[];
    for (const legacyCapability of [
      "doctor",
      "suspended_spawn",
      "kill_on_close",
      "job-status",
    ])
      expect(capabilityValues).not.toContain(legacyCapability);
  });

  it("UT-COMPAT-05: does not raise tool or platform verification levels", () => {
    const parsed = CompatibilitySchema.parse(doc);
    expect(Object.keys(parsed.tools)).toHaveLength(8);
    for (const tool of Object.values(parsed.tools)) {
      expect(tool.status).toBe("adapter_implemented");
      expect(tool.live_workflow_verified).toBe(false);
    }
    expect(parsed.platforms["win32-x64"].status).toBe("local_regression_tested");
    for (const id of [
      "win32-arm64",
      "darwin-x64",
      "darwin-arm64",
      "linux-x64",
      "linux-arm64",
    ] as const)
      expect(parsed.platforms[id].status).toBe("unverified");
    for (const platform of Object.values(parsed.platforms))
      for (const record of Object.values(platform.install_verification)) {
        expect(record.status).toBe("unverified");
        expect(record.evidence).toEqual([]);
      }
  });
});
