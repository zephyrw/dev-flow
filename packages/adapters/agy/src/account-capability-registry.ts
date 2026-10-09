import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { credentialCapabilitiesReady } from "../../../agy-accounts/src/credential-capabilities.js";

const execute = promisify(execFile);

export interface CapabilitySnapshot {
  cli_path?: string;
  cli_version?: string;
  cli_sha256?: string;
  adapter_revision?: number;
  host_platform: string;
  host_version: string;
  dpapi_available: boolean;
  cred_manager_available: boolean;
  named_mutex_available: boolean;
  encrypted_storage_available?: boolean;
  credential_store_available?: boolean;
  domain_lock_available?: boolean;
  capabilities: {
    identity: { status: "verified" | "unverified" | "unsupported"; reason?: string };
    dual_quota: { status: "verified" | "unverified" | "unsupported"; reason?: string };
    interactive_login: { status: "verified" | "unverified" | "unsupported"; reason?: string };
    model_access: { status: "verified" | "unverified" | "unsupported"; reason?: string };
  };
  supported: boolean;
  reason?: string;
}

export async function inspectCliBinary(cliPath: string): Promise<{
  version: string;
  sha256: string;
} | null> {
  if (!existsSync(cliPath)) return null;
  try {
    const bytes = readFileSync(cliPath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let version = "unknown";
    try {
      const { stdout } = await execute(cliPath, ["--version"], { timeout: 5000, windowsHide: true });
      const match = /(\d+\.\d+\.\d+)/.exec(stdout);
      if (match && match[1]) version = match[1];
    } catch {}
    return { version, sha256 };
  } catch {
    return null;
  }
}

export function evaluateCapabilitySnapshot(
  cliInfo: { version?: string; sha256?: string; path?: string } | null,
  hostCaps?: {
    platform?: string;
    version?: string;
    dpapi_available?: boolean;
    cred_manager_available?: boolean;
    named_mutex_available?: boolean;
    encrypted_storage_available?: boolean;
    credential_store_available?: boolean;
    domain_lock_available?: boolean;
  },
  evidence?: {
    identityVerified?: boolean;
    dualQuotaVerified?: boolean;
    loginVerified?: boolean;
    modelAccessVerified?: boolean;
    evidenceKind?: string;
  },
): CapabilitySnapshot {
  const platform = hostCaps?.platform ?? process.platform;
  const supportedPlatform = platform === "win32" || platform === "darwin";
  const hostReady = credentialCapabilitiesReady({ ...hostCaps, platform });

  const version = cliInfo?.version ?? "unknown";
  const sha256 = cliInfo?.sha256;
  const hasCli = !!(cliInfo?.path || cliInfo?.sha256);

  // 区分 detected / supported / verified (D02)
  // 必须有真实核验证据才标记为 verified；仅检测到版本不能伪造 verified
  const identityStatus = !hasCli
    ? "unsupported"
    : evidence?.identityVerified
      ? "verified"
      : "unverified";

  const quotaStatus = !hasCli
    ? "unsupported"
    : evidence?.dualQuotaVerified
      ? "verified"
      : "unverified";

  const loginStatus = !hostReady || !hasCli
    ? "unsupported"
    : evidence?.loginVerified
      ? "verified"
      : "unverified";

  const modelStatus = !hasCli
    ? "unsupported"
    : evidence?.modelAccessVerified
      ? "verified"
      : "unverified";

  // 基础环境支持状态：宿主就绪且检测到可用 CLI，允许进入受管登录与录入向导，不形成循环依赖
  const supported = hostReady && hasCli;
  const reason = !supportedPlatform
    ? "当前平台未实现 AGY 账号凭据宿主"
    : !hostReady
      ? "凭据宿主的加密存储、系统凭据库或域锁未就绪"
      : !hasCli
        ? "未检测到已安装的官方 AGY CLI"
        : undefined;

  return {
    cli_path: cliInfo?.path,
    cli_version: version,
    cli_sha256: sha256,
    host_platform: hostCaps?.platform ?? process.platform,
    host_version: hostCaps?.version ?? "unknown",
    dpapi_available: hostCaps?.dpapi_available ?? false,
    cred_manager_available: hostCaps?.cred_manager_available ?? false,
    named_mutex_available: hostCaps?.named_mutex_available ?? false,
    encrypted_storage_available: hostCaps?.encrypted_storage_available,
    credential_store_available: hostCaps?.credential_store_available,
    domain_lock_available: hostCaps?.domain_lock_available,
    capabilities: {
      identity: {
        status: identityStatus,
        reason: identityStatus === "verified" ? undefined : (hasCli ? "待完成身份核验" : "未检测到 CLI"),
      },
      dual_quota: {
        status: quotaStatus,
        reason: quotaStatus === "verified" ? undefined : (hasCli ? "待完成双额度核验" : "未检测到 CLI"),
      },
      interactive_login: {
        status: loginStatus,
        reason: loginStatus === "verified" ? undefined : (!supportedPlatform ? "当前平台未实现凭据宿主" : !hostReady ? "凭据宿主未就绪" : "待执行登录核验"),
      },
      model_access: {
        status: modelStatus,
        reason: modelStatus === "verified" ? undefined : (hasCli ? "待完成模型访问核验" : "未检测到 CLI"),
      },
    },
    supported,
    reason,
  };
}
