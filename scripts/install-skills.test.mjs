import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { installSkills } from "./install-skills.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "devflow-skills-"));
  t.after(() => {
    assert.equal(resolve(root).startsWith(resolve(tmpdir()) + "/") || resolve(root).startsWith(resolve(tmpdir()) + "\\"), true);
    rmSync(root, { recursive: true, force: true });
  });
  const source = join(root, "source"), target = join(root, "target"), backup = join(root, "backup");
  const write = (base, name, text) => {
    mkdirSync(join(base, name), { recursive: true });
    writeFileSync(join(base, name, "SKILL.md"), text);
  };
  write(source, "devflow-test", "three layers");
  write(source, "devflow-execute", "updated executor");
  write(target, "devflow-execute", "local previous executor");
  write(target, "devflow-browser-accept", "previous browser skill");
  write(target, "personal-skill", "keep personal data");
  return { root, source, target, backup, write };
}

test("upgrade installs three-layer skill, backs up and retires browser skill, preserves user skills", (t) => {
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
