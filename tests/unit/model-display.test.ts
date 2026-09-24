import { describe, it, expect } from "vitest";
import {
  formatToolName,
  formatModelName,
  formatRuntimeDisplay,
  buildModelChoices,
} from "../../packages/presentation/src/model-display.js";
import type { ModelEntry } from "../../packages/contracts/src/model-catalog.js";

describe("model-display 展示格式化与变体聚合", () => {
  it("U03: 工具名规范化输出，无前缀重复", () => {
    expect(formatToolName("codex")).toBe("Codex");
    expect(formatToolName("agy")).toBe("AGY");
    expect(formatToolName("claude-code")).toBe("Claude Code");
    expect(formatToolName("mimo-code")).toBe("MiMo Code");
    expect(formatToolName("unknown-tool")).toBe("unknown-tool");
  });

  it("U03: 模型名称格式化，解析已知家族或直接保留 token", () => {
    expect(formatModelName("codex", "gpt-5.1-codex")).toBe("GPT-5.1 Codex");
    expect(formatModelName("agy", "gemini-3.8-flash-high")).toBe("Gemini 3.8 Flash");
    expect(formatModelName("agy", "gemini-3.8-flash-medium")).toBe("Gemini 3.8 Flash");
    expect(formatModelName("agy", "custom-experimental-model")).toBe("custom-experimental-model");
  });

  it("U03: formatRuntimeDisplay 规范输出，强度在括号内且只出现一次", () => {
    expect(
      formatRuntimeDisplay({
        adapterId: "codex",
        modelId: "gpt-5.1-codex",
        effort: "high",
      }),
    ).toBe("Codex · GPT-5.1 Codex (high)");

    expect(
      formatRuntimeDisplay({
        adapterId: "agy",
        modelId: "gemini-3.8-flash-high",
        effort: "high",
      }),
    ).toBe("AGY · Gemini 3.8 Flash (high)");

    expect(
      formatRuntimeDisplay("codex", "gpt-5", "medium"),
    ).toBe("Codex · GPT-5 (medium)");

    expect(
      formatRuntimeDisplay("claude-code", "claude-3-7-sonnet", undefined),
    ).toBe("Claude Code · Claude 3.7 Sonnet");
  });

  it("U02: buildModelChoices 将同家族的 high/medium 变体归组为单一可选条目", () => {
    const entries: ModelEntry[] = [
      {
        entryId: "ent-1",
        adapterId: "agy",
        nativeId: "gemini-3.8-flash-high",
        label: "Gemini 3.8 Flash (High)",
        source: "native-live",
        selectionKind: "fixed",
        discoveredAt: "2026-09-22T00:00:00.000Z",
        hidden: false,
        availability: "listed",
        capabilityRevision: "1",
        effort: {
          status: "supported",
          transport: "variant-id",
          values: ["high"],
          defaultValue: "high",
          fixedValue: "high",
        },
      },
      {
        entryId: "ent-2",
        adapterId: "agy",
        nativeId: "gemini-3.8-flash-medium",
        label: "Gemini 3.8 Flash (Medium)",
        source: "native-live",
        selectionKind: "fixed",
        discoveredAt: "2026-09-22T00:00:00.000Z",
        hidden: false,
        availability: "listed",
        capabilityRevision: "1",
        effort: {
          status: "supported",
          transport: "variant-id",
          values: ["medium"],
          defaultValue: "medium",
          fixedValue: "medium",
        },
      },
    ];

    const choices = buildModelChoices(entries);
    expect(choices).toHaveLength(1);
    const choice = choices[0]!;
    expect(choice.choiceId).toBe("gemini-3.8-flash");
    expect(choice.label).toBe("Gemini 3.8 Flash");
    expect(choice.effortValues).toContain("high");
    expect(choice.effortValues).toContain("medium");
    expect(choice.variantByEffort["high"]).toBe("gemini-3.8-flash-high");
    expect(choice.variantByEffort["medium"]).toBe("gemini-3.8-flash-medium");
  });

  it("U07: 未知变体元数据的 model-high 与 model-low 保持独立条目，不丢失任何候选 (R07)", () => {
    const entries: ModelEntry[] = [
      {
        entryId: "ent-unk-1",
        adapterId: "agy",
        nativeId: "custom-model-high",
        label: "custom-model-high",
        source: "native-live",
        selectionKind: "fixed",
        discoveredAt: "2026-09-22T00:00:00.000Z",
        hidden: false,
        availability: "listed",
        capabilityRevision: "1",
        effort: {
          status: "unknown",
          transport: "none",
          values: [],
        },
      },
      {
        entryId: "ent-unk-2",
        adapterId: "agy",
        nativeId: "custom-model-low",
        label: "custom-model-low",
        source: "native-live",
        selectionKind: "fixed",
        discoveredAt: "2026-09-22T00:00:00.000Z",
        hidden: false,
        availability: "listed",
        capabilityRevision: "1",
        effort: {
          status: "unknown",
          transport: "none",
          values: [],
        },
      },
    ];

    const choices = buildModelChoices(entries);
    expect(choices).toHaveLength(2);
    expect(choices.map((c) => c.nativeId)).toEqual(["custom-model-high", "custom-model-low"]);
  });

  it("U08: buildModelChoices 正确聚合包含 high/medium/low 的同家族条目为单一项", () => {
    const entries: ModelEntry[] = [
      {
        entryId: "ent-1",
        adapterId: "agy",
        nativeId: "gemini-3.8-flash-high",
        label: "Gemini 3.8 Flash (High)",
        source: "native-live",
        selectionKind: "fixed",
        discoveredAt: "2026-09-22T00:00:00.000Z",
        hidden: false,
        availability: "listed",
        capabilityRevision: "1",
        effort: {
          status: "supported",
          transport: "none",
          values: ["high", "medium", "low"],
          defaultValue: "high",
          fixedValue: "high",
          variants: {
            high: "gemini-3.8-flash-high",
            medium: "gemini-3.8-flash-medium",
            low: "gemini-3.8-flash-low",
          },
        },
      },
      {
        entryId: "ent-2",
        adapterId: "agy",
        nativeId: "gemini-3.8-flash-medium",
        label: "Gemini 3.8 Flash (Medium)",
        source: "native-live",
        selectionKind: "fixed",
        discoveredAt: "2026-09-22T00:00:00.000Z",
        hidden: false,
        availability: "listed",
        capabilityRevision: "1",
        effort: {
          status: "supported",
          transport: "none",
          values: ["high", "medium", "low"],
          defaultValue: "high",
          fixedValue: "medium",
          variants: {
            high: "gemini-3.8-flash-high",
            medium: "gemini-3.8-flash-medium",
            low: "gemini-3.8-flash-low",
          },
        },
      },
      {
        entryId: "ent-3",
        adapterId: "agy",
        nativeId: "gemini-3.8-flash-low",
        label: "Gemini 3.8 Flash (Low)",
        source: "native-live",
        selectionKind: "fixed",
        discoveredAt: "2026-09-22T00:00:00.000Z",
        hidden: false,
        availability: "listed",
        capabilityRevision: "1",
        effort: {
          status: "supported",
          transport: "none",
          values: ["high", "medium", "low"],
          defaultValue: "high",
          fixedValue: "low",
          variants: {
            high: "gemini-3.8-flash-high",
            medium: "gemini-3.8-flash-medium",
            low: "gemini-3.8-flash-low",
          },
        },
      },
    ];

    const choices = buildModelChoices(entries);
    expect(choices).toHaveLength(1);
    const choice = choices[0]!;
    expect(choice.choiceId).toBe("gemini-3.8-flash");
    expect(choice.label).toBe("Gemini 3.8 Flash");
    expect(choice.effortValues).toEqual(["high", "medium", "low"]);
    expect(choice.variantByEffort).toEqual({
      high: "gemini-3.8-flash-high",
      medium: "gemini-3.8-flash-medium",
      low: "gemini-3.8-flash-low",
    });
  });
});
