import { describe, expect, it } from "vitest";
import { FlowError } from "../../packages/contracts/src/index.js";
import type { ToolProfile } from "../../packages/contracts/src/execution-spec.js";
import type {
  EffortTransport,
  ModelEffort,
  ModelEntry,
} from "../../packages/contracts/src/model-catalog.js";
import type {
  ModelSelectionCapability,
  ResolvedSelection,
} from "../../packages/adapters/sdk/src/interface.js";
import { resolveModelSelection } from "../../packages/adapters/sdk/src/model-selection.js";

function profile(
  adapterId: ToolProfile["adapterId"],
  modelId: string,
  effort: string | "native-default" | "not-applicable",
  extra: Partial<ToolProfile> = {},
): ToolProfile {
  const reasoning =
    effort === "native-default"
      ? { mode: "native-default" as const }
      : effort === "not-applicable"
        ? { mode: "not-applicable" as const }
        : { mode: "explicit" as const, value: effort };
  return {
    id: "profile-1",
    revision: 1,
    adapterId,
    modelSelection: "explicit",
    modelId,
    options: {},
    reasoning,
    selectionKind: "fixed",
    ...extra,
  };
}

function entry(
  adapterId: ModelEntry["adapterId"],
  nativeId: string,
  effort: Partial<ModelEffort> & Pick<ModelEffort, "transport" | "values">,
  extra: Partial<ModelEntry> = {},
): ModelEntry {
  return {
    entryId: `${adapterId}:${nativeId}`,
    adapterId,
    nativeId,
    label: extra.label ?? nativeId,
    providerId: extra.providerId,
    familyId: extra.familyId,
    accessModelKey: extra.accessModelKey,
    selectionKind: extra.selectionKind ?? "fixed",
    effort: {
      status: effort.status ?? "supported",
      transport: effort.transport,
      values: effort.values,
      defaultValue: effort.defaultValue,
      fixedValue: effort.fixedValue,
      variants: effort.variants,
    },
    source: extra.source ?? "native-live",
    discoveredAt: extra.discoveredAt ?? "2026-09-18T00:00:00.000Z",
    hidden: extra.hidden ?? false,
    availability: extra.availability ?? "listed",
    capabilityRevision: extra.capabilityRevision ?? "1",
  };
}

function modelArgs(result: ResolvedSelection): string[] {
  if (!result.modelToken) return [...result.effortArgs];
  return ["--model", result.modelToken, ...result.effortArgs];
}

function expectCode(run: () => unknown, code: string) {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(FlowError);
  expect((caught as FlowError).code).toBe(code);
}

function expectModelFlag(args: string[], modelId: string) {
  const index = args.indexOf("--model");
  expect(index).toBeGreaterThanOrEqual(0);
  expect(args[index + 1]).toBe(modelId);
}

const grok46Variants = {
  low: "cursor-grok-4.6-low",
  medium: "cursor-grok-4.6-medium",
  high: "cursor-grok-4.6-high",
  xhigh: "cursor-grok-4.6-xhigh",
};

const kimiCatalog = entry(
  "kimi-code",
  "kimi-code/k3",
  {
    transport: "env",
    values: ["low", "high", "max"],
    defaultValue: "high",
  },
  { providerId: "managed:kimi-code" },
);

const kimiCapability: ModelSelectionCapability = {
  kimiProvider: "managed:kimi-code",
  kimiSupportEfforts: ["low", "high", "max"],
};

