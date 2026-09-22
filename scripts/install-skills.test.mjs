import { test } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  installSkills,
  installCodexSkills,
  InstallSkillsError,
  ALLOWED_SKILLS,
} from "./install-skills.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "devflow-skills-"));
  t.after(() => {
    assert.equal(
      resolve(root).startsWith(resolve(tmpdir()) + "/") ||
        resolve(root).startsWith(resolve(tmpdir()) + "\\"),
      true,
    );
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {}
  });
  const source = join(root, "source"),
    target = join(root, "target"),
    backup = join(root, "backup");
  const write = (base, name, text) => {
    mkdirSync(join(base, name), { recursive: true });
    writeFileSync(join(base, name, "SKILL.md"), text);
  };
  for (const name of ALLOWED_SKILLS) {
    write(source, name, `source of ${name}`);
  }
  write(source, "devflow-test", "three layers");
  write(source, "devflow-execute", "updated executor");
  write(target, "devflow-execute", "local previous executor");
  write(target, "devflow-browser-accept", "previous browser skill");
  write(target, "personal-skill", "keep personal data");
  return { root, source, target, backup, write };
}

test("upgrade installs ALLOWED_SKILLS, backs up and retires browser skill, preserves user skills", (t) => {
  const f = fixture(t);
  installSkills(f.source, f.target, f.backup);
  assert.equal(readFileSync(join(f.target, "devflow-test/SKILL.md"), "utf8"), "three layers");
  assert.equal(readFileSync(join(f.target, "devflow-execute/SKILL.md"), "utf8"), "updated executor");
  assert.equal(readFileSync(join(f.backup, "devflow-execute/SKILL.md"), "utf8"), "local previous executor");
  assert.equal(readFileSync(join(f.backup, "devflow-browser-accept/SKILL.md"), "utf8"), "previous browser skill");
  assert.equal(existsSync(join(f.target, "devflow-browser-accept")), false);
  assert.equal(readFileSync(join(f.target, "personal-skill/SKILL.md"), "utf8"), "keep personal data");
  installSkills(f.source, f.target, join(f.root, "second-backup"));
  assert.equal(existsSync(join(f.target, "devflow-browser-accept")), false);
});

test("refuses overlapping directories and backup collisions before overwriting skills", (t) => {
  const f = fixture(t);
  assert.throws(() => installSkills(f.source, f.target, join(f.target, "backup")), /separate/);
  f.write(f.backup, "devflow-execute", "saved data");
  assert.throws(() => installSkills(f.source, f.target, f.backup), /already exists/);
  assert.equal(readFileSync(join(f.target, "devflow-execute/SKILL.md"), "utf8"), "local previous executor");
  assert.equal(readFileSync(join(f.backup, "devflow-execute/SKILL.md"), "utf8"), "saved data");
});

test("UT08: installCodexSkills synchronizes to both codex and shared-agent targets with independent backups", (t) => {
  const f = fixture(t);
  const codexHome = join(f.root, "custom-codex");
  const userHome = join(f.root, "custom-user");
  const backupRoot = join(f.root, "custom-backups");

  // Pre-seed some target skills and personal skills
  f.write(join(codexHome, "skills"), "devflow-review", "old codex review");
  f.write(join(codexHome, "skills"), "custom-codex-skill", "preserve me codex");
  f.write(join(userHome, ".agents", "skills"), "devflow-review", "old shared review");
  f.write(join(userHome, ".agents", "skills"), "custom-agent-skill", "preserve me agent");

  const result = installCodexSkills(f.source, { codexHome, userHome, backupRoot });
  assert.equal(result.results.length, 2);
  assert.equal(result.results.every((r) => r.success), true);

  // Both targets have updated skills
  assert.equal(
    readFileSync(join(codexHome, "skills", "devflow-execute", "SKILL.md"), "utf8"),
    "updated executor",
  );
  assert.equal(
    readFileSync(join(userHome, ".agents", "skills", "devflow-execute", "SKILL.md"), "utf8"),
    "updated executor",
  );

  // Personal skills are preserved
  assert.equal(
    readFileSync(join(codexHome, "skills", "custom-codex-skill", "SKILL.md"), "utf8"),
    "preserve me codex",
  );
  assert.equal(
    readFileSync(join(userHome, ".agents", "skills", "custom-agent-skill", "SKILL.md"), "utf8"),
    "preserve me agent",
  );

  // Independent backups exist and hold previous versions
  assert.equal(
    readFileSync(join(backupRoot, "codex-skills", "devflow-review", "SKILL.md"), "utf8"),
    "old codex review",
  );
  assert.equal(
    readFileSync(join(backupRoot, "shared-agent-skills", "devflow-review", "SKILL.md"), "utf8"),
    "old shared review",
  );
});

