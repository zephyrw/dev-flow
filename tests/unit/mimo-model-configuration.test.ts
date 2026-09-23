import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  detectMimoVariantEncoding,
  discoverModels,
  parseMimoModelCatalog,
} from "../../packages/adapters/mimo/src/model-configuration.js";
import {
  CATALOG_OUTPUT_LIMIT,
  ModelCatalogSchema,
  type ModelCatalog,
  type ModelEntry,
} from "../../packages/contracts/src/model-catalog.js";

const FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/model-catalog/mimo-code",
);
const DISCOVERED_AT = "2026-09-22T09:00:00.000Z";

function readFixture(name: string): string {
  return readFileSync(join(FIXTURE_ROOT, name), "utf8");
}

function requireEntry(catalog: ModelCatalog, nativeId: string): ModelEntry {
  const entry = catalog.entries.find((item) => item.nativeId === nativeId);
  expect(entry, nativeId).toBeDefined();
  return entry!;
}

describe("MiMo models --verbose 解析", () => {
  it("保留完整 provider/model，多行 JSON 元数据与 variant 正确关联", async () => {
    const catalog = await discoverModels({
      stdout: readFixture("models-success.txt"),
      discoveredAt: DISCOVERED_AT,
      scopeHash: "mimo-test",
    });
    expect(ModelCatalogSchema.parse(catalog).status).toBe("fresh");
    const expected = JSON.parse(readFixture("expected.json")) as {
      visibleNativeIds: string[];
      rejectedLabels?: string[];
      entries: Record<
        string,
        {
          nativeId: string;
          label?: string;
          hidden?: boolean;
          effort?: {
            status?: string;
            transport?: string;
            values?: string[];
          };
        }
      >;
    };
    expect(catalog.entries.map((entry) => entry.nativeId)).toEqual(
      expected.visibleNativeIds,
    );
    for (const label of expected.rejectedLabels ?? []) {
      expect(catalog.entries.some((entry) => entry.nativeId === label)).toBe(
        false,
      );
      expect(catalog.entries.some((entry) => entry.label === label)).toBe(false);
    }
    for (const [nativeId, want] of Object.entries(expected.entries)) {
      const entry = requireEntry(catalog, nativeId);
      expect(entry.nativeId).toBe(want.nativeId);
      if (want.hidden !== undefined) expect(entry.hidden).toBe(want.hidden);
      if (want.label) expect(entry.label).toBe(want.label);
      if (want.effort?.status) expect(entry.effort.status).toBe(want.effort.status);
      if (want.effort?.transport) {
        expect(entry.effort.transport).toBe(want.effort.transport);
      }
      if (want.effort?.values) {
        expect(entry.effort.values).toEqual(want.effort.values);
      }
    }
  });

  it("逻辑模型名 mimo-v2.6-* 仅作展示/种子，实际 token 是完整 provider/model", async () => {
    const catalog = parseMimoModelCatalog({
      stdout: readFixture("models-success.txt"),
      discoveredAt: DISCOVERED_AT,
      scopeHash: "mimo-logical",
    });
    const pro = requireEntry(catalog, "xiaomi/mimo-v2.6-pro");
    const flash = requireEntry(catalog, "xiaomi/mimo-v2.6-flash");
    // Logical names must not become native tokens.
    expect(catalog.entries.some((e) => e.nativeId === "mimo-v2.6-pro")).toBe(
      false,
    );
    expect(catalog.entries.some((e) => e.nativeId === "mimo-v2.6-flash")).toBe(
      false,
    );
    // Display/seed labels stay logical.
    expect(pro.label).toBe("MiMo-V2.6-Pro");
    expect(flash.label).toBe("MiMo-V2.6-Flash");
    // Frozen/dispatch token is the full provider/model.
    expect(pro.nativeId).toBe("xiaomi/mimo-v2.6-pro");
    expect(flash.nativeId).toBe("xiaomi/mimo-v2.6-flash");
    expect(pro.familyId).toBe("mimo-v2.6-pro");
    expect(flash.familyId).toBe("mimo-v2.6-flash");
  });

  it("上下文窗口文字不当模型，JSON 元数据不被截成独立条目", async () => {
    const catalog = parseMimoModelCatalog({
      stdout: readFixture("models-success.txt"),
      discoveredAt: DISCOVERED_AT,
      scopeHash: "mimo-window",
    });
    // Only the three model lines become entries; window/budget prose does not.
    expect(catalog.entries).toHaveLength(3);
    for (const entry of catalog.entries) {
      expect(entry.nativeId).toMatch(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._+-]*$/i);
    }
    // Multi-line JSON must attach cost/limit to the model above it, not become tokens.
    const jsonLike = catalog.entries.filter((e) => e.nativeId.includes("{"));
    expect(jsonLike).toEqual([]);
  });

  it("失败/环境错误/超长输出保持 failed，不落空目录成功", async () => {
    const fail = await discoverModels({
      stdout: readFixture("models-failure.txt"),
      discoveredAt: DISCOVERED_AT,
      scopeHash: "mimo-fail",
    });
    expect(fail.status).toBe("failed");
    expect(fail.errorCode).toBe("DISCOVERY_AUTH_REQUIRED");
    expect(fail.entries).toEqual([]);

    const oversize = parseMimoModelCatalog({
      stdout: "x".repeat(CATALOG_OUTPUT_LIMIT + 8),
      discoveredAt: DISCOVERED_AT,
      scopeHash: "mimo-oversize",
    });
    expect(oversize.status).toBe("failed");
    expect(oversize.errorCode).toBe("CATALOG_OUTPUT_TRUNCATED");
    expect(oversize.entries).toEqual([]);
  });

  it("detectMimoVariantEncoding 识别 --variant 且不注入密钥", async () => {
    expect(detectMimoVariantEncoding(readFixture("help.txt"))).toBe("flag");
    expect(detectMimoVariantEncoding("no encoding here")).toBeUndefined();
    const catalog = parseMimoModelCatalog({
      stdout: `mimo/mimo-secret
{
  "id": "mimo-secret",
  "providerID": "mimo",
  "api_key": "sk-should-not-leak",
  "variants": ["high"]
}
`,
      discoveredAt: DISCOVERED_AT,
      scopeHash: "mimo-secret",
    });
    expect(catalog.status).toBe("fresh");
    expect(JSON.stringify(catalog)).not.toContain("sk-should-not-leak");
    expect(JSON.stringify(catalog)).not.toMatch(/api[_-]?key/i);
  });
});
