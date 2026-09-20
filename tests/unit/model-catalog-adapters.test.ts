import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CATALOG_OUTPUT_LIMIT,
  ModelCatalogSchema,
  type ModelCatalog,
  type ModelEntry,
} from "../../packages/contracts/src/model-catalog.js";
import type { RunContext } from "../../packages/adapters/sdk/src/interface.js";
import {
  binaryNamesForLookup,
  isQoderProductIdentity,
} from "../../packages/adapters/sdk/src/registry.js";
import { clientInvocation } from "../../packages/adapters/sdk/src/invocation.js";
import { discoverModels as discoverClaudeModels } from "../../packages/adapters/claude/src/model-configuration.js";
import { discoverModels as discoverGrokModels } from "../../packages/adapters/grok/src/model-configuration.js";
import { discoverModels as discoverKimiModels } from "../../packages/adapters/kimi/src/model-configuration.js";
import { discoverModels as discoverQoderModels } from "../../packages/adapters/qoder/src/model-configuration.js";
import { discoverModels as discoverOpenCodeModels } from "../../packages/adapters/opencode/src/model-configuration.js";

const FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/model-catalog",
);
const DISCOVERED_AT = "2026-09-18T09:00:00.000Z";

type ExpectedEffort = {
  status?: string;
  transport?: string;
  values?: string[];
  fixedValue?: string;
  defaultValue?: string;
};

type ExpectedEntry = {
  nativeId: string;
  hidden?: boolean;
  label?: string;
  selectionKind?: string;
  effort?: ExpectedEffort;
};

type ExpectedCatalog = {
  visibleNativeIds: string[];
  rejectedLabels?: string[];
  entries: Record<string, ExpectedEntry>;
};

function readFixture(adapter: string, name: string): string {
  return readFileSync(join(FIXTURE_ROOT, adapter, name), "utf8");
}

