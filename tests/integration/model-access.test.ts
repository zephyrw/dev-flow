import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setup } from "../helpers.js";
import { ModelCatalogService } from "../../packages/core/src/model-catalog-service.js";
import * as registry from "../../packages/adapters/sdk/src/registry.js";
import { fingerprintModelIdentity, modelIdentityKey, resolveModelIdentity, managedAgyAccountIdentityId, readManagedAgyModelIdentity } from "../../packages/core/src/model-identity.js";
import { parseAgyModelCatalog } from "../../packages/adapters/agy/src/model-configuration.js";
import { buildFrozenInvocation } from "../../packages/adapters/sdk/src/frozen-invocation.js";
import {
  ACCESS_PROBE_PROMPT,
  ModelAccessService,
  parseProbeTerminal,
  type AccessIdentityInput,
  type ModelAccessServiceOptions,
} from "../../packages/core/src/model-access-service.js";
import { FlowError, type ToolProfile } from "../../packages/contracts/src/index.js";
import type { ModelCatalog } from "../../packages/contracts/src/model-catalog.js";
import type { ModelVerificationJob } from "../../packages/contracts/src/model-access.js";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/model-probe/cli.mjs",
);
const CATALOG_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/model-catalog",
);

type ProbeKind = "version" | "help" | "catalog" | "identity" | "probe";
type Invocation = {
  kind: ProbeKind;
  argv: string[];
  cwd: string;
  pid: number;
  stdin: string;
  env: Record<string, string>;
};

let closeEnv: (() => Promise<void>) | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (!closeEnv) return;
  await closeEnv();
  closeEnv = undefined;
});

function readCatalogStdout(adapter: string, file: string): string {
  return readFileSync(join(CATALOG_ROOT, adapter, file), "utf8");
}

function writeControl(logDir: string, patch: Record<string, unknown>) {
  const path = join(logDir, "control.json");
  const current = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
    : {};
  writeFileSync(path, JSON.stringify({ ...current, ...patch }));
}

