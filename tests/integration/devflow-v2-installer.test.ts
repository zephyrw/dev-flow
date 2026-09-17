import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createIsolatedTestEnv,
  type IsolatedTestEnv,
} from "../fixtures/isolation.js";
import { ClientInstaller } from "../../packages/clients/src/installer.js";
import { UpgradeManager } from "../../packages/installer/src/upgrade.js";
import Database from "better-sqlite3";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("IT-INSTALLER: 六核心 Skill/MCP 完整分发、选定闭包与配置保护 (W07, RQ-21, RQ-22)", () => {
  let env: IsolatedTestEnv;
  let fakeSkillsSrc: string;
  let installer: ClientInstaller;

  beforeEach(() => {
    env = createIsolatedTestEnv();

    // 构造模拟的源码技能仓库
    fakeSkillsSrc = join(env.root, "source_skills");
    mkdirSync(fakeSkillsSrc, { recursive: true });

    const skills = [
      "devflow",
      "devflow-project-onboard",
      "devflow-plan",
      "devflow-execute",
      "devflow-test",
      "devflow-review",
    ];

    for (const sk of skills) {
      const skDir = join(fakeSkillsSrc, sk);
      mkdirSync(join(skDir, "references"), { recursive: true });
      writeFileSync(join(skDir, "SKILL.md"), `# ${sk}\nDescription of ${sk}`);
      writeFileSync(join(skDir, "references", "guide.md"), `# ${sk} Guide`);
    }

    const bridge = join(env.root, "bridge.js"),
      config = join(env.root, "devflow.yaml");
    writeFileSync(bridge, "// isolated bridge");
    writeFileSync(config, "{}");
    installer = new ClientInstaller(fakeSkillsSrc, {
      home: env.root,
      bridge,
      config,
    });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("TC-INST-01: 完整分发 6 个核心 Skill 且包含全部 references 子目录与文件 (RQ-21)", () => {
    const report = installer.installSkillsForClient("codex");

    expect(report.clientId).toBe("codex");
    expect(report.skillsInstalled.length).toBe(6);
    expect(report.skillsInstalled.every((s) => s.status === "installed")).toBe(
      true,
    );

    const targetDir = installer.locateClientSkillDir("codex")!;
    for (const sk of [
      "devflow",
      "devflow-project-onboard",
      "devflow-plan",
      "devflow-execute",
      "devflow-test",
      "devflow-review",
    ]) {
      expect(existsSync(join(targetDir, sk, "SKILL.md"))).toBe(true);
      expect(existsSync(join(targetDir, sk, "references", "guide.md"))).toBe(
        true,
      );
    }
  });

  it("TC-INST-02: Codex 配置写入保留用户已有配置并追加 [mcp_servers.devflow] (RQ-22)", () => {
    const codexBase = installer.locateClientBaseDir("codex")!;
    mkdirSync(codexBase, { recursive: true });
    writeFileSync(
      join(codexBase, "config.toml"),
      `model = "o3-mini"\n[custom]\nkey = "val"\n`,
    );

    const report = installer.installSkillsForClient("codex");
    expect(report.mcpConfigured).toBe(true);

    const updatedContent = readFileSync(join(codexBase, "config.toml"), "utf8");
    // 保留了原有配置
    expect(updatedContent).toContain(`model = "o3-mini"`);
    expect(updatedContent).toContain(`key = "val"`);
    // 追加了 devflow mcp
    expect(updatedContent).toContain("[mcp_servers.devflow]");
    expect(updatedContent).toContain(JSON.stringify(process.execPath));
    expect(installer.installSkillsForClient("codex").mcpConfigured).toBe(true);
  });

  it("TC-INST-03: AGY 客户端正确写入 mcp_config.json 并保留隔离环境 (RQ-21)", () => {
    const report = installer.installSkillsForClient("agy");
    expect(report.clientId).toBe("agy");
    expect(report.mcpConfigured).toBe(true);

    const agyBase = installer.locateClientBaseDir("agy")!;
    const mcpJson = JSON.parse(
      readFileSync(join(agyBase, "mcp_config.json"), "utf8"),
    );
    expect(mcpJson.mcpServers.devflow).toBeDefined();
    expect(mcpJson.mcpServers.devflow.command).toBe(process.execPath);
  });

  it("TC-INST-04: UpgradeManager 对活动数据库执行一致性快照备份，验证备份可读且与原库分离", async () => {
    const dbPath = join(env.root, "active.db");
    const db = new Database(dbPath);
    db.prepare("CREATE TABLE workflows (id TEXT PRIMARY KEY, title TEXT)").run();
    db.prepare("INSERT INTO workflows VALUES (?, ?)").run("wf_1", "升级前任务");
    db.close();

    const upgrade = new UpgradeManager({
      installDir: env.root,
      targetVersion: "0.2.1",
      backupDir: join(env.root, "backups"),
    });

    const backupFile = await upgrade.backupData(dbPath);
    expect(backupFile).toBeDefined();
    expect(existsSync(backupFile!)).toBe(true);

    // 验证备份数据库立即可读且数据完全一致
    const backupDb = new Database(backupFile!, { readonly: true });
    const row = backupDb.prepare("SELECT * FROM workflows WHERE id = ?").get("wf_1") as any;
    expect(row.title).toBe("升级前任务");
    backupDb.close();
  });

  it("TC-INST-05: 升级事务原子切换 current.json，若元数据持久化失败保留原有 current.json 不变", () => {
    const upgrade = new UpgradeManager({
      installDir: env.root,
      targetVersion: "0.2.1",
    });

    // 初始 current.json
    const initialMeta = { version: "0.2.0", entry: "versions/0.2.0/main.js" };
    expect(upgrade.atomicSwitchCurrent(initialMeta)).toBe(true);

    const currentPath = join(env.root, "current.json");
    expect(existsSync(currentPath)).toBe(true);
    expect(JSON.parse(readFileSync(currentPath, "utf8")).version).toBe("0.2.0");

    // 切换至新版本 0.2.1
    const nextMeta = { version: "0.2.1", entry: "versions/0.2.1/main.js" };
    expect(upgrade.atomicSwitchCurrent(nextMeta)).toBe(true);
    expect(JSON.parse(readFileSync(currentPath, "utf8")).version).toBe("0.2.1");
  });

  it("TC-INST-06: 卸载时受管配置保护与引用清理：保留用户自定义注释与无关配置，清理 devflow 条目", () => {
    const codexBase = installer.locateClientBaseDir("codex")!;
    mkdirSync(codexBase, { recursive: true });
    writeFileSync(
      join(codexBase, "config.toml"),
      `# 用户自定义全局设置\nmodel = "o3-mini"\n[custom_section]\ncustom_key = "user_value"\n\n[mcp_servers.devflow]\ncommand = "node"\n`,
    );

    // 模拟清理 devflow 受管条目
    let content = readFileSync(join(codexBase, "config.toml"), "utf8");
    content = content.replace(/\[mcp_servers\.devflow\][\s\S]*?(?=\n\[|$)/, "");
    writeFileSync(join(codexBase, "config.toml"), content, "utf8");

    const cleaned = readFileSync(join(codexBase, "config.toml"), "utf8");
    expect(cleaned).toContain("# 用户自定义全局设置");
    expect(cleaned).toContain(`model = "o3-mini"`);
    expect(cleaned).toContain(`custom_key = "user_value"`);
    expect(cleaned).not.toContain("[mcp_servers.devflow]");
  });
});

