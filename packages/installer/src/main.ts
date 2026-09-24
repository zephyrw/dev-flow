import { InstallationStateManager, INSTALL_EXIT_CODES } from "./state.js";
import { ClientInstaller } from "../../clients/src/installer.js";
import {
  SupportedAdapters,
  ToolProfileSchema,
  type SupportedAdapterId,
  type ToolProfile,
} from "../../contracts/src/execution-spec.js";
import {
  migrateAccountConfiguration,
  UpgradeManager,
  writeAccountsLauncher,
} from "./upgrade.js";
import {
  ConfigSchema,
  loadConfig,
  type Config,
} from "../../contracts/src/config.js";
import {
  parseStoredToolProfile,
  type ModelCatalog,
  type ModelDefaults,
} from "../../contracts/src/index.js";
import { atomicWrite, hash, now } from "../../core/src/util.js";
import { ModelDefaultsService } from "../../core/src/model-defaults-service.js";
import { assertProfilesVerified } from "../../core/src/access-guard.js";
import { ModelCatalogService } from "../../core/src/model-catalog-service.js";
import { resolveModelIdentity } from "../../core/src/model-identity.js";
import { Store } from "../../store/src/store.js";
import { createDefaultAdapterRegistry } from "../../adapters/sdk/src/index.js";
import { resolve, join } from "node:path";
import {
  existsSync,
  mkdirSync,
  cpSync,
  readFileSync,
  renameSync,
  rmSync,
  lstatSync,
} from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { acquireControllerLock } from "../../process/src/controller-lock.js";
import { cleanProcessEnvironment } from "../../process/src/manager.js";
import {
  acquireInstallTransactionLock,
  ensureInstallLayout,
  installBootstrapRuntime,
  writeCurrentPointer,
  writeStableEntry,
  appendWindowsUserPath,
  upsertShellPathBlock,
  type CurrentPointer,
} from "./launchers.js";
import {
  readRuntimeFilesManifest,
  requiredEntries,
  COMPLIANCE_BASENAMES,
} from "./runtime-files.js";
import { isWithinRoot, assertSafeArchiveEntry } from "./download.js";

const exec = promisify(execFile);

export interface InstallerRoleInputs {
  plannerTool?: string;
  plannerModel?: string;
  plannerEffort?: string;
  executorTool?: string;
  executorModel?: string;
  executorEffort?: string;
}

export interface InstallerRunOptions {
  sourceDir?: string;
  targetTools?: string[];
  installRoot?: string;
  clientHome?: string;
  port?: number;
  roleInputs?: InstallerRoleInputs;
  /** --require-ready: only this mode treats unfinished tool setup as non-success. */
  requireReady?: boolean;
  /** Skip opening the browser after install (prints the address instead). */
  noOpen?: boolean;
  /** Skip PATH / system menu registration (tests). */
  skipSystemRegistration?: boolean;
}

export class InstallerDefaultsError extends Error {
  readonly code = "illegal" as const;
}

export type ApplyInstallerDefaultsResult = {
  defaults: ModelDefaults;
  saved: boolean;
  pending: boolean;
  message: string;
};

export function parseInstallerCliArgs(args: string[]): {
  sourceDir?: string;
  installRoot?: string;
  targetTools?: string[];
  roleInputs: InstallerRoleInputs;
  requireReady: boolean;
  noOpen: boolean;
} {
  const read = (name: string) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const value = args[i + 1];
    if (!value || value.startsWith("--")) return undefined;
    return value;
  };
  const tools = read("--tools");
  return {
    sourceDir: read("--source"),
    installRoot: read("--install-dir"),
    // 空/未指定 = 不选客户端（合法）；不再默认 ["codex"]。
    targetTools: tools?.split(",").map((t) => t.trim()).filter(Boolean),
    roleInputs: {
      plannerTool: read("--planner-tool"),
      plannerModel: read("--planner-model"),
      plannerEffort: read("--planner-effort"),
      executorTool: read("--executor-tool"),
      executorModel: read("--executor-model"),
      executorEffort: read("--executor-effort"),
    },
    requireReady: args.includes("--require-ready"),
    noOpen: args.includes("--no-open"),
  };
}

export function roleInputsProvided(inputs: InstallerRoleInputs): boolean {
  return Boolean(
    inputs.plannerTool ||
      inputs.plannerModel ||
      inputs.plannerEffort ||
      inputs.executorTool ||
      inputs.executorModel ||
      inputs.executorEffort,
  );
}

function rolePatchProvided(tool?: string, model?: string, effort?: string) {
  return Boolean(tool || model || effort);
}

