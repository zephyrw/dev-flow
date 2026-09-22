import { normalize, resolve, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { createHash } from "node:crypto";
import type { NativeAgentAdapter, SessionIdentityResolutionInput, ResolvedSessionIdentity } from "./interface.js";

/**
 * 读取本地非敏感 CLI 账户身份（只读解码）
 */
export function readLocalAccountScope(adapterId: string, clientHome: string): string | undefined {
  try {
    if (adapterId === "codex") {
      const authFile = join(clientHome, "auth.json");
      if (existsSync(authFile)) {
        const data = JSON.parse(readFileSync(authFile, "utf8"));
        return data.account_id || data.email || data.user_id || undefined;
      }
      const configFile = join(clientHome, "config.json");
      if (existsSync(configFile)) {
        const data = JSON.parse(readFileSync(configFile, "utf8"));
        return data.account || data.profile || undefined;
      }
    } else if (adapterId === "agy") {
      const settingsFile = join(clientHome, "settings.json");
      if (existsSync(settingsFile)) {
        const data = JSON.parse(readFileSync(settingsFile, "utf8"));
        return data.active_account || data.account_id || data.email || undefined;
      }
    }
  } catch {}
  return undefined;
}

/**
 * 从实际有效配置文件读取 native-config 默认模型
 */
function readLocalConfiguredModel(adapterId: string, clientHome: string): string | undefined {
  try {
    if (adapterId === "codex") {
      const tomlFile = join(clientHome, "config.toml");
      if (existsSync(tomlFile)) {
        const tomlContent = readFileSync(tomlFile, "utf8");
        const m = tomlContent.match(/^\s*model\s*=\s*["']([^"']+)["']/m);
        if (m && m[1] && m[1] !== "default") return m[1];
      }
      const configFile = join(clientHome, "config.json");
      if (existsSync(configFile)) {
        const data = JSON.parse(readFileSync(configFile, "utf8"));
        if (data.model && data.model !== "default") return String(data.model);
      }
    } else if (adapterId === "agy") {
      const settingsFile = join(clientHome, "settings.json");
      if (existsSync(settingsFile)) {
        const data = JSON.parse(readFileSync(settingsFile, "utf8"));
        if (data.model && data.model !== "default") return String(data.model);
      }
    }
  } catch {}
  return undefined;
}

/**
 * 统一解析并规范化 client_scope_id (绝对路径且全小写)
 */
export function resolveClientScope(
  adapterId: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  let clientScope: string | undefined;
  if (adapterId === "codex") {
    clientScope = env.CODEX_HOME || join(homedir(), ".codex");
  } else if (adapterId === "agy") {
    clientScope = env.AGY_HOME || join(homedir(), ".gemini", "antigravity");
  } else {
    clientScope = env.DEVFLOW_CLIENT_SCOPE;
  }
  return clientScope ? normalize(resolve(clientScope)).toLowerCase() : undefined;
}

/**
 * 统一解析并规范化 workspace_identity
 */
export function resolveWorkspaceIdentity(
  primaryRoot: string,
  allWorkspaces?: Array<{ repo_id?: string; root: string; source_root?: string; common_dir?: string }>,
): string {
  if (Array.isArray(allWorkspaces) && allWorkspaces.length > 1) {
    const sorted = [...allWorkspaces].sort((a, b) => (a.repo_id ?? "").localeCompare(b.repo_id ?? ""));
    const segments = sorted.map((w) => {
      const rId = w.repo_id ?? "main";
      const rRoot = normalize(resolve(w.root)).toLowerCase();
      const rSrc = normalize(resolve(w.source_root ?? w.root)).toLowerCase();
      const rCommon = w.common_dir ? normalize(resolve(w.common_dir)).toLowerCase() : "";
      return `${rId}:${rRoot}:${rSrc}:${rCommon}`;
    });
    return segments.join(";");
  }
  return primaryRoot ? normalize(resolve(primaryRoot)).toLowerCase() : "";
}

/**
 * 依据 CW2-D05 / §8.2 规范：在复用前解析真实会话身份
 * 绝不填充固定假 default，无法确认的字段如实列入 missing_fields
 */
export async function resolveSessionIdentity(
  adapter: NativeAgentAdapter,
  input: SessionIdentityResolutionInput,
): Promise<ResolvedSessionIdentity> {
  if (adapter.resolveSessionIdentity) {
    return adapter.resolveSessionIdentity(input);
  }

  const profile = input.frozenProfile;
  const env = input.effectiveEnvironment || {};
  const missing: string[] = [];

  // 1. 本地主机身份 (稳定主机标识)
  let hostId = env.DEVFLOW_HOST_ID || process.env.DEVFLOW_HOST_ID;
  if (!hostId) {
    const host = hostname();
    if (host && host.trim()) {
      hostId = host.trim().toLowerCase();
    } else {
      missing.push("host_id");
    }
  }

  // 2. 解析 CLI 安装与配置域 (client_scope)
  const clientScope = resolveClientScope(profile.adapterId, env);
  if (!clientScope) {
    missing.push("client_scope_id");
  }

  // 3. 解析账户身份 (account_scope)
  let accountScope = env.DEVFLOW_ACCOUNT_SCOPE || env.DEVFLOW_PROVIDER_ACCOUNT;
  if (!accountScope && clientScope) {
    accountScope = readLocalAccountScope(profile.adapterId, clientScope);
  }
  if (!accountScope || accountScope === "default-account" || accountScope === "default") {
    missing.push("provider_account_scope");
  }

  // 4. 解析模型事实 (canonical_model_id) - CW3-F04: 配置读取优先于 DEVFLOW_RESOLVED_MODEL
  let modelId: string | undefined;
  if (profile.modelSelection === "explicit" && profile.modelId && profile.modelId !== "default") {
    modelId = profile.modelId;
  } else if (profile.modelSelection === "native-config" && clientScope) {
    const configuredModel = readLocalConfiguredModel(profile.adapterId, clientScope);
    modelId = configuredModel || env.DEVFLOW_RESOLVED_MODEL;
  }

  if (!modelId || modelId === "default" || modelId === "native-config" || modelId === "CLI_DEFAULT_MODEL") {
    missing.push("canonical_model_id");
  }

  // 5. 工作区身份规范化 - CW3-F04 / CW4-F04: 完整 repo 映射生成稳定 workspace 身份
  const normRoot = resolveWorkspaceIdentity(input.workspace.root, input.workspace.all_workspaces);
  if (!normRoot) {
    missing.push("workspace_identity");
  }

  if (missing.length > 0) {
    return {
      adapter_id: profile.adapterId,
      host_id: hostId ?? "",
      client_scope_id: clientScope ?? "",
      provider_account_scope: accountScope ?? "",
      canonical_model_id: modelId ?? "",
      workspace_identity: normRoot,
      missing_fields: missing,
      resolved: false,
      unresolved_reason: `无法解析真实会话身份，缺少必需字段: ${missing.join(", ")}`,
    };
  }

  return {
    adapter_id: profile.adapterId,
    host_id: hostId!,
    client_scope_id: clientScope!,
    provider_account_scope: accountScope!,
    canonical_model_id: modelId!,
    workspace_identity: normRoot,
    resolved: true,
  };
}
