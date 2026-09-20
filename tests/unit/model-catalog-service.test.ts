import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../../packages/store/src/store.js";
import {
  ModelCatalogService,
  assertManualNativeId,
} from "../../packages/core/src/model-catalog-service.js";
import { FlowError } from "../../packages/contracts/src/index.js";
import { selectionCapabilityFromCatalog } from "../../packages/adapters/sdk/src/frozen-invocation.js";
import { resolveModelSelection } from "../../packages/adapters/sdk/src/model-selection.js";
import * as modelIdentity from "../../packages/core/src/model-identity.js";

// Catalog tests exercise only the fixture CLI and a deterministic non-secret scope.
vi.mock("../../packages/core/src/model-identity.js", () => ({
  resolveModelIdentity: (_store: unknown, profile: {
    adapterId: string; executableRef: string; nativeConfigProfile?: string;
  }) => ({
    adapterId: profile.adapterId,
    executablePath: profile.executableRef,
    nativeConfigScope: profile.nativeConfigProfile ?? "default",
    nativeConfigProfile: profile.nativeConfigProfile,
    accountFingerprint: "test-account",
    providerEndpointFingerprint: "test-endpoint",
    identityConfidence: "profile-scope",
    profileSelectionSupported: profile.adapterId === "codex",
  }),
}));

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/model-probe/cli.mjs",
);
const CATALOG_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/model-catalog",
);

async function waitDone(catalog: ModelCatalogService, id: string) {
  return catalog.waitForOperation(id);
}

let closeEnv: (() => Promise<void>) | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  if (closeEnv) await closeEnv();
  closeEnv = undefined;
});

function writeControl(logDir: string, patch: Record<string, unknown>) {
  const path = join(logDir, "control.json");
  const current = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
    : {};
  writeFileSync(path, JSON.stringify({ ...current, ...patch }));
}

function openCatalog(control: Record<string, unknown> = {}, executable = FIXTURE) {
  const root = mkdtempSync(join(tmpdir(), "devflow-catalog-"));
  const store = new Store(join(root, "state", "devflow.sqlite"));
  const logDir = join(root, "probe-log");
  mkdirSync(logDir, { recursive: true });
  writeControl(logDir, {
    adapterId: "agy",
    catalogStdout: readFileSync(
      join(CATALOG_ROOT, "agy", "models-success.txt"),
      "utf8",
    ),
    ...control,
  });
  const catalog = new ModelCatalogService(store, {
    extraEnv: { MODEL_PROBE_LOG_DIR: logDir },
    workingDirectory: root,
    versionHelpTimeoutMs: 3000,
    catalogTimeoutMs: 4000,
    resolveExecutable: () => executable,
  });
  closeEnv = async () => {
    await catalog.close();
    store.close();
  };
  return { root, store, catalog, logDir };
}

