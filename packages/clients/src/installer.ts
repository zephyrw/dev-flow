import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  copyFileSync,
  lstatSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import type { SupportedAdapterId } from "../../contracts/src/execution-spec.js";
import { atomicWrite, hash } from "../../core/src/util.js";
export interface SkillInstallResult {
  clientId: SupportedAdapterId;
  skillName: string;
  targetPath: string;
  status: "installed" | "skipped" | "failed";
  reason?: string;
}
export interface ClientInstallReport {
  clientId: SupportedAdapterId;
  configFound: boolean;
  skillsInstalled: SkillInstallResult[];
  mcpConfigured: boolean;
  error?: string;
}
export const ALLOWED_SKILLS = [
  "devflow",
  "devflow-project-onboard",
  "devflow-plan",
  "devflow-execute",
  "devflow-test",
  "devflow-review",
];
export interface ClientInstallOptions {
  home?: string;
  node?: string;
  bridge?: string;
  config?: string;
}
function copyVerified(src: string, dest: string) {
  if (
    lstatSync(src).isSymbolicLink() ||
    (existsSync(dest) && lstatSync(dest).isSymbolicLink())
  )
    throw new Error("不覆盖链接目录：" + dest);
  mkdirSync(dest, { recursive: true });
  for (const item of readdirSync(src, { withFileTypes: true })) {
    const source = join(src, item.name),
      target = join(dest, item.name);
    if (
      item.isSymbolicLink() ||
      (existsSync(target) && lstatSync(target).isSymbolicLink())
    )
      throw new Error("Skill 不接受链接：" + target);
    if (item.isDirectory()) copyVerified(source, target);
    else if (item.isFile()) {
      const bytes = readFileSync(source);
      if (existsSync(target) && hash(readFileSync(target)) !== hash(bytes))
        copyFileSync(target, target + ".devflow-backup-" + Date.now());
      atomicWrite(target, bytes);
      if (hash(readFileSync(target)) !== hash(bytes))
        throw new Error("Skill 文件校验失败：" + target);
    }
  }
}
export class ClientInstaller {
  constructor(
    private skillsSourceDir: string,
    private options: ClientInstallOptions = {},
  ) {}
  private home() {
    return (
      this.options.home ??
      process.env.USERPROFILE ??
      process.env.HOME ??
      homedir()
    );
  }
  locateClientBaseDir(client: SupportedAdapterId): string {
    const h = this.home(),
      isolated = !!this.options.home;
    switch (client) {
      case "codex":
        return (!isolated && process.env.CODEX_HOME) || join(h, ".codex");
      case "agy":
        return join(h, ".gemini", "antigravity");
      case "claude-code":
        return join(h, ".claude");
      case "kimi-code":
        return (
          (!isolated && process.env.KIMI_CODE_HOME) || join(h, ".kimi-code")
        );
      case "grok-build":
        return join(h, ".grok");
      case "qoder":
        return join(h, ".qoder");
      case "opencode":
        return join(
          (!isolated && process.env.XDG_CONFIG_HOME) || join(h, ".config"),
          "opencode",
        );
      case "cursor-agent":
        return join(h, ".cursor");
    }
  }
  locateClientSkillDir(client: SupportedAdapterId) {
    return join(this.locateClientBaseDir(client), "skills");
  }
  private configure(client: SupportedAdapterId) {
    const base = this.locateClientBaseDir(client),
      bridge = this.options.bridge,
      config = this.options.config;
    if (!bridge || !config || !existsSync(bridge) || !existsSync(config))
      throw new Error("MCP 需要已安装的真实 bridge 与服务配置路径");
    const command = this.options.node ?? process.execPath;
    if (!existsSync(command)) throw new Error("Node 入口不存在");
    const spec = {
      command: resolve(command),
      args: [resolve(bridge)],
      env: { DEVFLOW_CONFIG: resolve(config) },
    };
    const toml = client === "codex" || client === "grok-build";
    const path = toml
      ? join(base, "config.toml")
      : client === "claude-code"
        ? join(this.home(), ".claude.json")
        : join(
            base,
            client === "agy"
              ? "mcp_config.json"
              : client === "qoder"
                ? "settings.json"
                : client === "opencode"
                  ? "opencode.json"
                  : "mcp.json",
          );
    mkdirSync(dirname(path), { recursive: true });
    const before = existsSync(path) ? readFileSync(path, "utf8") : "";
    let after: string;
    if (toml) {
      const block =
        "[mcp_servers.devflow]\ncommand = " +
        JSON.stringify(spec.command) +
        "\nargs = " +
        JSON.stringify(spec.args) +
        "\nenv = { DEVFLOW_CONFIG = " +
        JSON.stringify(spec.env.DEVFLOW_CONFIG) +
        " }\n";
      const start = before.indexOf("[mcp_servers.devflow]");
      if (start >= 0) {
        const tail = before.slice(start),
          end = tail.slice(1).search(/^\[/m);
        const existing = end < 0 ? tail : tail.slice(0, end + 1);
        if (existing.trim() !== block.trim())
          throw new Error(
            "已有 devflow MCP 设置不同，请先迁移该条目；其他设置保持原样",
          );
        return;
      }
      if (/\[mcp_servers[."'\s]+devflow/.test(before))
        throw new Error("已有不同格式的 devflow 配置，不能安全追加");
      after = before + "\n" + block;
    } else {
      const json = before ? JSON.parse(before) : {};
      if (!json || Array.isArray(json) || typeof json !== "object")
        throw new Error("客户端配置不是对象");
      const field = client === "opencode" ? "mcp" : "mcpServers";
      const entry =
        client === "opencode"
          ? {
              type: "local",
              command: [spec.command, ...spec.args],
              environment: spec.env,
              enabled: true,
            }
          : spec;
      const prior = json[field]?.devflow;
      if (prior && JSON.stringify(prior) !== JSON.stringify(entry))
        throw new Error("已有 devflow MCP 设置不同，请先迁移该条目");
      json[field] = { ...json[field], devflow: entry };
      after = JSON.stringify(json, null, 2) + "\n";
    }
    if (before) copyFileSync(path, path + ".devflow-backup-" + Date.now());
    // Fail if another process modified the config while we prepared its update.
    if ((existsSync(path) ? readFileSync(path, "utf8") : "") !== before)
      throw new Error("客户端配置正在被修改");
    atomicWrite(path, after);
    if (readFileSync(path, "utf8") !== after)
      throw new Error("MCP 配置回读失败");
  }
  installSkillsForClient(client: SupportedAdapterId): ClientInstallReport {
    const report: ClientInstallReport = {
      clientId: client,
      configFound: false,
      skillsInstalled: [],
      mcpConfigured: false,
    };
    const target = this.locateClientSkillDir(client);
    // Validate the complete required distribution before writing anything.
    for (const name of ALLOWED_SKILLS)
      if (!existsSync(join(this.skillsSourceDir, name, "SKILL.md")))
        throw new Error("缺少必需 Skill：" + name);
    for (const skillName of ALLOWED_SKILLS) {
      const dest = join(target, skillName);
      try {
        copyVerified(join(this.skillsSourceDir, skillName), dest);
        report.skillsInstalled.push({
          clientId: client,
          skillName,
          targetPath: dest,
          status: "installed",
        });
      } catch (e) {
        report.skillsInstalled.push({
          clientId: client,
          skillName,
          targetPath: dest,
          status: "failed",
          reason: String(e),
        });
      }
    }
    try {
      this.configure(client);
      report.configFound = true;
      report.mcpConfigured = true;
    } catch (e) {
      report.error = String(e);
    }
    return report;
  }
}
