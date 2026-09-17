import { execFileSync } from "node:child_process";
import { mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
/** Freeze the user's initial index and working tree without changing either. */
export function captureInitialState(root: string) {
  const temp = mkdtempSync(join(tmpdir(), "devflow-initial-index-"));
  const index = join(temp, "index");
  const git = (args: string[], isolated = false) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, ...(isolated ? { GIT_INDEX_FILE: index } : {}) },
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  try {
    const initial_index_tree = git(["write-tree"]);
    git(["read-tree", "HEAD"], true);
    git(["add", "--all", "--", "."], true);
    const initial_worktree_tree = git(["write-tree"], true);
    return { initial_index_tree, initial_worktree_tree };
  } finally {
    try {
      unlinkSync(index);
    } catch {}
    try {
      rmdirSync(temp);
    } catch {}
  }
}

/** Compare against the preserved starting files using an isolated Git index. */
export function changesFromInitialInput(root: string, initialTree: string) {
  const temp = mkdtempSync(join(tmpdir(), "devflow-input-diff-"));
  const index = join(temp, "index");
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
  try {
    git(["read-tree", initialTree]);
    git(["add", "--all", "--", "."]);
    return git([
      "diff",
      "--cached",
      "--name-only",
      "--no-renames",
      "-z",
      initialTree,
      "--",
    ])
      .split("\0")
      .filter(Boolean);
  } finally {
    try {
      unlinkSync(index);
    } catch {}
    try {
      rmdirSync(temp);
    } catch {}
  }
}