test("RT01: .agents 或 skills 为符号链接/junction 时拒绝安装，目标与另一安装目录不变", (t) => {
  const f = fixture(t);
  const codexHome = join(f.root, "codex-home");
  const userHome = join(f.root, "user-home");
  const backupRoot = join(f.root, "backups");

  const realAgents = join(f.root, "external-agents-target");
  mkdirSync(realAgents, { recursive: true });
  writeFileSync(join(realAgents, "original.txt"), "untouched");

  // 将 userHome/.agents 创建为指向 realAgents 的 junction/symlink
  mkdirSync(userHome, { recursive: true });
  symlinkSync(realAgents, join(userHome, ".agents"), process.platform === "win32" ? "junction" : "dir");

  assert.throws(
    () => installCodexSkills(f.source, { codexHome, userHome, backupRoot }),
    /Symlink or junction forbidden/,
  );

  // 验证被链接的目标目录以及未处理的 codexHome 均未被意外写入
  assert.equal(readFileSync(join(realAgents, "original.txt"), "utf8"), "untouched");
  assert.equal(existsSync(join(codexHome, "skills")), false);
});

test("RT02: 源、备份、skill子目录存在链接时在写入前拒绝", (t) => {
  const f = fixture(t);
  const codexHome = join(f.root, "codex-home-rt02");
  const userHome = join(f.root, "user-home-rt02");
  const backupRoot = join(f.root, "backups-rt02");

  // 在源目录的一个 skill 下创建指向外部的链接
  const external = join(f.root, "external-source");
  mkdirSync(external, { recursive: true });
  symlinkSync(external, join(f.source, "devflow", "link-dir"), process.platform === "win32" ? "junction" : "dir");

  assert.throws(
    () => installCodexSkills(f.source, { codexHome, userHome, backupRoot }),
    /Symlink or junction forbidden/,
  );
  assert.equal(existsSync(join(codexHome, "skills")), false);
});

test("RT03: codexHome=userHome/.agents 时物理目标只安装一次且只有一份有效备份", (t) => {
  const f = fixture(t);
  const userHome = join(f.root, "shared-home");
  const codexHome = join(userHome, ".agents"); // 两目标重叠
  const backupRoot = join(f.root, "backups-rt03");

  const report = installCodexSkills(f.source, { codexHome, userHome, backupRoot });
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].status, "completed");
  assert.equal(report.results[0].aliases?.includes("shared-agent"), true);
  assert.equal(existsSync(join(codexHome, "skills", "devflow-execute", "SKILL.md")), true);
});

test("RT04: backupRoot 与目标目录重叠时首次写入前失败", (t) => {
  const f = fixture(t);
  const codexHome = join(f.root, "codex-home-rt04");
  const userHome = join(f.root, "user-home-rt04");
  const backupRoot = join(codexHome, "skills", "backups"); // backupRoot 位于目标目录内部

  assert.throws(
    () => installCodexSkills(f.source, { codexHome, userHome, backupRoot }),
    /must be separate/,
  );
  assert.equal(existsSync(join(codexHome, "skills", "devflow")), false);
});