describe("model catalog operations", { timeout: 30000 }, () => {
  it("手工 ID 登记 manual candidate，非法 ID 拒绝", () => {
    const env = openCatalog({ adapterId: "agy" });
    const scope = {
      adapterId: "agy" as const,
      executablePath: FIXTURE,
      nativeConfigScope: "default",
    };
    const entry = env.catalog.ensureManualCandidate(scope, "gpt-unlisted-lab");
    expect(entry.source).toBe("manual");
    expect(entry.nativeId).toBe("gpt-unlisted-lab");
    expect(entry.availability).toBe("candidate");
    expect(entry.effort.status).toBe("unknown");
    expect(entry.effort.values).toEqual([]);
    const again = env.catalog.ensureManualCandidate(scope, "gpt-unlisted-lab");
    expect(again.entryId).toBe(entry.entryId);
    expect(() => assertManualNativeId("agy", "foo; rm -rf /")).toThrow(FlowError);
    expect(() => env.catalog.ensureManualCandidate(scope, "--help")).toThrow(
      FlowError,
    );
  });

  it("空存储 discoverTools 真正扫描 fixture CLI", async () => {
    const env = openCatalog({ adapterId: "agy" });
    const requestId = randomUUID();
    const first = env.catalog.discoverTools({
      request_id: requestId,
      adapter_ids: ["agy"],
    });
    expect(first.created).toBe(true);
    const done = await waitDone(env.catalog, first.operation.id);
    expect(done.status).toBe("committed");
    const models = env.catalog.getModels("agy");
    expect(models.status).toBe("fresh");
    expect(
      models.entries.some((entry) => entry.nativeId === "gemini-3.7-flash-high"),
    ).toBe(true);
  });

  it("刷新失败保留旧目录", async () => {
    const env = openCatalog({ adapterId: "agy" });
    const discovered = env.catalog.discoverTools({
      request_id: randomUUID(),
      adapter_ids: ["agy"],
    });
    await waitDone(env.catalog, discovered.operation.id);
    const before = env.catalog.getModels("agy");
    expect(before.entries.length).toBeGreaterThan(0);
    writeControl(env.logDir, { catalogBehavior: "fail" });
    const refresh = env.catalog.refreshModels({
      adapter: "agy",
      request_id: randomUUID(),
    });
    const done = await waitDone(env.catalog, refresh.operation.id);
    expect(["failed", "retryable"]).toContain(done.status);
    const after = env.catalog.getModels("agy");
    expect(after.entries.map((entry) => entry.nativeId)).toEqual(
      before.entries.map((entry) => entry.nativeId),
    );
    expect(after.discoveredAt).toBe(before.discoveredAt);
  });

  it("同 request 幂等复用原操作", async () => {
    const env = openCatalog({ adapterId: "agy" });
    const requestId = randomUUID();
    const first = env.catalog.discoverTools({
      request_id: requestId,
      adapter_ids: ["agy"],
    });
    const second = env.catalog.discoverTools({
      request_id: requestId,
      adapter_ids: ["agy"],
    });
    expect(second.created).toBe(false);
    expect(second.operation.id).toBe(first.operation.id);
    const done = await env.catalog.waitForOperation(first.operation.id);
    const third = env.catalog.discoverTools({
      request_id: requestId,
      adapter_ids: ["agy"],
    });
    expect(third.created).toBe(false);
    expect(third.operation.id).toBe(first.operation.id);
    expect(done.status).toBe("committed");
    expect(third.operation.status).toBe("committed");
  });

  it("发现和选择使用同一身份范围，其他账号不能借用目录", async () => {
    const env = openCatalog();
    const operation = env.catalog.discoverTools({ request_id: randomUUID(), adapter_ids: ["agy"] });
    await waitDone(env.catalog, operation.operation.id);
    const scope = {
      adapterId: "agy" as const,
      executablePath: FIXTURE,
      nativeConfigScope: "default",
      accountFingerprint: "test-account",
      providerFingerprint: "test-endpoint",
    };
    const catalog = env.catalog.loadForSelector(scope);
    expect(catalog.status).toBe("fresh");
    expect(catalog.entries.length).toBeGreaterThan(0);
    expect(env.catalog.getModels("agy", catalog.scopeHash).scopeHash).toBe(catalog.scopeHash);
    const other = { ...scope, accountFingerprint: "another-account" };
    expect(env.catalog.loadForSelector(other).status).toBe("missing");
    const candidate = env.catalog.ensureManualCandidate(other, "gemini-3.7-flash-high");
    expect(candidate.source).toBe("manual");
    expect(candidate.effort.status).toBe("unknown");
    expect(env.catalog.readCached(scope)?.entries[0]?.source).toBe("native-live");
    expect(env.catalog.readCached(other)?.entries).toEqual([candidate]);
  });

  it("同 Store 新建服务不接管或重复执行正在刷新的操作", async () => {
    const env = openCatalog({ catalogDelayMs: 100 });
    const operation = env.catalog.discoverTools({ request_id: randomUUID(), adapter_ids: ["agy"] });
    const second = new ModelCatalogService(env.store);
    expect(second.getOperation(operation.operation.id).status).toBe("processing");
    const done = await second.waitForOperation(operation.operation.id);
    expect(done.status).toBe("committed");
    const invocations = readFileSync(join(env.logDir, "invocations.jsonl"), "utf8")
      .trim().split(/\r?\n/).map((line) => JSON.parse(line) as { kind: string });
    expect(invocations.filter((entry) => entry.kind === "catalog")).toHaveLength(1);
  });

  it("产品身份不匹配的扫描结果持久化，不因失败目录被显示为已检测", async () => {
    const env = openCatalog({ versionStdout: "other-product 1.0", helpStdout: "other-product help" });
    const operation = env.catalog.discoverTools({ request_id: randomUUID(), adapter_ids: ["agy"] });
    expect((await waitDone(env.catalog, operation.operation.id)).status).toBe("failed");
    expect(env.catalog.listTools().find((tool) => tool.adapterId === "agy")?.probeStatus).toBe("identity-mismatch");
    expect(new ModelCatalogService(env.store).listTools().find((tool) => tool.adapterId === "agy")?.probeStatus)
      .toBe("identity-mismatch");
  });

  it.each([
    ["flag", "opencode run --model provider/model --variant value"],
    ["hash", "opencode run --model provider/model#<variant>"],
  ] as const)("OpenCode %s 能力来自实际 help 并供验证和冻结共用", async (encoding, helpStdout) => {
    const env = openCatalog({
      adapterId: "opencode",
      helpStdout,
      catalogStdout: readFileSync(join(CATALOG_ROOT, "opencode", "models-success.txt"), "utf8"),
    });
    const operation = env.catalog.discoverTools({ request_id: randomUUID(), adapter_ids: ["opencode"] });
    expect((await waitDone(env.catalog, operation.operation.id)).status).toBe("committed");
    const catalog = env.catalog.getModels("opencode");
    expect(catalog.invocationCapability?.opencodeVariantEncoding).toBe(encoding);
    const entry = catalog.entries.find((item) => item.nativeId === "openai/gpt-4.1");
    const selected = resolveModelSelection({
      id: "opencode", revision: 1, adapterId: "opencode", modelSelection: "explicit",
      modelId: "openai/gpt-4.1", reasoning: { mode: "explicit", value: "high" }, options: {},
    }, entry, selectionCapabilityFromCatalog(catalog, entry));
    expect(selected.modelToken).toBe(encoding === "hash" ? "openai/gpt-4.1#high" : "openai/gpt-4.1");
    expect(selected.effortArgs).toEqual(encoding === "flag" ? ["--variant", "high"] : []);
    const invocations = readFileSync(join(env.logDir, "invocations.jsonl"), "utf8")
      .trim().split(/\r?\n/).map((line) => JSON.parse(line) as { argv: string[] });
    expect(invocations.some((entry) => entry.argv.join(" ") === "run --help")).toBe(true);
  });

  it("不能选择非 Codex 命名配置，刷新保留明确错误码", async () => {
    const env = openCatalog();
    const operation = env.catalog.refreshModels({ adapter: "agy", request_id: randomUUID(), scope_id: "named" });
    const done = await waitDone(env.catalog, operation.operation.id);
    expect(done.error_code).toBe("CLI_PARAMETER_UNSUPPORTED");
    expect(existsSync(join(env.logDir, "invocations.jsonl"))).toBe(false);
  });


  it("Codex 命名 profile 在真实 JSON-RPC 握手后分页读取目录", async () => {
    const env = openCatalog({}, join(CATALOG_ROOT, "codex", "app-server.mjs"));
    const operation = env.catalog.refreshModels({ adapter: "codex", request_id: randomUUID(), scope_id: "work" });
    expect((await waitDone(env.catalog, operation.operation.id)).status).toBe("committed");
    const catalog = env.catalog.getModels("codex", "work");
    expect(catalog.nativeConfigProfile).toBe("work");
    expect(catalog.entries.map((entry) => entry.nativeId)).toEqual(["fixture-first", "fixture-second"]);
    const events = readFileSync(join(env.logDir, "rpc.jsonl"), "utf8")
      .trim().split(/\r?\n/).map((line) => JSON.parse(line) as {
        args?: string[]; method?: string; params?: { cursor?: string; limit?: number; includeHidden?: boolean };
      });
    expect(events.filter((event) => event.args).every((event) => event.args?.slice(0, 2).join(" ") === "--profile work"))
      .toBe(true);
    expect(events.filter((event) => event.method).map((event) => event.method))
      .toEqual(["initialize", "initialized", "model/list", "model/list"]);
    expect(events.filter((event) => event.method === "model/list").map((event) => event.params))
      .toEqual([{ includeHidden: false, limit: 20 }, { includeHidden: false, limit: 20, cursor: "page-2" }]);
  });

});


