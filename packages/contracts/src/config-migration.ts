import {
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  fsyncSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { parseDocument } from "yaml";
import { ConfigSchema, loadConfig, normalizeLegacyConfig } from "./config.js";

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
  backup_path?: string;
}
export function fileHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** One transformation for dry-run, apply, setup and installer; mutate YAML nodes to retain comments. */
export function planConfigMigration(content: string): {
  result: MigrationResult;
  output?: string;
} {
  const result: MigrationResult = {
    success: false,
    input_hash: fileHash(content),
    removed_fields: [],
    preserved_fields: [],
    warnings: [],
    errors: [],
    can_apply: false,
  };
  try {
    const document = parseDocument(content);
    if (document.errors.length) throw new Error("INVALID_CONFIG_YAML");
    const raw: unknown = document.toJS();
    const normalized = normalizeLegacyConfig(raw) as Record<string, unknown>;
    ConfigSchema.parse(raw); // Includes the same legacy/custom-path validation as the runtime loader.
    if (document.has("host")) {
      const host = document.get("host", true);
      for (const key of ["executable", "required"])
        if (document.hasIn(["host", key]))
          result.removed_fields.push("host." + key);
      if (
        host &&
        typeof host === "object" &&
        "commentBefore" in host &&
        host.commentBefore
      )
        document.commentBefore = [document.commentBefore, host.commentBefore]
          .filter(Boolean)
          .join("\n");
      document.delete("host");
    }
    if (document.hasIn(["agy_accounts", "auth_host_executable"])) {
      document.deleteIn(["agy_accounts", "auth_host_executable"]);
      result.removed_fields.push("agy_accounts.auth_host_executable");
    }
    document.set("schema_version", 2);
    result.preserved_fields = Object.keys(normalized).filter(
      (key) => key !== "schema_version",
    );
    const output =
      result.removed_fields.length === 0 &&
      (raw as Record<string, unknown>).schema_version === 2
        ? content
        : document.toString();
    ConfigSchema.parse(parseDocument(output).toJS());
    result.success = result.can_apply = true;
    result.output_hash = fileHash(output);
    return { result, output };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    result.errors.push(
      /^[A-Z_]{1,80}$/.test(message) ? message : "INVALID_CONFIG",
    );
    return { result };
  }
}
export function dryRunMigration(path: string): MigrationResult {
  return planConfigMigration(readFileSync(path, "utf8")).result;
}

/** Caller owns the controller lock. The short file lock serializes migration writers. */
export function applyMigration(
  path: string,
  expectedHash: string,
): MigrationResult {
  const content = readFileSync(path, "utf8");
  const { result, output } = planConfigMigration(content);
  if (result.input_hash !== expectedHash) {
    return {
      ...result,
      success: false,
      can_apply: false,
      errors: ["CONFIG_CHANGED"],
    };
  }
  if (!result.can_apply || output === undefined || output === content)
    return result;
  const lockPath = path + ".migration.lock";
  const fd = openSync(lockPath, "wx", 0o600);
  const temp = path + ".tmp." + randomUUID();
  try {
    if (fileHash(readFileSync(path, "utf8")) !== expectedHash)
      throw new Error("CONFIG_CHANGED");
    const backup = path + ".backup." + randomUUID();
    const backupFd = openSync(backup, "wx", 0o600);
    try {
      writeFileSync(backupFd, content);
      fsyncSync(backupFd);
    } finally {
      closeSync(backupFd);
    }
    const outputFd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(outputFd, output);
      fsyncSync(outputFd);
    } finally {
      closeSync(outputFd);
    }
    if (fileHash(readFileSync(path, "utf8")) !== expectedHash)
      throw new Error("CONFIG_CHANGED");
    renameSync(temp, path);
    return { ...result, backup_path: backup };
  } catch (error) {
    return {
      ...result,
      success: false,
      can_apply: false,
      errors: [
        error instanceof Error && error.message === "CONFIG_CHANGED"
          ? "CONFIG_CHANGED"
          : "CONFIG_MIGRATION_FAILED",
      ],
    };
  } finally {
    closeSync(fd);
    unlinkSync(lockPath);
    try {
      unlinkSync(temp);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
export const loadConfigCompat = loadConfig;
