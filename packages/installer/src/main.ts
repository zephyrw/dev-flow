import { InstallationStateManager, INSTALL_EXIT_CODES } from "./state.js";
import { ClientInstaller } from "../../clients/src/installer.js";
import {
  SupportedAdapters,
  type SupportedAdapterId,
} from "../../contracts/src/execution-spec.js";
import {
  migrateAccountConfiguration,
  writeAccountsLauncher,
} from "./upgrade.js";
import { ConfigSchema, loadConfig } from "../../contracts/src/config.js";
import { atomicWrite, hash } from "../../core/src/util.js";
import { createDefaultAdapterRegistry } from "../../adapters/sdk/src/index.js";
import { resolve, join, dirname } from "node:path";
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
const exec = promisify(execFile);
export interface InstallerRunOptions {
  sourceDir?: string;
  targetTools?: string[];
  installRoot?: string;
  clientHome?: string;
  port?: number;
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
    for (const adapterId of tools as SupportedAdapterId[]) {
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
      if (!probe.available)
        throw new Error(
          "服务和 Skill 已安装；客户端尚未安装或未通过探测：" + adapterId,
        );
    }
    const saved = state.load();
    saved.last_exit_code = 0;
    state.save(saved);
    return INSTALL_EXIT_CODES.SUCCESS;
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
  const args = process.argv.slice(2),
    read = (name: string) => {
      const i = args.indexOf(name);
      return i < 0 ? undefined : args[i + 1];
    };
  runInstaller({
    sourceDir: read("--source"),
    installRoot: read("--install-dir"),
    targetTools: read("--tools")?.split(","),
  }).then((code) => {
    process.exitCode = code;
  });
}
