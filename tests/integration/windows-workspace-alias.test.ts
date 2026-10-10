import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/store/src/store.js";
import { CreateWorkflowService } from "../../packages/core/src/create-workflow.js";
import { ProjectAssetMigrationService } from "../../packages/core/src/project-asset-migration.js";
import { findRealSourceRoot, isSubWorktreePath, previewWorktreePath, resolveWorktreePath, validateWorktreeSafety } from "../../packages/git/src/workspace-paths.js";
import { seedCreateAccess } from "../helpers.js";
import type { Project, Workspace } from "../../packages/contracts/src/index.js";
import { computeSessionBindingKey, type SessionBinding } from "../../packages/contracts/src/session-binding.js";
import { resolveWorkspaceIdentity } from "../../packages/adapters/sdk/src/identity.js";

function shortPath(path: string): string {
  const literal = "'" + path.replaceAll("'", "''") + "'";
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `Add-Type -TypeDefinition 'using System.Text; using System.Runtime.InteropServices; public class ShortWorkspacePath { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, EntryPoint="GetShortPathNameW")] public static extern uint Read(string path, StringBuilder buffer, uint capacity); }'; $buffer=[Text.StringBuilder]::new(4096); if([ShortWorkspacePath]::Read(${literal},$buffer,4096) -eq 0){throw 'Short path unavailable'}; $buffer.ToString()`],
    { encoding: "utf8", windowsHide: true, timeout: 15000 }).trim();
}

