import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CATALOG_OUTPUT_LIMIT,
  ModelCatalogSchema,
  type ModelCatalog,
  type ModelEntry,
} from "../../packages/contracts/src/model-catalog.js";
import {
  splitCompleteLines,
  stripAnsi,
  visibleModelEntries,
} from "../../packages/adapters/sdk/src/catalog-parse.js";
import { discoverModels as discoverCodexModels } from "../../packages/adapters/codex/src/model-configuration.js";
import { discoverModels as discoverAgyModels } from "../../packages/adapters/agy/src/model-configuration.js";
import { discoverModels as discoverCursorModels } from "../../packages/adapters/cursor/src/model-configuration.js";

const FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/model-catalog",
);
const DISCOVERED_AT = "2026-09-18T09:00:00.000Z";
const OLD_EFFORT_ENUM = ["low", "medium", "high", "xhigh"];

type ExpectedEffort = {
  status?: string;
  transport?: string;
  values?: string[];
  fixedValue?: string;
  defaultValue?: string;
  variants?: Record<string, string>;
};

type ExpectedEntry = {
  nativeId: string;
  hidden?: boolean;
  label?: string;
  entryId?: string;
  accessModelKey?: string;
  selectionKind?: string;
  effort?: ExpectedEffort;
};

type ExpectedCatalog = {
  visibleNativeIds: string[];
  hiddenNativeIds?: string[];
  rejectedLabels?: string[];
  absentNativeIds?: string[];
  entries: Record<string, ExpectedEntry>;
};

function readFixture(adapter: string, name: string): string {
  return readFileSync(join(FIXTURE_ROOT, adapter, name), "utf8");
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
  if (expected.variants) expect(entry.effort.variants).toEqual(expected.variants);
}

function assertExpected(catalog: ModelCatalog, expected: ExpectedCatalog): void {
  expect(ModelCatalogSchema.parse(catalog).status).toBe("fresh");
  expect(catalog.entries.map((entry) => entry.nativeId)).toEqual(
    expected.visibleNativeIds.concat(expected.hiddenNativeIds ?? []),
  );
  expect(visibleModelEntries(catalog.entries).map((entry) => entry.nativeId)).toEqual(
    expected.visibleNativeIds,
  );
  for (const label of expected.rejectedLabels ?? []) {
    expect(catalog.entries.some((entry) => entry.nativeId === label)).toBe(false);
    expect(catalog.entries.some((entry) => entry.label === label)).toBe(false);
  }
  for (const nativeId of expected.absentNativeIds ?? []) {
    expect(catalog.entries.some((entry) => entry.nativeId === nativeId)).toBe(false);
  }
  for (const [nativeId, expectedEntry] of Object.entries(expected.entries)) {
    const entry = requireEntry(catalog, nativeId);
    expect(entry.nativeId).toBe(expectedEntry.nativeId);
    if (expectedEntry.hidden !== undefined) expect(entry.hidden).toBe(expectedEntry.hidden);
    if (expectedEntry.label) expect(entry.label).toBe(expectedEntry.label);
    if (expectedEntry.entryId) expect(entry.entryId).toBe(expectedEntry.entryId);
    if (expectedEntry.accessModelKey) {
      expect(entry.accessModelKey).toBe(expectedEntry.accessModelKey);
    }
    if (expectedEntry.selectionKind) {
      expect(entry.selectionKind).toBe(expectedEntry.selectionKind);
    }
    assertEffort(entry, expectedEntry.effort);
  }
}

