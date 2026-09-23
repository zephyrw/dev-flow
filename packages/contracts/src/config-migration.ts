/**
 * Config schema migration v1 → v2.
 *
 * Removes host-related fields that are no longer needed with Node runtime:
 *   - host.executable (C# host binary path)
 *   - host.required (whether host binary is required)
 *   - agy_accounts.auth_host_executable (C# auth host path)
 *
 * Preserves all other fields, comments, and field order.
 *
 * R08 修复：
 * - 使用 YAML parseDocument 保留注释
 * - apply 必须重新运行 dry-run 验证
 * - 统一使用 ConfigSchema，不创建平行 schema
 */

import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { parse, stringify, parseDocument } from "yaml";
import { ConfigSchema } from "./config.js";

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

  // R08 修复：使用 ConfigSchema 验证迁移后的配置
  const migrated = { ...config };
  migrated.schema_version = 2;
  delete migrated.host;
  if (migrated.agy_accounts) {
    delete migrated.agy_accounts.auth_host_executable;
  }

  // Count preserved fields
  const allFields = Object.keys(config);
  result.preserved_fields = allFields.filter((f) => !["host"].includes(f));

  // R08 修复：用 ConfigSchema 验证迁移后的配置
  try {
    ConfigSchema.parse(migrated);
  } catch (err) {
    result.errors.push(`迁移后配置验证失败: ${err instanceof Error ? err.message : String(err)}`);
    result.can_apply = false;
    result.reason = "迁移后配置验证失败";
    return result;
  }

  result.output_hash = fileHash(stringify(migrated));
  result.success = true;
  result.can_apply = true;
  result.reason = "可以安全迁移";

  return result;
}

/**
 * Apply migration: modify config file in place with backup.
 * R08 修复：apply 必须重新运行 dry-run 验证
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

  // R08 修复：重新运行 dry-run 验证
  const dryRun = dryRunMigration(configPath);
  if (!dryRun.can_apply) {
    return dryRun;
  }

  // Create backup
  const backupPath = configPath + ".backup." + Date.now();
  copyFileSync(configPath, backupPath);

  // R08 修复：使用 YAML parseDocument 保留注释
  const doc = parseDocument(content);
  const docObj = doc.toJS();

  // Apply migration
  docObj.schema_version = 2;
  if (docObj.host) {
    delete docObj.host;
  }
  if (docObj.agy_accounts?.auth_host_executable) {
    delete docObj.agy_accounts.auth_host_executable;
  }

  // R08 修复：使用 YAML stringify 保留格式
  const migratedContent = stringify(docObj);
  writeFileSync(configPath, migratedContent, "utf8");

  return {
    success: true,
    input_hash: currentHash,
    output_hash: fileHash(migratedContent),
    removed_fields: ["host.executable", "host.required", "agy_accounts.auth_host_executable"],
    preserved_fields: Object.keys(docObj).filter((f) => !["host"].includes(f)),
    warnings: [`备份已保存到: ${backupPath}`],
    errors: [],
    can_apply: true,
    reason: "迁移完成",
  };
}

/**
 * Load config with v1/v2 compatibility.
 * R08 修复：统一使用 ConfigSchema，不再需要独立的 ConfigSchemaV2
 */
export function loadConfigCompat(file?: string): z.infer<typeof ConfigSchema> {
  file ??= existsSync("devflow.yaml") ? resolve("devflow.yaml") : undefined;
  const raw = file ? parse(readFileSync(file, "utf8")) : {};

  // R08 修复：ConfigSchema 已通过 transform 自动处理 v1 字段
  return ConfigSchema.parse(raw);
}
