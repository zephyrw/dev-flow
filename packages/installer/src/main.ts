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
import { atomicWrite, hash } from "../../core/src/util.js";
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
} from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
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
    targetTools: tools?.split(","),
    roleInputs: {
      plannerTool: read("--planner-tool"),
      plannerModel: read("--planner-model"),
      plannerEffort: read("--planner-effort"),
      executorTool: read("--executor-tool"),
      executorModel: read("--executor-model"),
      executorEffort: read("--executor-effort"),
    },
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

function catalogForProfile(store: Store, profile: ToolProfile): ModelCatalog | undefined {
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
    (entry) => entry.nativeId === profile.modelId || entry.entryId === profile.modelId,
  );
}

function catalogEffortDefault(store: Store, profile: ToolProfile): string | undefined {
  const entry = catalogEntryFor(store, profile);
  return entry?.effort.defaultValue ?? entry?.effort.fixedValue;
}

function assertCatalogEffortAllowed(store: Store, profile: ToolProfile, effort: string) {
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

function effortAllowed(store: Store, profile: ToolProfile, effort: string): boolean {
  const entry = catalogEntryFor(store, profile);
  if (!entry) return true;
  if (entry.effort.status === "unsupported") return false;
  if (entry.effort.status === "unknown") return effort.length === 0;
  if (entry.effort.values.length && !entry.effort.values.includes(effort)) {
    return false;
  }
  return true;
}

function explicitEffort(store: Store, profile: ToolProfile, effort: string): ToolProfile["reasoning"] {
  assertCatalogEffortAllowed(store, profile, effort);
  return { mode: "explicit", value: effort };
}

function catalogOrNativeDefault(store: Store, profile: ToolProfile): ToolProfile["reasoning"] {
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
    return { ok: false, reason: "incomplete", message: "改工具时必须指定合法模型" };
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
    ...(patch.model ? {
      modelSelection: "explicit" as const,
      modelId: patch.model,
      selectionKind: "fixed" as const,
    } : {}),
  };
  if (patch.effort) {
    next.reasoning = explicitEffort(store, next, patch.effort);
  } else if (modelChanged) {
    const oldEffort = base.reasoning?.mode === "explicit" ? base.reasoning.value : undefined;
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
export async function runInstaller(
  options: InstallerRunOptions = {},
): Promise<number> {
  const root = resolve(
    options.installRoot ?? join(homedir(), ".local", "share", "devflow"),
  );
  const source = resolve(options.sourceDir ?? process.cwd()),
    version = "0.2.0";
  const state = new InstallationStateManager(join(root, "state.json"));
  const tools = options.targetTools ?? ["codex"];
  const roleInputs = options.roleInputs ?? {};
  let code: number = INSTALL_EXIT_CODES.DOWNLOAD_VERIFICATION_FAILED;
  try {
    if (
      !tools.length ||
      tools.some((t) => !SupportedAdapters.includes(t as SupportedAdapterId))
    )
      return INSTALL_EXIT_CODES.CONFIGURATION_CONFLICT;
    const hostName =
      process.platform === "win32" ? "devflow-host.exe" : "devflow-host";
    const required = [
      "dist/apps/api/src/main.js",
      "dist/apps/api/src/accounts-main.js",
      "dist/packages/agy-accounts/src/service.js",
      "dist/packages/service/src/open.js",
      ...(process.platform === "win32"
        ? ["dist/host/devflow-auth-host.exe"]
        : []),
      "dist/web/index.html",
      "dist/packages/bridge/src/planner.js",
      "dist/packages/service/src/launcher.js",
      "dist/host/" + hostName,
      "package.json",
      "node_modules/better-sqlite3/package.json",
      ...[
        "devflow",
        "devflow-project-onboard",
        "devflow-plan",
        "devflow-execute",
        "devflow-test",
        "devflow-review",
      ].map((s) => "packages/skills/" + s + "/SKILL.md"),
    ];
    for (const path of required)
      if (!existsSync(join(source, path)))
        throw new Error("安装包不完整：" + path);
    const sourcePackage = JSON.parse(
      readFileSync(join(source, "package.json"), "utf8"),
    );
    if (sourcePackage.name !== "devflow" || sourcePackage.version !== version)
      throw new Error("安装包身份或版本不符");
    // The version directory is immutable once activated; never overwrite a running installation.
    const target = join(root, "versions", version);
    const digest = hash(
      required
        .map((p) => p + ":" + hash(readFileSync(join(source, p))))
        .join("\n"),
    );
    const receipt = join(target, "install-source.json");
    if (source !== target && existsSync(target)) {
      if (
        !existsSync(receipt) ||
        JSON.parse(readFileSync(receipt, "utf8")).digest !== digest
      )
        throw new Error("现有版本内容不同，不能覆盖正在使用的安装目录");
    }
    state.updateComponent("service", version, "PLANNED");
    if (source !== target && !existsSync(target)) {
      const staging = target + ".staging-" + crypto.randomUUID();
      mkdirSync(staging, { recursive: true });
      for (const entry of [
        "dist",
        "packages/skills",
        "node_modules",
        "package.json",
      ])
        cpSync(join(source, entry), join(staging, entry), {
          recursive: true,
          dereference: true,
        });
      if (existsSync(join(source, "runtime")))
        cpSync(join(source, "runtime"), join(staging, "runtime"), {
          recursive: true,
        });
      atomicWrite(
        join(staging, "install-source.json"),
        JSON.stringify({ digest }),
      );
      renameSync(staging, target);
    }
    const bundledNode = join(
      source,
      "runtime",
      process.platform === "win32" ? "node.exe" : "node",
    );
    const node = existsSync(bundledNode)
      ? join(
          target,
          "runtime",
          process.platform === "win32" ? "node.exe" : "node",
        )
      : process.execPath;
    // The runtime was staged together with the immutable service directory.
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
    const host = join(target, "dist", "host", hostName);
    const hostVersion = (
      await exec(host, ["--version"], { windowsHide: true, timeout: 10000 })
    ).stdout.trim();
    if (!hostVersion.startsWith("devflow-host "))
      throw new Error("Host 身份校验失败");
    state.updateComponent("host", hostVersion, "VERIFIED");
    state.updateComponent("service", version, "INSTALLED");
    code = INSTALL_EXIT_CODES.CONFIGURATION_CONFLICT;
    const config = join(root, "devflow.yaml");
    const authHost = join(target, "dist/host/devflow-auth-host.exe");
    const currentPointer = join(root, "current.json");
    let previousAuthHost: string | undefined;
    if (existsSync(currentPointer)) {
      const previous = JSON.parse(readFileSync(currentPointer, "utf8"));
      if (typeof previous.root === "string")
        previousAuthHost = join(
          previous.root,
          "dist/host/devflow-auth-host.exe",
        );
    }
    if (!existsSync(config))
      atomicWrite(
        config,
        JSON.stringify(
          ConfigSchema.parse({
            storage_root: join(root, "state"),
            workspace_root: join(root, "worktrees"),
            host: { executable: host, required: true },
            agy_accounts: { enabled: false, auth_host_executable: authHost },
            server: {
              port: options.port ?? 4810,
              human_origin: "http://localhost:" + (options.port ?? 4810),
            },
          }),
          null,
          2,
        ),
      );
    else migrateAccountConfiguration(config, authHost, previousAuthHost);
    const configured = loadConfig(config);
    // Pure version/doctor queries only; never inspect, import or switch user credentials.
    let accountPrerequisite = "unsupported_platform";
    let authVersion = "unsupported";
    if (process.platform === "win32") {
      accountPrerequisite = "auth_host_unavailable";
      try {
        authVersion = (
          await exec(
            configured.agy_accounts.auth_host_executable,
            ["--version"],
            { windowsHide: true, timeout: 5000, maxBuffer: 4096 },
          )
        ).stdout.trim();
        if (!/^devflow-auth-host v[0-9]+\.[0-9]+\.[0-9]+$/.test(authVersion)) authVersion = "unrecognized_helper";
        accountPrerequisite = "auth_host_protocol_unavailable";
        if (authVersion === "devflow-auth-host v2.0.0") {
          accountPrerequisite = "process_host_capability_unavailable";
          const doctor = JSON.parse(
            (
              await exec(configured.host.executable, ["doctor"], {
                windowsHide: true,
                timeout: 5000,
                maxBuffer: 4096,
              })
            ).stdout,
          );
          const id = "account-install-" + crypto.randomUUID();
          const status = JSON.parse(
            (
              await exec(configured.host.executable, ["job-status", id], {
                windowsHide: true,
                timeout: 5000,
                maxBuffer: 4096,
              })
            ).stdout,
          );
          if (
            doctor.suspended_spawn === true &&
            doctor.kill_on_close === true &&
            status.id === id &&
            status.alive === false
          )
            accountPrerequisite = "official_cli_capability_unverified";
        }
      } catch {
        /* Optional accounts remain unavailable; full DevFlow can still install. */
      }
    }
    state.updateComponent(
      "auth-host",
      authVersion,
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
      "AGY 账号功能未获就绪认证：" +
        accountPrerequisite +
        "。安装不会登录或更改账号。",
    );
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
    state.updateComponent("service", version, "CONFIGURED");
    code = INSTALL_EXIT_CODES.CONFIGURATION_CONFLICT;
    const loaded = loadConfig(config);
    const defaultsResult = applyInstallerModelDefaultsFromConfigFile(
      config,
      roleInputs,
      tools,
    );
    code = INSTALL_EXIT_CODES.SERVICE_UNHEALTHY;
    // A subprocess loads the installed config without contaminating the installer's own module cache.
    const launcher = join(target, "dist/packages/service/src/launcher.js");
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
        env: { ...process.env, DEVFLOW_CONFIG: config },
        windowsHide: true,
        timeout: 150000,
      },
    );
    atomicWrite(
      join(root, "current.json"),
      JSON.stringify({ version, root: target, config, node }, null, 2),
    );
    writeAccountsLauncher(root);
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
    let toolsReady = true;
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
    console.log("首次设置页面：" + loaded.server.human_origin);
    const pending = defaultsResult.pending || !toolsReady;
    if (pending) console.log("模型设置待完成");
    const saved = state.load();
    saved.last_exit_code = pending
      ? INSTALL_EXIT_CODES.NEEDS_USER_ACTION
      : INSTALL_EXIT_CODES.SUCCESS;
    state.save(saved);
    return pending
      ? INSTALL_EXIT_CODES.NEEDS_USER_ACTION
      : INSTALL_EXIT_CODES.SUCCESS;
  } catch (e) {
    const saved = state.load();
    saved.last_exit_code = code;
    state.save(saved);
    console.error("[DevFlow 安装未完成] " + String(e));
    return code;
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
  }).then((code) => {
    process.exitCode = code;
  });
}
