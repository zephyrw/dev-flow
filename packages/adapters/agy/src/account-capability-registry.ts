import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

export interface CertifiedAdapterEntry {
  version: string;
  sha256?: string;
  adapterRevision: number;
  capabilities: {
    identity: boolean;
    usage: boolean;
    login: boolean;
    modelProbe: boolean;
  };
  supportedPools: string[];
}

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
  capabilities: {
    identity: { status: "verified" | "unverified" | "unsupported"; reason?: string };
    dual_quota: { status: "verified" | "unverified" | "unsupported"; reason?: string };
    interactive_login: { status: "verified" | "unverified" | "unsupported"; reason?: string };
    model_access: { status: "verified" | "unverified" | "unsupported"; reason?: string };
  };
  supported: boolean;
  reason?: string;
}

// 经过官方审查认证的已知版本列表（默认为空，或通过显式审查配置录入）
const certifiedRegistry: CertifiedAdapterEntry[] = [];

export function registerCertifiedAdapter(entry: CertifiedAdapterEntry): void {
  const existing = certifiedRegistry.findIndex(
    (e) => e.version === entry.version && (!e.sha256 || !entry.sha256 || e.sha256 === entry.sha256),
  );
  if (existing >= 0) {
    certifiedRegistry[existing] = entry;
  } else {
    certifiedRegistry.push(entry);
  }
}

export function clearCertifiedAdaptersForTest(): void {
  certifiedRegistry.length = 0;
}

export function lookupCertifiedAdapter(
  version: string,
  sha256?: string,
): CertifiedAdapterEntry | undefined {
  return certifiedRegistry.find((entry) => {
    if (entry.version !== version) return false;
    if (entry.sha256 && sha256 && entry.sha256 !== sha256) return false;
    return true;
  });
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
  },
  evidence?: {
    identityVerified?: boolean;
    dualQuotaVerified?: boolean;
    loginVerified?: boolean;
    modelAccessVerified?: boolean;
    evidenceKind?: string;
  },
): CapabilitySnapshot {
  const isWindows = (hostCaps?.platform ?? process.platform) === "win32";
  const hostReady =
    isWindows &&
    hostCaps?.dpapi_available === true &&
    hostCaps?.cred_manager_available === true &&
    hostCaps?.named_mutex_available === true;

  const version = cliInfo?.version ?? "unknown";
  const sha256 = cliInfo?.sha256;
  const hasCli = !!cliInfo && version !== "unknown";

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

  const loginStatus = !isWindows || !hostReady || !hasCli
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
  const reason = !isWindows
    ? "AGY 账号轮换需要 Windows 凭据 API"
    : !hostReady
      ? "Windows 宿主安全能力（DPAPI / 凭据管理器 / 互斥锁）未就绪"
      : !hasCli
        ? "未检测到已安装的官方 AGY CLI"
        : undefined;

  const certified = hasCli ? lookupCertifiedAdapter(version, sha256) : undefined;
  return {
    cli_path: cliInfo?.path,
    cli_version: version,
    cli_sha256: sha256,
    adapter_revision: certified?.adapterRevision,
    host_platform: hostCaps?.platform ?? process.platform,
    host_version: hostCaps?.version ?? "unknown",
    dpapi_available: hostCaps?.dpapi_available ?? false,
    cred_manager_available: hostCaps?.cred_manager_available ?? false,
    named_mutex_available: hostCaps?.named_mutex_available ?? false,
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
        reason: loginStatus === "verified" ? undefined : (!isWindows ? "仅支持 Windows 环境" : !hostReady ? "凭据宿主未就绪" : "待执行登录核验"),
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