test("RT05: 第二目标父路径不是目录时全局预检失败，两个目标均不写入", (t) => {
  const f = fixture(t);
  const codexHome = join(f.root, "codex-home-rt05");
  const userHome = join(f.root, "user-home-rt05");
  const backupRoot = join(f.root, "backups-rt05");

  // 使第二目标的 shared-agent 根目录不可写（例如创建一个同名文件而不是目录，导致其 skills 无法创建）
  mkdirSync(userHome, { recursive: true });
  writeFileSync(join(userHome, ".agents"), "blocker-file");

  let caught = null;
  try {
    installCodexSkills(f.source, { codexHome, userHome, backupRoot });
  } catch (err) {
    caught = err;
  }

  assert.ok(caught instanceof InstallSkillsError);
  assert.equal(caught.report.results.length, 2);
  // 预检在任何目标写入前完成，第一目标没有启动。
  assert.equal(caught.report.results[0].name, "codex");
  assert.equal(caught.report.results[0].status, "not_started");
  assert.equal(caught.report.results[0].skillsInstalled.length, 0);
  assert.equal(existsSync(join(codexHome, "skills")), false);
  assert.equal(existsSync(backupRoot), false);
  // 第二目标失败
  assert.equal(caught.report.results[1].name, "shared-agent");
  assert.equal(caught.report.results[1].status, "failed");
  assert.equal(caught.report.results[1].failureStage, "preflight");
  assert.equal(caught.report.results[1].partial, false);
});

test("RT06: 第一目标预检失败时所有目标不写入，状态正确记录", (t) => {
  const f = fixture(t);
  const codexHome = join(f.root, "codex-home-rt06");
  const userHome = join(f.root, "user-home-rt06");
  const backupRoot = join(f.root, "backups-rt06");

  // 破坏源：删掉一个 skill 的 SKILL.md
  rmSync(join(f.source, "devflow-plan", "SKILL.md"));

  let caught = null;
  try {
    installCodexSkills(f.source, { codexHome, userHome, backupRoot });
  } catch (err) {
    caught = err;
  }

  assert.ok(caught instanceof InstallSkillsError);
  assert.equal(caught.report.results[0].status, "failed");
  assert.equal(caught.report.results[1].status, "not_started");
  assert.equal(existsSync(join(codexHome, "skills")), false);
  assert.equal(existsSync(join(userHome, ".agents", "skills")), false);
});


function failSkillCopyAfterWrite(t, target) {
  const copy = fs.cpSync;
  const mocked = t.mock.method(fs, "cpSync", (source, destination, options) => {
    if (resolve(destination) === resolve(target)) {
      mkdirSync(destination, { recursive: true });
      writeFileSync(join(destination, "partial.txt"), "copy started");
      throw Object.assign(new Error("Injected copy I/O failure"), { code: "EIO" });
    }
    return copy(source, destination, options);
  });
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
}

test("RT12: 第二目标在复制中途失败，保留第一目标结果、备份和失败位置", (t) => {
  const f = fixture(t);
  const codexHome = join(f.root, "codex");
  const userHome = join(f.root, "user");
  const backupRoot = join(f.root, "backups");
  const shared = join(userHome, ".agents", "skills");
  f.write(shared, "devflow", "previous shared entry");
  const failedPath = join(shared, "devflow");
  failSkillCopyAfterWrite(t, failedPath);

  assert.throws(() => installCodexSkills(f.source, { codexHome, userHome, backupRoot }), (error) => {
    assert.ok(error instanceof InstallSkillsError);
    assert.equal(error.report.backupRoot, backupRoot);
    assert.equal(error.report.results[0].status, "completed");
    assert.deepEqual(error.report.results[0].skillsInstalled, ALLOWED_SKILLS);
    const failed = error.report.results[1];
    assert.equal(failed.status, "failed");
    assert.equal(failed.partial, true);
    assert.deepEqual(failed.skillsInstalled, []);
    assert.equal(failed.failureStage, "copy");
    assert.equal(failed.failedSkill, "devflow");
    assert.equal(failed.failedPath, failedPath);
    assert.equal(readFileSync(join(failed.backupRoot, "devflow", "SKILL.md"), "utf8"), "previous shared entry");
    assert.equal(readFileSync(join(failedPath, "partial.txt"), "utf8"), "copy started");
    return true;
  });
});

