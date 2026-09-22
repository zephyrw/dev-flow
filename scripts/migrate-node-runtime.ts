#!/usr/bin/env tsx
/**
 * Node 运行时迁移脚本
 *
 * 将 DevFlow 配置从 schema v1 迁移到 v2，移除 Host 相关字段。
 *
 * 使用方法:
 *   pnpm exec tsx scripts/migrate-node-runtime.ts --config <配置绝对路径> --dry-run
 *   pnpm exec tsx scripts/migrate-node-runtime.ts --config <配置绝对路径> --apply --expected-sha256 <dry-run返回的哈希>
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { parse, stringify } from 'yaml';

interface MigrationResult {
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

/**
 * 计算文件 SHA256
 */
function fileHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * 识别旧 Host 路径
 */
function isKnownHostPath(path: string): boolean {
  const knownPaths = [
    'dist/host/devflow-host.exe',
    'dist/host/devflow-auth-host.exe',
    'dist/host/DevFlow.WinHost.exe',
  ];
  return knownPaths.some(known => path.includes(known));
}

/**
 * 检查是否为自定义 Host 路径
 */
function isCustomHostPath(path: string): boolean {
  return !isKnownHostPath(path) && path.length > 0;
}

/**
 * 执行 dry-run 迁移
 */
function dryRun(configPath: string): MigrationResult {
  const content = readFileSync(configPath, 'utf8');
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

  // 检查 schema_version
  if (config.schema_version !== 1) {
    result.errors.push(`期望 schema_version=1，实际为 ${config.schema_version}`);
    return result;
  }

  // 检查 host.executable
  if (config.host?.executable) {
    if (isCustomHostPath(config.host.executable)) {
      result.warnings.push(`检测到自定义 Host 路径: ${config.host.executable}`);
      result.errors.push('LEGACY_CUSTOM_HOST_UNSUPPORTED: 自定义 Host 路径需要人工核对');
      result.can_apply = false;
      result.reason = '存在自定义 Host 路径，需要人工核对';
      return result;
    }
    result.removed_fields.push('host.executable');
  }

  // 检查 host.required
  if (config.host?.required !== undefined) {
    result.removed_fields.push('host.required');
  }

  // 检查 agy_accounts.auth_host_executable
  if (config.agy_accounts?.auth_host_executable) {
    if (isCustomHostPath(config.agy_accounts.auth_host_executable)) {
      result.warnings.push(`检测到自定义 Auth Host 路径: ${config.agy_accounts.auth_host_executable}`);
      result.errors.push('LEGACY_CUSTOM_HOST_UNSUPPORTED: 自定义 Auth Host 路径需要人工核对');
      result.can_apply = false;
      result.reason = '存在自定义 Auth Host 路径，需要人工核对';
      return result;
    }
    result.removed_fields.push('agy_accounts.auth_host_executable');
  }

  // 统计保留字段
  const allFields = Object.keys(config);
  result.preserved_fields = allFields.filter(f => !['host'].includes(f));

  // 生成迁移后的配置
  const migrated = { ...config };
  migrated.schema_version = 2;
  delete migrated.host;
  if (migrated.agy_accounts) {
    delete migrated.agy_accounts.auth_host_executable;
  }

  result.output_hash = fileHash(stringify(migrated));
  result.success = true;
  result.can_apply = true;
  result.reason = '可以安全迁移';

  return result;
}

/**
 * 执行 apply 迁移
 */
function apply(configPath: string, expectedHash: string): MigrationResult {
  const content = readFileSync(configPath, 'utf8');
  const currentHash = fileHash(content);

  if (currentHash !== expectedHash) {
    return {
      success: false,
      input_hash: currentHash,
      removed_fields: [],
      preserved_fields: [],
      warnings: [],
      errors: ['CONFIG_CHANGED: 配置文件已变更，请重新 dry-run'],
      can_apply: false,
      reason: '配置文件已变更',
    };
  }

  // 创建备份
  const backupPath = configPath + '.backup.' + Date.now();
  copyFileSync(configPath, backupPath);

  // 执行迁移
  const config = parse(content);
  config.schema_version = 2;
  delete config.host;
  if (config.agy_accounts) {
    delete config.agy_accounts.auth_host_executable;
  }

  const migratedContent = stringify(config);
  writeFileSync(configPath, migratedContent, 'utf8');

  return {
    success: true,
    input_hash: currentHash,
    output_hash: fileHash(migratedContent),
    removed_fields: ['host.executable', 'host.required', 'agy_accounts.auth_host_executable'],
    preserved_fields: Object.keys(config).filter(f => !['host'].includes(f)),
    warnings: [`备份已保存到: ${backupPath}`],
    errors: [],
    can_apply: true,
    reason: '迁移完成',
  };
}

// 主程序
const args = process.argv.slice(2);
const configIdx = args.indexOf('--config');
const configPath = configIdx >= 0 ? resolve(args[configIdx + 1]) : null;
const isDryRun = args.includes('--dry-run');
const isApply = args.includes('--apply');
const expectedHashIdx = args.indexOf('--expected-sha256');
const expectedHash = expectedHashIdx >= 0 ? args[expectedHashIdx + 1] : null;

if (!configPath || (!isDryRun && !isApply)) {
  console.error('使用方法:');
  console.error('  pnpm exec tsx scripts/migrate-node-runtime.ts --config <path> --dry-run');
  console.error('  pnpm exec tsx scripts/migrate-node-runtime.ts --config <path> --apply --expected-sha256 <hash>');
  process.exit(1);
}

if (!existsSync(configPath)) {
  console.error(`配置文件不存在: ${configPath}`);
  process.exit(1);
}

let result: MigrationResult;

if (isDryRun) {
  result = dryRun(configPath);
} else {
  if (!expectedHash) {
    console.error('--apply 需要 --expected-sha256 参数');
    process.exit(1);
  }
  result = apply(configPath, expectedHash);
}

console.log(JSON.stringify(result, null, 2));
process.exit(result.success ? 0 : 1);
