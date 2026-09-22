/**
 * Config schema migration v1 → v2.
 *
 * Removes host-related fields that are no longer needed with Node runtime:
 *   - host.executable (C# host binary path)
 *   - host.required (whether host binary is required)
 *   - agy_accounts.auth_host_executable (C# auth host path)
 *
 * Preserves all other fields, comments, and field order.
 */

import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { parse, stringify } from "yaml";

// ── Known host paths (built-in C#/Go binaries) ──────────────────────────────

const KNOWN_HOST_PATHS = [
  "dist/host/devflow-host.exe",
  "dist/host/devflow-auth-host.exe",
  "dist/host/DevFlow.WinHost.exe",
];

function isKnownHostPath(path: string): boolean {
  return KNOWN_HOST_PATHS.some((known) => path.includes(known));
}

function isCustomHostPath(path: string): boolean {
  return !isKnownHostPath(path) && path.length > 0;
}

// ── Migration result types ───────────────────────────────────────────────────

export interface MigrationResult {
  success: boolean;
  input_hash: string;
  output_hash?: string;
  removed_fields: string[];
  preserved_fields: string[];
  warnings: string[];
  errors: string[];
  can_apply: boolean;
  reason?: string;
}

// ── Schema v2 (without host fields) ─────────────────────────────────────────

export const ConfigSchemaV2 = z.object({
  schema_version: z.literal(2).default(2),
  server: z
    .object({
      host: z.literal("127.0.0.1").default("127.0.0.1"),
      port: z.number().int().positive().max(65535).default(4810),
      human_origin: z.string().url().default("http://localhost:4810"),
    })
    .strict()
    .prefault({}),
  retain_services_on_stop: z.boolean().default(false),
  storage_root: z.string().default(".devflow"),
  agy_accounts: z
    .object({
      enabled: z.boolean().default(false),
      // auth_host_executable removed in v2
    })
    .strict()
    .prefault({}),
  workspace_root: z.string().default(".devflow/worktrees"),
  models: z
    .object({
      executor: z.string().min(1).default("gemini-3.7-flash-high"),
      reviewer: z.string().min(1).default("gpt-6-astra"),
      effort: z.literal("high").default("high"),
      agy_executable: z.string().default("agy"),
      codex_executable: z.string().default("codex"),
      codex_prefix_args: z.array(z.string()).default([]),
    })
    .strict()
    .prefault({}),
  scheduler: z
    .object({
      executors: z.number().int().positive().max(16).default(1),
      reviewers: z.number().int().positive().max(4).default(1),
      heavy_tests: z.number().int().positive().max(8).default(1),
      live_environments: z.number().int().positive().max(16).default(1),
      aging_minutes: z.number().int().positive().default(10),
    })
    .strict()
    .prefault({}),
  ports: z
    .object({
      frontend: z
        .tuple([z.number().int().positive().max(65535), z.number().int().positive().max(65535)])
        .default([15173, 15272]),
      backend: z
        .tuple([z.number().int().positive().max(65535), z.number().int().positive().max(65535)])
        .default([18081, 18180]),
      bind_retries: z.number().int().positive().max(10).default(5),
    })
    .strict()
    .prefault({}),
  // host field removed in v2
  opentabs: z
    .object({
      endpoint: z.string().url().default("http://127.0.0.1:9515/mcp"),
      secret_file: z.string().default(""),
      allowed_test_origins: z.array(z.string().url()).default([]),
    })
    .strict()
    .prefault({}),
  timeouts: z
    .object({
      agent_minutes: z.number().int().positive().default(60),
      idle_minutes: z.number().int().positive().default(10),
      stop_seconds: z.number().int().positive().default(5),
      heartbeat_seconds: z.number().int().positive().default(5),
    })
    .strict()
    .prefault({}),
  retention: z
    .object({
      logs_days: z.number().int().positive().default(30),
      failed_logs_days: z.number().int().positive().default(90),
      evidence_days: z.number().int().positive().default(180),
    })
    .strict()
    .prefault({}),
});

export type ConfigV2 = z.infer<typeof ConfigSchemaV2>;

// ── Migration functions ─────────────────────────────────────────────────────

export function fileHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Dry-run migration: analyze what would change without modifying the file.
 */
