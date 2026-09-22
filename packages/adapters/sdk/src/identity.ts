import { normalize, resolve, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { createHash } from "node:crypto";
import type { NativeAgentAdapter, SessionIdentityResolutionInput, ResolvedSessionIdentity } from "./interface.js";

/**
 * 从 JSON 配置文件读取常见账户字段
 */
function readAccountFromJson(filePath: string): string | undefined {
  try {
    if (!existsSync(filePath)) return undefined;
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    return data.active_account || data.account_id || data.email
      || data.user_id || data.account || data.profile
      || undefined;
  } catch {}
  return undefined;
}

/**
 * 读取本地非敏感 CLI 账户身份（只读解码）
 * 部分适配器（如 claude-code/grok-build）只有 API key 而无账户概念，
 * 此时返回 undefined，由调用方决定是否使用占位值。
 */
export function readLocalAccountScope(adapterId: string, clientHome: string): string | undefined {
  try {
    switch (adapterId) {
      case "codex": {
        const authFile = join(clientHome, "auth.json");
        const fromAuth = readAccountFromJson(authFile);
        if (fromAuth) return fromAuth;
        return readAccountFromJson(join(clientHome, "config.json"));
      }
      case "agy":
        return readAccountFromJson(join(clientHome, "settings.json"));
      case "claude-code":
      case "grok-build":
      case "kimi-code":
      case "opencode":
      case "cursor-agent":
      case "mimo-code":
      case "qoder":
        return readAccountFromJson(join(clientHome, "settings.json"))
          ?? readAccountFromJson(join(clientHome, "config.json"));
      default:
        return undefined;
    }
  } catch {}
  return undefined;
}

/**
 * 从 JSON 配置文件读取 model 字段，通用逻辑
 */
function readModelFromJson(filePath: string): string | undefined {
  try {
    if (!existsSync(filePath)) return undefined;
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    if (data.model && data.model !== "default") return String(data.model);
  } catch {}
  return undefined;
}

/**
 * 从实际有效配置文件读取 native-config 默认模型
 * 路径映射与 packages/clients/src/installer.ts locateClientBaseDir 保持一致
 */
function readLocalConfiguredModel(adapterId: string, clientHome: string): string | undefined {
  try {
    switch (adapterId) {
      case "codex": {
        const tomlFile = join(clientHome, "config.toml");
        if (existsSync(tomlFile)) {
          const tomlContent = readFileSync(tomlFile, "utf8");
          const m = tomlContent.match(/^\s*model\s*=\s*["']([^"']+)["']/m);
          if (m && m[1] && m[1] !== "default") return m[1];
        }
        return readModelFromJson(join(clientHome, "config.json"));
      }
      case "agy":
        return readModelFromJson(join(clientHome, "settings.json"));
      case "claude-code": {
        // claude-code 同时支持 .model 和 .env.ANTHROPIC_MODEL
        // 逻辑与 packages/adapters/claude/src/model-configuration.ts readClaudeConfiguredModels 一致
        const settingsPath = join(clientHome, "settings.json");
        if (!existsSync(settingsPath)) return undefined;
        const data = JSON.parse(readFileSync(settingsPath, "utf8"));
        if (data.model && data.model !== "default") return String(data.model);
        if (data.env?.ANTHROPIC_MODEL && data.env.ANTHROPIC_MODEL !== "default") {
          return String(data.env.ANTHROPIC_MODEL);
        }
        return undefined;
      }
      case "grok-build":
        return readModelFromJson(join(clientHome, "settings.json"))
          ?? readModelFromJson(join(clientHome, "config.json"));
      case "kimi-code":
        return readModelFromJson(join(clientHome, "settings.json"))
          ?? readModelFromJson(join(clientHome, "config.json"));
      case "opencode":
        return readModelFromJson(join(clientHome, "settings.json"))
          ?? readModelFromJson(join(clientHome, "config.json"));
      case "cursor-agent":
        return readModelFromJson(join(clientHome, "settings.json"))
          ?? readModelFromJson(join(clientHome, "config.json"));
      case "mimo-code":
        return readModelFromJson(join(clientHome, "settings.json"))
          ?? readModelFromJson(join(clientHome, "config.json"));
      case "qoder":
        return readModelFromJson(join(clientHome, "settings.json"))
          ?? readModelFromJson(join(clientHome, "config.json"));
      default:
        return undefined;
    }
  } catch {}
  return undefined;
}

/**
 * 统一解析并规范化 client_scope_id (绝对路径且全小写)
 * 路径映射与 packages/clients/src/installer.ts locateClientBaseDir 保持一致
 */
export function resolveClientScope(
  adapterId: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const h = homedir();
  let clientScope: string | undefined;
  switch (adapterId) {
    case "codex":
      clientScope = env.CODEX_HOME || join(h, ".codex");
      break;
    case "agy":
      clientScope = env.AGY_HOME || join(h, ".gemini", "antigravity");
      break;
    case "claude-code":
      clientScope = env.CLAUDE_HOME || join(h, ".claude");
      break;
    case "grok-build":
      clientScope = env.GROK_HOME || join(h, ".grok");
      break;
    case "kimi-code":
      clientScope = env.KIMI_CODE_HOME || join(h, ".kimi-code");
      break;
    case "opencode":
      clientScope = env.OPENCODE_HOME || join(env.XDG_CONFIG_HOME || join(h, ".config"), "opencode");
      break;
    case "cursor-agent":
      clientScope = env.CURSOR_HOME || join(h, ".cursor");
      break;
    case "mimo-code":
      clientScope = env.MIMO_HOME || join(env.XDG_CONFIG_HOME || join(h, ".config"), "mimo");
      break;
    case "qoder":
      clientScope = env.QODER_HOME || join(h, ".qoder");
      break;
    default:
      clientScope = env.DEVFLOW_CLIENT_SCOPE;
      break;
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
  // 并非所有适配器都有本地账户体系（如 claude-code/grok-build 等只有 API key，无 account 概念）。
  // SessionBindingKeySchema 要求 provider_account_scope 非空，
  // 因此当适配器确实无账户信息时，用确定性占位值 "_" 而非阻断身份解析。
  let accountScope = env.DEVFLOW_ACCOUNT_SCOPE || env.DEVFLOW_PROVIDER_ACCOUNT;
  if (!accountScope && clientScope) {
    accountScope = readLocalAccountScope(profile.adapterId, clientScope);
  }
  if (!accountScope || accountScope === "default-account" || accountScope === "default") {
    // codex 和 agy 有明确的账户体系，缺失时如实报告
    if (profile.adapterId === "codex" || profile.adapterId === "agy") {
      missing.push("provider_account_scope");
    } else {
      accountScope = "_";
    }
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