it.each([undefined, "work"])("opaque native scope never becomes the Codex profile argument (%s)", (profileName) => {
  const env = openCatalog({ adapterId: "codex" });
  const opaqueScope = "codex-config:fixture-scope";
  const resolver = vi.spyOn(modelIdentity, "resolveModelIdentity").mockImplementation((_store, profile) => ({
    adapterId: profile.adapterId,
    executablePath: profile.executableRef!,
    nativeConfigProfile: profile.nativeConfigProfile,
    nativeConfigScope: opaqueScope,
    accountFingerprint: "test-account",
    providerEndpointFingerprint: "test-endpoint",
    identityConfidence: "profile-scope",
    profileSelectionSupported: true,
  }));
  const scope = {
    adapterId: "codex" as const,
    executablePath: FIXTURE,
    nativeConfigProfile: profileName,
    nativeConfigScope: opaqueScope,
    accountFingerprint: "test-account",
    providerFingerprint: "test-endpoint",
  };
  env.catalog.ensureManualCandidate(scope, "gpt-fixture");
  const cached = env.catalog.readCached(scope)!;
  expect(env.catalog.getModels("codex", cached.scopeHash).scopeHash).toBe(cached.scopeHash);
  expect(resolver.mock.calls[0]?.[1].nativeConfigProfile).toBe(profileName);
  resolver.mockClear();
  expect(env.catalog.getModels("codex", "codex-config:unknown").status).toBe("missing");
  expect(resolver).not.toHaveBeenCalled();
});
