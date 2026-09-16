import { cpSync, existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

function contains(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
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
  const names = readdirSync(source, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^devflow(?:-[a-z-]+)?$/.test(entry.name))
    .map((entry) => entry.name)
    .filter((name) => name !== "devflow-browser-accept");
  // Preflight all entries before changing the user's installed skills.
  for (const name of names) {
    if (!existsSync(join(source, name, "SKILL.md")))
      throw new Error(`Missing SKILL.md: ${name}`);
  }
  for (const name of [...names, "devflow-browser-accept"]) {
    if (existsSync(join(backup, name)))
      throw new Error(`Skill backup already exists: ${name}`);
  }
  mkdirSync(target, { recursive: true });
  mkdirSync(backup, { recursive: true });
  for (const name of names) {
    const installed = join(target, name);
    if (existsSync(installed)) cpSync(installed, join(backup, name), { recursive: true });
    cpSync(join(source, name), installed, { recursive: true });
  }
  // This exact child belongs to DevFlow. Move it to backup, without following
  // links or recursively deleting any user directory.
  const retired = join(target, "devflow-browser-accept");
  if (existsSync(retired)) renameSync(retired, join(backup, "devflow-browser-accept"));
  return names;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = join(codexHome, "devflow-backups", stamp);
  const names = installSkills(join(root, "packages/skills"), join(codexHome, "skills"), backup);
  console.log(`Updated ${names.length} DevFlow skills. Backup: ${backup}`);
}
