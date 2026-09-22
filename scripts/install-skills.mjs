import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  lstatSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export function canonicalizePath(p) {
  const abs = resolve(p);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

export function isSameOrSubPath(parent, child) {
  const normParent = canonicalizePath(parent);
  const normChild = canonicalizePath(child);
  if (normParent === normChild) return true;
  const rel = relative(normParent, normChild);
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}

function contains(parent, child) {
  return isSameOrSubPath(parent, child);
}

export function assertNoSymlinkInPath(targetPath) {
  const resolved = resolve(targetPath);
  let current = resolved;
  const parts = [];
  while (true) {
    parts.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const p of parts) {
    try {
      const stat = lstatSync(p);
      if (p !== resolved && !stat.isDirectory() && !stat.isSymbolicLink())
        throw new Error("Expected directory ancestor: " + p);
      if (stat.isSymbolicLink()) {
        throw new Error(`Symlink or junction forbidden: ${p}`);
      }
    } catch (err) {
      if (err.code === "ENOENT") {
        break;
      }
      throw err;
    }
  }
}

export function assertTreeHasNoSymlinks(rootPath) {
  assertNoSymlinkInPath(rootPath);
  try {
    const stat = lstatSync(rootPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Symlink or junction forbidden: ${rootPath}`);
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
        const full = join(rootPath, entry.name);
        if (entry.isSymbolicLink()) {
          throw new Error(`Symlink or junction forbidden: ${full}`);
        }
        if (entry.isDirectory()) {
          assertTreeHasNoSymlinks(full);
        }
      }
    }
  } catch (err) {
    if (err.code === "ENOENT") {
      return;
    }
    throw err;
  }
}

export class InstallSkillsError extends Error {
  constructor(message, report) {
    super(message);
    this.name = "InstallSkillsError";
    this.report = report;
    this.backupRoot = report?.backupRoot;
    this.results = report?.results ?? [];
  }
}

export const ALLOWED_SKILLS = [
  "devflow",
  "devflow-project-onboard",
  "devflow-plan",
  "devflow-execute",
  "devflow-test",
  "devflow-review",
];

function statIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err.code === "ENOENT") return undefined;
    throw err;
  }
}

function assertDirectory(path) {
  assertNoSymlinkInPath(path);
  const stat = statIfPresent(path);
  if (stat && !stat.isDirectory()) throw new Error("Expected skill directory: " + path);
}

function preflightSource(source) {
  assertDirectory(source);
  for (const name of ALLOWED_SKILLS) {
    const skill = join(source, name);
    assertDirectory(skill);
    assertTreeHasNoSymlinks(skill);
    if (!statIfPresent(join(skill, "SKILL.md"))?.isFile())
      throw new Error("Missing SKILL.md: " + name);
  }
}

function assertUnusedBackup(path) {
  assertNoSymlinkInPath(path);
  if (statIfPresent(path)) throw new Error("Skill backup already exists: " + path);
}

function assertCompatibleTree(source, target) {
  const sourceStat = lstatSync(source), targetStat = statIfPresent(target);
  if (targetStat && sourceStat.isDirectory() !== targetStat.isDirectory())
    throw new Error("Skill file/directory conflict: " + target);
  if (sourceStat.isDirectory()) {
    for (const entry of readdirSync(source, { withFileTypes: true }))
      assertCompatibleTree(join(source, entry.name), join(target, entry.name));
  }
}

function preflightTarget(source, target, backup) {
  assertDirectory(target);
  assertDirectory(backup);
  // Inspect only the DevFlow entries this installation can change.
  for (const name of [...ALLOWED_SKILLS, "devflow-browser-accept"]) {
    const installed = join(target, name);
    assertDirectory(installed);
    assertTreeHasNoSymlinks(installed);
    if (ALLOWED_SKILLS.includes(name))
      assertCompatibleTree(join(source, name), installed);
    assertUnusedBackup(join(backup, name));
  }
}

function copySkill(source, installed, backup, onWrite = () => {}) {
  assertTreeHasNoSymlinks(source);
  assertTreeHasNoSymlinks(installed);
  assertUnusedBackup(backup);
  if (statIfPresent(installed)) {
    onWrite("backup", backup);
    cpSync(installed, backup, { recursive: true, force: false, errorOnExist: true });
  }
  onWrite("copy", installed);
  cpSync(source, installed, { recursive: true });
}

/** Update only DevFlow skills, retaining backups and retiring the old fourth layer. */
export function installSkills(sourceRoot, targetRoot, backupRoot) {
  const roots = [sourceRoot, targetRoot, backupRoot].map((path) => resolve(path));
  for (let i = 0; i < roots.length; i++) {
    for (let j = i + 1; j < roots.length; j++) {
      if (contains(roots[i], roots[j]) || contains(roots[j], roots[i]))
        throw new Error("Skill source, target and backup directories must be separate");
    }
  }
  const [source, target, backup] = roots;

  preflightSource(source);
  preflightTarget(source, target, backup);
  const names = ALLOWED_SKILLS;

  assertNoSymlinkInPath(target);
  mkdirSync(target, { recursive: true });
  assertNoSymlinkInPath(backup);
  mkdirSync(backup, { recursive: true });

  for (const name of names) {
    const installed = join(target, name);
    copySkill(join(source, name), installed, join(backup, name));
  }

  // This exact child belongs to DevFlow. Move it to backup, without following
  // links or recursively deleting any user directory.
  const retired = join(target, "devflow-browser-accept");
  if (existsSync(retired)) {
    assertTreeHasNoSymlinks(retired);
    assertUnusedBackup(join(backup, "devflow-browser-accept"));
    renameSync(retired, join(backup, "devflow-browser-accept"));
  }
  return names;
}

/** Install DevFlow skills into both primary Codex home and shared agent home. */
export function installCodexSkills(sourceRoot, options = {}) {
  const userHome = resolve(options.userHome ?? process.env.USERPROFILE ?? process.env.HOME ?? homedir());
  const codexHome = resolve(options.codexHome ?? process.env.CODEX_HOME ?? join(userHome, ".codex"));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupRoot = resolve(options.backupRoot ?? join(codexHome, "devflow-backups", stamp));
  const source = resolve(sourceRoot);

  const initialTargets = [
    {
      name: "codex",
      targetRoot: resolve(join(codexHome, "skills")),
      backupRoot: resolve(join(backupRoot, "codex-skills")),
    },
    {
      name: "shared-agent",
      targetRoot: resolve(join(userHome, ".agents", "skills")),
      backupRoot: resolve(join(backupRoot, "shared-agent-skills")),
    },
  ];

  // 目标去重：当 codex 与 shared-agent 指向同一物理目标时去重
  const targets = [];
  if (canonicalizePath(initialTargets[0].targetRoot) === canonicalizePath(initialTargets[1].targetRoot)) {
    targets.push({
      name: "codex",
      aliases: ["codex", "shared-agent"],
      targetRoot: initialTargets[0].targetRoot,
      backupRoot: initialTargets[0].backupRoot,
    });
  } else {
    targets.push(...initialTargets);
  }

  const report = {
    backupRoot,
    results: targets.map((t) => ({
      name: t.name,
      aliases: t.aliases,
      targetRoot: t.targetRoot,
      backupRoot: t.backupRoot,
      status: "not_started",
      skills: [],
      skillsInstalled: [],
      partial: false,
      success: false,
      error: undefined,
      failureStage: undefined,
      failedSkill: undefined,
      failedPath: undefined,
    })),
  };

  // 全局静态预检（在任何写入或创建目录之前）
  let preflightTargetIndex = 0;
  try {
    // 1. 目录互斥规则检查
    for (let i = 0; i < targets.length; i++) {
      preflightTargetIndex = i;
      const t = targets[i];
      if (isSameOrSubPath(source, t.targetRoot) || isSameOrSubPath(t.targetRoot, source)) {
        throw new Error(`Skill source and target directories must be separate: ${source} vs ${t.targetRoot}`);
      }
      if (isSameOrSubPath(source, t.backupRoot) || isSameOrSubPath(t.backupRoot, source)) {
        throw new Error(`Skill source and backup directories must be separate: ${source} vs ${t.backupRoot}`);
      }
      if (isSameOrSubPath(t.targetRoot, t.backupRoot) || isSameOrSubPath(t.backupRoot, t.targetRoot)) {
        throw new Error(`Skill target and backup directories must be separate: ${t.targetRoot} vs ${t.backupRoot}`);
      }
      if (isSameOrSubPath(t.targetRoot, backupRoot) || isSameOrSubPath(backupRoot, t.targetRoot)) {
        throw new Error(`Skill target and backupRoot must be separate: ${t.targetRoot} vs ${backupRoot}`);
      }
    }
    for (let i = 0; i < targets.length; i++) {
      for (let j = i + 1; j < targets.length; j++) {
        preflightTargetIndex = j;
        const t1 = targets[i], t2 = targets[j];
        if (isSameOrSubPath(t1.targetRoot, t2.targetRoot) || isSameOrSubPath(t2.targetRoot, t1.targetRoot)) {
          throw new Error(`Distinct skill target directories must not overlap: ${t1.targetRoot} vs ${t2.targetRoot}`);
        }
        if (isSameOrSubPath(t1.backupRoot, t2.targetRoot) || isSameOrSubPath(t2.targetRoot, t1.backupRoot)) {
          throw new Error(`Backup directory must not overlap with target directory: ${t1.backupRoot} vs ${t2.targetRoot}`);
        }
      }
    }

    preflightTargetIndex = 0;
    preflightSource(source);
    for (let i = 0; i < targets.length; i++) {
      preflightTargetIndex = i;
      preflightTarget(source, targets[i].targetRoot, targets[i].backupRoot);
    }
  } catch (preflightError) {
    const failed = report.results[preflightTargetIndex];
    failed.status = "failed";
    failed.failureStage = "preflight";
    failed.error = preflightError;
    if (options.throwOnError !== false) {
      throw new InstallSkillsError(`Preflight validation failed: ${preflightError.message}`, report);
    }
    return report;
  }

  // 执行阶段：逐个目标安装
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const r = report.results[i];
    const installedList = [];
    let writeAttempted = false;
    let activeSkill;
    let activePath = t.targetRoot;
    let stage = "prepare";
    try {
      assertNoSymlinkInPath(t.targetRoot);
      mkdirSync(t.targetRoot, { recursive: true });
      activePath = t.backupRoot;
      assertNoSymlinkInPath(t.backupRoot);
      mkdirSync(t.backupRoot, { recursive: true });

      for (const name of ALLOWED_SKILLS) {
        const installed = join(t.targetRoot, name);
        activeSkill = name;
        activePath = installed;
        stage = "pre_copy";
        copySkill(join(source, name), installed, join(t.backupRoot, name), (operation, path) => {
          stage = operation;
          activePath = path;
          writeAttempted = true;
        });
        installedList.push(name);
      }

      const retired = join(t.targetRoot, "devflow-browser-accept");
      if (existsSync(retired)) {
        activeSkill = "devflow-browser-accept";
        activePath = retired;
        stage = "retire";
        assertTreeHasNoSymlinks(retired);
        assertUnusedBackup(join(t.backupRoot, "devflow-browser-accept"));
        writeAttempted = true;
        renameSync(retired, join(t.backupRoot, "devflow-browser-accept"));
      }

      r.status = "completed";
      r.skills = installedList;
      r.skillsInstalled = installedList;
      r.success = true;
      r.partial = false;
    } catch (err) {
      r.status = "failed";
      r.skillsInstalled = installedList;
      r.skills = installedList;
      // A first skill can fail after writing files but before completing.
      r.partial = writeAttempted;
      r.failureStage = stage;
      r.failedSkill = activeSkill;
      r.failedPath = activePath;
      r.error = err;
      r.success = false;

      if (options.throwOnError !== false) {
        throw new InstallSkillsError(`Failed to install skills for target ${t.name}: ${err.message}`, report);
      }
      // Non-throwing callers continue with the next independent target.
    }
  }

  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const report = installCodexSkills(join(root, "packages/skills"));
    console.log(`Updated DevFlow skills across ${report.results.length} targets. Backup: ${report.backupRoot}`);
    for (const r of report.results) {
      console.log(`- ${r.name}: ${r.skillsInstalled?.length ?? 0} skills -> ${r.targetRoot}`);
    }
  } catch (err) {
    if (err.report) {
      console.error(`Skill update failed. Backup root: ${err.report.backupRoot}`);
      for (const r of err.report.results) {
        if (r.status === "completed") {
          console.log(`- ${r.name}: completed (${r.skillsInstalled?.length ?? 0} skills) -> ${r.targetRoot}`);
        } else if (r.status === "failed") {
          console.error(`- ${r.name}: failed (partial: ${r.partial ? "yes" : "no"}) -> ${r.targetRoot}: ${r.error?.message ?? r.error}`);
        } else {
          console.warn(`- ${r.name}: not_started -> ${r.targetRoot}`);
        }
      }
    } else {
      console.error(`Skill update failed: ${err.message}`);
    }
    process.exit(1);
  }
}