for (const throwOnError of [true, false]) {
  test(`RT13: 首个 skill 中途写入失败，partial 正确且 throwOnError=${throwOnError} 遵循继续策略`, (t) => {
    const f = fixture(t);
    const codexHome = join(f.root, "codex");
    const userHome = join(f.root, "user");
    const backupRoot = join(f.root, "backups");
    failSkillCopyAfterWrite(t, join(codexHome, "skills", "devflow"));
    let report;
    if (throwOnError) {
      assert.throws(() => installCodexSkills(f.source, { codexHome, userHome, backupRoot }), (error) => {
        assert.ok(error instanceof InstallSkillsError);
        report = error.report;
        return true;
      });
    } else {
      report = installCodexSkills(f.source, { codexHome, userHome, backupRoot, throwOnError });
    }
    assert.equal(report.results[0].status, "failed");
    assert.equal(report.results[0].partial, true);
    assert.deepEqual(report.results[0].skillsInstalled, []);
    assert.equal(report.results[0].failureStage, "copy");
    assert.equal(report.results[1].status, throwOnError ? "not_started" : "completed");
    assert.equal(existsSync(join(userHome, ".agents", "skills", "devflow", "SKILL.md")), !throwOnError);
  });
}

test("RT14: 无关个人 skill 链接不阻止 DevFlow 安装，链接和内容保留", (t) => {
  const f = fixture(t);
  const personal = join(f.root, "linked-personal");
  mkdirSync(personal);
  writeFileSync(join(personal, "SKILL.md"), "personal original");
  const link = join(f.target, "personal-link");
  symlinkSync(personal, link, process.platform === "win32" ? "junction" : "dir");
  installSkills(f.source, f.target, f.backup);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(readFileSync(join(link, "SKILL.md"), "utf8"), "personal original");
  assert.equal(readFileSync(join(f.target, "devflow-execute", "SKILL.md"), "utf8"), "updated executor");
});

test("RT15: 悬空备份链接在所有目标写入前拒绝", (t) => {
  const f = fixture(t);
  const codexHome = join(f.root, "codex");
  const userHome = join(f.root, "user");
  const backupRoot = join(f.root, "backups");
  const backupTarget = join(backupRoot, "shared-agent-skills");
  mkdirSync(backupTarget, { recursive: true });
  const missing = join(f.root, "missing-backup-target");
  const link = join(backupTarget, "devflow");
  symlinkSync(missing, link, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => installCodexSkills(f.source, { codexHome, userHome, backupRoot }), /Symlink or junction forbidden/);
  assert.equal(existsSync(join(codexHome, "skills")), false);
  assert.equal(existsSync(join(userHome, ".agents", "skills")), false);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(existsSync(missing), false);
});


test("RT20: 第二目标的引用目录被文件占位时首次写入前拒绝", (t) => {
  const f = fixture(t);
  const codexHome = join(f.root, "codex");
  const userHome = join(f.root, "user");
  const backupRoot = join(f.root, "backups");
  mkdirSync(join(f.source, "devflow", "references"));
  writeFileSync(join(f.source, "devflow", "references", "guide.md"), "new guide");
  const sharedSkill = join(userHome, ".agents", "skills", "devflow");
  mkdirSync(sharedSkill, { recursive: true });
  const blocker = join(sharedSkill, "references");
  writeFileSync(blocker, "keep blocker");
  assert.throws(() => installCodexSkills(f.source, { codexHome, userHome, backupRoot }), (error) => {
    assert.ok(error instanceof InstallSkillsError);
    assert.equal(error.report.results[0].status, "not_started");
    assert.equal(error.report.results[1].status, "failed");
    assert.equal(error.report.results[1].failureStage, "preflight");
    assert.equal(error.report.results[1].partial, false);
    return true;
  });
  assert.equal(existsSync(join(codexHome, "skills")), false);
  assert.equal(existsSync(backupRoot), false);
  assert.equal(readFileSync(blocker, "utf8"), "keep blocker");
});
