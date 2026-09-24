import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../../packages/store/src/store.js";
import {
  SupportedAdapters,
  type ModelEntry,
} from "../../packages/contracts/src/index.js";
import {
  TOOL_DISPLAY_ORDER,
  PARSER_REVISION,
} from "../../packages/contracts/src/model-catalog.js";
import { ConfigSchema } from "../../packages/contracts/src/config.js";
import {
  AGY_VARIANTS,
  knownAgyEffortFor,
} from "../../packages/adapters/agy/src/model-configuration.js";
import { knownCodexEffortFor } from "../../packages/adapters/codex/src/model-configuration.js";
import {
  ModelCatalogService,
  enrichManualEntry,
} from "../../packages/core/src/model-catalog-service.js";
import {
  executorProfileFromConfig,
  migrateLegacyExecutorModel,
} from "../../packages/core/src/model-defaults-service.js";
import { parseMimoModelCatalog } from "../../packages/adapters/mimo/src/model-configuration.js";

describe("UI/API 工具一致性护栏", () => {
  it("TOOL_DISPLAY_ORDER 的每个工具都必须被 SupportedAdapters 接受", () => {
    expect(TOOL_DISPLAY_ORDER.length).toBeGreaterThan(0);
    for (const item of TOOL_DISPLAY_ORDER) {
      expect(SupportedAdapters, item.adapterId).toContain(item.adapterId);
    }
  });

  it("MiMo Code 与 GPT/AGY 皆在 UI 工具列表中", () => {
    const ids = TOOL_DISPLAY_ORDER.map((item) => item.adapterId);
    expect(ids).toContain("mimo-code");
    expect(ids).toContain("agy");
    expect(ids).toContain("codex");
  });
});

describe("思考强度严格按模型对齐（不臆造档位）", () => {
  it("Gemini 3.8/3.7/3.6 Flash 只有 high/medium，不存在 xhigh/max/ultra", () => {
    for (const family of ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"]) {
      const known = knownAgyEffortFor(`${family}-high`);
      expect(known, family).toBeDefined();
      expect(known!.effort.status).toBe("supported");
      expect(known!.effort.values).toEqual(["high", "medium"]);
      expect(known!.effort.fixedValue).toBe("high");
      expect(known!.effort.values).not.toContain("xhigh");
      expect(known!.effort.values).not.toContain("max");
      expect(known!.effort.values).not.toContain("ultra");
    }
  });

  it("Gemini 3.1 Pro 只有 high", () => {
    const known = knownAgyEffortFor("gemini-3.1-pro-high");
    expect(known).toBeDefined();
    expect(known!.effort.values).toEqual(["high"]);
    expect(known!.effort.fixedValue).toBe("high");
    expect(AGY_VARIANTS["gemini-3.1-pro"]).toEqual({ high: "gemini-3.1-pro-high" });
  });

  it("AGY 未知 ID 不获得任何思考强度能力", () => {
    expect(knownAgyEffortFor("gemini-9.9-flash-high")).toBeUndefined();
    expect(knownAgyEffortFor("mystery-model")).toBeUndefined();
  });

  it("GPT-6 Astra 恰为 low..ultra 六档，默认 medium", () => {
    const known = knownCodexEffortFor("gpt-6-astra");
    expect(known).toBeDefined();
    expect(known!.status).toBe("supported");
    expect(known!.transport).toBe("config");
    expect(known!.values).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(known!.defaultValue).toBe("medium");
  });

  it("Codex 其余已知模型按各自档位对齐，未知 ID 不臆造", () => {
    expect(knownCodexEffortFor("gpt-5.6-luna")?.values).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(knownCodexEffortFor("gpt-5.6-luna")?.defaultValue).toBeUndefined();
    expect(knownCodexEffortFor("gpt-4.1")).toBeUndefined();
    expect(knownCodexEffortFor("gpt-6-astra-pro-max")).toBeUndefined();
  });
});