export function dryRunMigration(configPath: string): MigrationResult {
  const content = readFileSync(configPath, "utf8");
  const inputHash = fileHash(content);
  const config = parse(content);

  const result: MigrationResult = {
    success: false,
    input_hash: inputHash,
    removed_fields: [],
    preserved_fields: [],
    warnings: [],
    errors: [],
    can_apply: false,
  };

  // Check schema_version
  if (config.schema_version !== 1) {
    result.errors.push(`期望 schema_version=1，实际为 ${config.schema_version}`);
    return result;
  }

  // Check host.executable
  if (config.host?.executable) {
    if (isCustomHostPath(config.host.executable)) {
      result.warnings.push(`检测到自定义 Host 路径: ${config.host.executable}`);
      result.errors.push("LEGACY_CUSTOM_HOST_UNSUPPORTED: 自定义 Host 路径需要人工核对");
      result.can_apply = false;
      result.reason = "存在自定义 Host 路径，需要人工核对";
      return result;
    }
    result.removed_fields.push("host.executable");
  }

  // Check host.required
  if (config.host?.required !== undefined) {
    result.removed_fields.push("host.required");
  }

  // Check agy_accounts.auth_host_executable
  if (config.agy_accounts?.auth_host_executable) {
    if (isCustomHostPath(config.agy_accounts.auth_host_executable)) {
      result.warnings.push(`检测到自定义 Auth Host 路径: ${config.agy_accounts.auth_host_executable}`);
      result.errors.push("LEGACY_CUSTOM_HOST_UNSUPPORTED: 自定义 Auth Host 路径需要人工核对");
      result.can_apply = false;
      result.reason = "存在自定义 Auth Host 路径，需要人工核对";
      return result;
    }
    result.removed_fields.push("agy_accounts.auth_host_executable");
  }

  // Count preserved fields
  const allFields = Object.keys(config);
  result.preserved_fields = allFields.filter((f) => !["host"].includes(f));

  // Generate migrated config hash
  const migrated = { ...config };
  migrated.schema_version = 2;
  delete migrated.host;
  if (migrated.agy_accounts) {
    delete migrated.agy_accounts.auth_host_executable;
  }

  result.output_hash = fileHash(stringify(migrated));
  result.success = true;
  result.can_apply = true;
  result.reason = "可以安全迁移";

  return result;
}

/**
 * Apply migration: modify config file in place with backup.
 */
export function applyMigration(configPath: string, expectedHash: string): MigrationResult {
  const content = readFileSync(configPath, "utf8");
  const currentHash = fileHash(content);

  if (currentHash !== expectedHash) {
    return {
      success: false,
      input_hash: currentHash,
      removed_fields: [],
      preserved_fields: [],
      warnings: [],
      errors: ["CONFIG_CHANGED: 配置文件已变更，请重新 dry-run"],
      can_apply: false,
      reason: "配置文件已变更",
    };
  }

  // Create backup
  const backupPath = configPath + ".backup." + Date.now();
  copyFileSync(configPath, backupPath);

  // Apply migration
  const config = parse(content);
  config.schema_version = 2;
  delete config.host;
  if (config.agy_accounts) {
    delete config.agy_accounts.auth_host_executable;
  }

  const migratedContent = stringify(config);
  writeFileSync(configPath, migratedContent, "utf8");

  return {
    success: true,
    input_hash: currentHash,
    output_hash: fileHash(migratedContent),
    removed_fields: ["host.executable", "host.required", "agy_accounts.auth_host_executable"],
    preserved_fields: Object.keys(config).filter((f) => !["host"].includes(f)),
    warnings: [`备份已保存到: ${backupPath}`],
    errors: [],
    can_apply: true,
    reason: "迁移完成",
  };
}

/**
 * Load config with v1/v2 compatibility.
 * Accepts both schema versions and migrates v1 fields on read.
 */
export function loadConfigCompat(file?: string): ConfigV2 {
  file ??= existsSync("devflow.yaml") ? resolve("devflow.yaml") : undefined;
  const raw = file ? parse(readFileSync(file, "utf8")) : {};

  // If v1, strip host fields before parsing
  if (raw.schema_version === 1) {
    delete raw.host;
    if (raw.agy_accounts) {
      delete raw.agy_accounts.auth_host_executable;
    }
    raw.schema_version = 2;
  }

  return ConfigSchemaV2.parse(raw);
}