function parseAdapterId(value: string): SupportedAdapterId {
  if (SupportedAdapters.includes(value as SupportedAdapterId)) {
    return value as SupportedAdapterId;
  }
  throw new InstallerDefaultsError("未知工具：" + value);
}

function executableRefFor(
  adapterId: SupportedAdapterId,
  config: Config,
): string | undefined {
  if (adapterId === "codex") return config.models.codex_executable ?? "codex";
  if (adapterId === "agy") return config.models.agy_executable ?? "agy";
  return undefined;
}

function catalogForProfile(
  store: Store,
  profile: ToolProfile,
): ModelCatalog | undefined {
  const native = resolveModelIdentity(store, profile);
  return new ModelCatalogService(store).readCached({
    adapterId: profile.adapterId,
    executablePath: native.executablePath,
    nativeConfigProfile: native.nativeConfigProfile,
    nativeConfigScope: native.nativeConfigScope,
    accountFingerprint: native.accountFingerprint,
    providerFingerprint: native.providerEndpointFingerprint,
  });
}

function catalogEntryFor(store: Store, profile: ToolProfile) {
  if (!profile.modelId) return undefined;
  return catalogForProfile(store, profile)?.entries.find(
    (entry) =>
      entry.nativeId === profile.modelId || entry.entryId === profile.modelId,
  );
}

function catalogEffortDefault(
  store: Store,
  profile: ToolProfile,
): string | undefined {
  const entry = catalogEntryFor(store, profile);
  return entry?.effort.defaultValue ?? entry?.effort.fixedValue;
}

function assertCatalogEffortAllowed(
  store: Store,
  profile: ToolProfile,
  effort: string,
) {
  const entry = catalogEntryFor(store, profile);
  if (!entry) return;
  if (entry.effort.status === "unsupported") {
    throw new InstallerDefaultsError("当前模型不适用思考强度");
  }
  if (entry.effort.status === "unknown") {
    throw new InstallerDefaultsError("当前客户端未提供该档位信息");
  }
  if (entry.effort.values.length && !entry.effort.values.includes(effort)) {
    throw new InstallerDefaultsError("当前模型不支持该思考强度");
  }
}

function effortAllowed(
  store: Store,
  profile: ToolProfile,
  effort: string,
): boolean {
  const entry = catalogEntryFor(store, profile);
  if (!entry) return true;
  if (entry.effort.status === "unsupported") return false;
  if (entry.effort.status === "unknown") return effort.length === 0;
  if (entry.effort.values.length && !entry.effort.values.includes(effort)) {
    return false;
  }
  return true;
}

function explicitEffort(
  store: Store,
  profile: ToolProfile,
  effort: string,
): ToolProfile["reasoning"] {
  assertCatalogEffortAllowed(store, profile, effort);
  return { mode: "explicit", value: effort };
}

function catalogOrNativeDefault(
  store: Store,
  profile: ToolProfile,
): ToolProfile["reasoning"] {
  const catalogDefault = catalogEffortDefault(store, profile);
  if (catalogDefault) return { mode: "explicit", value: catalogDefault };
  return { mode: "native-default" };
}

type OverlayResult =
  | { ok: true; profile: ToolProfile }
  | { ok: false; reason: "incomplete" | "illegal"; message: string };

function overlayRoleProfile(
  base: ToolProfile,
  patch: { tool?: string; model?: string; effort?: string },
  store: Store,
  config: Config,
): OverlayResult {
  if (!rolePatchProvided(patch.tool, patch.model, patch.effort)) {
    return { ok: true, profile: parseStoredToolProfile(base) };
  }
  const nextAdapter = patch.tool ? parseAdapterId(patch.tool) : base.adapterId;
  const toolChanged = nextAdapter !== base.adapterId;
  if (toolChanged && !patch.model) {
    return {
      ok: false,
      reason: "incomplete",
      message: "改工具时必须指定合法模型",
    };
  }
  if (toolChanged) {
    const next: ToolProfile = {
      ...base,
      adapterId: nextAdapter,
      modelSelection: "explicit",
      modelId: patch.model!,
      selectionKind: "fixed",
      reasoning: { mode: "native-default" },
    };
    delete next.providerConfigRef;
    delete next.toolsetRef;
    delete next.nativeConfigProfile;
    next.options = {};
    const executable = executableRefFor(nextAdapter, config);
    if (executable) next.executableRef = executable;
    else delete next.executableRef;
    next.reasoning = patch.effort
      ? explicitEffort(store, next, patch.effort)
      : catalogOrNativeDefault(store, next);
    return { ok: true, profile: ToolProfileSchema.parse(next) };
  }
  const modelChanged = Boolean(patch.model && patch.model !== base.modelId);
  const next: ToolProfile = {
    ...base,
    ...(patch.model
      ? {
          modelSelection: "explicit" as const,
          modelId: patch.model,
          selectionKind: "fixed" as const,
        }
      : {}),
  };
  if (patch.effort) {
    next.reasoning = explicitEffort(store, next, patch.effort);
  } else if (modelChanged) {
    const oldEffort =
      base.reasoning?.mode === "explicit" ? base.reasoning.value : undefined;
    if (oldEffort && !effortAllowed(store, next, oldEffort)) {
      throw new InstallerDefaultsError("当前模型不支持该思考强度");
    }
  }
  return { ok: true, profile: ToolProfileSchema.parse(next) };
}

