import { describe, expect, it } from "vitest";
import type { ToolProfile } from "../../packages/contracts/src/execution-spec.js";
import type { ModelCatalog, ModelEntry } from "../../packages/contracts/src/model-catalog.js";
import type { NativeResolvedConfig } from "../../packages/contracts/src/model-access.js";
import type { FrozenInvocation } from "../../packages/contracts/src/model-routing.js";
import type { RunContext } from "../../packages/adapters/sdk/src/interface.js";
import { clientInvocation } from "../../packages/adapters/sdk/src/invocation.js";
import { buildFrozenInvocation, selectionCapabilityFromCatalog } from "../../packages/adapters/sdk/src/frozen-invocation.js";
import { resolveModelSelection } from "../../packages/adapters/sdk/src/model-selection.js";
import { CursorAgentNativeAdapter } from "../../packages/adapters/cursor/src/adapter.js";
import { AgyNativeCliAdapter } from "../../packages/adapters/agy/src/adapter.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/model-probe/cli.mjs",
);

function profile(
  adapterId: ToolProfile["adapterId"],
  modelId: string,
  effort: string,
): ToolProfile {
  return {
    id: "profile-1",
    revision: 1,
    adapterId,
    modelSelection: "explicit",
    modelId,
    executableRef: FIXTURE,
    options: {},
    reasoning: { mode: "explicit", value: effort },
    selectionKind: "fixed",
  };
}

function nativeConfig(adapterId: NativeResolvedConfig["adapterId"]): NativeResolvedConfig {
  return {
    adapterId,
    executablePath: FIXTURE,
    nativeConfigScope: "default",
    accountFingerprint: "acct-fp",
    identityConfidence: "profile-scope",
    profileSelectionSupported: false,
  };
}

function agyEntry(): ModelEntry {
  return {
    entryId: "agy/google/gemini-3.7-flash-high",
    adapterId: "agy",
    nativeId: "gemini-3.7-flash-high",
    label: "gemini-3.7-flash-high",
    providerId: "google",
    selectionKind: "fixed",
    effort: {
      status: "supported",
      transport: "none",
      values: ["high", "medium"],
      fixedValue: "high",
      variants: {
        high: "gemini-3.7-flash-high",
        medium: "gemini-3.7-flash-medium",
      },
    },
    source: "native-live",
    discoveredAt: "2026-09-18T00:00:00.000Z",
    hidden: false,
    availability: "listed",
    capabilityRevision: "agy-gemini-high",
    accessModelKey: "gemini-3.7-flash",
  };
}

function cursorEntry(): ModelEntry {
  return {
    entryId: "cursor-agent/cursor/cursor-grok-4.6-high",
    adapterId: "cursor-agent",
    nativeId: "cursor-grok-4.6-high",
    label: "cursor-grok-4.6-high",
    familyId: "cursor-grok-4.6",
    accessModelKey: "cursor-grok-4.6:standard",
    selectionKind: "fixed",
    effort: {
      status: "supported",
      transport: "variant-id",
      values: ["low", "medium", "high", "xhigh"],
      fixedValue: "high",
      variants: {
        low: "cursor-grok-4.6-low",
        medium: "cursor-grok-4.6-medium",
        high: "cursor-grok-4.6-high",
        xhigh: "cursor-grok-4.6-xhigh",
      },
    },
    source: "native-live",
    discoveredAt: "2026-09-18T00:00:00.000Z",
    hidden: false,
    availability: "listed",
    capabilityRevision: "cursor-grok-4.6:standard:low,medium,high,xhigh",
  };
}

function kimiAliasEntry(): ModelEntry {
  return {
    entryId: "kimi-code/managed:kimi-code/work/k3",
    adapterId: "kimi-code",
    nativeId: "work/k3",
    label: "work/k3",
    providerId: "managed:kimi-code",
    selectionKind: "fixed",
    effort: {
      status: "supported",
      transport: "env",
      values: ["low", "high", "max"],
      defaultValue: "high",
    },
    source: "native-config",
    discoveredAt: "2026-09-18T00:00:00.000Z",
    hidden: false,
    availability: "listed",
    capabilityRevision: "work/k3:supported:low,high,max",
    accessModelKey: "work/k3",
  };
}

function runContext(
  adapter: ToolProfile["adapterId"],
  extra: {
    frozen?: FrozenInvocation;
    catalogEntry?: ModelEntry;
    effort?: string;
    conversationId?: string;
    modelId?: string;
  },
): RunContext {
  return {
    workflowId: "wf_1",
    runId: extra.conversationId ? "run_resume" : "run_1",
    stage: "execute",
    epoch: 1,
    workspaceRoots: { repo1: "C:/fake/repo" },
    allowedPaths: ["app.txt"],
    purpose: "implement",
    prompt: "ok",
    conversationId: extra.conversationId,
    toolProfile: profile(adapter, extra.modelId ?? "model", extra.effort ?? "high"),
    frozenInvocation: extra.frozen,
    catalogEntry: extra.catalogEntry,
  };
}

