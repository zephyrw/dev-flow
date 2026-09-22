import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize, resolve } from "node:path";
import { resolveSessionIdentity } from "../../packages/adapters/sdk/src/identity.js";
import type { NativeAgentAdapter } from "../../packages/adapters/sdk/src/interface.js";

describe("CW2-T10: CLI 会话真实身份解析与隔离集成测试", () => {
  let tempDir: string;
  let codexHome: string;
  let agyHome: string;
  let fakeWorkspaceRoot: string;

  const dummyAdapter: NativeAgentAdapter = {
    id: "codex",
    name: "Codex Adapter",
  } as any;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "devflow-identity-test-"));
    codexHome = join(tempDir, "fake-codex-home");
    agyHome = join(tempDir, "fake-agy-home");
    fakeWorkspaceRoot = join(tempDir, "test-workspace");
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(agyHome, { recursive: true });
    mkdirSync(fakeWorkspaceRoot, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("CW2-T10: native-config 正确读取配置中的实际模型与账户，不依赖假 default 字符串", async () => {
    // 写入 Codex 配置文件，不设置任何环境变量
    writeFileSync(
      join(codexHome, "config.json"),
      JSON.stringify({
        model: "o3-mini",
        account: "user-codex-org-123",
      }),
      "utf8",
    );

    const result = await resolveSessionIdentity(dummyAdapter, {
      frozenProfile: {
        id: "p1",
        revision: 1,
        adapterId: "codex",
        modelSelection: "native-config",
        options: {},
      } as any,
      effectiveEnvironment: {
        CODEX_HOME: codexHome,
        DEVFLOW_HOST_ID: "testhost-01",
      },
      workspace: {
        root: fakeWorkspaceRoot,
      },
    });

    expect(result.resolved).toBe(true);
    expect(result.canonical_model_id).toBe("o3-mini");
    expect(result.provider_account_scope).toBe("user-codex-org-123");
    expect(result.client_scope_id).toBe(normalize(resolve(codexHome)).toLowerCase());
    expect(result.host_id).toBe("testhost-01");
  });

  it("CW2-T10: 缺必需字段时如实报告 missing_fields，绝不填写入假默认值", async () => {
    // 空目录，无 config.json
    const emptyHome = join(tempDir, "empty-codex-home");
    mkdirSync(emptyHome, { recursive: true });

    const result = await resolveSessionIdentity(dummyAdapter, {
      frozenProfile: {
        id: "p2",
        revision: 1,
        adapterId: "codex",
        modelSelection: "native-config",
        options: {},
      } as any,
      effectiveEnvironment: {
        CODEX_HOME: emptyHome,
        DEVFLOW_HOST_ID: "testhost-01",
      },
      workspace: {
        root: fakeWorkspaceRoot,
      },
    });

    expect(result.resolved).toBe(false);
    expect(result.missing_fields).toContain("canonical_model_id");
    expect(result.missing_fields).toContain("provider_account_scope");
    expect(result.canonical_model_id).not.toBe("default");
    expect(result.provider_account_scope).not.toBe("default-account");
  });

  it("CW2-T10: explicit 模式不同账户或不同 CLI home 会解析为不同身份键，防止混键", async () => {
    const res1 = await resolveSessionIdentity(dummyAdapter, {
      frozenProfile: {
        id: "p3",
        revision: 1,
        adapterId: "codex",
        modelSelection: "explicit",
        modelId: "gpt-4o",
        options: {},
      } as any,
      effectiveEnvironment: {
        CODEX_HOME: codexHome,
        DEVFLOW_ACCOUNT_SCOPE: "acc-A",
        DEVFLOW_HOST_ID: "testhost-01",
      },
      workspace: { root: fakeWorkspaceRoot },
    });

    const res2 = await resolveSessionIdentity(dummyAdapter, {
      frozenProfile: {
        id: "p3",
        revision: 1,
        adapterId: "codex",
        modelSelection: "explicit",
        modelId: "gpt-4o",
        options: {},
      } as any,
      effectiveEnvironment: {
        CODEX_HOME: codexHome,
        DEVFLOW_ACCOUNT_SCOPE: "acc-B", // 切换账户
        DEVFLOW_HOST_ID: "testhost-01",
      },
      workspace: { root: fakeWorkspaceRoot },
    });

    expect(res1.resolved).toBe(true);
    expect(res2.resolved).toBe(true);
    expect(res1.provider_account_scope).toBe("acc-A");
    expect(res2.provider_account_scope).toBe("acc-B");
    expect(res1.provider_account_scope).not.toBe(res2.provider_account_scope);
  });

  it("CW2-T10: AGY 适配器即使无外部 accounts 服务也不崩溃，从本地 settings.json 解析", async () => {
    const agyAdapter: NativeAgentAdapter = {
      id: "agy",
      name: "Antigravity Adapter",
    } as any;

    writeFileSync(
      join(agyHome, "settings.json"),
      JSON.stringify({
        model: "gemini-2.5-pro",
        active_account: "agy-user-999@domain.com",
      }),
      "utf8",
    );

    const result = await resolveSessionIdentity(agyAdapter, {
      frozenProfile: {
        id: "p-agy-1",
        revision: 1,
        adapterId: "agy",
        modelSelection: "native-config",
        options: {},
      } as any,
      effectiveEnvironment: {
        AGY_HOME: agyHome,
        DEVFLOW_HOST_ID: "testhost-01",
      },
      workspace: { root: fakeWorkspaceRoot },
    });

    expect(result.resolved).toBe(true);
    expect(result.canonical_model_id).toBe("gemini-2.5-pro");
    expect(result.provider_account_scope).toBe("agy-user-999@domain.com");
  });

  it("CW2-T10: claude-code native-config 读取 settings.json 模型，无账户时用占位值", async () => {
    const claudeHome = join(tempDir, "fake-claude-home");
    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(
      join(claudeHome, "settings.json"),
      JSON.stringify({ model: "claude-sonnet-4-20250514" }),
      "utf8",
    );

    const claudeAdapter: NativeAgentAdapter = {
      id: "claude-code",
      name: "Claude Code Adapter",
    } as any;

    const result = await resolveSessionIdentity(claudeAdapter, {
      frozenProfile: {
        id: "p-claude-1",
        revision: 1,
        adapterId: "claude-code",
        modelSelection: "native-config",
        options: {},
      } as any,
      effectiveEnvironment: {
        CLAUDE_HOME: claudeHome,
        DEVFLOW_HOST_ID: "testhost-01",
      },
      workspace: { root: fakeWorkspaceRoot },
    });

    expect(result.resolved).toBe(true);
    expect(result.canonical_model_id).toBe("claude-sonnet-4-20250514");
    expect(result.provider_account_scope).toBe("_");
    expect(result.client_scope_id).toBe(normalize(resolve(claudeHome)).toLowerCase());
  });

  it("CW2-T10: claude-code 读取 .env.ANTHROPIC_MODEL 作为 fallback", async () => {
    const claudeHome = join(tempDir, "claude-env-model");
    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(
      join(claudeHome, "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_MODEL: "claude-opus-4-20250514" } }),
      "utf8",
    );

    const claudeAdapter: NativeAgentAdapter = {
      id: "claude-code",
      name: "Claude Code Adapter",
    } as any;

    const result = await resolveSessionIdentity(claudeAdapter, {
      frozenProfile: {
        id: "p-claude-2",
        revision: 1,
        adapterId: "claude-code",
        modelSelection: "native-config",
        options: {},
      } as any,
      effectiveEnvironment: {
        CLAUDE_HOME: claudeHome,
        DEVFLOW_HOST_ID: "testhost-01",
      },
      workspace: { root: fakeWorkspaceRoot },
    });

    expect(result.resolved).toBe(true);
    expect(result.canonical_model_id).toBe("claude-opus-4-20250514");
  });

  it("CW2-T10: mimo-code native-config 读取 config.json 模型，无账户时用占位值", async () => {
    const mimoHome = join(tempDir, "fake-mimo-home");
    mkdirSync(mimoHome, { recursive: true });
    writeFileSync(
      join(mimoHome, "settings.json"),
      JSON.stringify({ model: "xiaomi/mimo-v2.6-pro" }),
      "utf8",
    );

    const mimoAdapter: NativeAgentAdapter = {
      id: "mimo-code",
      name: "MiMo Code Adapter",
    } as any;

    const result = await resolveSessionIdentity(mimoAdapter, {
      frozenProfile: {
        id: "p-mimo-1",
        revision: 1,
        adapterId: "mimo-code",
        modelSelection: "native-config",
        options: {},
      } as any,
      effectiveEnvironment: {
        MIMO_HOME: mimoHome,
        DEVFLOW_HOST_ID: "testhost-01",
      },
      workspace: { root: fakeWorkspaceRoot },
    });

    expect(result.resolved).toBe(true);
    expect(result.canonical_model_id).toBe("xiaomi/mimo-v2.6-pro");
    expect(result.provider_account_scope).toBe("_");
  });

  it("CW2-T10: 无本地模型配置时 canonical_model_id 缺失，native-config resolved false", async () => {
    const emptyClaudeHome = join(tempDir, "empty-claude-home");
    mkdirSync(emptyClaudeHome, { recursive: true });
    // 不写入 settings.json

    const claudeAdapter: NativeAgentAdapter = {
      id: "claude-code",
      name: "Claude Code Adapter",
    } as any;

    const result = await resolveSessionIdentity(claudeAdapter, {
      frozenProfile: {
        id: "p-claude-empty",
        revision: 1,
        adapterId: "claude-code",
        modelSelection: "native-config",
        options: {},
      } as any,
      effectiveEnvironment: {
        CLAUDE_HOME: emptyClaudeHome,
        DEVFLOW_HOST_ID: "testhost-01",
      },
      workspace: { root: fakeWorkspaceRoot },
    });

    expect(result.resolved).toBe(false);
    expect(result.missing_fields).toContain("canonical_model_id");
  });

  it("CW2-T10: explicit 模式直接使用 modelId，不依赖本地配置", async () => {
    const noConfigHome = join(tempDir, "no-config-home");
    mkdirSync(noConfigHome, { recursive: true });

    const mimoAdapter: NativeAgentAdapter = {
      id: "mimo-code",
      name: "MiMo Code Adapter",
    } as any;

    const result = await resolveSessionIdentity(mimoAdapter, {
      frozenProfile: {
        id: "p-mimo-explicit",
        revision: 1,
        adapterId: "mimo-code",
        modelSelection: "explicit",
        modelId: "xiaomi/mimo-v2.6-flash",
        options: {},
      } as any,
      effectiveEnvironment: {
        MIMO_HOME: noConfigHome,
        DEVFLOW_HOST_ID: "testhost-01",
      },
      workspace: { root: fakeWorkspaceRoot },
    });

    expect(result.resolved).toBe(true);
    expect(result.canonical_model_id).toBe("xiaomi/mimo-v2.6-flash");
    expect(result.provider_account_scope).toBe("_");
  });
});