export function mergeInstallerDefaults(
  store: Store,
  current: ModelDefaults,
  inputs: InstallerRoleInputs,
  config: Config,
): {
  plannerProfile: ToolProfile;
  executorProfile: ToolProfile;
  complete: boolean;
  message?: string;
} {
  const planner = overlayRoleProfile(
    current.plannerProfile,
    {
      tool: inputs.plannerTool,
      model: inputs.plannerModel,
      effort: inputs.plannerEffort,
    },
    store,
    config,
  );
  const executor = overlayRoleProfile(
    current.executorProfile,
    {
      tool: inputs.executorTool,
      model: inputs.executorModel,
      effort: inputs.executorEffort,
    },
    store,
    config,
  );
  if (!planner.ok) {
    return {
      plannerProfile: current.plannerProfile,
      executorProfile: current.executorProfile,
      complete: false,
      message: planner.message,
    };
  }
  if (!executor.ok) {
    return {
      plannerProfile: current.plannerProfile,
      executorProfile: current.executorProfile,
      complete: false,
      message: executor.message,
    };
  }
  return {
    plannerProfile: planner.profile,
    executorProfile: executor.profile,
    complete: true,
  };
}

function profilesVerified(store: Store, profiles: ToolProfile[]): boolean {
  try {
    assertProfilesVerified(store, profiles);
    return true;
  } catch {
    return false;
  }
}

function selectedProfiles(
  defaults: ModelDefaults,
  inputs: InstallerRoleInputs,
): ToolProfile[] {
  const selected: ToolProfile[] = [];
  if (
    rolePatchProvided(
      inputs.plannerTool,
      inputs.plannerModel,
      inputs.plannerEffort,
    )
  ) {
    selected.push(defaults.plannerProfile);
  }
  if (
    rolePatchProvided(
      inputs.executorTool,
      inputs.executorModel,
      inputs.executorEffort,
    )
  ) {
    selected.push(defaults.executorProfile);
  }
  return selected;
}

function defaultsPending(
  store: Store,
  defaults: ModelDefaults,
  inputs: InstallerRoleInputs,
): boolean {
  const selected = selectedProfiles(defaults, inputs);
  if (selected.length) return !profilesVerified(store, selected);
  return !profilesVerified(store, [
    defaults.plannerProfile,
    defaults.executorProfile,
  ]);
}

export function applyInstallerModelDefaults(options: {
  store: Store;
  config: Config;
  roleInputs?: InstallerRoleInputs;
  targetTools?: string[];
}): ApplyInstallerDefaultsResult {
  void options.targetTools;
  const inputs = options.roleInputs ?? {};
  const service = new ModelDefaultsService(options.store);
  const current = service.getOrImport(options.config);
  if (!roleInputsProvided(inputs)) {
    const pending = defaultsPending(options.store, current, inputs);
    return {
      defaults: current,
      saved: false,
      pending,
      message: pending ? "模型设置待完成" : "模型默认配置已就绪",
    };
  }
  const merged = mergeInstallerDefaults(
    options.store,
    current,
    inputs,
    options.config,
  );
  if (!merged.complete) {
    return {
      defaults: current,
      saved: false,
      pending: true,
      message: merged.message ?? "模型设置待完成",
    };
  }
  try {
    assertProfilesVerified(options.store, [
      merged.plannerProfile,
      merged.executorProfile,
    ]);
    service.save({
      request_id: randomUUID(),
      expected_defaults_revision: current.revision,
      plannerProfile: merged.plannerProfile,
      executorProfile: merged.executorProfile,
    });
  } catch (error) {
    if (error instanceof InstallerDefaultsError) throw error;
    options.store.put("model_defaults_draft", "global", "global", {
      schema_version: 1,
      expected_defaults_revision: current.revision,
      plannerProfile: merged.plannerProfile,
      executorProfile: merged.executorProfile,
      updated_at: new Date().toISOString(),
    });
    return {
      defaults: current,
      saved: false,
      pending: true,
      message: "模型设置待完成",
    };
  }
  const saved = service.getOrImport(options.config);
  const pending = defaultsPending(options.store, saved, inputs);
  return {
    defaults: saved,
    saved: true,
    pending,
    message: pending ? "模型设置待完成" : "模型默认配置已就绪",
  };
}