describe("model catalog parse", () => {
  it("UT-M08 metadata unknown → 不产生全套强度", async () => {
    const catalog = await discoverCodexModels({
      stdout: readFixture("codex", "models-success.json"),
      discoveredAt: DISCOVERED_AT,
      scopeHash: "codex-test",
    });
    const unknown = requireEntry(catalog, "experimental-foo");
    expect(unknown.effort.status).toBe("unknown");
    expect(unknown.effort.values).toEqual([]);
    for (const value of OLD_EFFORT_ENUM) {
      expect(unknown.effort.values).not.toContain(value);
    }
    const agy = await discoverAgyModels({
      stdout: readFixture("agy", "models-success.txt"),
      discoveredAt: DISCOVERED_AT,
      scopeHash: "agy-test",
    });
    const sonnet = requireEntry(agy, "claude-sonnet-4-6");
    expect(sonnet.effort.status).toBe("unknown");
    expect(sonnet.effort.values).toEqual([]);
    const cursor = await discoverCursorModels({
      stdout: readFixture("cursor-agent", "models-success.txt"),
      discoveredAt: DISCOVERED_AT,
      scopeHash: "cursor-test",
    });
    const mystery = requireEntry(cursor, "unknown-new-model-xyz");
    expect(mystery.effort.status).toBe("unknown");
    expect(mystery.effort.values).toEqual([]);
    expect(mystery.familyId).toBeUndefined();
  });

  it("UT-M09 Codex 有 max/ultra 不被旧枚举删掉", async () => {
    const catalog = await discoverCodexModels({
      stdout: readFixture("codex", "models-success.json"),
      discoveredAt: DISCOVERED_AT,
      scopeHash: "codex-test",
    });
    assertExpected(catalog, readExpected("codex"));
    const astra = requireEntry(catalog, "gpt-6-astra");
    expect(astra.nativeId).toBe("gpt-6-astra");
    expect(astra.label).not.toBe(astra.nativeId);
    expect(astra.entryId).toBe("codex/openai/gpt-6-astra-2026-09-18");
    expect(astra.effort.values).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(astra.effort.values).toEqual(
      expect.arrayContaining(["max", "ultra", ...OLD_EFFORT_ENUM]),
    );
    expect(astra.effort.transport).toBe("config");
    expect(astra.source).toBe("native-live");
  });

  it("UT-M10 Codex hidden 默认列表不出现", async () => {
    const catalog = await discoverCodexModels({
      stdout: readFixture("codex", "models-success.json"),
      discoveredAt: DISCOVERED_AT,
      scopeHash: "codex-test",
    });
    const hiddenIds = ["gpt-reserve", "codex-auto-review"];
    for (const nativeId of hiddenIds) {
      const entry = requireEntry(catalog, nativeId);
      expect(entry.hidden).toBe(true);
    }
    const visible = visibleModelEntries(catalog.entries).map((entry) => entry.nativeId);
    expect(visible).not.toContain("gpt-reserve");
    expect(visible).not.toContain("codex-auto-review");
    expect(visible).toContain("gpt-6-astra");
  });

  it("Codex 真实缓存结构 fallback，损坏条目跳过", async () => {
    const catalog = await discoverCodexModels({
      stdout: readFixture("codex", "models-cache.json"),
      discoveredAt: DISCOVERED_AT,
      scopeHash: "codex-cache",
      source: "native-cache",
    });
    expect(catalog.status).toBe("fresh");
    expect(catalog.entries.map((entry) => entry.nativeId)).toEqual([
      "gpt-5.6-codex",
      "gpt-hidden-cache",
      "gpt-optional-fields",
    ]);
    const visible = requireEntry(catalog, "gpt-5.6-codex");
    expect(visible.label).toBe("GPT-5.6 Codex");
    expect(visible.effort.defaultValue).toBe("medium");
    expect(visible.effort.values).toEqual(["low", "medium", "high", "xhigh"]);
    expect(visible.source).toBe("native-cache");
    expect(requireEntry(catalog, "gpt-hidden-cache").hidden).toBe(true);
    expect(requireEntry(catalog, "gpt-optional-fields").effort.status).toBe(
      "unknown",
    );
    expect(catalog.entries.some((entry) => entry.nativeId === "not-a-model")).toBe(
      false,
    );
  });

  it("UT-M11 agy 高档换中档依赖实际 medium slug", async () => {
    const catalog = await discoverAgyModels({
      stdout: readFixture("agy", "models-success.txt"),
      stderr: "Warning: 缓存未命中\nfake-stderr-model-high\n",
      discoveredAt: DISCOVERED_AT,
      scopeHash: "agy-test",
    });
    assertExpected(catalog, readExpected("agy"));
    const medium = requireEntry(catalog, "gemini-3.7-flash-medium");
    expect(medium.effort.fixedValue).toBe("medium");
    expect(medium.effort.transport).toBe("none");
    expect(medium.accessModelKey).toBe("gemini-3.7-flash");
    expect(requireEntry(catalog, "gemini-3.7-flash-high").accessModelKey).toBe(medium.accessModelKey);
    expect(catalog.entries.some((entry) => entry.nativeId === "gemini-3.7-flash-low")).toBe(
      false,
    );
    expect(catalog.entries.some((entry) => entry.nativeId === "fake-stderr-model-high")).toBe(
      false,
    );
    expect(catalog.entries.some((entry) => entry.nativeId.includes("Opus"))).toBe(false);
  });

  it("UT-M12 Cursor 含 Fast/Thinking 和 effort 变体，完整 ID 保留，只映射已存在组合", async () => {
    const catalog = await discoverCursorModels({
      stdout: readFixture("cursor-agent", "models-success.txt"),
      discoveredAt: DISCOVERED_AT,
      scopeHash: "cursor-test",
    });
    assertExpected(catalog, readExpected("cursor-agent"));
    const grokHigh = requireEntry(catalog, "cursor-grok-4.6-high");
    expect(grokHigh.accessModelKey).toBe("cursor-grok-4.6:standard");
    expect(grokHigh.effort.variants?.xhigh).toBe("cursor-grok-4.6-xhigh");
    const grok45 = requireEntry(catalog, "cursor-grok-4.5-high");
    expect(grok45.effort.values).toEqual(["low", "medium", "high"]);
    expect(grok45.effort.variants).not.toHaveProperty("xhigh");
    const sol = requireEntry(catalog, "gpt-5.6-sol-high");
    expect(sol.effort.values).not.toContain("ultra");
    const extra = requireEntry(catalog, "gpt-5.5-extra-high");
    expect(extra.nativeId).toBe("gpt-5.5-extra-high");
    expect(extra.effort.fixedValue).toBe("extra-high");
    expect(extra.effort.variants).not.toHaveProperty("xhigh");
    expect(requireEntry(catalog, "cursor-grok-4.6-high-fast").accessModelKey).toBe(
      "cursor-grok-4.6:fast",
    );
    expect(requireEntry(catalog, "cursor-grok-4.6-high-fast").effort.status).toBe(
      "supported",
    );
    expect(requireEntry(catalog, "cursor-grok-4.6-high-fast").effort.variants?.xhigh).toBe(
      "cursor-grok-4.6-xhigh-fast",
    );
    expect(requireEntry(catalog, "claude-opus-5-thinking-high-fast").nativeId).toBe(
      "claude-opus-5-thinking-high-fast",
    );
    expect(requireEntry(catalog, "auto").selectionKind).toBe("native-router");
    const muse = requireEntry(catalog, "muse-spark-1.3-high");
    expect(muse.effort.values).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(muse.effort.values).not.toContain("none");
    expect(requireEntry(catalog, "muse-spark-1.3-none").effort.status).toBe(
      "unknown",
    );
  });

  it("UT-M18 ANSI、中文、stderr 警告、半行/超长：正确清理/限制；错误不变空目录成功", async () => {
    expect(stripAnsi("\u001B[32m模型\u001B[0m")).toBe("模型");
    expect(splitCompleteLines("ok\npart", true)).toEqual(["ok"]);
    const agy = await discoverAgyModels({
      stdout: readFixture("agy", "models-success.txt"),
      stderr: "Warning: 网络波动\n",
      discoveredAt: DISCOVERED_AT,
      scopeHash: "agy-test",
    });
    expect(agy.status).toBe("fresh");
    expect(requireEntry(agy, "gemini-3.7-flash-high").nativeId).toBe(
      "gemini-3.7-flash-high",
    );
    const half = await discoverAgyModels({
      stdout: "gemini-3.7-flash-high\ngemini-3.7-flash-med",
      truncated: true,
      discoveredAt: DISCOVERED_AT,
      scopeHash: "agy-half",
    });
    expect(half.status).toBe("fresh");
    expect(half.entries.map((entry) => entry.nativeId)).toEqual([
      "gemini-3.7-flash-high",
    ]);
    const oversize = await discoverAgyModels({
      stdout: `${"x".repeat(CATALOG_OUTPUT_LIMIT + 8)}`,
      discoveredAt: DISCOVERED_AT,
      scopeHash: "agy-oversize",
    });
    expect(oversize.status).toBe("failed");
    expect(oversize.errorCode).toBe("CATALOG_OUTPUT_TRUNCATED");
    expect(oversize.entries).toEqual([]);
    const nonJson = await discoverCodexModels({
      stdout: "codex app-server starting\nnot-json <<<>>>",
      discoveredAt: DISCOVERED_AT,
      scopeHash: "codex-non-json",
    });
    expect(nonJson.status).toBe("failed");
    expect(nonJson.errorCode).toBeTruthy();
    expect(nonJson.entries).toEqual([]);
    const timedOut = await discoverCodexModels({
      stdout: readFixture("codex", "models-failure.json"),
      discoveredAt: DISCOVERED_AT,
      scopeHash: "codex-timeout",
    });
    expect(timedOut.status).toBe("failed");
    expect(timedOut.errorCode).toBe("MODEL_PROBE_TIMEOUT");
    expect(timedOut.entries).toEqual([]);
    const env = await discoverCursorModels({
      stdout: readFixture("cursor-agent", "models-failure.txt"),
      discoveredAt: DISCOVERED_AT,
      scopeHash: "cursor-env",
    });
    expect(env.status).toBe("failed");
    expect(env.errorCode).toBe("DISCOVERY_ENVIRONMENT_UNAVAILABLE");
    expect(env.errorCode).not.toBe("MODEL_LOGIN_REQUIRED");
    expect(env.entries).toEqual([]);
    const agyFail = await discoverAgyModels({
      stdout: readFixture("agy", "models-failure.txt"),
      discoveredAt: DISCOVERED_AT,
      scopeHash: "agy-fail",
    });
    expect(agyFail.status).toBe("failed");
    expect(agyFail.entries).toEqual([]);
    expect(agyFail.status).not.toBe("fresh");
  });

  it("agy 未知未来 ID 不根据 high 后缀臆造强度或授权模型族", async () => {
    const catalog = await discoverAgyModels({
      stdout: "future-lab-high\nfuture-lab-medium\n",
      discoveredAt: DISCOVERED_AT,
      scopeHash: "agy-future",
    });
    const unknown = requireEntry(catalog, "future-lab-high");
    expect(unknown.effort.status).toBe("unknown");
    expect(unknown.effort.values).toEqual([]);
    expect(unknown.effort.variants).toBeUndefined();
    expect(unknown.accessModelKey).toBeUndefined();
  });

});