function readInvocations(logDir: string): Invocation[] {
  const file = join(logDir, "invocations.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Invocation);
}

function probeCount(logDir: string): number {
  return readInvocations(logDir).filter((item) => item.kind === "probe").length;
}

function identity(accountId = "acct-1"): AccessIdentityInput {
  return {
    nativeConfigScope: "default",
    accountId,
    providerEndpoint: "https://api.example.test",
  };
}

function profile(
  adapterId: ToolProfile["adapterId"],
  modelId: string,
  effort: string,
): ToolProfile {
  return {
    id: "profile-1",
    revision: 1,
    adapterId,
    executableRef: FIXTURE,
    modelSelection: "explicit",
    modelId,
    reasoning: { mode: "explicit", value: effort },
    selectionKind: "fixed",
    nativeConfigProfile: "default",
    options: {},
  };
}

async function waitJob(
  access: ModelAccessService,
  job: ModelVerificationJob,
): Promise<ModelVerificationJob> {
  const deadline = Date.now() + 20000;
  let current = job;
  while (Date.now() < deadline) {
    current = access.getVerification(job.id);
    if (
      current.status !== "queued" &&
      current.status !== "checking"
    ) {
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("验证作业超时: " + current.status);
}

async function verifyNow(
  access: ModelAccessService,
  toolProfile: ToolProfile,
  idn: AccessIdentityInput,
  catalog: ModelCatalog,
  force = false,
) {
  const outcome = await access.verify({
    request_id: randomUUID(),
    profile: toolProfile,
    identity: idn,
    catalog,
    force,
  });
  if (outcome.statusCode === 200) return { outcome, job: undefined };
  const job = await waitJob(access, outcome.job);
  return { outcome, job };
}

function expectCode(run: () => unknown, code: string) {
  try {
    run();
    expect.unreachable("应当抛出 " + code);
  } catch (error) {
    expect(error).toBeInstanceOf(FlowError);
    expect(error).toMatchObject({ code });
  }
}

function dumpStore(store: { db: { prepare: (sql: string) => { all: () => unknown[] } } }) {
  const rows = store.db.prepare("SELECT data FROM entities").all() as Array<{
    data: string;
  }>;
  const events = store.db.prepare("SELECT data FROM events").all() as Array<{
    data: string;
  }>;
  return JSON.stringify({
    entities: rows.map((row) => row.data),
    events: events.map((row) => row.data),
  });
}

function openAccess(control: Record<string, unknown>, verifyTimeoutMs = 4000) {
  const env = setup();
  const logDir = join(env.root, "probe-log");
  mkdirSync(logDir, { recursive: true });
  const probeRoot = join(env.root, "empty-probe");
  mkdirSync(probeRoot, { recursive: true });
  writeControl(logDir, {
    adapterId: "codex",
    behavior: "ok",
    catalogStdout: readCatalogStdout("codex", "models-success.json"),
    ...control,
  });
  const extraEnv = { MODEL_PROBE_LOG_DIR: logDir };
  const catalog = new ModelCatalogService(env.store, {
    extraEnv,
    workingDirectory: env.root,
  });
  const access = new ModelAccessService(env.store, {
    catalog,
    extraEnv,
    probeRoot,
    verifyTimeoutMs,
  });
  closeEnv = async () => {
    await access.close();
    env.store.close();
  };
  return { ...env, logDir, probeRoot, catalog, access, extraEnv };
}

async function discoverAdapter(
  env: ReturnType<typeof openAccess>,
  adapterId: ToolProfile["adapterId"],
  idn: AccessIdentityInput,
) {
  writeControl(env.logDir, { adapterId });
  return env.catalog.discover({
    adapterId,
    executablePath: FIXTURE,
    nativeConfigScope: idn.nativeConfigScope,
    accountFingerprint: idn.accountId
      ? env.access.fingerprintValue(idn.accountId)
      : undefined,
    providerFingerprint: idn.providerEndpoint
      ? env.access.fingerprintValue(idn.providerEndpoint)
      : undefined,
  });
}

it("IT-A01：同工具同账号首次模型只做一次短探测并 verified", async () => {
  const env = openAccess({});
  const idn = identity();
  const catalog = await discoverAdapter(env, "codex", idn);
  const before = probeCount(env.logDir);
  const { outcome, job } = await verifyNow(
    env.access,
    profile("codex", "gpt-6-astra", "high"),
    idn,
    catalog,
  );
  expect(outcome.statusCode).toBe(202);
  expect(job?.status).toBe("verified");
  expect(probeCount(env.logDir) - before).toBe(1);
  const record = env.access.assertCachedAccess(
    profile("codex", "gpt-6-astra", "high"),
    idn,
    catalog,
  );
  expect(record.status).toBe("verified");
  expect(record.accessModelKey).toBe("gpt-6-astra");
});

it("IT-A02：同配置用于另一角色零新探测", async () => {
  const env = openAccess({});
  const idn = identity();
  const catalog = await discoverAdapter(env, "codex", idn);
  await verifyNow(env.access, profile("codex", "gpt-6-astra", "high"), idn, catalog);
  const before = probeCount(env.logDir);
  const other: ToolProfile = {
    ...profile("codex", "gpt-6-astra", "high"),
    id: "reviewer",
  };
  const again = await verifyNow(env.access, other, idn, catalog);
  expect(again.outcome.statusCode).toBe(200);
  expect(probeCount(env.logDir)).toBe(before);
});

it("IT-A03：服务重启后 verified 复用", async () => {
  const env = openAccess({});
  const idn = identity();
  const catalog = await discoverAdapter(env, "codex", idn);
  await verifyNow(env.access, profile("codex", "gpt-6-astra", "high"), idn, catalog);
  const before = probeCount(env.logDir);
  const access2 = new ModelAccessService(env.store, {
    catalog: env.catalog,
    extraEnv: env.extraEnv,
    probeRoot: env.probeRoot,
    verifyTimeoutMs: 4000,
  });
  const record = access2.assertCachedAccess(
    profile("codex", "gpt-6-astra", "high"),
    idn,
    catalog,
  );
  expect(record.status).toBe("verified");
  const again = await access2.verify({
    request_id: randomUUID(),
    profile: profile("codex", "gpt-6-astra", "high"),
    identity: idn,
    catalog,
  });
  expect(again.statusCode).toBe(200);
  expect(probeCount(env.logDir)).toBe(before);
});

it("IT-A04：Codex effort 改变与 Cursor Grok4.6 high→xhigh 不重复授权", async () => {
  const env = openAccess({});
  const idn = identity();
  const codex = await discoverAdapter(env, "codex", idn);
  const first = await verifyNow(
    env.access,
    profile("codex", "gpt-6-astra", "high"),
    idn,
    codex,
  );
  expect(first.job?.status).toBe("verified");
  const probes = readInvocations(env.logDir).filter((item) => item.kind === "probe");
  expect(probes[0]?.argv.join(" ")).toContain('model_reasoning_effort="high"');
  const afterCodex = probeCount(env.logDir);
  const effortChange = await verifyNow(
    env.access,
    profile("codex", "gpt-6-astra", "xhigh"),
    idn,
    codex,
  );
  expect(effortChange.outcome.statusCode).toBe(200);
  expect(probeCount(env.logDir)).toBe(afterCodex);
  writeControl(env.logDir, {
    adapterId: "cursor-agent",
    catalogStdout: readCatalogStdout("cursor-agent", "models-success.txt"),
  });
  const cursor = await discoverAdapter(env, "cursor-agent", idn);
  await verifyNow(
    env.access,
    profile("cursor-agent", "cursor-grok-4.6-high", "high"),
    idn,
    cursor,
  );
  const afterHigh = probeCount(env.logDir);
  const xhigh = await verifyNow(
    env.access,
    profile("cursor-agent", "cursor-grok-4.6-xhigh", "xhigh"),
    idn,
    cursor,
  );
  expect(xhigh.outcome.statusCode).toBe(200);
  expect(probeCount(env.logDir)).toBe(afterHigh);
  const grok = env.access.assertCachedAccess(
    profile("cursor-agent", "cursor-grok-4.6-xhigh", "xhigh"),
    idn,
    cursor,
  );
  expect(grok.accessModelKey).toBe("cursor-grok-4.6:standard");
});

it("IT-A05：新底层模型需要新访问验证", async () => {
  const env = openAccess({});
  const idn = identity();
  const catalog = await discoverAdapter(env, "codex", idn);
  await verifyNow(env.access, profile("codex", "gpt-6-astra", "high"), idn, catalog);
  const before = probeCount(env.logDir);
  const { job } = await verifyNow(
    env.access,
    profile("codex", "gpt-5.6-sol", "high"),
    idn,
    catalog,
  );
  expect(job?.status).toBe("verified");
  expect(probeCount(env.logDir) - before).toBe(1);
});

it("IT-A06：换工具或账号不复用", async () => {
  const env = openAccess({});
  const idn = identity();
  const codex = await discoverAdapter(env, "codex", idn);
  await verifyNow(env.access, profile("codex", "gpt-6-astra", "high"), idn, codex);
  writeControl(env.logDir, {
    adapterId: "cursor-agent",
    catalogStdout: readCatalogStdout("cursor-agent", "models-success.txt"),
  });
  const cursor = await discoverAdapter(env, "cursor-agent", idn);
  const beforeTool = probeCount(env.logDir);
  await verifyNow(
    env.access,
    profile("cursor-agent", "cursor-grok-4.6-high", "high"),
    idn,
    cursor,
  );
  expect(probeCount(env.logDir) - beforeTool).toBe(1);
  const beforeAccount = probeCount(env.logDir);
  await verifyNow(
    env.access,
    profile("cursor-agent", "cursor-grok-4.6-high", "high"),
    identity("acct-2"),
    cursor,
  );
  expect(probeCount(env.logDir) - beforeAccount).toBe(1);
});

it("IT-A07：OAuth token 刷新但 account 不变不重复验证", async () => {
  const env = openAccess({});
  const catalog = await discoverAdapter(env, "codex", identity());
  await verifyNow(
    env.access,
    profile("codex", "gpt-6-astra", "high"),
    { ...identity(), credentialSecret: "refresh-token-old" },
    catalog,
  );
  const before = probeCount(env.logDir);
  const again = await verifyNow(
    env.access,
    profile("codex", "gpt-6-astra", "high"),
    { ...identity(), credentialSecret: "refresh-token-new" },
    catalog,
  );
  expect(again.outcome.statusCode).toBe(200);
  expect(probeCount(env.logDir)).toBe(before);
  expect(dumpStore(env.store)).not.toContain("refresh-token-old");
  expect(dumpStore(env.store)).not.toContain("refresh-token-new");
});

it("IT-A08：401 只失效账号 scope，403 只失效该模型键", async () => {
  const env = openAccess({});
  const idn = identity();
  const other = identity("acct-other");
  const catalog = await discoverAdapter(env, "codex", idn);
  const otherCatalog = await discoverAdapter(env, "codex", other);
  await verifyNow(env.access, profile("codex", "gpt-6-astra", "high"), idn, catalog);
  await verifyNow(env.access, profile("codex", "gpt-5.6-sol", "high"), idn, catalog);
  await verifyNow(env.access, profile("codex", "gpt-6-astra", "high"), other, otherCatalog);
  writeControl(env.logDir, { behavior: "401" });
  const login = await verifyNow(
    env.access,
    profile("codex", "gpt-6-astra", "high"),
    idn,
    catalog,
    true,
  );
  expect(login.job?.status).toBe("failed");
  expect(login.job?.error_code).toBe("MODEL_LOGIN_REQUIRED");
  expectCode(
    () => env.access.assertCachedAccess(profile("codex", "gpt-6-astra", "high"), idn, catalog),
    "MODEL_LOGIN_REQUIRED",
  );
  expectCode(
    () => env.access.assertCachedAccess(profile("codex", "gpt-5.6-sol", "high"), idn, catalog),
    "MODEL_LOGIN_REQUIRED",
  );
  env.access.assertCachedAccess(
    profile("codex", "gpt-6-astra", "high"),
    other,
    otherCatalog,
  );
  writeControl(env.logDir, { behavior: "ok" });
  await verifyNow(env.access, profile("codex", "gpt-6-astra", "high"), idn, catalog, true);
  await verifyNow(env.access, profile("codex", "gpt-5.6-sol", "high"), idn, catalog, true);
  writeControl(env.logDir, { behavior: "403" });
  const forbidden = await verifyNow(
    env.access,
    profile("codex", "gpt-6-astra", "high"),
    idn,
    catalog,
    true,
  );
  expect(forbidden.job?.error_code).toBe("MODEL_FORBIDDEN");
  expectCode(
    () => env.access.assertCachedAccess(profile("codex", "gpt-6-astra", "high"), idn, catalog),
    "MODEL_FORBIDDEN",
  );
  env.access.assertCachedAccess(profile("codex", "gpt-5.6-sol", "high"), idn, catalog);
});

it("IT-A09：429 保留已验证记录，不要求重新登录", async () => {
  const env = openAccess({});
  const idn = identity();
  const catalog = await discoverAdapter(env, "codex", idn);
  await verifyNow(env.access, profile("codex", "gpt-6-astra", "high"), idn, catalog);
  writeControl(env.logDir, { behavior: "429" });
  const retry = await verifyNow(
    env.access,
    profile("codex", "gpt-6-astra", "high"),
    idn,
    catalog,
    true,
  );
  expect(retry.job?.status).toBe("temporary_error");
  const record = env.access.assertCachedAccess(
    profile("codex", "gpt-6-astra", "high"),
    idn,
    catalog,
  );
  expect(record.status).toBe("verified");
  expect(record.last_success_at).toBeTruthy();
});

it("IT-A10：目录权限失败是 environment_error，不是 login_required", async () => {
  const env = openAccess({ catalogBehavior: "env-error" });
  const idn = identity();
  const failed = await discoverAdapter(env, "codex", idn);
  expect(failed.errorCode).toBe("DISCOVERY_ENVIRONMENT_UNAVAILABLE");
  expect(failed.errorCode).not.toBe("MODEL_LOGIN_REQUIRED");
  writeControl(env.logDir, { catalogBehavior: undefined, behavior: "env-error" });
  writeControl(env.logDir, {
    catalogStdout: readCatalogStdout("codex", "models-success.json"),
  });
  const catalog = await discoverAdapter(env, "codex", idn);
  const { job } = await verifyNow(
    env.access,
    profile("codex", "gpt-6-astra", "high"),
    idn,
    catalog,
  );
  expect(job?.error_code).toBe("VERIFICATION_ENVIRONMENT_UNAVAILABLE");
  expect(job?.error_code).not.toBe("MODEL_LOGIN_REQUIRED");
  expectCode(
    () => env.access.assertCachedAccess(profile("codex", "gpt-6-astra", "high"), idn, catalog),
    "VERIFICATION_ENVIRONMENT_UNAVAILABLE",
  );
});

it("IT-A11 / IT-A12：目录列出但探测失败，stdout OK 且 exit 非零不通过", async () => {
  const env = openAccess({ behavior: "exit-nonzero-ok" });
  const idn = identity();
  const catalog = await discoverAdapter(env, "codex", idn);
  expect(catalog.entries.some((entry) => entry.nativeId === "gpt-6-astra")).toBe(true);
  const { job } = await verifyNow(
    env.access,
    profile("codex", "gpt-6-astra", "high"),
    idn,
    catalog,
  );
  expect(job?.status).toBe("failed");
  expectCode(
    () => env.access.assertCachedAccess(profile("codex", "gpt-6-astra", "high"), idn, catalog),
    "MODEL_UNAVAILABLE",
  );
  expect(env.store.list("execution_spec")).toHaveLength(0);
});

it("IT-A13：原生 fallback 到另一模型不通过", async () => {
  const env = openAccess({ behavior: "fallback" });
  const idn = identity();
  const catalog = await discoverAdapter(env, "codex", idn);
  const { job } = await verifyNow(
    env.access,
    profile("codex", "gpt-6-astra", "high"),
    idn,
    catalog,
  );
  expect(job?.status).toBe("failed");
  expect(job?.error_message).toMatch(/回退/);
  expectCode(
    () => env.access.assertCachedAccess(profile("codex", "gpt-6-astra", "high"), idn, catalog),
    "MODEL_UNAVAILABLE",
  );
});

it("IT-A14：两个并发相同验证只启动一个子进程", async () => {
  const env = openAccess({ delayMs: 400 });
  const idn = identity();
  const catalog = await discoverAdapter(env, "codex", idn);
  const toolProfile = profile("codex", "gpt-6-astra", "high");
  const before = probeCount(env.logDir);
  const first = env.access.verify({
    request_id: randomUUID(),
    profile: toolProfile,
    identity: idn,
    catalog,
  });
  const second = env.access.verify({
    request_id: randomUUID(),
    profile: toolProfile,
    identity: idn,
    catalog,
  });
  const [a, b] = await Promise.all([first, second]);
  expect(a.statusCode).toBe(202);
  expect(b.statusCode).toBe(202);
  if (a.statusCode === 202 && b.statusCode === 202) {
    expect(a.job.id).toBe(b.job.id);
    await waitJob(env.access, a.job);
  }
  expect(probeCount(env.logDir) - before).toBe(1);
});

it("IT-A15：取消验证清理探测进程，不停止业务进程", async () => {
  const env = openAccess({ delayMs: 8000, behavior: "hang" });
  const idn = identity();
  const catalog = await discoverAdapter(env, "codex", idn);
  const business = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    windowsHide: true,
    stdio: "ignore",
  });
  const outcome = await env.access.verify({
    request_id: randomUUID(),
    profile: profile("codex", "gpt-6-astra", "high"),
    identity: idn,
    catalog,
  });
  expect(outcome.statusCode).toBe(202);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const pidFile = join(env.logDir, "last-pid");
  const probePid = Number(readFileSync(pidFile, "utf8"));
  if (outcome.statusCode === 202) {
    const cancelled = await env.access.cancel(outcome.job.id);
    expect(cancelled.status).toBe("cancelled");
  }
  await new Promise((resolve) => setTimeout(resolve, 80));
  let probeAlive = true;
  try {
    process.kill(probePid, 0);
  } catch {
    probeAlive = false;
  }
  expect(probeAlive).toBe(false);
  let businessAlive = false;
  try {
    process.kill(business.pid!, 0);
    businessAlive = true;
  } catch {
    businessAlive = false;
  }
  expect(businessAlive).toBe(true);
  business.kill();
});

it("IT-A16：失败验证不发布新 spec", async () => {
  const env = openAccess({ behavior: "401" });
  const idn = identity();
  const catalog = await discoverAdapter(env, "codex", idn);
  await verifyNow(env.access, profile("codex", "gpt-6-astra", "high"), idn, catalog);
  expect(env.store.list("execution_spec")).toHaveLength(0);
});

it("IT-A17：stderr 含 token 必须脱敏且无原文落库", async () => {
  const env = openAccess({ behavior: "401" });
  const idn = identity();
  const catalog = await discoverAdapter(env, "codex", idn);
  const { job } = await verifyNow(
    env.access,
    profile("codex", "gpt-6-astra", "high"),
    idn,
    catalog,
  );
  expect(job?.error_message).toBeTruthy();
  expect(job?.error_message).not.toContain("sk-secret-live");
  expect(job?.error_message).not.toContain("abc123token");
  const dumped = dumpStore(env.store);
  expect(dumped).not.toContain("sk-secret-live");
  expect(dumped).not.toContain("abc123token");
});

it("IT-A18：探测不含业务路径、业务 token、--force/--always-approve", async () => {
  process.env.MCP_WORKFLOW_TOKEN = "business-mcp-token";
  process.env.DEVFLOW_WORKFLOW_ID = "wf-business";
  const env = openAccess({});
  const idn = identity();
  const catalog = await discoverAdapter(env, "codex", idn);
  const businessDir = join(env.root, "business-workspace");
  mkdirSync(businessDir, { recursive: true });
  await verifyNow(env.access, profile("codex", "gpt-6-astra", "high"), idn, catalog);
  const probes = readInvocations(env.logDir).filter((item) => item.kind === "probe");
  expect(probes).toHaveLength(1);
  const probe = probes[0]!;
  expect(probe.cwd.startsWith(env.probeRoot)).toBe(true);
  expect(probe.cwd).not.toContain("business-workspace");
  expect(probe.argv.join(" ")).not.toContain("--force");
  expect(probe.argv.join(" ")).not.toContain("--always-approve");
  expect(probe.argv.join(" ")).not.toContain("business-workspace");
  expect(probe.stdin).toBe(ACCESS_PROBE_PROMPT);
  expect(probe.env.MCP_WORKFLOW_TOKEN).toBeUndefined();
  expect(probe.env.DEVFLOW_WORKFLOW_ID).toBeUndefined();
  delete process.env.MCP_WORKFLOW_TOKEN;
  delete process.env.DEVFLOW_WORKFLOW_ID;
});

it("目录缓存：打开选择器不打 CLI；刷新失败保留条目；version/help 不 verified", async () => {
  const env = openAccess({});
  const idn = identity();
  const scope = {
    adapterId: "codex" as const,
    executablePath: FIXTURE,
    nativeConfigScope: idn.nativeConfigScope,
    accountFingerprint: env.access.fingerprintValue(idn.accountId!),
    providerFingerprint: env.access.fingerprintValue(idn.providerEndpoint!),
  };
  expect(env.catalog.listTools().every((item) => item.catalogStatus === "missing")).toBe(
    true,
  );
  expect(readInvocations(env.logDir)).toHaveLength(0);
  const first = await env.catalog.discover(scope);
  expect(first.status).toBe("fresh");
  expect(first.entries.length).toBeGreaterThan(0);
  const afterDiscover = readInvocations(env.logDir).length;
  const cached = env.catalog.loadForSelector(scope);
  expect(cached.entries).toHaveLength(first.entries.length);
  expect(readInvocations(env.logDir)).toHaveLength(afterDiscover);
  writeControl(env.logDir, { catalogBehavior: "fail" });
  const failed = await env.catalog.discover(scope);
  expect(failed.entries).toHaveLength(first.entries.length);
  expect(failed.status).toBe("failed");
  writeControl(env.logDir, { catalogBehavior: undefined });
  const scanned = await env.catalog.scanTools([scope]);
  expect(scanned[0]?.probeStatus).toBe("detected");
  expectCode(
    () => env.access.assertCachedAccess(profile("codex", "gpt-6-astra", "high"), idn, first),
    "MODEL_ACCESS_REQUIRED",
  );
});

it("普通 dispatch 路径不调用探测", async () => {
  const env = openAccess({});
  const idn = identity();
  const catalog = await discoverAdapter(env, "codex", idn);
  await verifyNow(env.access, profile("codex", "gpt-6-astra", "high"), idn, catalog);
  const before = probeCount(env.logDir);
  env.access.assertCachedAccess(profile("codex", "gpt-6-astra", "high"), idn, catalog);
  expect(probeCount(env.logDir)).toBe(before);
});

it("R09：中间 OK 后终态错误不能 verified", async () => {
  const env = openAccess({ behavior: "mid-ok-then-error" });
  const idn = identity();
  const catalog = await discoverAdapter(env, "codex", idn);
  const { job } = await verifyNow(
    env.access,
    profile("codex", "gpt-6-astra", "high"),
    idn,
    catalog,
  );
  expect(job?.status).toBe("failed");
  expectCode(
    () => env.access.assertCachedAccess(profile("codex", "gpt-6-astra", "high"), idn, catalog),
    "MODEL_UNAVAILABLE",
  );
});

it("R09：嵌套非结果字段 OK 不能 verified", async () => {
  const env = openAccess({ behavior: "nested-ok" });
  const idn = identity();
  const catalog = await discoverAdapter(env, "codex", idn);
  const { job } = await verifyNow(
    env.access,
    profile("codex", "gpt-6-astra", "high"),
    idn,
    catalog,
  );
  expect(job?.status).toBe("failed");
});

it("R09：明确 model mismatch 不能 verified", async () => {
  const env = openAccess({ behavior: "model-mismatch" });
  const idn = identity();
  const catalog = await discoverAdapter(env, "codex", idn);
  const { job } = await verifyNow(
    env.access,
    profile("codex", "gpt-6-astra", "high"),
    idn,
    catalog,
  );
  expect(job?.status).toBe("failed");
  expect(job?.error_message).toMatch(/回退/);
});

it("R09：终态成功且模型一致可通过", async () => {
  const env = openAccess({ behavior: "terminal-success" });
  const idn = identity();
  const catalog = await discoverAdapter(env, "codex", idn);
  const { job } = await verifyNow(
    env.access,
    profile("codex", "gpt-6-astra", "high"),
    idn,
    catalog,
  );
  expect(job?.status).toBe("verified");
});

it("R08：两个原生 profile 使用不同访问记录", async () => {
  const env = openAccess({});
  const idn = identity();
  const catalog = await discoverAdapter(env, "codex", idn);
  const firstProfile = {
    ...profile("codex", "gpt-6-astra", "high"),
    nativeConfigProfile: "work",
  };
  const secondProfile = {
    ...profile("codex", "gpt-6-astra", "high"),
    nativeConfigProfile: "home",
  };
  await verifyNow(env.access, firstProfile, { ...idn, nativeConfigScope: "work" }, catalog);
  const before = probeCount(env.logDir);
  const second = await verifyNow(
    env.access,
    secondProfile,
    { ...idn, nativeConfigScope: "home" },
    catalog,
  );
  expect(second.outcome.statusCode).toBe(202);
  expect(probeCount(env.logDir)).toBeGreaterThan(before);
});

it("R10：Grok/OpenCode/Qoder 探针带约定权限限制", async () => {
  const env = openAccess({});
  const idn = identity();
  writeControl(env.logDir, {
    adapterId: "grok-build",
    catalogStdout: readCatalogStdout("grok-build", "models-success.txt"),
  });
  const grok = await discoverAdapter(env, "grok-build", idn);
  await verifyNow(env.access, profile("grok-build", "grok-4.6", "high"), idn, grok);
  writeControl(env.logDir, {
    adapterId: "opencode",
    catalogStdout: readCatalogStdout("opencode", "models-success.txt"),
  });
  const opencode = await discoverAdapter(env, "opencode", idn);
  const openProfile = {
    ...profile("opencode", "openai/gpt-4.1", "high"),
    reasoning: { mode: "native-default" as const },
    selectionKind: "fixed" as const,
  };
  await verifyNow(env.access, openProfile, idn, opencode);
  writeControl(env.logDir, {
    adapterId: "qoder",
    catalogStdout: readCatalogStdout("qoder", "models-success.txt"),
  });
  const qoder = await discoverAdapter(env, "qoder", idn);
  await verifyNow(env.access, profile("qoder", "qwen-3.8-max", "low"), idn, qoder);
  const probes = readInvocations(env.logDir).filter((item) => item.kind === "probe");
  const grokProbe = probes.find((item) =>
    item.argv.includes("--no-plan") && item.argv.includes("--no-subagents"),
  );
  const openProbe = probes.find((item) => item.argv.includes("--pure"));
  const qoderProbe = probes.find((item) => item.env.QODER_CONFIG_DIR);
  expect(grokProbe?.argv).toEqual(expect.arrayContaining(["--disable-web-search", "--tools", ""]));
  expect(grokProbe?.argv.join(" ")).not.toContain("--always-approve");
  expect(openProbe?.argv).toEqual(expect.arrayContaining(["run", "--format", "json", "--pure"]));
  expect(openProbe?.argv.join(" ")).not.toContain("--force");
  expect(qoderProbe?.argv).toEqual(expect.arrayContaining(["--print", "--tools", ""]));
  expect(qoderProbe?.cwd.startsWith(env.probeRoot)).toBe(true);
});

it("R09：超时不能 verified", async () => {
  const terminal = parseProbeTerminal(
    {
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: true,
      cancelled: false,
      truncated: false,
    },
    "gpt-6-astra",
  );
  expect(terminal.success).toBe(false);
  expect(terminal.errorCode).toBe("MODEL_PROBE_TIMEOUT");
  const env = openAccess({ behavior: "slow-2s" }, 400);
  const idn = identity();
  const catalog = await discoverAdapter(env, "codex", idn);
  const { job } = await verifyNow(
    env.access,
    profile("codex", "gpt-6-astra", "high"),
    idn,
    catalog,
  );
  expect(job?.status).toBe("temporary_error");
  expect(job?.error_code).toBe("MODEL_PROBE_TIMEOUT");
});

it("R08：不支持 native profile 的工具保存前拒绝该字段", () => {
  const env = openAccess({});
  expectCode(
    () =>
      env.access.assertNativeProfileAllowed({
        ...profile("grok-build", "grok-4.6", "high"),
        nativeConfigProfile: "work",
      }),
    "CLI_PARAMETER_UNSUPPORTED",
  );
});


it.each([
  [{ type: "item.completed", item: { type: "agent_message", text: "OK" } }],
  [{ type: "error", error: "denied" }, { type: "turn.completed" }],
  [{ type: "system", init: { model: "other-model" } }, { type: "result", model: "gpt-6-astra" }],
])("R09：不完整终态、早期错误或早期模型回退不能发布 verified：%j", async (...records) => {
  const env = openAccess({ probeStdout: records.map((record) => JSON.stringify(record)).join("\n") + "\n" });
  const idn = identity();
  const catalog = await discoverAdapter(env, "codex", idn);
  const result = await verifyNow(env.access, profile("codex", "gpt-6-astra", "high"), idn, catalog);
  expect(result.job?.status).toBe("failed");
  expectCode(() => env.access.assertCachedAccess(profile("codex", "gpt-6-astra", "high"), idn, catalog), "MODEL_UNAVAILABLE");
});

it("R08：所有非 Codex 工具拒绝命名 profile，默认仍允许", () => {
  const env = openAccess({});
  for (const adapterId of ["agy", "claude-code", "kimi-code", "cursor-agent", "grok-build", "opencode", "qoder"] as const) {
    expect(() => env.access.assertNativeProfileAllowed(profile(adapterId, "fixture-model", "high"))).not.toThrow();
    expectCode(() => env.access.assertNativeProfileAllowed({ ...profile(adapterId, "fixture-model", "high"), nativeConfigProfile: "work" }), "CLI_PARAMETER_UNSUPPORTED");
  }
});

it("UI 省略 executableRef 时使用发现后的真实路径读目录和探测", async () => {
  const env = openAccess({});
  const idn = identity();
  await discoverAdapter(env, "codex", idn);
  vi.spyOn(registry, "resolveAdapterExecutable").mockReturnValue(FIXTURE);
  const chosen = { ...profile("codex", "gpt-6-astra", "high"), executableRef: undefined };
  const outcome = await env.access.verify({ request_id: randomUUID(), profile: chosen, identity: idn });
  expect(outcome.statusCode).toBe(202);
  if (outcome.statusCode === 202) expect((await waitJob(env.access, outcome.job)).status).toBe("verified");
  expect(env.access.assertCachedAccess(chosen, idn).status).toBe("verified");
  expect(readInvocations(env.logDir).filter((item) => item.kind === "probe")).toHaveLength(1);
});

it("共享指纹函数和 access 服务使用同一 HMAC，重复实例不更换密钥", () => {
  const env = openAccess({});
  const key = modelIdentityKey(env.store);
  const fingerprint = fingerprintModelIdentity(env.store, identity());
  expect(fingerprint.accountFingerprint).toBe(env.access.fingerprintValue(identity().accountId!));
  expect(fingerprint.providerEndpointFingerprint).toBe(env.access.fingerprintValue(identity().providerEndpoint!));
  expect(new ModelAccessService(env.store).fingerprintValue(identity().accountId!)).toBe(fingerprint.accountFingerprint);
  expect(modelIdentityKey(env.store).equals(key)).toBe(true);
});

it("运行时401仅失效相同账号和provider，403只失效指定模型", () => {
  const env = openAccess({});
  const chosen = profile("codex", "gpt-6-astra", "high");
  const sibling = profile("codex", "gpt-5.6-sol", "high");
  const idn = identity();
  const otherEndpoint = { ...idn, providerEndpoint: "https://another.example.test" };
  const otherAccount = identity("another-account");
  const first = env.access.seedVerified(chosen, idn);
  const second = env.access.seedVerified(sibling, idn);
  const third = env.access.seedVerified(chosen, otherEndpoint);
  const fourth = env.access.seedVerified(chosen, otherAccount);
  env.access.invalidate(first, "MODEL_FORBIDDEN");
  expect(env.access.getAccess(first.key)?.status).toBe("model_forbidden");
  expect(env.access.getAccess(second.key)?.status).toBe("verified");
  expect(env.access.getAccess(third.key)?.status).toBe("verified");
  env.access.invalidate(first, "MODEL_LOGIN_REQUIRED");
  expect(env.access.getAccess(first.key)?.status).toBe("login_required");
  expect(env.access.getAccess(second.key)?.status).toBe("login_required");
  expect(env.access.getAccess(third.key)?.status).toBe("verified");
  expect(env.access.getAccess(fourth.key)?.status).toBe("verified");
});


it("native-router auto 可验证实际路由结果，伪造profile路由标记不能绕过固定模型检查", async () => {
  const env = openAccess({
    adapterId: "cursor-agent",
    catalogStdout: readCatalogStdout("cursor-agent", "models-success.txt"),
    probeStdout: JSON.stringify({ type: "result", model: "gpt-6-astra", result: "OK" }) + "\n",
  });
  const idn = identity();
  const catalog = await discoverAdapter(env, "cursor-agent", idn);
  const routed: ToolProfile = {
    ...profile("cursor-agent", "auto", "high"),
    reasoning: { mode: "native-default" }, selectionKind: "native-router",
  };
  expect(catalog.entries.find((entry) => entry.nativeId === "auto")?.selectionKind).toBe("native-router");
  expect((await verifyNow(env.access, routed, idn, catalog)).job?.status).toBe("verified");
  expect(env.access.assertCachedAccess(routed, idn, catalog).accessModelKey).toBe("auto");
  const forged: ToolProfile = { ...routed, modelId: "cursor-grok-4.6-high" };
  expect(catalog.entries.find((entry) => entry.nativeId === forged.modelId)?.selectionKind).toBe("fixed");
  expect((await verifyNow(env.access, forged, idn, catalog)).job?.status).toBe("failed");
  expectCode(() => env.access.assertCachedAccess(forged, idn, catalog), "MODEL_UNAVAILABLE");
});


it.each(["providerConfigRef", "toolsetRef"] as const)("unsupported %s is rejected before verification and cached publication", async (field) => {
  const env = openAccess({});
  const chosen = profile("codex", "gpt-6-astra", "high");
  const idn = identity();
  env.access.seedVerified(chosen, idn);
  const unsupported = { ...chosen, [field]: "unsupported-reference" };
  await expect(env.access.verify({ request_id: randomUUID(), profile: unsupported, identity: idn }))
    .rejects.toMatchObject({ code: "CLI_PARAMETER_UNSUPPORTED" });
  expectCode(() => env.access.assertCachedAccess(unsupported, idn), "CLI_PARAMETER_UNSUPPORTED");
  expect(env.access.assertCachedAccess(chosen, idn).status).toBe("verified");
  expect(probeCount(env.logDir)).toBe(0);
});

it("changing Codex home cannot reuse profile-scope authorization and never changes the CLI profile name", () => {
  const env = openAccess({});
  const chosen = { ...profile("codex", "gpt-6-astra", "high"), nativeConfigProfile: "work" };
  vi.stubEnv("CODEX_HOME", join(env.root, "empty-codex-home-a"));
  const first = env.access.identityFromProfile(chosen);
  expect(first.identityConfidence).toBe("profile-scope");
  env.access.seedVerified(chosen, first);
  vi.stubEnv("CODEX_HOME", join(env.root, "empty-codex-home-b"));
  const second = env.access.identityFromProfile(chosen);
  expect(second.nativeConfigScope).not.toBe(first.nativeConfigScope);
  expectCode(() => env.access.assertCachedAccess(chosen, second), "MODEL_ACCESS_REQUIRED");
  expect(env.access.assertCachedAccess(chosen, first).status).toBe("verified");
  const native = resolveModelIdentity(env.store, chosen);
  expect(native.nativeConfigProfile).toBe("work");
  expect(native.nativeConfigScope).toBe(second.nativeConfigScope);
  expect(native.nativeConfigScope).not.toBe("work");
});

function managedAccount(
  env: ReturnType<typeof openAccess>,
  accountId = "account-a",
  epoch = 1,
  credentialRevision = 1,
) {
  const realmId = "default-agy-realm";
  env.store.put("agy_account", accountId, realmId, {
    id: accountId, realm_id: realmId, alias: accountId,
    identity: { email: `${accountId}@fixture.invalid`, verified_at: "2026-09-20T00:00:00Z" },
    secret_ref: "fixture-reference-only", credential_revision: credentialRevision,
    state: "ready", enrolled_at: "2026-09-20T00:00:00Z",
    auth: { has_refresh_credential: false, refresh_expiry_source: "not_provided" },
  });
  env.store.put("agy_realm", realmId, realmId, {
    realm_id: realmId, owner: "devflow", active_account_id: accountId,
    auth_epoch: epoch, revision: epoch, phase: "idle", service_state: "running",
    desired_enabled: true,
  });
}

function managedAccessFixture(
  delegate?: ModelAccessServiceOptions["withManagedAccountVerification"],
) {
  const env = openAccess({ adapterId: "agy", behavior: "ok" });
  managedAccount(env);
  const access = new ModelAccessService(env.store, {
    catalog: env.catalog, extraEnv: env.extraEnv, probeRoot: env.probeRoot,
    verifyTimeoutMs: 4000, withManagedAccountVerification: delegate,
  });
  const catalog = parseAgyModelCatalog({
    stdout: readCatalogStdout("agy", "models-success.txt"), cliPath: FIXTURE,
    nativeConfigScope: "agy-managed:default-agy-realm",
  });
  const chosen = profile("agy", "gemini-3.7-flash-high", "high");
  const originalClose = closeEnv!;
  closeEnv = async () => { await access.close(); await originalClose(); };
  return { env, access, catalog, chosen };
}

it("managed AGY isolates stable accounts while epoch and credential refresh preserve the same authorization", () => {
  const { env, access, chosen, catalog } = managedAccessFixture();
  const first = resolveModelIdentity(env.store, chosen);
  expect(first.accountId).toBe(managedAgyAccountIdentityId("default-agy-realm", "account-a"));
  const verified = access.seedVerified(chosen, undefined, catalog);
  managedAccount(env, "account-a", 2, 9);
  const refreshed = resolveModelIdentity(env.store, chosen);
  expect(refreshed.accountFingerprint).toBe(first.accountFingerprint);
  expect(refreshed.nativeConfigScope).toBe(first.nativeConfigScope);
  expect(access.assertCachedAccess(chosen, access.identityFromProfile(chosen), catalog).key).toBe(verified.key);
  managedAccount(env, "account-b", 3);
  const second = resolveModelIdentity(env.store, chosen, { nativeConfigScope: "default", accountId: first.accountId });
  expect(second.accountFingerprint).not.toBe(first.accountFingerprint);
  expectCode(() => access.assertCachedAccess(chosen, { nativeConfigScope: first.nativeConfigScope, accountId: first.accountId }, catalog), "MODEL_ACCESS_REQUIRED");
  expect(access.getAccess(verified.key)?.status).toBe("verified");
});

it("assertFrozenAccess uses the frozen access key after catalog changes and rejects a different managed account", () => {
  const { env, access, chosen, catalog } = managedAccessFixture();
  const native = resolveModelIdentity(env.store, chosen);
  const frozen = buildFrozenInvocation(chosen, catalog.entries.find(entry => entry.nativeId === chosen.modelId), {}, native, "profile-native");
  const record = access.seedVerified(chosen, undefined, catalog);
  expect(record.accessModelKey).toBe("gemini-3.7-flash");
  // No catalog was installed in the service cache: re-translating profile.modelId
  // here would incorrectly seek the variant token instead of this frozen family.
  expect(access.assertFrozenAccess(chosen, frozen).key).toBe(record.key);
  managedAccount(env, "account-b", 2);
  expectCode(() => access.assertFrozenAccess(chosen, frozen), "MODEL_IDENTITY_CHANGED");
});

it("managed AGY verification fails closed without account coordination and launches no native probe", async () => {
  const { env, access, chosen, catalog } = managedAccessFixture();
  const result = await verifyNow(access, chosen, access.identityFromProfile(chosen), catalog);
  expect(result.job).toMatchObject({ status: "failed", error_code: "VERIFICATION_ENVIRONMENT_UNAVAILABLE" });
  expect(probeCount(env.logDir)).toBe(0);
});

it("managed verification delegates the existing exact model probe and retains account-scoped results", async () => {
  const delegated: unknown[] = [];
  const { env, access, chosen, catalog } = managedAccessFixture(async (identity, verify) => {
    delegated.push(identity);
    return verify();
  });
  const result = await verifyNow(access, chosen, access.identityFromProfile(chosen), catalog);
  expect(result.job?.status).toBe("verified");
  expect(delegated).toEqual([readManagedAgyModelIdentity(env.store)]);
  const probes = readInvocations(env.logDir).filter(item => item.kind === "probe");
  expect(probes).toHaveLength(1);
  expect(probes[0]?.argv).toContain("gemini-3.7-flash-high");
  expect(probes[0]?.argv).toContain(ACCESS_PROBE_PROMPT);
  expect((await verifyNow(access, chosen, access.identityFromProfile(chosen), catalog)).outcome.statusCode).toBe(200);
  expect(delegated).toHaveLength(1);
  managedAccount(env, "account-b", 2);
  expectCode(() => access.assertCachedAccess(chosen, access.identityFromProfile(chosen), catalog), "MODEL_ACCESS_REQUIRED");
});

it("a successful managed probe cannot publish after the account epoch changes", async () => {
  let changeAccount!: () => void;
  const { env, access, chosen, catalog } = managedAccessFixture(async (_identity, verify) => {
    const result = await verify();
    changeAccount();
    return result;
  });
  changeAccount = () => managedAccount(env, "account-a", 2);
  const result = await verifyNow(access, chosen, access.identityFromProfile(chosen), catalog);
  expect(result.job).toMatchObject({ status: "failed", error_code: "MODEL_IDENTITY_CHANGED" });
  expect(env.store.list<{status: string}>("model_access").some(record => record.status === "verified")).toBe(false);
});

it.each(["cancel", "close"] as const)("%s prevents an already queued managed verification from starting later", async (action) => {
  let release!: () => void;
  let finished!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const done = new Promise<void>(resolve => { finished = resolve; });
  const { env, access, chosen, catalog } = managedAccessFixture(async (_identity, verify) => {
    await gate;
    try { return await verify(); } finally { finished(); }
  });
  const started = await access.verify({ request_id: randomUUID(), profile: chosen, catalog });
  expect(started.statusCode).toBe(202);
  if (started.statusCode !== 202) return;
  if (action === "cancel") await access.cancel(started.job.id);
  else await access.close();
  release();
  await done;
  expect(access.getVerification(started.job.id).status).toBe("cancelled");
  expect(probeCount(env.logDir)).toBe(0);
});