describe("resolveModelSelection 清单 10.1", () => {
  it.each([
    {
      name: "codex / gpt-6-astra / xhigh",
      input: () =>
        resolveModelSelection(
          profile("codex", "gpt-6-astra", "xhigh"),
          entry("codex", "gpt-6-astra", {
            transport: "config",
            values: ["low", "medium", "high", "xhigh", "max", "ultra"],
            defaultValue: "medium",
          }),
        ),
      token: "gpt-6-astra",
      args: ["-c", 'model_reasoning_effort="xhigh"'],
      env: {},
      transport: "config" as EffortTransport,
    },
    {
      name: "agy / gemini-3.7-flash-high / high",
      input: () =>
        resolveModelSelection(
          profile("agy", "gemini-3.7-flash-high", "high"),
          entry("agy", "gemini-3.7-flash-high", {
            transport: "variant-id",
            values: ["high", "medium"],
            fixedValue: "high",
            variants: {
              high: "gemini-3.7-flash-high",
              medium: "gemini-3.7-flash-medium",
            },
          }),
        ),
      token: "gemini-3.7-flash-high",
      args: [] as string[],
      env: {},
      transport: "variant-id" as EffortTransport,
    },
    {
      name: "claude-code / claude-opus-5 / max",
      input: () =>
        resolveModelSelection(
          profile("claude-code", "claude-opus-5", "max"),
          entry("claude-code", "claude-opus-5", {
            transport: "flag",
            values: ["low", "medium", "high", "xhigh", "max"],
          }),
        ),
      token: "claude-opus-5",
      args: ["--effort", "max"],
      env: { CLAUDE_CODE_EFFORT_LEVEL: "max" },
      transport: "flag" as EffortTransport,
    },
    {
      name: "cursor-agent / cursor-grok-4.6-high / high",
      input: () =>
        resolveModelSelection(
          profile("cursor-agent", "cursor-grok-4.6-high", "high"),
          entry("cursor-agent", "cursor-grok-4.6-high", {
            transport: "variant-id",
            values: ["low", "medium", "high", "xhigh"],
            fixedValue: "high",
            variants: grok46Variants,
          }),
        ),
      token: "cursor-grok-4.6-high",
      args: [] as string[],
      env: {},
      transport: "variant-id" as EffortTransport,
    },
    {
      name: "grok-build / grok-4.6 / xhigh",
      input: () =>
        resolveModelSelection(
          profile("grok-build", "grok-4.6", "xhigh"),
          entry("grok-build", "grok-4.6", {
            transport: "flag",
            values: ["low", "medium", "high", "xhigh"],
            defaultValue: "high",
          }),
        ),
      token: "grok-4.6",
      args: ["--reasoning-effort", "xhigh"],
      env: {},
      transport: "flag" as EffortTransport,
    },
    {
      name: "kimi-code / kimi-code/k3 / max",
      input: () =>
        resolveModelSelection(
          profile("kimi-code", "kimi-code/k3", "max"),
          kimiCatalog,
          kimiCapability,
        ),
      token: "kimi-code/k3",
      args: [] as string[],
      env: { KIMI_MODEL_THINKING_EFFORT: "max" },
      transport: "env" as EffortTransport,
    },
    {
      name: "qoder / 原生已列出 ID / xhigh",
      input: () =>
        resolveModelSelection(
          profile("qoder", "qwen-3.8-max", "xhigh"),
          entry("qoder", "qwen-3.8-max", {
            transport: "flag",
            values: ["low", "medium", "xhigh"],
          }),
        ),
      token: "qwen-3.8-max",
      args: ["--reasoning-effort", "xhigh"],
      env: {},
      transport: "flag" as EffortTransport,
    },
    {
      name: "opencode 1.x / provider/model / high",
      input: () =>
        resolveModelSelection(
          profile("opencode", "openai/gpt-4.1", "high"),
          entry("opencode", "openai/gpt-4.1", {
            transport: "variant-flag",
            values: ["high", "max"],
          }),
          { opencodeVariantEncoding: "flag" },
        ),
      token: "openai/gpt-4.1",
      args: ["--variant", "high"],
      env: {},
      transport: "variant-flag" as EffortTransport,
    },
  ])("$name", (row) => {
    const result = row.input();
    expect(result.modelToken).toBe(row.token);
    expect(result.effortArgs).toEqual(row.args);
    expect(result.effortEnv).toEqual(row.env);
    expect(result.transport).toBe(row.transport);
    const args = modelArgs(result);
    expectModelFlag(args, row.token);
    if (row.name.startsWith("agy") || row.name.startsWith("cursor")) {
      expect(args).not.toContain("--effort");
    }
    if (row.name.startsWith("kimi")) {
      expect(args).not.toContain("--effort");
      expect(result.effortEnv.KIMI_MODEL_THINKING_EFFORT).toBe("max");
    }
    if (row.name.startsWith("opencode")) {
      expect(result.modelToken).not.toContain("#");
      expect(result.effortArgs.includes("--variant")).toBe(true);
    }
  });
});