function modelArg(args: string[]): string | undefined {
  const index = args.indexOf("--model");
  if (index < 0) return undefined;
  return args[index + 1];
}

describe("冻结调用与 prepare/resume", () => {
  it("agy 显式强度 prepare/resume 与验证解析一致", async () => {
    const selected = profile("agy", "gemini-3.7-flash-high", "high");
    const verified = resolveModelSelection(selected, agyEntry());
    const frozen = buildFrozenInvocation(
      selected,
      agyEntry(),
      {},
      nativeConfig("agy"),
      "profile-native",
    );
    expect(frozen.modelToken).toBe(verified.modelToken);
    expect(frozen.effortArgs).toEqual(verified.effortArgs);
    const adapter = new AgyNativeCliAdapter();
    const prepared = await adapter.prepare(
      runContext("agy", { frozen, catalogEntry: agyEntry(), modelId: selected.modelId }),
    );
    const resumed = await adapter.resume({
      ...runContext("agy", {
        frozen,
        catalogEntry: agyEntry(),
        modelId: selected.modelId,
        conversationId: "conv-agy",
      }),
      previousConversationId: "conv-agy",
    });
    expect(modelArg(prepared.args)).toBe("gemini-3.7-flash-high");
    expect(modelArg(resumed.args)).toBe("gemini-3.7-flash-high");
    expect(prepared.args).not.toContain("--effort");
    expect(resumed.args).toContain("--conversation");
  });

  it("Cursor 显式强度 prepare/resume 使用目录变体", async () => {
    const selected = profile("cursor-agent", "cursor-grok-4.6-high", "high");
    const verified = resolveModelSelection(selected, cursorEntry());
    const frozen = buildFrozenInvocation(
      selected,
      cursorEntry(),
      {},
      nativeConfig("cursor-agent"),
      "profile-native",
    );
    expect(frozen.modelToken).toBe("cursor-grok-4.6-high");
    expect(frozen.modelToken).toBe(verified.modelToken);
    expect(frozen.accessModelKey).toBe("cursor-grok-4.6:standard");
    const adapter = new CursorAgentNativeAdapter();
    const prepared = await adapter.prepare(
      runContext("cursor-agent", {
        frozen,
        catalogEntry: cursorEntry(),
        modelId: selected.modelId,
      }),
    );
    const resumed = await adapter.resume({
      ...runContext("cursor-agent", {
        frozen,
        catalogEntry: cursorEntry(),
        modelId: selected.modelId,
        conversationId: "conv-cursor",
      }),
      previousConversationId: "conv-cursor",
    });
    expect(modelArg(prepared.args)).toBe("cursor-grok-4.6-high");
    expect(modelArg(resumed.args)).toBe("cursor-grok-4.6-high");
    expect(prepared.args).not.toContain("--effort");
  });

  it("Kimi 自定义 alias work/k3 不猜成 provider work", () => {
    const selected = profile("kimi-code", "work/k3", "max");
    const frozen = buildFrozenInvocation(
      selected,
      kimiAliasEntry(),
      {},
      nativeConfig("kimi-code"),
      "profile-native",
    );
    expect(frozen.kimiProvider).toBe("managed:kimi-code");
    expect(frozen.kimiProvider).not.toBe("work");
    const inv = clientInvocation(
      "kimi-code",
      runContext("kimi-code", {
        frozen,
        catalogEntry: kimiAliasEntry(),
        modelId: "work/k3",
        effort: "max",
      }),
      "C:/kimi.exe",
    );
    expect(modelArg(inv.args)).toBe("work/k3");
    expect(inv.env.KIMI_MODEL_THINKING_EFFORT).toBe("max");
    expect(inv.args).not.toContain("--effort");
  });

  it("OpenCode flag 与 hash 两种能力分别编码", () => {
    const selected = profile("opencode", "openai/gpt-4.1", "high");
    const entry: ModelEntry = {
      entryId: "opencode/openai/openai/gpt-4.1",
      adapterId: "opencode",
      nativeId: "openai/gpt-4.1",
      label: "openai/gpt-4.1",
      providerId: "openai",
      selectionKind: "fixed",
      effort: {
        status: "supported",
        transport: "variant-flag",
        values: ["high", "max"],
      },
      source: "native-live",
      discoveredAt: "2026-09-18T00:00:00.000Z",
      hidden: false,
      availability: "listed",
      capabilityRevision: "opencode-flag",
    };
    const catalog: ModelCatalog = {
      adapterId: "opencode", scopeHash: "opencode-scope", status: "fresh",
      discoveredAt: entry.discoveredAt, staleAfter: "2026-09-19T00:00:00.000Z",
      cliVersion: "opencode fixture", entries: [entry],
    };
    const flagCapability = selectionCapabilityFromCatalog({
      ...catalog, invocationCapability: { opencodeVariantEncoding: "flag" },
    }, entry);
    const hashCapability = selectionCapabilityFromCatalog({
      ...catalog, invocationCapability: { opencodeVariantEncoding: "hash" },
    }, entry);
    const flagFrozen = buildFrozenInvocation(
      selected,
      entry,
      flagCapability,
      nativeConfig("opencode"),
      "profile-native",
    );
    const hashFrozen = buildFrozenInvocation(
      selected,
      entry,
      hashCapability,
      nativeConfig("opencode"),
      "profile-native",
    );
    expect(flagFrozen.modelToken).toBe(resolveModelSelection(selected, entry, flagCapability).modelToken);
    expect(hashFrozen.modelToken).toBe(resolveModelSelection(selected, entry, hashCapability).modelToken);
    const flagInv = clientInvocation(
      "opencode",
      runContext("opencode", { frozen: flagFrozen, modelId: "openai/gpt-4.1" }),
      "C:/opencode.exe",
    );
    const hashInv = clientInvocation(
      "opencode",
      runContext("opencode", { frozen: hashFrozen, modelId: "openai/gpt-4.1" }),
      "C:/opencode.exe",
    );
    expect(modelArg(flagInv.args)).toBe("openai/gpt-4.1");
    expect(flagInv.args).toContain("--variant");
    expect(flagInv.args).toContain("high");
    expect(modelArg(hashInv.args)).toBe("openai/gpt-4.1#high");
    expect(hashInv.args).not.toContain("--variant");
  });

  it("无 frozen 的历史 Run 用目录条目保持显式强度", async () => {
    const selected = profile("agy", "gemini-3.7-flash-high", "medium");
    const verified = resolveModelSelection(selected, agyEntry());
    const adapter = new AgyNativeCliAdapter();
    const prepared = await adapter.prepare(
      runContext("agy", {
        catalogEntry: agyEntry(),
        modelId: selected.modelId,
        effort: "medium",
      }),
    );
    expect(modelArg(prepared.args)).toBe(verified.modelToken);
    expect(modelArg(prepared.args)).toBe("gemini-3.7-flash-medium");
    expect(prepared.args).not.toContain("--effort");
  });

  it("冻结可执行文件优先于后续 profile 路径变更", async () => {
    const selected = profile("agy", "gemini-3.7-flash-high", "high");
    const frozen = buildFrozenInvocation(selected, agyEntry(), {}, nativeConfig("agy"), "profile-native");
    const input = runContext("agy", { frozen, catalogEntry: agyEntry(), modelId: selected.modelId });
    input.toolProfile.executableRef = join(FIXTURE, "missing-tool");
    const prepared = await new AgyNativeCliAdapter().prepare(input);
    expect(prepared.args[0]).toBe(FIXTURE);
    expect(modelArg(prepared.args)).toBe("gemini-3.7-flash-high");
  });

  it("只有 Codex 命名配置使用真实 profile 参数，其他工具明确拒绝", () => {
    const codex = runContext("codex", { modelId: "gpt-6-astra" });
    codex.toolProfile.nativeConfigProfile = "work";
    expect(clientInvocation("codex", codex, "codex").args.slice(0, 3))
      .toEqual(["--profile", "work", "exec"]);
    for (const adapter of ["agy", "cursor-agent", "claude-code", "kimi-code", "grok-build", "qoder", "opencode"] as const) {
      const input = runContext(adapter, {});
      input.toolProfile.nativeConfigProfile = "work";
      expect(() => clientInvocation(adapter, input, adapter)).toThrow("当前工具不支持命名原生配置");
    }
  });

  it("冻结的默认配置不会因后续 profile 名称变更而改变", () => {
    const selected = profile("agy", "gemini-3.7-flash-high", "high");
    const frozen = buildFrozenInvocation(selected, agyEntry(), {}, nativeConfig("agy"), "profile-native");
    const input = runContext("agy", { frozen, modelId: selected.modelId });
    input.toolProfile.nativeConfigProfile = "later-profile";
    const invocation = clientInvocation("agy", input, "agy");
    expect(invocation.args).not.toContain("--profile");
    expect(modelArg(invocation.args)).toBe("gemini-3.7-flash-high");
  });

});