function readNamedOrThrow(adapter: string, names: string[]): string {
  for (const name of names) {
    const path = join(FIXTURE_ROOT, adapter, name);
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  throw new Error(`${adapter} 缺少 ${names.join("/")}`);
}

function readExpected(adapter: string): ExpectedCatalog {
  return JSON.parse(readFixture(adapter, "expected.json")) as ExpectedCatalog;
}

function requireEntry(catalog: ModelCatalog, nativeId: string): ModelEntry {
  const entry = catalog.entries.find((item) => item.nativeId === nativeId);
  expect(entry, nativeId).toBeDefined();
  return entry!;
}

function assertEffort(entry: ModelEntry, expected?: ExpectedEffort): void {
  if (!expected) return;
  if (expected.status) expect(entry.effort.status).toBe(expected.status);
  if (expected.transport) expect(entry.effort.transport).toBe(expected.transport);
  if (expected.values) expect(entry.effort.values).toEqual(expected.values);
  if (expected.fixedValue) expect(entry.effort.fixedValue).toBe(expected.fixedValue);
  if (expected.defaultValue) {
    expect(entry.effort.defaultValue).toBe(expected.defaultValue);
  }
}

function assertExpected(catalog: ModelCatalog, expected: ExpectedCatalog): void {
  expect(ModelCatalogSchema.parse(catalog).status).toBe("fresh");
  expect(catalog.entries.map((entry) => entry.nativeId)).toEqual(
    expected.visibleNativeIds,
  );
  for (const label of expected.rejectedLabels ?? []) {
    expect(catalog.entries.some((entry) => entry.nativeId === label)).toBe(false);
    expect(catalog.entries.some((entry) => entry.label === label)).toBe(false);
  }
  for (const [nativeId, expectedEntry] of Object.entries(expected.entries)) {
    const entry = requireEntry(catalog, nativeId);
    expect(entry.nativeId).toBe(expectedEntry.nativeId);
    if (expectedEntry.hidden !== undefined) expect(entry.hidden).toBe(expectedEntry.hidden);
    if (expectedEntry.label) expect(entry.label).toBe(expectedEntry.label);
    if (expectedEntry.selectionKind) {
      expect(entry.selectionKind).toBe(expectedEntry.selectionKind);
    }
    assertEffort(entry, expectedEntry.effort);
  }
}

function failedCatalog(
  discover: (input: {
    stdout: string;
    stderr?: string;
    discoveredAt: string;
    scopeHash: string;
  }) => Promise<ModelCatalog>,
  adapter: string,
  stdout: string,
  stderr?: string,
): Promise<ModelCatalog> {
  return discover({
    stdout,
    stderr,
    discoveredAt: DISCOVERED_AT,
    scopeHash: `${adapter}-fail`,
  });
}

function runContext(
  adapter: RunContext["toolProfile"]["adapterId"],
  extra: {
    purpose?: RunContext["purpose"];
    modelId?: string;
    effort?: string;
    conversationId?: string;
    stage?: string;
  } = {},
): RunContext {
  const reasoning = extra.effort
    ? { mode: "explicit" as const, value: extra.effort }
    : { mode: "native-default" as const };
  return {
    workflowId: "wf_1",
    runId: extra.conversationId ? "run_resume" : "run_1",
    stage: extra.stage ?? "planning",
    epoch: 1,
    workspaceRoots: { repo1: "C:/fake/repo" },
    allowedPaths: ["app.txt"],
    purpose: extra.purpose ?? "planning",
    prompt: "ok",
    conversationId: extra.conversationId,
    toolProfile: {
      id: "prof",
      revision: 1,
      adapterId: adapter,
      modelSelection: extra.modelId ? "explicit" : "native-config",
      modelId: extra.modelId,
      reasoning,
      options: {},
    },
  };
}

describe("Claude / Grok / Kimi / Qoder / OpenCode 目录解析", () => {
  it("Claude 使用官方种子与已配置模型，opus-4-6 无 xhigh", async () => {
    const catalog = await discoverClaudeModels({
      stdout: readNamedOrThrow("claude-code", ["models-success.json"]),
      discoveredAt: DISCOVERED_AT,
      scopeHash: "claude-test",
    });
    assertExpected(catalog, readExpected("claude-code"));
    expect(requireEntry(catalog, "claude-opus-4-6").source).toBe("native-config");
    expect(requireEntry(catalog, "claude-opus-5").source).toBe("official-seed");
    expect(requireEntry(catalog, "claude-opus-4-6").effort.values).not.toContain(
      "xhigh",
    );
    expect(requireEntry(catalog, "claude-opus-5").effort.values).toContain("xhigh");
    expect(catalog.entries.some((entry) => entry.nativeId === "opusplan")).toBe(
      false,
    );
    const help = readFixture("claude-code", "help.txt");
    expect(help).toMatch(/--effort/);
    expect(help).not.toMatch(/^\s+models\b/m);
  });

  it("Grok grok-4.6 有 xhigh、grok-4.5 没有，自定义条目不继承官方表", async () => {
    const catalog = await discoverGrokModels({
      stdout: readNamedOrThrow("grok-build", ["models-success.txt"]),
      discoveredAt: DISCOVERED_AT,
      scopeHash: "grok-test",
    });
    assertExpected(catalog, readExpected("grok-build"));
    expect(requireEntry(catalog, "grok-4.6").source).toBe("native-cache");
    expect(requireEntry(catalog, "grok-4.5").effort.values).not.toContain("xhigh");
    expect(requireEntry(catalog, "kimi-k3-flash").effort.status).toBe("unknown");
    const help = readFixture("grok-build", "help.txt");
    expect(help).toMatch(/^\s+--reasoning-effort\b/m);
    expect(help).not.toMatch(/^\s+--no-auto-update\b/m);
  });

  it("Kimi 只读解析 config.toml，k3 支持 low/high/max 且不发明 --effort", async () => {
    const catalog = await discoverKimiModels({
      stdout: readNamedOrThrow("kimi-code", ["models-success.txt"]),
      discoveredAt: DISCOVERED_AT,
      scopeHash: "kimi-test",
    });
    assertExpected(catalog, readExpected("kimi-code"));
    expect(JSON.stringify(catalog)).not.toMatch(/api[_-]?key|sk-/i);
    expect(requireEntry(catalog, "kimi-code/k3").effort.transport).toBe("env");
    expect(requireEntry(catalog, "openai/gpt-4.1").effort.status).toBe("unknown");
    const help = readFixture("kimi-code", "help.txt");
    expect(help).not.toMatch(/^\s+--effort\b/m);
  });

  it("Kimi 解析时丢弃密钥字段", async () => {
    const catalog = await discoverKimiModels({
      stdout: `[models."kimi-code/k3"]
model = "k3"
provider = "managed:kimi-code"
support_efforts = ["low", "high", "max"]
api_key = "sk-test-should-not-leak"
`,
      discoveredAt: DISCOVERED_AT,
      scopeHash: "kimi-secret",
    });
    expect(catalog.status).toBe("fresh");
    expect(JSON.stringify(catalog)).not.toContain("sk-test-should-not-leak");
    expect(JSON.stringify(catalog)).not.toMatch(/api_key/i);
  });

  it("UT-M16 Qodercli 路径、帮助不含 plan，只解析已确认 nativeId", async () => {
    expect(binaryNamesForLookup("qodercli")).toEqual(["qodercli", "qoder"]);
    expect(binaryNamesForLookup("qoder")).toEqual(["qodercli", "qoder"]);
    expect(isQoderProductIdentity("qodercli 1.1.51\nQoder CLI")).toBe(true);
    expect(isQoderProductIdentity("cursor agent")).toBe(false);
    const help = readFixture("qoder", "help.txt");
    expect(help).toMatch(/--list-models/);
    expect(help).toMatch(/--reasoning-effort/);
    expect(help).toMatch(/dont_ask/);
    expect(help).not.toMatch(/permission-mode[^\n]*plan/);
    const catalog = await discoverQoderModels({
      stdout: readNamedOrThrow("qoder", ["models-success.txt"]),
      discoveredAt: DISCOVERED_AT,
      scopeHash: "qoder-test",
    });
    assertExpected(catalog, readExpected("qoder"));
    expect(requireEntry(catalog, "auto").selectionKind).toBe("native-router");
    const readonly = clientInvocation(
      "qoder",
      runContext("qoder", { purpose: "planning", modelId: "qwen-3.8-max", effort: "xhigh" }),
      "C:/qodercli.exe",
    );
    const modeAt = readonly.args.indexOf("--permission-mode");
    expect(modeAt).toBeGreaterThanOrEqual(0);
    expect(readonly.args[modeAt + 1]).toBe("dont_ask");
    expect(readonly.args).not.toContain("plan");
    expect(readonly.args).toContain("Read,Glob,Grep");
    expect(readonly.args).toContain("--reasoning-effort");
    expect(readonly.args).toContain("xhigh");
  });

  it("OpenCode verbose 保留 provider/model，有 variants 才开放档位", async () => {
    const catalog = await discoverOpenCodeModels({
      stdout: readNamedOrThrow("opencode", ["models-success.txt"]),
      discoveredAt: DISCOVERED_AT,
      scopeHash: "opencode-test",
    });
    assertExpected(catalog, readExpected("opencode"));
    const gpt = requireEntry(catalog, "openai/gpt-4.1");
    expect(gpt.nativeId).not.toContain("#");
    expect(gpt.effort.transport).toBe("variant-flag");
    expect(requireEntry(catalog, "anthropic/claude-sonnet-4-5").effort.status).toBe(
      "unknown",
    );
    const help = readFixture("opencode", "help.txt");
    expect(help).toMatch(/--variant/);
  });
});

describe("目录失败不得变成空目录成功", () => {
  it("各适配器失败/环境错误/超长输出保持 failed", async () => {
    const claudeFail = await failedCatalog(
      discoverClaudeModels,
      "claude-code",
      readNamedOrThrow("claude-code", ["models-failure.txt", "models-failure.json"]),
    );
    expect(claudeFail.status).toBe("failed");
    expect(claudeFail.errorCode).toBe("DISCOVERY_ENVIRONMENT_UNAVAILABLE");
    expect(claudeFail.entries).toEqual([]);

    const grokFail = await failedCatalog(
      discoverGrokModels,
      "grok-build",
      readNamedOrThrow("grok-build", ["models-failure.txt", "models-failure.json"]),
    );
    expect(grokFail.status).toBe("failed");
    expect(grokFail.status).not.toBe("fresh");
    expect(grokFail.entries).toEqual([]);

    const kimiFail = await failedCatalog(
      discoverKimiModels,
      "kimi-code",
      readNamedOrThrow("kimi-code", ["models-failure.txt", "models-failure.json"]),
    );
    expect(kimiFail.status).toBe("failed");
    expect(kimiFail.errorCode).toBe("DISCOVERY_ENVIRONMENT_UNAVAILABLE");
    expect(kimiFail.entries).toEqual([]);

    const qoderFail = await failedCatalog(
      discoverQoderModels,
      "qoder",
      readNamedOrThrow("qoder", ["models-failure.txt", "models-failure.json"]),
    );
    expect(qoderFail.status).toBe("failed");
    expect(qoderFail.entries).toEqual([]);

    const openFail = await failedCatalog(
      discoverOpenCodeModels,
      "opencode",
      readNamedOrThrow("opencode", ["models-failure.txt", "models-failure.json"]),
    );
    expect(openFail.status).toBe("failed");
    expect(openFail.errorCode).toBe("DISCOVERY_ENVIRONMENT_UNAVAILABLE");
    expect(openFail.entries).toEqual([]);

    const oversize = await discoverGrokModels({
      stdout: "x".repeat(CATALOG_OUTPUT_LIMIT + 8),
      discoveredAt: DISCOVERED_AT,
      scopeHash: "grok-oversize",
    });
    expect(oversize.status).toBe("failed");
    expect(oversize.errorCode).toBe("CATALOG_OUTPUT_TRUNCATED");
    expect(oversize.entries).toEqual([]);
  });
});

describe("clientInvocation 注入冻结模型选择", () => {
  it("Codex exec 与 resume 使用同一组 model/effort", () => {
    const execInv = clientInvocation(
      "codex",
      runContext("codex", {
        purpose: "implement",
        stage: "execute",
        modelId: "gpt-6-astra",
        effort: "xhigh",
      }),
      "C:/codex.exe",
    );
    const resumeInv = clientInvocation(
      "codex",
      runContext("codex", {
        purpose: "implement",
        stage: "execute",
        modelId: "gpt-6-astra",
        effort: "xhigh",
        conversationId: "conv-1",
      }),
      "C:/codex.exe",
    );
    expect(execInv.args).toContain("exec");
    expect(resumeInv.args).toContain("resume");
    expect(resumeInv.args).toContain("conv-1");
    for (const inv of [execInv, resumeInv]) {
      const modelAt = inv.args.indexOf("--model");
      expect(inv.args[modelAt + 1]).toBe("gpt-6-astra");
      expect(inv.args).toContain("-c");
      expect(inv.args).toContain('model_reasoning_effort="xhigh"');
    }
  });

  it("Claude 显式 effort 同步 CLAUDE_CODE_EFFORT_LEVEL", () => {
    const inv = clientInvocation(
      "claude-code",
      runContext("claude-code", {
        purpose: "implement",
        modelId: "claude-opus-5",
        effort: "max",
      }),
      "C:/claude.exe",
    );
    expect(inv.args).toContain("--effort");
    expect(inv.args).toContain("max");
    expect(inv.env.CLAUDE_CODE_EFFORT_LEVEL).toBe("max");
  });

  it("Kimi 显式 effort 只设本次 KIMI_MODEL_THINKING_EFFORT", () => {
    const inv = clientInvocation(
      "kimi-code",
      runContext("kimi-code", {
        purpose: "implement",
        modelId: "kimi-code/k3",
        effort: "max",
      }),
      "C:/kimi.exe",
    );
    const modelAt = inv.args.indexOf("--model");
    expect(inv.args[modelAt + 1]).toBe("kimi-code/k3");
    expect(inv.args).not.toContain("--effort");
    expect(inv.env.KIMI_MODEL_THINKING_EFFORT).toBe("max");
  });

  it("Grok 不再传 --no-auto-update，effort 走 --reasoning-effort", () => {
    const inv = clientInvocation(
      "grok-build",
      runContext("grok-build", {
        purpose: "implement",
        modelId: "grok-4.6",
        effort: "xhigh",
      }),
      "C:/grok.exe",
    );
    expect(inv.args).not.toContain("--no-auto-update");
    expect(inv.args).toContain("--reasoning-effort");
    expect(inv.args).toContain("xhigh");
  });

  it("OpenCode 1.x 使用 --variant 且不混用 #variant", () => {
    const inv = clientInvocation(
      "opencode",
      {
        ...runContext("opencode", {
          purpose: "implement",
          modelId: "openai/gpt-4.1",
          effort: "high",
        }),
        selectionCapability: { opencodeVariantEncoding: "flag" },
      },
      "C:/opencode.exe",
    );
    const modelAt = inv.args.indexOf("--model");
    expect(inv.args[modelAt + 1]).toBe("openai/gpt-4.1");
    expect(inv.args[modelAt + 1]).not.toContain("#");
    expect(inv.args).toContain("--variant");
    expect(inv.args).toContain("high");
  });
});