export function applyInstallerModelDefaultsFromConfigFile(
  configFile: string,
  roleInputs: InstallerRoleInputs = {},
  targetTools?: string[],
): ApplyInstallerDefaultsResult {
  const config = loadConfig(configFile);
  const store = new Store(join(config.storage_root, "devflow.sqlite"));
  try {
    return applyInstallerModelDefaults({
      store,
      config,
      roleInputs,
      targetTools,
    });
  } finally {
    store.close();
  }
}

export function readBuildInfo(sourceDir: string): Record<string, unknown> {
  const file = join(sourceDir, "build-info.json");
  if (!existsSync(file)) {
    throw new Error("安装包不完整：缺少 build-info.json 构建身份");
  }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") {
      throw new Error("build-info.json 无效");
    }
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message.includes("build-info")) {
      throw error;
    }
    throw new Error("安装包不完整：build-info.json 无法解析");
  }
}

export function computeContentDigest(
  sourceDir: string,
  paths: string[],
): string {
  return hash(
    paths
      .map((p) => p + ":" + hash(readFileSync(join(sourceDir, p))))
      .join("\n"),
  );
}

export interface InstallReceipt {
  digest: string;
  content_digest: string;
  application_version: string;
  build_revision: string;
  build_tag?: string;
  built_at?: string;
  platform: string;
  node_version?: string;
  bootstrap?: Record<string, string>;
  updated_at: string;
}

/** Same version + same digest is idempotent. Same version + different digest is refused (U-04). */
export function assertVersionDigestCompatible(
  existingReceiptRaw: string | undefined,
  digest: string,
  version: string,
): { reuse: boolean } {
  if (!existingReceiptRaw) return { reuse: false };
  let receipt: any;
  try {
    receipt = JSON.parse(existingReceiptRaw);
  } catch {
    throw new Error(
      `版本 ${version} 已存在且收据无法解析，不能覆盖。请使用新版本号或独立开发目录。`,
    );
  }
  const existingDigest = receipt.digest ?? receipt.content_digest;
  if (existingDigest === digest) return { reuse: true };
  throw new Error(
    `版本 ${version} 已安装但内容摘要不同，拒绝覆盖。请使用新版本号或独立开发目录。`,
  );
}

/** F stream UpgradeManager surface used by the update path (integration-aligned). */
export interface UpgradeMaintenanceApi {
  prepareCandidate(meta: {
    sourceDir: string;
    targetVersion: string;
  }): Promise<{ targetDir: string; digest: string }>;
  requestMaintenance(): Promise<void>;
  waitForQuiescent(options: {
    onActiveTasks: "wait" | "pause-and-update";
  }): Promise<void>;
  runUpgradeStateMachine(options: unknown): Promise<unknown>;
}

export function asUpgradeMaintenanceApi(manager: UpgradeManager): UpgradeMaintenanceApi {
  const api = manager as unknown as Partial<UpgradeMaintenanceApi>;
  for (const name of [
    "prepareCandidate",
    "requestMaintenance",
    "waitForQuiescent",
    "runUpgradeStateMachine",
  ] as const) {
    if (typeof api[name] !== "function") {
      throw new Error(
        "升级维护接口尚未就绪：" + name + "（需与升级流集成对齐）",
      );
    }
  }
  return api as UpgradeMaintenanceApi;
}

async function copyTreeProtected(source: string, destination: string, root: string) {
  if (!isWithinRoot(root, destination)) {
    throw new Error("拒绝跨根写入：" + destination);
  }
  if (!existsSync(source)) return;
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) {
    throw new Error("拒绝复制符号链接：" + source);
  }
  cpSync(source, destination, {
    recursive: true,
    dereference: true,
    force: true,
    errorOnExist: false,
  });
}