describe("resolveModelSelection 验收用例", () => {
  it("UT-M07 模型只支持 low/high/max 时提交 medium", () => {
    expectCode(
      () =>
        resolveModelSelection(
          profile("kimi-code", "kimi-code/k3", "medium"),
          kimiCatalog,
          kimiCapability,
        ),
      "EFFORT_UNSUPPORTED",
    );
  });

  it("UT-M09 Codex native metadata 的 max/ultra 不被旧枚举删掉", () => {
    const catalog = entry("codex", "gpt-5.6-sol", {
      transport: "config",
      values: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultValue: "low",
    });
    const ultra = resolveModelSelection(
      profile("codex", "gpt-5.6-sol", "ultra"),
      catalog,
    );
    const max = resolveModelSelection(
      profile("codex", "gpt-5.6-sol", "max"),
      catalog,
    );
    expect(ultra.modelToken).toBe("gpt-5.6-sol");
    expect(ultra.effortArgs).toEqual([
      "-c",
      'model_reasoning_effort="ultra"',
    ]);
    expect(max.effortArgs).toEqual(["-c", 'model_reasoning_effort="max"']);
  });

  it("UT-M11 agy 高档换中档使用实际 medium slug", () => {
    const catalog = entry("agy", "gemini-3.7-flash-high", {
      transport: "variant-id",
      values: ["high", "medium"],
      fixedValue: "high",
      variants: {
        high: "gemini-3.7-flash-high",
        medium: "gemini-3.7-flash-medium",
      },
    });
    const result = resolveModelSelection(
      profile("agy", "gemini-3.7-flash-high", "medium"),
      catalog,
    );
    const args = modelArgs(result);
    expect(result.modelToken).toBe("gemini-3.7-flash-medium");
    expectModelFlag(args, "gemini-3.7-flash-medium");
    expect(result.effortArgs).toEqual([]);
    expect(args).not.toContain("--effort");
  });

  it("UT-M11 agy 找不到 medium slug 时拒绝拼接", () => {
    expectCode(
      () =>
        resolveModelSelection(
          profile("agy", "gemini-3.1-pro-high", "medium"),
          entry("agy", "gemini-3.1-pro-high", {
            transport: "variant-id",
            values: ["high", "medium"],
            fixedValue: "high",
            variants: { high: "gemini-3.1-pro-high" },
          }),
        ),
      "EFFORT_UNSUPPORTED",
    );
  });

  it("UT-M12 Cursor 保留 Thinking/Fast 完整 ID 且只映射已存在组合", () => {
    const thinking = resolveModelSelection(
      profile("cursor-agent", "claude-opus-5-thinking-high", "medium"),
      entry("cursor-agent", "claude-opus-5-thinking-high", {
        transport: "variant-id",
        values: ["low", "medium", "high", "xhigh", "max"],
        fixedValue: "high",
        variants: {
          low: "claude-opus-5-thinking-low",
          medium: "claude-opus-5-thinking-medium",
          high: "claude-opus-5-thinking-high",
          xhigh: "claude-opus-5-thinking-xhigh",
          max: "claude-opus-5-thinking-max",
        },
      }),
    );
    expect(thinking.modelToken).toBe("claude-opus-5-thinking-medium");
    expect(thinking.effortArgs).toEqual([]);
    expect(modelArgs(thinking)).not.toContain("--effort");

    const fast = resolveModelSelection(
      profile("cursor-agent", "cursor-grok-4.6-high-fast", "xhigh"),
      entry("cursor-agent", "cursor-grok-4.6-high-fast", {
        transport: "variant-id",
        values: ["low", "medium", "high", "xhigh"],
        fixedValue: "high",
        variants: {
          low: "cursor-grok-4.6-low-fast",
          medium: "cursor-grok-4.6-medium-fast",
          high: "cursor-grok-4.6-high-fast",
          xhigh: "cursor-grok-4.6-xhigh-fast",
        },
      }),
    );
    expect(fast.modelToken).toBe("cursor-grok-4.6-xhigh-fast");
    expect(fast.modelToken).not.toBe("cursor-grok-4.6-xhigh");

    expectCode(
      () =>
        resolveModelSelection(
          profile("cursor-agent", "claude-opus-5-high", "xhigh"),
          entry("cursor-agent", "claude-opus-5-high", {
            transport: "variant-id",
            values: ["low", "medium", "high"],
            fixedValue: "high",
            variants: {
              low: "claude-opus-5-low",
              medium: "claude-opus-5-medium",
              high: "claude-opus-5-high",
            },
          }),
        ),
      "EFFORT_UNSUPPORTED",
    );
  });

  it("UT-M13 Grok 4.5 提交 xhigh 拒绝且不降到 high", () => {
    const catalog = entry("grok-build", "grok-4.5", {
      transport: "flag",
      values: ["low", "medium", "high"],
      defaultValue: "high",
    });
    expectCode(
      () =>
        resolveModelSelection(profile("grok-build", "grok-4.5", "xhigh"), catalog),
      "EFFORT_UNSUPPORTED",
    );
    const high = resolveModelSelection(
      profile("grok-build", "grok-4.5", "high"),
      catalog,
    );
    expect(high.modelToken).toBe("grok-4.5");
    expect(high.effortArgs).toEqual(["--reasoning-effort", "high"]);
  });

  it("UT-M14 Kimi K3 high 使用进程 env 且不含假 --effort", () => {
    const result = resolveModelSelection(
      profile("kimi-code", "kimi-code/k3", "high"),
      kimiCatalog,
      kimiCapability,
    );
    const args = modelArgs(result);
    expectModelFlag(args, "kimi-code/k3");
    expect(result.modelToken).toBe("kimi-code/k3");
    expect(result.effortEnv).toEqual({ KIMI_MODEL_THINKING_EFFORT: "high" });
    expect(args).not.toContain("--effort");
    expect(result.effortArgs).toEqual([]);
    expect(result.transport).toBe("env");
  });

  it("UT-M14 Kimi K3 max 同样只改本次 env", () => {
    const result = resolveModelSelection(
      profile("kimi-code", "kimi-code/k3", "max"),
      kimiCatalog,
      kimiCapability,
    );
    const args = modelArgs(result);
    expectModelFlag(args, "kimi-code/k3");
    expect(result.effortEnv).toEqual({ KIMI_MODEL_THINKING_EFFORT: "max" });
    expect(args).not.toContain("--effort");
  });

  it("UT-M15 Kimi 非支持 provider 的 effort 返回能力错误", () => {
    expectCode(
      () =>
        resolveModelSelection(
          profile("kimi-code", "openai/gpt-4.1", "high"),
          entry(
            "kimi-code",
            "openai/gpt-4.1",
            { transport: "env", values: ["low", "high", "max"] },
            { providerId: "openai" },
          ),
          { kimiProvider: "openai", kimiSupportEfforts: ["low", "high", "max"] },
        ),
      "CLI_PARAMETER_UNSUPPORTED",
    );
  });

  it("UT-M16 Qoder 使用 --reasoning-effort 且选择结果不含 plan", () => {
    const result = resolveModelSelection(
      profile("qoder", "qwen-3.8-max", "xhigh"),
      entry("qoder", "qwen-3.8-max", {
        transport: "flag",
        values: ["low", "medium", "xhigh"],
      }),
    );
    expect(result.modelToken).toBe("qwen-3.8-max");
    expect(result.effortArgs).toEqual(["--reasoning-effort", "xhigh"]);
    expect(result.effortArgs.join(" ")).not.toMatch(/\bplan\b/);
    expect(result.transport).toBe("flag");
  });

  it("无目录条目时仍编码冻结的 Claude/Kimi explicit effort", () => {
    const claude = resolveModelSelection(
      profile("claude-code", "claude-opus-5", "max"),
      undefined,
    );
    expect(claude.effortArgs).toEqual(["--effort", "max"]);
    expect(claude.effortEnv).toEqual({ CLAUDE_CODE_EFFORT_LEVEL: "max" });
    const kimi = resolveModelSelection(
      profile("kimi-code", "kimi-code/k3", "max"),
      undefined,
      kimiCapability,
    );
    expect(kimi.modelToken).toBe("kimi-code/k3");
    expect(kimi.effortArgs).toEqual([]);
    expect(kimi.effortEnv).toEqual({ KIMI_MODEL_THINKING_EFFORT: "max" });
  });

  it("UT-M17 OpenCode v1/v2 参数互斥", () => {
    const catalog = entry("opencode", "openai/gpt-4.1", {
      transport: "variant-flag",
      values: ["high", "max"],
    });
    const v1 = resolveModelSelection(
      profile("opencode", "openai/gpt-4.1", "high"),
      catalog,
      { opencodeVariantEncoding: "flag" },
    );
    expect(v1.modelToken).toBe("openai/gpt-4.1");
    expect(v1.effortArgs).toEqual(["--variant", "high"]);
    expect(v1.modelToken?.includes("#")).toBe(false);
    expect(v1.effortArgs.includes("--variant") && v1.modelToken?.includes("#")).toBe(
      false,
    );

    const v2 = resolveModelSelection(
      profile("opencode", "openai/gpt-4.1", "high"),
      catalog,
      { opencodeVariantEncoding: "hash" },
    );
    expect(v2.modelToken).toBe("openai/gpt-4.1#high");
    expect(v2.effortArgs).toEqual([]);
    expect(v2.effortArgs).not.toContain("--variant");
    expect(v2.modelToken?.includes("#") && v2.effortArgs.includes("--variant")).toBe(
      false,
    );
  });
});

