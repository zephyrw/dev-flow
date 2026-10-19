import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, lstatSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { createIsolatedTestEnv, type IsolatedTestEnv } from "../fixtures/isolation.js";
import {
  ClientInstaller,
  MANAGED_WRITING_SKILLS,
  ALL_MANAGED_SKILLS,
  ALLOWED_SKILLS,
} from "../../packages/clients/src/installer.js";

describe("A2 — 集成测试：隔离目录中的受管写作技能安装、升级与个人原名技能保护", () => {
  let env: IsolatedTestEnv;
  let fakeSkillsSrc: string;
  let installer: ClientInstaller;
  let createdLinks: string[];

  beforeEach(() => {
    createdLinks = [];
    env = createIsolatedTestEnv();

    fakeSkillsSrc = join(env.root, "source_skills");
    mkdirSync(fakeSkillsSrc, { recursive: true });

    for (const sk of ALL_MANAGED_SKILLS) {
      const skDir = join(fakeSkillsSrc, sk);
      mkdirSync(join(skDir, "references"), { recursive: true });
      writeFileSync(join(skDir, "SKILL.md"), `# ${sk}\nDescription of ${sk}\nVersion 1.0.0`);
      writeFileSync(join(skDir, "references", "guide.md"), `# ${sk} Guide`);
    }

    const bridge = join(env.root, "bridge.js");
    const config = join(env.root, "devflow.yaml");
    writeFileSync(bridge, "// isolated bridge");
    writeFileSync(config, "{}");

    installer = new ClientInstaller(fakeSkillsSrc, {
      home: env.root,
      bridge,
      config,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // 先解除本用例创建的链接；unlink 只删除链接本身，不递归处理目标。
    try {
      for (const path of createdLinks.reverse()) {
        let stat;
        try {
          stat = lstatSync(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (stat.isSymbolicLink()) unlinkSync(path);
      }
    } finally {
      await env.cleanup();
    }
  });

  function seedSharedWritingSkills() {
    const sharedRoot = join(env.root, ".agents", "skills");
    for (const name of MANAGED_WRITING_SKILLS) {
      mkdirSync(join(sharedRoot, name), { recursive: true });
      writeFileSync(join(sharedRoot, name, "SKILL.md"), `old shared ${name}`);
      writeFileSync(join(sharedRoot, name, "notes.txt"), `keep ${name}`);
    }
    return sharedRoot;
  }

  function expectInstallationUntouched(sharedRoot: string) {
    expect(existsSync(join(env.root, ".codex"))).toBe(false);
    expect(readdirSync(sharedRoot).sort()).toEqual([...MANAGED_WRITING_SKILLS].sort());
    for (const name of MANAGED_WRITING_SKILLS) {
      expect(readdirSync(join(sharedRoot, name)).sort()).toEqual(["SKILL.md", "notes.txt"]);
      expect(readFileSync(join(sharedRoot, name, "SKILL.md"), "utf8")).toBe(`old shared ${name}`);
      expect(readFileSync(join(sharedRoot, name, "notes.txt"), "utf8")).toBe(`keep ${name}`);
    }
  }

  function createDirectoryLink(target: string, path: string) {
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
    createdLinks.push(path);
  }

  it("A2 — 在 Codex 与 AGY 目录中成功安装两项受管写作技能，且保护个人原名技能与额外文件", () => {
    // 1. 模拟用户个人技能目录及其额外文件已存在于用户主目录下
    const codexSkillsDir = join(env.root, ".codex", "skills");
    mkdirSync(join(codexSkillsDir, "concise-complete-writing"), { recursive: true });
    mkdirSync(join(codexSkillsDir, "human-readable-plans"), { recursive: true });

    const personalWritingSkill = join(codexSkillsDir, "concise-complete-writing", "SKILL.md");
    const personalWritingExtra = join(codexSkillsDir, "concise-complete-writing", "notes.txt");
    const personalPlanSkill = join(codexSkillsDir, "human-readable-plans", "SKILL.md");
    const personalPlanExtra = join(codexSkillsDir, "human-readable-plans", "custom-template.json");

    const personalWritingContent = "# User Personal Concise Writing\nCustom rule for me";
    const personalPlanContent = "# User Personal Human Readable Plans\nMy personal planning format";
    const personalExtraContent = "User extra notes";
    const personalJsonContent = '{"template": "personal"}';

    writeFileSync(personalWritingSkill, personalWritingContent);
    writeFileSync(personalWritingExtra, personalExtraContent);
    writeFileSync(personalPlanSkill, personalPlanContent);
    writeFileSync(personalPlanExtra, personalJsonContent);

    // 2. 执行 Codex 安装
    const codexRes = installer.installSkillsForClient("codex");
    const codexInstalled = codexRes.skillsInstalled.map((s) => s.skillName);
    expect(codexInstalled).toContain("devflow-concise-complete-writing");
    expect(codexInstalled).toContain("devflow-human-readable-plans");

    // 验证 Codex 受管技能在主目录成功创建
    const codexManagedWriting = join(codexSkillsDir, "devflow-concise-complete-writing", "SKILL.md");
    const codexManagedPlan = join(codexSkillsDir, "devflow-human-readable-plans", "SKILL.md");
    expect(existsSync(codexManagedWriting)).toBe(true);
    expect(existsSync(codexManagedPlan)).toBe(true);

    // 验证个人原名技能及额外文件保持完全不变
    expect(readFileSync(personalWritingSkill, "utf8")).toBe(personalWritingContent);
    expect(readFileSync(personalWritingExtra, "utf8")).toBe(personalExtraContent);
    expect(readFileSync(personalPlanSkill, "utf8")).toBe(personalPlanContent);
    expect(readFileSync(personalPlanExtra, "utf8")).toBe(personalJsonContent);

    // 验证 Codex 共享目录 (~/.agents/skills) 去重：写作技能不安装到共享目录，避免双目录重复加载
    const sharedAgentsSkillsDir = join(env.root, ".agents", "skills");
    if (existsSync(sharedAgentsSkillsDir)) {
      expect(existsSync(join(sharedAgentsSkillsDir, "devflow-concise-complete-writing"))).toBe(false);
      expect(existsSync(join(sharedAgentsSkillsDir, "devflow-human-readable-plans"))).toBe(false);
    }

    // 3. 执行 AGY 安装
    const agyRes = installer.installSkillsForClient("agy");
    const agyInstalled = agyRes.skillsInstalled.map((s) => s.skillName);
    expect(agyInstalled).toContain("devflow-concise-complete-writing");
    expect(agyInstalled).toContain("devflow-human-readable-plans");

    const agySkillsDir = installer.locateClientSkillDir("agy");
    expect(existsSync(join(agySkillsDir, "devflow-concise-complete-writing", "SKILL.md"))).toBe(true);
    expect(existsSync(join(agySkillsDir, "devflow-human-readable-plans", "SKILL.md"))).toBe(true);
  });

  it("A2 — 重复安装与版本升级：保持幂等且更新受管技能正文，不污染个人原名技能", () => {
    // 初始安装
    installer.installSkillsForClient("codex");

    // 更新源端技能内容为 Version 2.0.0
    const managedWritingSrc = join(fakeSkillsSrc, "devflow-concise-complete-writing", "SKILL.md");
    writeFileSync(managedWritingSrc, "# devflow-concise-complete-writing\nVersion 2.0.0 updated content");

    // 再次安装（模拟升级）
    const upgradeRes = installer.installSkillsForClient("codex");
    const upgradeInstalled = upgradeRes.skillsInstalled.map((s) => s.skillName);
    expect(upgradeInstalled).toContain("devflow-concise-complete-writing");

    const installedFile = join(env.root, ".codex", "skills", "devflow-concise-complete-writing", "SKILL.md");
    expect(readFileSync(installedFile, "utf8")).toContain("Version 2.0.0 updated content");
  });

  it("A2 — 缺文件场景失败明确报错并可定位，默认不静默降级", () => {
    // 构造一个缺失写作技能的非法源目录
    const brokenSrc = join(env.root, "broken_skills");
    mkdirSync(brokenSrc, { recursive: true });
    // 只放核心技能，缺少 devflow-concise-complete-writing
    for (const sk of ALLOWED_SKILLS) {
      const skDir = join(brokenSrc, sk);
      mkdirSync(skDir, { recursive: true });
      writeFileSync(join(skDir, "SKILL.md"), `# ${sk}`);
    }

    // 1. 显式指定 includeWritingSkills: true 报错
    const brokenInstaller = new ClientInstaller(brokenSrc, {
      home: env.root,
      bridge: join(env.root, "bridge.js"),
      config: join(env.root, "devflow.yaml"),
      includeWritingSkills: true,
    });
    expect(() => {
      brokenInstaller.installSkillsForClient("codex");
    }).toThrow(/devflow-concise-complete-writing/);

    // 2. F2: 默认未传 includeWritingSkills 时，也必须强制要求写作技能，不静默降级为6核心技能
    const defaultBrokenInstaller = new ClientInstaller(brokenSrc, {
      home: env.root,
      bridge: join(env.root, "bridge.js"),
      config: join(env.root, "devflow.yaml"),
    });
    expect(() => {
      defaultBrokenInstaller.installSkillsForClient("codex");
    }).toThrow(/devflow-concise-complete-writing/);

    expect(() => {
      defaultBrokenInstaller.installSkillsForClient("agy");
    }).toThrow(/devflow-concise-complete-writing/);
  });

  it("A2 — F3: Codex 共享目录中退役的写作技能移出技能搜索根，不留任何残留副本在 skills 目录内", () => {
    const sharedAgentsSkillsDir = join(env.root, ".agents", "skills");
    mkdirSync(join(sharedAgentsSkillsDir, "devflow-concise-complete-writing"), { recursive: true });
    writeFileSync(
      join(sharedAgentsSkillsDir, "devflow-concise-complete-writing", "SKILL.md"),
      "# Old Shared Skill",
    );

    installer.installSkillsForClient("codex");

    // skills 搜索根目录下不应该有 devflow-concise-complete-writing，也不应该有任何 backup 目录
    expect(existsSync(join(sharedAgentsSkillsDir, "devflow-concise-complete-writing"))).toBe(false);
    const remainingInSkills = readdirSync(sharedAgentsSkillsDir);
    for (const name of remainingInSkills) {
      expect(name).not.toContain("devflow-concise-complete-writing");
    }

    // 应移入独立备份目录 .devflow-backups/retired-skills
    const backupDir = join(env.root, ".agents", ".devflow-backups", "retired-skills");
    expect(existsSync(backupDir)).toBe(true);
    const backupFiles = readdirSync(backupDir);
    expect(backupFiles.some((f) => f.includes("devflow-concise-complete-writing"))).toBe(true);
  });

  for (const linkedLevel of ["backup-root", "retired-skills"] as const) {
    for (const destination of ["skills-root", "external-directory"] as const) {
      it(`F3: ${linkedLevel} 链接到 ${destination} 时在首次写入前拒绝`, () => {
        const sharedRoot = seedSharedWritingSkills();
        const externalRoot = join(env.root, "external-retirement-target");
        mkdirSync(externalRoot);
        writeFileSync(join(externalRoot, "keep.txt"), "external content");
        const backupRoot = join(env.root, ".agents", ".devflow-backups");
        const linkPath = linkedLevel === "backup-root"
          ? backupRoot
          : join(backupRoot, "retired-skills");
        createDirectoryLink(destination === "skills-root" ? sharedRoot : externalRoot, linkPath);

        expect(() => installer.installSkillsForClient("codex")).toThrow();

        expectInstallationUntouched(sharedRoot);
        expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
        expect(readdirSync(externalRoot)).toEqual(["keep.txt"]);
        expect(readFileSync(join(externalRoot, "keep.txt"), "utf8")).toBe("external content");
      });
    }
  }

  it.each(["backup-root", "retired-skills"] as const)(
    "F3: %s 被普通文件占位时在首次写入前拒绝",
    (occupiedLevel) => {
      const sharedRoot = seedSharedWritingSkills();
      const backupRoot = join(env.root, ".agents", ".devflow-backups");
      const occupiedPath = occupiedLevel === "backup-root"
        ? backupRoot
        : join(backupRoot, "retired-skills");
      mkdirSync(dirname(occupiedPath), { recursive: true });
      writeFileSync(occupiedPath, "keep occupied file");

      expect(() => installer.installSkillsForClient("codex")).toThrow();

      expectInstallationUntouched(sharedRoot);
      expect(lstatSync(occupiedPath).isFile()).toBe(true);
      expect(readFileSync(occupiedPath, "utf8")).toBe("keep occupied file");
    },
  );

  it.each(["directory", "dangling-link"] as const)(
    "F3: 第二项备份目标已有 %s 时不覆盖备份且不先移动第一项",
    (occupiedKind) => {
      const sharedRoot = seedSharedWritingSkills();
      const timestamp = 1_800_000_000_000;
      vi.spyOn(Date, "now").mockReturnValue(timestamp);
      const backupRoot = join(env.root, ".agents", ".devflow-backups", "retired-skills");
      mkdirSync(backupRoot, { recursive: true });
      const occupiedName = `${MANAGED_WRITING_SKILLS[1]!}.devflow-backup-${timestamp}`;
      const occupiedPath = join(backupRoot, occupiedName);
      const absentTarget = join(env.root, "absent-backup-target");
      if (occupiedKind === "directory") {
        mkdirSync(occupiedPath);
        writeFileSync(join(occupiedPath, "keep.txt"), "previous backup");
      } else {
        createDirectoryLink(absentTarget, occupiedPath);
        expect(existsSync(occupiedPath)).toBe(false);
      }

      expect(() => installer.installSkillsForClient("codex")).toThrow();

      expectInstallationUntouched(sharedRoot);
      expect(readdirSync(backupRoot)).toEqual([occupiedName]);
      if (occupiedKind === "directory") {
        expect(readdirSync(occupiedPath)).toEqual(["keep.txt"]);
        expect(readFileSync(join(occupiedPath, "keep.txt"), "utf8")).toBe("previous backup");
      } else {
        expect(lstatSync(occupiedPath).isSymbolicLink()).toBe(true);
        expect(existsSync(absentTarget)).toBe(false);
      }
    },
  );
});