describe("手工候补 effort 合成", () => {
  function manualEntry(adapterId: "agy" | "codex", nativeId: string): ModelEntry {
    return {
      entryId: `${adapterId}/manual/${nativeId}`,
      adapterId,
      nativeId,
      label: nativeId,
      selectionKind: "fixed",
      effort: { status: "unknown", transport: "none", values: [] },
      source: "manual",
      discoveredAt: "2026-09-23T00:00:00.000Z",
      hidden: false,
      availability: "candidate",
      capabilityRevision: `${nativeId}:manual:unknown`,
      accessModelKey: nativeId,
    };
  }

  it("AGY 候补合成家族聚合所需的 effort/family/accessModelKey", () => {
    const enriched = enrichManualEntry(manualEntry("agy", "gemini-3.8-flash-high"));
    expect(enriched.effort.status).toBe("supported");
    expect(enriched.effort.fixedValue).toBe("high");
    expect(enriched.effort.variants).toEqual({
      high: "gemini-3.8-flash-high",
      medium: "gemini-3.8-flash-medium",
    });
    expect(enriched.familyId).toBe("gemini-3.8-flash");
    expect(enriched.accessModelKey).toBe("gemini-3.8-flash");
    expect(enriched.providerId).toBe("google");
  });

  it("codex 候补 gpt-6-astra 合成 low..ultra", () => {
    const enriched = enrichManualEntry(manualEntry("codex", "gpt-6-astra"));
    expect(enriched.effort.values).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(enriched.effort.defaultValue).toBe("medium");
    expect(enriched.effort.transport).toBe("config");
  });

  it("未知模型与非 manual 来源保持原样", () => {
    const unknown = manualEntry("codex", "some-lab-model");
    expect(enrichManualEntry(unknown).effort.status).toBe("unknown");
    const discovered = {
      ...manualEntry("agy", "gemini-3.8-flash-high"),
      source: "native-live" as const,
    };
    expect(enrichManualEntry(discovered).effort.status).toBe("unknown");
  });

  it("ensureManualCandidate 为已知 ID 写入合成 effort，全 manual 目录报告 missing", () => {
    const root = mkdtempSync(join(tmpdir(), "devflow-effort-"));
    const store = new Store(join(root, "state", "devflow.sqlite"));
    const service = new ModelCatalogService(store);
    try {
      const scope = {
        adapterId: "agy" as const,
        executablePath: "fixture-cli",
        nativeConfigScope: "default",
      };
      const entry = service.ensureManualCandidate(scope, "gemini-3.8-flash-high");
      expect(entry.effort.values).toEqual(["high", "medium"]);
      const catalog = service.loadForSelector(scope);
      expect(catalog.status).toBe("missing");
      expect(catalog.discoveryStatus).toBe("missing");
    } finally {
      store.close();
    }
  });

  it("parserRevision 缺失或过期的目录判定为需重发现", () => {
    const root = mkdtempSync(join(tmpdir(), "devflow-parser-"));
    const store = new Store(join(root, "state", "devflow.sqlite"));
    const service = new ModelCatalogService(store);
    try {
      const scope = {
        adapterId: "codex" as const,
        executablePath: "fixture-cli",
        nativeConfigScope: "default",
      };
      service.ensureManualCandidate(scope, "gpt-6-astra");
      // 模拟旧构建写库：parserRevision 缺失
      const rows = store.entries<Record<string, unknown>>("model_catalog", "codex");
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const { parserRevision: _drop, ...rest } = row.value as Record<string, unknown> & {
          parserRevision?: string;
        };
        void _drop;
        store.put("model_catalog", row.id, "codex", rest);
      }
      expect(service.loadForSelector(scope).discoveryStatus).toBe("missing");

      // parserRevision 与当前解析器不一致同样视为需重发现
      for (const row of store.entries<Record<string, unknown>>("model_catalog", "codex")) {
        store.put("model_catalog", row.id, "codex", {
          ...row.value,
          parserRevision: "19990101",
          status: "fresh",
          discoveryStatus: "complete",
        });
      }
      expect(service.loadForSelector(scope).discoveryStatus).toBe("missing");

      // 当前 parserRevision 的目录不再被判定为需重发现
      for (const row of store.entries<Record<string, unknown>>("model_catalog", "codex")) {
        store.put("model_catalog", row.id, "codex", {
          ...row.value,
          parserRevision: PARSER_REVISION,
          status: "fresh",
          discoveryStatus: "complete",
        });
      }
      expect(service.loadForSelector(scope).discoveryStatus).toBe("complete");
    } finally {
      store.close();
    }
  });
});

describe("默认执行模型 3.7 → 3.8", () => {
  it("配置默认与预填默认均为 gemini-3.8-flash-high", () => {
    const config = ConfigSchema.parse({});
    expect(config.models.executor).toBe("gemini-3.8-flash-high");
    expect(executorProfileFromConfig().modelId).toBe("gemini-3.8-flash-high");
  });

  it("legacy-import 的旧默认 3.7 升级为 3.8，用户配置不覆盖", () => {
    const legacy = migrateLegacyExecutorModel({
      schema_version: 1,
      revision: 1,
      plannerProfile: {
        id: "planner",
        revision: 1,
        adapterId: "codex",
        executableRef: "codex",
        modelSelection: "explicit",
        modelId: "gpt-6-astra",
        reasoning: { mode: "explicit", value: "high" },
        selectionKind: "fixed",
        options: {},
      },
      executorProfile: {
        id: "executor",
        revision: 1,
        adapterId: "agy",
        executableRef: "agy",
        modelSelection: "explicit",
        modelId: "gemini-3.7-flash-high",
        reasoning: { mode: "explicit", value: "high" },
        selectionKind: "fixed",
        options: {},
      },
      updated_at: "2026-09-22T06:22:48.000Z",
      source: "legacy-import",
    } as never);
    expect(legacy.executorProfile.modelId).toBe("gemini-3.8-flash-high");
  });

  it("source 为 user 时即使值是旧默认也不迁移", () => {
    const user = migrateLegacyExecutorModel({
      schema_version: 1,
      revision: 2,
      plannerProfile: {
        id: "planner",
        revision: 1,
        adapterId: "codex",
        executableRef: "codex",
        modelSelection: "explicit",
        modelId: "gpt-6-astra",
        reasoning: { mode: "explicit", value: "high" },
        selectionKind: "fixed",
        options: {},
      },
      executorProfile: {
        id: "executor",
        revision: 1,
        adapterId: "agy",
        executableRef: "agy",
        modelSelection: "explicit",
        modelId: "gemini-3.7-flash-high",
        reasoning: { mode: "explicit", value: "high" },
        selectionKind: "fixed",
        options: {},
      },
      updated_at: "2026-09-23T00:00:00.000Z",
      source: "user",
    } as never);
    expect(user.executorProfile.modelId).toBe("gemini-3.7-flash-high");
  });
});

describe("MiMo 2.5 系列显示名", () => {
  it("xiaomi/mimo-v2.5 显示为 MiMo V2.5", () => {
    const catalog = parseMimoModelCatalog({
      stdout: "xiaomi/mimo-v2.5 MiMo V2.5",
      scopeHash: "mimo-label-test",
    });
    const entry = catalog.entries.find((item) => item.nativeId === "xiaomi/mimo-v2.5");
    expect(entry).toBeDefined();
    expect(entry!.label).toBe("MiMo V2.5");
  });
});