describe("resolveModelSelection 边界规则", () => {
  it("effort.status 为 unknown 时明确档位被拒绝", () => {
    expectCode(
      () =>
        resolveModelSelection(
          profile("claude-code", "claude-haiku-4-5", "high"),
          entry("claude-code", "claude-haiku-4-5", {
            status: "unknown",
            transport: "none",
            values: [],
          }),
        ),
      "EFFORT_METADATA_UNKNOWN",
    );
  });

  it("native-default 且无法解析具体档位时不发虚构 effort 参数", () => {
    const result = resolveModelSelection(
      profile("claude-code", "claude-haiku-4-5", "native-default"),
      entry("claude-code", "claude-haiku-4-5", {
        status: "unknown",
        transport: "none",
        values: [],
      }),
    );
    expect(result.reasoning).toEqual({ mode: "native-default" });
    expect(result.modelToken).toBe("claude-haiku-4-5");
    expect(result.effortArgs).toEqual([]);
    expect(result.effortEnv).toEqual({});
    expect(result.transport).toBe("none");
  });

  it("native-router 的 auto 保持为路由 token", () => {
    const result = resolveModelSelection(
      profile("cursor-agent", "auto", "native-default", {
        selectionKind: "native-router",
      }),
      entry(
        "cursor-agent",
        "auto",
        { status: "unknown", transport: "none", values: [] },
        { selectionKind: "native-router" },
      ),
    );
    expect(result.modelToken).toBe("auto");
    expect(result.effortArgs).toEqual([]);
    expect(result.fingerprint.modelId).toBe("auto");
  });

  it("cursor-grok-4.6-high 与 xhigh 是不同 modelToken", () => {
    const catalog = entry("cursor-agent", "cursor-grok-4.6-high", {
      transport: "variant-id",
      values: ["low", "medium", "high", "xhigh"],
      fixedValue: "high",
      variants: grok46Variants,
    });
    const high = resolveModelSelection(
      profile("cursor-agent", "cursor-grok-4.6-high", "high"),
      catalog,
    );
    const xhigh = resolveModelSelection(
      profile("cursor-agent", "cursor-grok-4.6-high", "xhigh"),
      catalog,
    );
    expect(high.modelToken).toBe("cursor-grok-4.6-high");
    expect(xhigh.modelToken).toBe("cursor-grok-4.6-xhigh");
    expect(high.modelToken).not.toBe(xhigh.modelToken);
    expect(modelArgs(xhigh)).not.toContain("--effort");
  });

  it("Cursor Fast 家族 high/xhigh 共享 accessModelKey 且不丢 Fast 维度", () => {
    const catalog = entry(
      "cursor-agent",
      "cursor-grok-4.6-high-fast",
      {
        transport: "variant-id",
        values: ["high", "xhigh"],
        fixedValue: "high",
        variants: {
          high: "cursor-grok-4.6-high-fast",
          xhigh: "cursor-grok-4.6-xhigh-fast",
        },
      },
      { accessModelKey: "cursor-grok-4.6:fast", familyId: "cursor-grok-4.6" },
    );
    const high = resolveModelSelection(
      profile("cursor-agent", "cursor-grok-4.6-high-fast", "high"),
      catalog,
    );
    const xhigh = resolveModelSelection(
      profile("cursor-agent", "cursor-grok-4.6-high-fast", "xhigh"),
      catalog,
    );
    expect(high.modelToken).toBe("cursor-grok-4.6-high-fast");
    expect(xhigh.modelToken).toBe("cursor-grok-4.6-xhigh-fast");
    expect(xhigh.modelToken).not.toBe("cursor-grok-4.6-xhigh");
  });

  it("Cursor Muse 合法档位可解析，none 非法", () => {
    const catalog = entry(
      "cursor-agent",
      "muse-spark-1.3-high",
      {
        transport: "variant-id",
        values: ["minimal", "low", "medium", "high", "xhigh", "max"],
        fixedValue: "high",
        variants: {
          minimal: "muse-spark-1.3-minimal",
          low: "muse-spark-1.3-low",
          medium: "muse-spark-1.3-medium",
          high: "muse-spark-1.3-high",
          xhigh: "muse-spark-1.3-xhigh",
          max: "muse-spark-1.3-max",
        },
      },
      { accessModelKey: "muse-spark-1.3:standard", familyId: "muse-spark-1.3" },
    );
    const minimal = resolveModelSelection(
      profile("cursor-agent", "muse-spark-1.3-high", "minimal"),
      catalog,
    );
    expect(minimal.modelToken).toBe("muse-spark-1.3-minimal");
    expectCode(
      () =>
        resolveModelSelection(
          profile("cursor-agent", "muse-spark-1.3-high", "none"),
          catalog,
        ),
      "EFFORT_UNSUPPORTED",
    );
  });

  it("Cursor Grok 4.5 提交 xhigh 被拒绝", () => {
    expectCode(
      () =>
        resolveModelSelection(
          profile("cursor-agent", "cursor-grok-4.5-high", "xhigh"),
          entry("cursor-agent", "cursor-grok-4.5-high", {
            transport: "variant-id",
            values: ["low", "medium", "high"],
            fixedValue: "high",
            variants: {
              low: "cursor-grok-4.5-low",
              medium: "cursor-grok-4.5-medium",
              high: "cursor-grok-4.5-high",
            },
          }),
        ),
      "EFFORT_UNSUPPORTED",
    );
  });

  it("Claude 不允许 opusplan 当纯 effort", () => {
    expectCode(
      () =>
        resolveModelSelection(
          profile("claude-code", "claude-opus-5", "opusplan"),
          entry("claude-code", "claude-opus-5", {
            transport: "flag",
            values: ["low", "medium", "high", "xhigh", "max"],
          }),
        ),
      "EFFORT_UNSUPPORTED",
    );
  });

  it("Cursor 未知 ID 保持 unknown，显式强度拒绝猜测", () => {
    const catalog = entry(
      "cursor-agent",
      "unknown-new-model-xyz",
      { status: "unknown", transport: "none", values: [] },
      { accessModelKey: "unknown-new-model-xyz" },
    );
    expect(catalog.effort.status).toBe("unknown");
    expectCode(
      () =>
        resolveModelSelection(
          profile("cursor-agent", "unknown-new-model-xyz", "high"),
          catalog,
        ),
      "EFFORT_METADATA_UNKNOWN",
    );
    const nativeDefault = resolveModelSelection(
      {
        ...profile("cursor-agent", "unknown-new-model-xyz", "high"),
        reasoning: { mode: "native-default" },
      },
      catalog,
    );
    expect(nativeDefault.modelToken).toBe("unknown-new-model-xyz");
    expect(nativeDefault.effortArgs).toEqual([]);
  });

  it("hidden 条目非历史当前值则拒绝，历史当前值可继续解析", () => {
    const hidden = entry(
      "codex",
      "codex-auto-review",
      { transport: "config", values: ["low", "medium", "high"] },
      { hidden: true },
    );
    expectCode(
      () =>
        resolveModelSelection(profile("codex", "gpt-6-astra", "high"), hidden),
      "MODEL_NOT_LISTED",
    );
    const kept = resolveModelSelection(
      profile("codex", "codex-auto-review", "high"),
      hidden,
    );
    expect(kept.modelToken).toBe("codex-auto-review");
    expect(kept.effortArgs).toEqual(["-c", 'model_reasoning_effort="high"']);
  });
});