export async function runInstaller(
  options: InstallerRunOptions = {},
): Promise<number> {
  const root = resolve(
    options.installRoot ?? join(homedir(), ".local", "share", "devflow"),
  );
  const source = resolve(options.sourceDir ?? process.cwd());
  const state = new InstallationStateManager(join(root, "state.json"));
  // tools 空数组合法：默认不选客户端、不写客户端配置。
  const tools = (options.targetTools ?? []).filter(Boolean);
  const roleInputs = options.roleInputs ?? {};
  const requireReady = options.requireReady === true;
  let code: number = INSTALL_EXIT_CODES.DOWNLOAD_VERIFICATION_FAILED;
  let releaseController: (() => Promise<void>) | undefined;
  let releaseInstall: (() => Promise<void>) | undefined;
  let originalConfig: string | undefined;
  let originalPointer: string | undefined;
  let configurationChanged = false;
  let writableStateStarted = false;
  const layout = ensureInstallLayout(root);
  try {
    state.updateResult({ software: { status: "downloading" } });
    if (tools.some((t) => !SupportedAdapters.includes(t as SupportedAdapterId)))
      return INSTALL_EXIT_CODES.CONFIGURATION_CONFLICT;
    // 操作正式目录前取得安装事务所有权（防两个安装器交错）。
    releaseInstall = await acquireInstallTransactionLock(root);

    const sourcePackage = JSON.parse(
      readFileSync(join(source, "package.json"), "utf8"),
    );
    const version: string = sourcePackage.version;
    if (
      sourcePackage.name !== "devflow" ||
      typeof version !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)
    )
      throw new Error("安装包身份或版本不符");

    const buildInfo = readBuildInfo(source);
    const buildRevision = String(buildInfo.build_revision ?? "");
    const applicationVersion = String(
      buildInfo.application_version ?? version,
    );

    state.updateResult({ software: { status: "verifying" } });
    const runtimeManifest = readRuntimeFilesManifest(source);
    const requiredList = requiredEntries(runtimeManifest).map((e) => e.path);
    // Critical runtime gates (I-05): bundled Node, native, SQLite, worker, runner.
    const bundledNodeRelative =
      "runtime/" + (process.platform === "win32" ? "node.exe" : "node");
    const critical = [
      ...new Set([
        ...requiredList,
        "dist/apps/api/src/main.js",
        "dist/apps/api/src/accounts-main.js",
        "dist/packages/agy-accounts/src/service.js",
        "dist/packages/agy-accounts/src/credential-worker.js",
        "dist/packages/process/src/runner-entry.js",
        "dist/packages/process/src/native/index.js",
        "dist/packages/service/src/open.js",
        ...(process.platform === "win32"
          ? ["dist/packages/agy-accounts/src/credential-windows.js"]
          : []),
        "dist/web/index.html",
        "dist/packages/bridge/src/planner.js",
        "dist/packages/service/src/launcher.js",
        "dist/packages/cli/src/main.js",
        "package.json",
        "build-info.json",
        "runtime-files.json",
        bundledNodeRelative,
        "node_modules/better-sqlite3/package.json",
        "node_modules/koffi/package.json",
        ...[
          "devflow",
          "devflow-project-onboard",
          "devflow-plan",
          "devflow-execute",
          "devflow-test",
          "devflow-review",
        ].map((s) => "packages/skills/" + s + "/SKILL.md"),
      ]),
    ];
    for (const path of critical) {
      if (assertSafeArchiveEntry(source, path, "file").safe === false) {
        throw new Error("安装包路径不安全：" + path);
      }
      if (!existsSync(join(source, path)))
        throw new Error("安装包不完整：" + path);
    }
    for (const name of COMPLIANCE_BASENAMES) {
      // LICENSE / THIRD_PARTY_NOTICES / sbom / build-info / compatibility / runtime-files
      if (name === "runtime-files.json" || name === "build-info.json") continue;
      if (!existsSync(join(source, name))) {
        // Compliance metadata is required for published packages; keep copying when present.
        // Missing optional compliance is recorded, not silently ignored for required categories.
        const listed = runtimeManifest.entries.some(
          (e) => e.category === "compliance" && e.path === name,
        );
        if (listed) throw new Error("安装包不完整：" + name);
      }
    }

    const target = join(root, "versions", version);
    const contentDigest = computeContentDigest(source, critical);
    const productDigest = hash(
      contentDigest +
        ":" +
        applicationVersion +
        ":" +
        buildRevision,
    );
    const receiptPath = join(target, "install-source.json");
    if (source !== target && existsSync(target)) {
      const existing = existsSync(receiptPath)
        ? readFileSync(receiptPath, "utf8")
        : undefined;
      assertVersionDigestCompatible(existing, productDigest, version);
    }

    state.updateComponent("service", version, "PLANNED");
    if (source !== target && !existsSync(target)) {
      const staging = target + ".staging-" + randomUUID();
      mkdirSync(staging, { recursive: true });
      try {
        for (const entry of ["dist", "packages/skills", "node_modules"]) {
          await copyTreeProtected(join(source, entry), join(staging, entry), staging);
        }
        // Package root files: identity, compliance, runtime manifest.
        for (const file of [
          "package.json",
          "build-info.json",
          "runtime-files.json",
          ...COMPLIANCE_BASENAMES,
        ]) {
          if (existsSync(join(source, file))) {
            const destination = join(staging, file);
            if (!isWithinRoot(staging, destination)) {
              throw new Error("拒绝跨根写入：" + destination);
            }
            cpSync(join(source, file), destination, { force: true });
          }
        }
        if (existsSync(join(source, "runtime"))) {
          await copyTreeProtected(
            join(source, "runtime"),
            join(staging, "runtime"),
            staging,
          );
        }
        const receipt: InstallReceipt = {
          digest: productDigest,
          content_digest: contentDigest,
          application_version: applicationVersion,
          build_revision: buildRevision,
          build_tag: buildInfo.build_tag ? String(buildInfo.build_tag) : undefined,
          built_at: buildInfo.built_at ? String(buildInfo.built_at) : undefined,
          platform: process.platform,
          node_version: buildInfo.node_version
            ? String(buildInfo.node_version)
            : undefined,
          updated_at: now(),
        };
        atomicWrite(
          join(staging, "install-source.json"),
          JSON.stringify(receipt, null, 2),
        );
        renameSync(staging, target);
      } catch (error) {
        try {
          rmSync(staging, { recursive: true, force: true });
        } catch {}
        throw error;
      }
    } else if (source !== target && existsSync(target)) {
      // Idempotent reuse: refresh receipt fields that describe the same content.
      const existing = JSON.parse(readFileSync(receiptPath, "utf8"));
      atomicWrite(
        receiptPath,
        JSON.stringify(
          {
            ...existing,
            digest: productDigest,
            content_digest: contentDigest,
            application_version: applicationVersion,
            build_revision: buildRevision,
            updated_at: now(),
          },
          null,
          2,
        ),
      );
    }

    // 正式包必须内置 Node；禁止静默回退系统 Node（I-05）。
    const bundledNode = join(source, "runtime", process.platform === "win32" ? "node.exe" : "node");
    const targetNode = join(target, "runtime", process.platform === "win32" ? "node.exe" : "node");
    if (!existsSync(bundledNode)) {
      throw new Error("安装包不完整：缺少内置 Node 运行时，不会回退到系统 Node");
    }
    const node = existsSync(targetNode) ? targetNode : bundledNode;
    const bootstrap = installBootstrapRuntime(root, {
      sourceNode: node,
      deferReplaceOnBusy: true,
    });
    state.updateComponent("bootstrap", version, "INSTALLED");

    const nodeVersion = (
      await exec(node, ["--version"], { windowsHide: true, timeout: 10000 })
    ).stdout.trim();
    const [major, minor, patch] = nodeVersion
      .replace(/^v/, "")
      .split(".")
      .map(Number);
    if (
      !major ||
      major < 22 ||
      (major === 22 && (minor! < 23 || (minor === 23 && patch! < 2)))
    )
      throw new Error("Node 版本不满足要求");
    state.updateComponent("node", nodeVersion, "VERIFIED");
    await exec(
      node,
      [
        "--input-type=module",
        "-e",
        "const n=await import(process.argv[1]);await n.getNativeAsync();const m=await import(process.argv[2]);const db=new m.default(':memory:');db.close();",
        pathToFileURL(join(target, "dist/packages/process/src/native/index.js"))
          .href,
        pathToFileURL(join(target, "node_modules/better-sqlite3/lib/index.js"))
          .href,
      ],
      {
        cwd: target,
        env: cleanProcessEnvironment(),
        windowsHide: true,
        timeout: 15000,
      },
    );
    const credentialWorker = join(
      target,
      "dist",
      "packages",
      "agy-accounts",
      "src",
      "credential-worker.js",
    );
    if (!existsSync(credentialWorker)) throw new Error("凭据 Worker 不存在");
    state.updateComponent("credential-worker", "node-module", "VERIFIED");
    state.updateComponent("service", version, "INSTALLED");
    code = INSTALL_EXIT_CODES.CONFIGURATION_CONFLICT;
    const config = join(root, "devflow.yaml");
    const currentPointer = join(root, "current.json");
    const upgrade = new UpgradeManager({
      installDir: root,
      targetVersion: version,
    });
    if (existsSync(config)) {
      originalConfig = readFileSync(config, "utf8");
      const previous = loadConfig(config);
      releaseController = await acquireControllerLock(previous.storage_root);
      const sqlite = join(previous.storage_root, "devflow.sqlite");
      await upgrade.assertQuiescent(sqlite);
      await upgrade.backupData(sqlite);
    } else {
      releaseController = await acquireControllerLock(join(root, "state"));
    }
    if (existsSync(currentPointer)) {
      originalPointer = readFileSync(currentPointer, "utf8");
      atomicWrite(
        join(root, "backup", "current-" + randomUUID() + ".json"),
        originalPointer,
      );
    }
    configurationChanged = true;
    if (!existsSync(config))
      atomicWrite(
        config,
        JSON.stringify(
          ConfigSchema.parse({
            storage_root: join(root, "state"),
            workspace_root: join(root, "worktrees"),
            agy_accounts: { enabled: false },
            server: {
              port: options.port ?? 4810,
              human_origin: "http://localhost:" + (options.port ?? 4810),
            },
          }),
          null,
          2,
        ),
      );
    else migrateAccountConfiguration(config);
    const configured = loadConfig(config);
    let accountPrerequisite = "unsupported_platform";
    if (process.platform === "win32") {
      accountPrerequisite = "credential_capability_unverified";
    }
    state.updateComponent(
      "credential-worker",
      "3.0.0-node",
      "INSTALLED",
      accountPrerequisite,
    );
    state.updateComponent(
      "agy-accounts",
      version,
      "DISCOVERED",
      accountPrerequisite,
    );
    console.log(
      "AGY 账号功能就绪状态：" +
        accountPrerequisite +
        "。安装不会登录或更改账号。",
    );

    // tools 空/未选：不进入客户端配置写入循环，不写 Codex 等客户端配置。
    if (tools.length) {
      const clients = new ClientInstaller(join(target, "packages", "skills"), {
        home: options.clientHome,
        node,
        bridge: join(target, "dist/packages/bridge/src/planner.js"),
        config,
      });
      for (const client of tools as SupportedAdapterId[]) {
        const report = clients.installSkillsForClient(client);
        atomicWrite(
          join(root, "client-" + client + ".json"),
          JSON.stringify(report, null, 2),
        );
        if (
          !report.mcpConfigured ||
          report.skillsInstalled.some((s) => s.status !== "installed")
        )
          throw new Error(report.error ?? "Skill 安装失败");
        state.updateComponent("skills:" + client, version, "VERIFIED");
      }
    }
    state.updateComponent("service", version, "CONFIGURED");
    code = INSTALL_EXIT_CODES.CONFIGURATION_CONFLICT;
    const loaded = loadConfig(config);
    const pointer: CurrentPointer = {
      version,
      root: target,
      config,
      node,
      schema: 2,
      application_version: applicationVersion,
      build_revision: buildRevision,
      updated_at: now(),
    };
    writeCurrentPointer(root, pointer);
    writableStateStarted = true;
    const defaultsResult = applyInstallerModelDefaultsFromConfigFile(
      config,
      roleInputs,
      tools,
    );
    code = INSTALL_EXIT_CODES.SERVICE_UNHEALTHY;
    const launcher = join(target, "dist/packages/service/src/launcher.js");
    await releaseController();
    releaseController = undefined;
    await exec(
      node,
      [
        "--input-type=module",
        "-e",
        "const m=await import(process.argv[1]);await m.ensureService();",
        pathToFileURL(launcher).href,
      ],
      {
        cwd: target,
        env: cleanProcessEnvironment({ DEVFLOW_CONFIG: config }),
        windowsHide: true,
        timeout: 150000,
      },
    );
    writeCurrentPointer(root, pointer);
    writeAccountsLauncher(root);

    // Stable entry + user PATH / menu (absolute open does not wait for PATH refresh).
    let openHint = loaded.server.human_origin;
    let conflictHint: string[] = [];
    if (!options.skipSystemRegistration) {
      const stable = writeStableEntry(root);
      conflictHint = stable.conflicts;
      if (process.platform === "win32") {
        try {
          appendWindowsUserPath(
            root,
            () => process.env.PATH,
            () => {
              /* registry write performed by bootstrap scripts; keep env-only in process */
            },
          );
        } catch {
          /* PATH registration is best-effort; absolute entry still works */
        }
      } else {
        try {
          upsertShellPathBlock(
            join(homedir(), process.platform === "darwin" ? ".zshrc" : ".bashrc"),
            join(root, "bin"),
          );
        } catch {
          /* shell rc is best-effort */
        }
      }
    }

    state.updateComponent("service", version, "VERIFIED");
    code = INSTALL_EXIT_CODES.NEEDS_USER_ACTION;
    const registry = createDefaultAdapterRegistry();
    const selectedRoleAdapters = [
      roleInputs.plannerTool,
      roleInputs.executorTool,
    ].filter((id): id is string => Boolean(id));
    const probeIds = [
      ...new Set([...tools, ...selectedRoleAdapters]),
    ] as SupportedAdapterId[];
    let toolsReady = tools.length === 0;
    for (const adapterId of probeIds) {
      if (!SupportedAdapters.includes(adapterId)) continue;
      const probe = await registry.mustGet(adapterId).probe({
        toolProfile: {
          id: adapterId,
          revision: 1,
          adapterId,
          modelSelection: "native-config",
          options: {},
        },
      });
      state.updateComponent(
        "tool:" + adapterId,
        probe.version ?? "unknown",
        probe.available ? "VERIFIED" : "DISCOVERED",
        probe.unsupportedReason,
      );
      if (!probe.available) toolsReady = false;
    }

    const pending = defaultsResult.pending || !toolsReady;
    state.updateResult({
      software: { status: "installed", detail: applicationVersion },
      setup: {
        status: defaultsResult.pending
          ? "not_started"
          : toolsReady
            ? "done"
            : "pending_verification",
        detail: defaultsResult.message,
      },
      capability: {
        status: tools.length ? (toolsReady ? "discovered" : "unknown") : "unknown",
        scope: tools.length ? tools.join(",") : "none",
        detail: accountPrerequisite,
      },
    });

    // Default success = software can run. Model unconfigured is onboarding, not failure.
    const success = !pending || !requireReady;
    const exitCode = success
      ? pending && requireReady
        ? INSTALL_EXIT_CODES.NEEDS_USER_ACTION
        : INSTALL_EXIT_CODES.SUCCESS
      : INSTALL_EXIT_CODES.NEEDS_USER_ACTION;

    if (!options.noOpen) {
      try {
        const { openBrowser } = await import(
          "../../service/src/launcher.js"
        );
        await openBrowser("full");
        console.log(
          "DevFlow 已安装，并已打开设置页面。选择你要使用的编程助手和模型，即可开始。",
        );
      } catch {
        console.log(
          "DevFlow 已安装。浏览器未能自动打开，请访问下方地址，或运行 `devflow` 再次打开。",
        );
        console.log("首次设置页面：" + loaded.server.human_origin);
      }
    } else {
      console.log(
        "DevFlow 已安装。浏览器未能自动打开，请访问下方地址，或运行 `devflow` 再次打开。",
      );
      console.log("首次设置页面：" + loaded.server.human_origin);
    }
    if (conflictHint.length) {
      console.log(
        "检测到同名非 DevFlow 命令，未覆盖。请使用绝对路径入口：" +
          conflictHint.join(", "),
      );
    }
    if (pending) console.log("模型设置待完成（不影响软件已可运行）");
    const saved = state.load();
    saved.last_exit_code = exitCode;
    state.save(saved);
    return exitCode;
  } catch (e) {
    if (configurationChanged && !writableStateStarted) {
      if (originalConfig !== undefined)
        atomicWrite(join(root, "devflow.yaml"), originalConfig);
      if (originalPointer !== undefined)
        atomicWrite(join(root, "current.json"), originalPointer);
    }
    state.updateResult({
      software: {
        status: "failed",
        detail: e instanceof Error ? e.message : String(e),
      },
    });
    const saved = state.load();
    saved.last_exit_code = code;
    state.save(saved);
    console.error("[DevFlow 安装未完成] " + String(e));
    if (writableStateStarted)
      console.error(
        "新版本可能已写入状态；保留当前配置、版本指针及数据库备份，禁止直接降级或覆盖数据库。",
      );
    return code;
  } finally {
    await releaseController?.();
    await releaseInstall?.();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const parsed = parseInstallerCliArgs(process.argv.slice(2));
  runInstaller({
    sourceDir: parsed.sourceDir,
    installRoot: parsed.installRoot,
    targetTools: parsed.targetTools,
    roleInputs: parsed.roleInputs,
    requireReady: parsed.requireReady,
    noOpen: parsed.noOpen,
  }).then((code) => {
    process.exitCode = code;
  });
}