describe.runIf(process.platform === "win32")("physical Windows workspace identity under actual 8.3 aliases", () => {
  let root: string, repo: string, alias: string, linked: string, store: Store;
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), "devflow-workspace-alias-")));
    repo = join(root, "repository-with-long-name"); mkdirSync(repo);
    git(repo, "init", "-b", "main"); git(repo, "config", "user.name", "Test"); git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "commit.gpgsign", "false"); git(repo, "config", "core.autocrlf", "false");
    writeFileSync(join(repo, "app.txt"), "original\n"); git(repo, "add", "app.txt"); git(repo, "commit", "-m", "baseline");
    alias = shortPath(repo);
    expect(alias.toLowerCase()).not.toBe(repo.toLowerCase());
    expect(realpathSync.native(alias)).toBe(repo);
    linked = join(root, "linked-worktree-with-long-name");
    store = new Store(join(root, "instance.db")); seedCreateAccess(store);
  });
  afterEach(() => { store?.close(); if(root) rmSync(root, { recursive: true, force: true }); });

  it("preview and creation resolve the same physical root and target while rejecting a subdirectory", () => {
    const service = new CreateWorkflowService(store);
    const existing = previewWorktreePath({ sourceRoot: alias, workflowId: "wf-preview", mode: "existing_workspace" });
    expect(existing.source_root).toBe(repo); expect(existing.target_path).toBe(repo);
    const created = service.execute({ request_id: "existing", workspace_root: alias, request_text: "alias creation" });
    const workspace = store.list<Workspace>("workspace", created.workflow.id)[0]!;
    expect(workspace.root).toBe(repo); expect(workspace.common_dir).toBe(realpathSync.native(join(repo, ".git")));
    const target = resolveWorktreePath({ sourceRoot: alias, workflowId: "wf-new" });
    expect(target).toBe(join(repo, ".worktrees", "wf-new", "main"));
    expect(findRealSourceRoot(alias)).toBe(repo);
    expect(isSubWorktreePath(join(alias, ".worktrees", "wf-new"), repo)).toBe(true);
    expect(isSubWorktreePath(join(alias, ".worktrees-sibling"), repo)).toBe(false);
    expect(() => validateWorktreeSafety(alias, repo)).toThrow(/相同/);
    expect(() => validateWorktreeSafety(join(alias, ".git", "unsafe"), repo)).toThrow(/\.git/);
    mkdirSync(join(repo, "subdirectory"));
    expect(() => service.execute({ request_id: "subdirectory", workspace_root: join(alias, "subdirectory"), request_text: "invalid" })).toThrow(/根目录/);
  }, 30000);

  it("historical short-name workspace and project records retain busy exclusion and reuse the project", () => {
    const service = new CreateWorkflowService(store);
    const first = service.execute({ request_id: "first", workspace_root: repo, request_text: "first" });
    const workspace = store.list<Workspace>("workspace", first.workflow.id)[0]!;
    store.put("workspace", workspace.id, first.workflow.id, { ...workspace, root: alias });
    const project = store.must<Project>("project", first.workflow.project_id);
    store.put("project", project.id, project.id, { ...project, repositories: project.repositories.map(r => ({ ...r, path: alias })) });
    expect(() => service.execute({ request_id: "busy", workspace_root: repo, request_text: "busy" })).toThrow(/已有未完成任务/);
    const parallel = service.execute({ request_id: "parallel", workspace_root: alias, workspace_mode: "new_worktree", request_text: "parallel" });
    expect(parallel.workflow.project_id).toBe(first.workflow.project_id);
    expect(store.list<Project>("project")).toHaveLength(1);
    expect(store.list<Workspace>("workspace", parallel.workflow.id)[0]!.root).toBe(join(repo, ".worktrees", parallel.workflow.id, "main"));
  }, 30000);

  function migrationWorkspace(path: string, source = alias) {
    store.put("workspace", "ws-alias", "wf-alias", { id: "ws-alias", workflow_id: "wf-alias", repo_id: "main", root: path, source_root: source, branch: "linked", mode: "new_worktree", owned: true });
    return new ProjectAssetMigrationService(store, join(root, "storage"));
  }

  it("moves a registered linked alias with exact material bytes and replays the receipt through its new alias", async () => {
    git(repo, "worktree", "add", "-b", "linked", linked, "HEAD");
    const linkedAlias = shortPath(linked);
    const service = migrationWorkspace(linkedAlias);
    const binding: SessionBinding = {
      id: "binding-alias", workflow_id: "wf-alias", repo_id: "main", adapter_id: "codex", host_id: "fixture-host",
      client_scope_id: "fixture-scope", provider_account_scope: "fixture-account", canonical_model_id: "fixture-model",
      workspace_root: linkedAlias, source_root: alias, workspace_identity: resolveWorkspaceIdentity(linkedAlias),
      conversation_id: "preserved-native-conversation", state: "bound", revision: 1, generation: 1,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), metadata: { retained: "original" },
    };
    const oldKey = computeSessionBindingKey(binding);
    store.put("session_binding", oldKey, "wf-alias", binding);
    store.put("session_binding_by_id", binding.id, "wf-alias", { keyStr: oldKey });
    const cache = join(root, "storage", "documents", "wf-alias"); mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "plan.md"), "# preserved exact material\n");
    const target = join(repo, ".worktrees", "wf-alias", "main");
    const preview = service.preview({ workflowId: "wf-alias", workspaceId: "ws-alias", explicitTargetRoot: join(alias, ".worktrees", "wf-alias", "main") });
    expect(preview.eligible).toBe(true); expect(preview.is_linked_worktree).toBe(true);
    expect(preview.current_root).toBe(linked); expect(preview.target_root).toBe(target);
    const input = { workflow_id: "wf-alias", workspace_id: "ws-alias", request_id: "move", expected_workspace_version: 1, expected_preview_digest: preview.preview_digest, target_root: target };
    const record = await service.apply(input);
    expect(record.stage).toBe("committed"); expect(existsSync(linked)).toBe(false);
    expect(readFileSync(join(target, "docs/process/wf-alias/migrated/plan.md"), "utf8")).toBe("# preserved exact material\n");
    expect(store.must<Workspace>("workspace", "ws-alias").root).toBe(target);
    expect(await service.apply({ ...input, target_root: shortPath(target) })).toEqual(record);
    expect(await service.resume("wf-alias", record.id, "move")).toEqual(record);
    expect(git(repo, "worktree", "list", "--porcelain").replaceAll("\\", "/")).toContain(target.replaceAll("\\", "/"));
    const movedKey = store.must<{ keyStr: string }>("session_binding_by_id", binding.id).keyStr;
    const moved = store.must<SessionBinding>("session_binding", movedKey);
    expect(moved.workspace_root).toBe(target);
    expect(moved.workspace_identity).toBe(resolveWorkspaceIdentity(target));
    expect(moved.id).toBe(binding.id); expect(moved.conversation_id).toBe(binding.conversation_id); expect(moved.metadata).toEqual(binding.metadata);
    expect(store.get("session_binding", oldKey)).toBeUndefined();
    const rolled = await service.rollback("wf-alias", record.id, "move");
    expect(rolled.stage).toBe("rolled_back"); expect(existsSync(linked)).toBe(true); expect(existsSync(target)).toBe(false);
    const rolledKey = store.must<{ keyStr: string }>("session_binding_by_id", binding.id).keyStr;
    const restored = store.must<SessionBinding>("session_binding", rolledKey);
    expect(restored.workspace_root).toBe(linked); expect(restored.id).toBe(binding.id); expect(restored.conversation_id).toBe(binding.conversation_id);
    expect(restored.metadata).toEqual(binding.metadata);
  }, 30000);

  it("a short alias of the primary root cannot impersonate a registered linked worktree", () => {
    const service = migrationWorkspace(alias);
    const preview = service.preview({ workflowId: "wf-alias", workspaceId: "ws-alias" });
    expect(preview.eligible).toBe(false); expect(preview.can_move_worktree).toBe(false); expect(preview.is_linked_worktree).toBe(false);
    expect(preview.conflicts.join(" ")).toContain("不是可移动的 Git 登记 linked worktree");
  }, 30000);

  it("NOFOLLOW still rejects supplied junction ancestry before physical alias normalization", () => {
    git(repo, "worktree", "add", "-b", "linked", linked, "HEAD");
    const junction = join(root, "junction-to-linked"); symlinkSync(linked, junction, "junction");
    const service = migrationWorkspace(junction);
    expect(() => service.preview({ workflowId: "wf-alias", workspaceId: "ws-alias" })).toThrow(/材料目录/);
    const safe = migrationWorkspace(linked);
    expect(() => safe.preview({ workflowId: "wf-alias", workspaceId: "ws-alias", explicitTargetRoot: join(junction, "new-target") })).toThrow(/材料目录/);
    expect(readFileSync(join(linked, "app.txt"), "utf8")).toBe("original\n");
  }, 30000);
});
