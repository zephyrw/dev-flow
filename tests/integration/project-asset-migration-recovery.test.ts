import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../../packages/store/src/store.js";
import { ProjectAssetMigrationService } from "../../packages/core/src/project-asset-migration.js";
import type { Workspace, WorkflowDispatchControl, Run } from "../../packages/contracts/src/index.js";
import { computeSessionBindingKey, type SessionBinding } from "../../packages/contracts/src/session-binding.js";
import { resolveWorkspaceIdentity } from "../../packages/adapters/sdk/src/identity.js";

describe("CW2-T01 & CW2-T02: 项目资产与工作树迁移、恢复及回退集成测试", () => {
  let tempDir: string;
  let repoDir: string;
  let oldWorktreeDir: string;
  let store: Store;
  let storageRoot: string;
  let service: ProjectAssetMigrationService;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "devflow-mig-rec-"));
    repoDir = join(tempDir, "sample-repo");
    oldWorktreeDir = join(tempDir, "old-worktree");
    storageRoot = join(tempDir, ".devflow-storage");
    const dbPath = join(tempDir, "test.db");
    store = new Store(dbPath);
    service = new ProjectAssetMigrationService(store, storageRoot);

    // 初始化 Git 主仓库
    execFileSync("git", ["init", repoDir]);
    execFileSync("git", ["config", "user.name", "DevFlow Test"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@devflow.local"], { cwd: repoDir });
    writeFileSync(join(repoDir, "README.md"), "# Main Repo\n");
    execFileSync("git", ["add", "README.md"], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "initial commit"], { cwd: repoDir });

    // 创建一个合法的 linked worktree
    execFileSync("git", ["worktree", "add", "-b", "feature-mig", oldWorktreeDir, "HEAD"], { cwd: repoDir });
  });

  afterEach(() => {
    try {
      store.close();
    } catch {}
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("CW2-T01: linked worktree + 两份历史正文真实迁移，copy在旧树且move后target存在，同请求恢复幂等", async () => {
    const workflowId = "wf-mig-001";
    const workspaceId = "ws-mig-001";

    // 准备两份历史正文文件放入平台缓存
    const docCache = join(storageRoot, "documents", workflowId);
    mkdirSync(docCache, { recursive: true });
    writeFileSync(join(docCache, "plan.md"), "# Project Plan Content\nVersion 1\n");
    writeFileSync(join(docCache, "review-1.md"), "# Review Content\nApproved\n");

    // 在 store 中初始化 workspace 与 control
    store.put("workspace", workspaceId, workflowId, {
      id: workspaceId,
      workflow_id: workflowId,
      repo_id: "main",
      source_root: repoDir,
      root: oldWorktreeDir,
      branch: "feature-mig",
      mode: "new_worktree",
      owned: true,
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    store.put("workflow_dispatch_control", workflowId, workflowId, {
      workflow_id: workflowId,
      dispatch_enabled: true,
      reasons: [],
      writer_state: "idle",
      revision: 1,
      updated_at: Date.now(),
    });

    const targetRoot = join(repoDir, ".worktrees", workflowId, "main");

    // 预览
    const preview = service.preview({
      workflowId,
      workspaceId,
      mode: "move_worktree",
      explicitTargetRoot: targetRoot,
    });
    expect(preview.eligible).toBe(true);
    expect(preview.can_move_worktree).toBe(true);
    expect(preview.file_mappings.length).toBe(2);

    // apply 迁移
    const record = await service.apply({
      workflow_id: workflowId,
      workspace_id: workspaceId,
      request_id: "req-mig-001",
      mode: "move_worktree",
      expected_workspace_version: 1,
      expected_preview_digest: preview.preview_digest,
      target_root: targetRoot,
    });

    expect(record.stage).toBe("committed");
    // 验证目标路径已变为有效工作树
    expect(existsSync(targetRoot)).toBe(true);
    expect(existsSync(oldWorktreeDir)).toBe(false);

    // 验证材料两份字节均在正确相对路径
    const planPath = join(targetRoot, "docs", "process", workflowId, "migrated", "plan.md");
    const reviewPath = join(targetRoot, "docs", "process", workflowId, "migrated", "review-1.md");
    expect(existsSync(planPath)).toBe(true);
    expect(readFileSync(planPath, "utf8")).toBe("# Project Plan Content\nVersion 1\n");
    expect(existsSync(reviewPath)).toBe(true);
    expect(readFileSync(reviewPath, "utf8")).toBe("# Review Content\nApproved\n");

    // 验证数据库中工作区 root 已更新
    const updatedWs = store.must<Workspace>("workspace", workspaceId);
    expect(updatedWs.root.toLowerCase()).toBe(targetRoot.toLowerCase());

    // 验证控制调度被暂停并记录 migration 原因
    const updatedControl = store.must<WorkflowDispatchControl>("workflow_dispatch_control", workflowId);
    expect(updatedControl.dispatch_enabled).toBe(false);
    expect(updatedControl.reasons.some((r) => r.reason === "migration")).toBe(true);

    // 恢复测试：同 request_id resume 应当幂等返回已 committed 状态
    const resumed = await service.resume(workflowId, record.id, "req-mig-001");
    expect(resumed.stage).toBe("committed");
    expect(resumed.id).toBe(record.id);
  });

  it("CW2-T02: materials_only 模式不移动工作树根，仅在当前工作树同步材料", async () => {
    const workflowId = "wf-mat-only";
    const workspaceId = "ws-mat-only";

    const docCache = join(storageRoot, "documents", workflowId);
    mkdirSync(docCache, { recursive: true });
    writeFileSync(join(docCache, "plan.md"), "# Materials Only Plan\n");

    // 使用主仓库作为工作区（不可移动的主树）
    store.put("workspace", workspaceId, workflowId, {
      id: workspaceId,
      workflow_id: workflowId,
      repo_id: "main",
      source_root: repoDir,
      root: repoDir,
      branch: "main",
      mode: "existing_workspace",
      owned: false,
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    const preview = service.preview({
      workflowId,
      workspaceId,
      mode: "materials_only",
    });

    expect(preview.eligible).toBe(true);
    expect(preview.target_root.toLowerCase()).toBe(repoDir.toLowerCase());

    const record = await service.apply({
      workflow_id: workflowId,
      workspace_id: workspaceId,
      request_id: "req-mat-001",
      mode: "materials_only",
      expected_workspace_version: 1,
      expected_preview_digest: preview.preview_digest,
    });

    expect(record.stage).toBe("committed");
    // 主树 root 不变
    const ws = store.must<Workspace>("workspace", workspaceId);
    expect(ws.root.toLowerCase()).toBe(repoDir.toLowerCase());
    // 材料已同步至主树
    const planInRepo = join(repoDir, "docs", "process", workflowId, "migrated", "plan.md");
    expect(existsSync(planInRepo)).toBe(true);
    expect(readFileSync(planInRepo, "utf8")).toBe("# Materials Only Plan\n");
  });

  it("CW2-T02: 主树/locked 工作树拒绝 move_worktree 模式，DB 保持不动", async () => {
    const workflowId = "wf-main-refuse";
    const workspaceId = "ws-main-refuse";

    // 对主树尝试 move_worktree 模式
    store.put("workspace", workspaceId, workflowId, {
      id: workspaceId,
      workflow_id: workflowId,
      repo_id: "main",
      source_root: repoDir,
      root: repoDir,
      branch: "main",
      mode: "existing_workspace",
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    const preview = service.preview({
      workflowId,
      workspaceId,
      mode: "move_worktree",
    });

    expect(preview.can_move_worktree).toBe(false);
    expect(preview.eligible).toBe(false);
    expect(preview.conflicts.length).toBeGreaterThan(0);

    // 直接调用 apply 会被拒绝且 DB 不变
    await expect(
      service.apply({
        workflow_id: workflowId,
        workspace_id: workspaceId,
        request_id: "req-main-move",
        mode: "move_worktree",
        expected_workspace_version: 1,
        expected_preview_digest: preview.preview_digest,
      }),
    ).rejects.toThrow(/不满足条件/);

    const ws = store.must<Workspace>("workspace", workspaceId);
    expect(ws.root.toLowerCase()).toBe(repoDir.toLowerCase());
  });

  it("CW2-T02: 目标路径已存在同名冲突时拒绝覆盖并报告冲突", async () => {
    const workflowId = "wf-conflict-001";
    const workspaceId = "ws-conflict-001";

    const docCache = join(storageRoot, "documents", workflowId);
    mkdirSync(docCache, { recursive: true });
    writeFileSync(join(docCache, "plan.md"), "# Conflict Plan\n");

    store.put("workspace", workspaceId, workflowId, {
      id: workspaceId,
      workflow_id: workflowId,
      repo_id: "main",
      source_root: repoDir,
      root: oldWorktreeDir,
      branch: "feature-mig",
      mode: "new_worktree",
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    // 预先在目标路径建立一个目录冲突
    const targetRoot = join(repoDir, ".worktrees", workflowId, "main");
    mkdirSync(targetRoot, { recursive: true });
    writeFileSync(join(targetRoot, "dirty.txt"), "someone wrote here");

    const preview = service.preview({
      workflowId,
      workspaceId,
      mode: "move_worktree",
      explicitTargetRoot: targetRoot,
    });

    expect(preview.eligible).toBe(false);
    expect(preview.conflicts.some((c) => c.includes("目标路径已存在"))).toBe(true);

    await expect(
      service.apply({
        workflow_id: workflowId,
        workspace_id: workspaceId,
        request_id: "req-conflict-apply",
        mode: "move_worktree",
        expected_workspace_version: 1,
        expected_preview_digest: preview.preview_digest,
        target_root: targetRoot,
      }),
    ).rejects.toThrow(/不满足条件/);
  });

  it("CW2-T02: 安全回滚 (rollback) 恢复原路径，但若已有后续 Run 则禁止回滚", async () => {
    const workflowId = "wf-rollback-001";
    const workspaceId = "ws-rollback-001";

    const docCache = join(storageRoot, "documents", workflowId);
    mkdirSync(docCache, { recursive: true });
    writeFileSync(join(docCache, "note.txt"), "Some note");

    store.put("workspace", workspaceId, workflowId, {
      id: workspaceId,
      workflow_id: workflowId,
      repo_id: "main",
      source_root: repoDir,
      root: oldWorktreeDir,
      branch: "feature-mig",
      mode: "new_worktree",
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    const targetRoot = join(repoDir, ".worktrees", workflowId, "main");

    const preview = service.preview({
      workflowId,
      workspaceId,
      mode: "move_worktree",
      explicitTargetRoot: targetRoot,
    });

    const record = await service.apply({
      workflow_id: workflowId,
      workspace_id: workspaceId,
      request_id: "req-roll-001",
      mode: "move_worktree",
      expected_workspace_version: 1,
      expected_preview_digest: preview.preview_digest,
      target_root: targetRoot,
    });

    expect(record.stage).toBe("committed");
    expect(existsSync(targetRoot)).toBe(true);

    // 场景 A: 插入一个后续执行的 Run，模拟迁移后已发生新运行
    const newRun: Run = {
      id: "run-after-mig",
      workflow_id: workflowId,
      profile_id: "p1",
      status: "completed",
      started_at: Date.now() + 1000,
      created_at: Date.now() + 1000,
    } as any;
    store.put("run", newRun.id, workflowId, newRun);

    // 此时回滚应被拒绝
    await expect(service.rollback(workflowId, record.id, "req-roll-001")).rejects.toThrow(/禁止安全回滚/);

    // 场景 B: 清除后续 Run 后，可以安全执行反向 move 与数据库恢复
    store.remove("run", newRun.id);
    const rolled = await service.rollback(workflowId, record.id, "req-roll-001");
    expect(rolled.stage).toBe("rolled_back");

    // 验证路径恢复至 oldWorktreeDir
    expect(existsSync(oldWorktreeDir)).toBe(true);
    const ws = store.must<Workspace>("workspace", workspaceId);
    expect(ws.root.toLowerCase()).toBe(oldWorktreeDir.toLowerCase());
  });

  it("CW4-F04: 两仓库任务移动非主仓库：主 cwd 保持不变，完整 workspace identity 和查询键更新，binding ID/conversation ID 不变", async () => {
    const workflowId = "wf-multi-repo-mig";
    const wsMainId = "ws-multi-main";
    const wsSecId = "ws-multi-sec";

    // 准备两份 workspace
    const wsMain: any = {
      id: wsMainId,
      workflow_id: workflowId,
      repo_id: "main",
      source_root: repoDir,
      root: repoDir,
      branch: "main",
      mode: "existing_workspace",
      owned: false,
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    const wsSec: any = {
      id: wsSecId,
      workflow_id: workflowId,
      repo_id: "secondary",
      source_root: repoDir,
      root: oldWorktreeDir,
      branch: "feature-mig",
      mode: "new_worktree",
      owned: true,
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    store.put("workspace", wsMainId, workflowId, wsMain);
    store.put("workspace", wsSecId, workflowId, wsSec);

    store.put("workflow_dispatch_control", workflowId, workflowId, {
      workflow_id: workflowId,
      dispatch_enabled: true,
      reasons: [],
      writer_state: "idle",
      revision: 1,
      updated_at: Date.now(),
    });

    const initialWorkspaces = [wsMain, wsSec];
    const initialWorkspaceIdentity = resolveWorkspaceIdentity(wsMain.root, initialWorkspaces);

    // 为两个仓库各自创建会话绑定
    const bindingMain: SessionBinding = {
      id: "bind-main-001",
      workflow_id: workflowId,
      adapter_id: "codex",
      host_id: "host-mig-01",
      client_scope_id: "c:/users/test/.codex",
      provider_account_scope: "acc-user-mig",
      canonical_model_id: "gpt-4o",
      workspace_identity: initialWorkspaceIdentity,
      conversation_id: "conv-main-stay",
      workspace_root: repoDir, // 主仓库 cwd
      source_root: repoDir,
      repo_id: "main",
      revision: 1,
      generation: 1,
      state: "bound",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      metadata: {},
    };

    const bindingSec: SessionBinding = {
      id: "bind-sec-002",
      workflow_id: workflowId,
      adapter_id: "codex",
      host_id: "host-mig-01",
      client_scope_id: "c:/users/test/.codex",
      provider_account_scope: "acc-user-mig",
      canonical_model_id: "claude-3-5-sonnet",
      workspace_identity: initialWorkspaceIdentity,
      conversation_id: "conv-sec-move",
      workspace_root: oldWorktreeDir, // 次要仓库 cwd (将被移动)
      source_root: repoDir,
      repo_id: "secondary",
      revision: 1,
      generation: 1,
      state: "bound",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      metadata: {},
    };

    const initialKeyMain = computeSessionBindingKey(bindingMain);
    const initialKeySec = computeSessionBindingKey(bindingSec);

    store.put("session_binding", initialKeyMain, workflowId, bindingMain);
    store.put("session_binding_by_id", bindingMain.id, workflowId, { keyStr: initialKeyMain });
    store.put("session_binding", initialKeySec, workflowId, bindingSec);
    store.put("session_binding_by_id", bindingSec.id, workflowId, { keyStr: initialKeySec });

    const targetSecRoot = join(repoDir, ".worktrees", workflowId, "secondary");

    // 预览移动次要工作树 wsSecId
    const preview = service.preview({
      workflowId,
      workspaceId: wsSecId,
      mode: "move_worktree",
      explicitTargetRoot: targetSecRoot,
    });
    expect(preview.eligible).toBe(true);

    // 执行迁移
    const record = await service.apply({
      workflow_id: workflowId,
      workspace_id: wsSecId,
      request_id: "req-mig-sec-001",
      mode: "move_worktree",
      expected_workspace_version: 1,
      expected_preview_digest: preview.preview_digest,
      target_root: targetSecRoot,
    });
    expect(record.stage).toBe("committed");

    // 计算迁移后预期的全量 workspace_identity
    const migratedWorkspaces = [
      wsMain,
      { ...wsSec, root: targetSecRoot },
    ];
    const expectedNewIdentity = resolveWorkspaceIdentity(wsMain.root, migratedWorkspaces);
    expect(expectedNewIdentity).not.toBe(initialWorkspaceIdentity);

    // 验证主工作区绑定：
    const mainById = store.get<{ keyStr: string }>("session_binding_by_id", bindingMain.id);
    expect(mainById).toBeDefined();
    const updatedBindingMain = store.must<SessionBinding>("session_binding", mainById!.keyStr);
    // 1. 主 cwd 保持不变
    expect(updatedBindingMain.workspace_root).toBe(repoDir);
    expect(updatedBindingMain.source_root).toBe(repoDir);
    // 2. 完整 workspace_identity 更新
    expect(updatedBindingMain.workspace_identity).toBe(expectedNewIdentity);
    // 3. binding ID 与 conversation ID 不变
    expect(updatedBindingMain.id).toBe(bindingMain.id);
    expect(updatedBindingMain.conversation_id).toBe("conv-main-stay");
    // 4. 旧 key 已不存在，新 key 匹配计算出的 key
    expect(store.get("session_binding", initialKeyMain)).toBeUndefined();
    expect(mainById!.keyStr).toBe(computeSessionBindingKey(updatedBindingMain));

    // 验证次工作区绑定：
    const secById = store.get<{ keyStr: string }>("session_binding_by_id", bindingSec.id);
    expect(secById).toBeDefined();
    const updatedBindingSec = store.must<SessionBinding>("session_binding", secById!.keyStr);
    // 1. 移动仓库的 cwd 更新为 targetSecRoot
    expect(updatedBindingSec.workspace_root.toLowerCase()).toBe(targetSecRoot.toLowerCase());
    // 2. 完整 workspace_identity 更新
    expect(updatedBindingSec.workspace_identity).toBe(expectedNewIdentity);
    // 3. binding ID 与 conversation ID 不变
    expect(updatedBindingSec.id).toBe(bindingSec.id);
    expect(updatedBindingSec.conversation_id).toBe("conv-sec-move");

    // 5. 验证安全回滚 (rollback)
    const rolled = await service.rollback(workflowId, record.id, "req-mig-sec-001");
    expect(rolled.stage).toBe("rolled_back");

    // 回滚后主工作区与次工作区绑定均恢复原始 workspace_identity
    const rolledMainById = store.get<{ keyStr: string }>("session_binding_by_id", bindingMain.id);
    const rolledBindingMain = store.must<SessionBinding>("session_binding", rolledMainById!.keyStr);
    expect(rolledBindingMain.workspace_identity).toBe(initialWorkspaceIdentity);
    expect(rolledBindingMain.workspace_root).toBe(repoDir);

    const rolledSecById = store.get<{ keyStr: string }>("session_binding_by_id", bindingSec.id);
    const rolledBindingSec = store.must<SessionBinding>("session_binding", rolledSecById!.keyStr);
    expect(rolledBindingSec.workspace_identity).toBe(initialWorkspaceIdentity);
    expect(rolledBindingSec.workspace_root.toLowerCase()).toBe(oldWorktreeDir.toLowerCase());
  });

  it("CW4-F04: 迁移同步绑定时若目标键已存在不同 binding 则抛出 409 SESSION_BINDING_CONFLICT 拒绝覆盖", async () => {
    const workflowId = "wf-conflict-bind";
    const workspaceId = "ws-conflict-bind";

    store.put("workspace", workspaceId, workflowId, {
      id: workspaceId,
      workflow_id: workflowId,
      repo_id: "main",
      source_root: repoDir,
      root: oldWorktreeDir,
      branch: "feature-mig",
      mode: "new_worktree",
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    store.put("workflow_dispatch_control", workflowId, workflowId, {
      workflow_id: workflowId,
      dispatch_enabled: true,
      reasons: [],
      writer_state: "idle",
      revision: 1,
      updated_at: Date.now(),
    });

    const targetRoot = join(repoDir, ".worktrees", workflowId, "main");

    const currentBinding: SessionBinding = {
      id: "binding-to-move",
      workflow_id: workflowId,
      adapter_id: "codex",
      host_id: "host-1",
      client_scope_id: "c:/users/test/.codex",
      provider_account_scope: "acc-1",
      canonical_model_id: "gpt-4o",
      workspace_identity: resolveWorkspaceIdentity(oldWorktreeDir),
      conversation_id: "conv-move",
      workspace_root: oldWorktreeDir,
      source_root: repoDir,
      repo_id: "main",
      revision: 1,
      generation: 1,
      state: "bound",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      metadata: {},
    };

    const currentKey = computeSessionBindingKey(currentBinding);
    store.put("session_binding", currentKey, workflowId, currentBinding);
    store.put("session_binding_by_id", currentBinding.id, workflowId, { keyStr: currentKey });

    // 预先在目标 key 处放置一个不同 ID 的绑定
    const conflictingBinding: SessionBinding = {
      id: "binding-already-there", // 不同的 binding ID
      workflow_id: workflowId,
      adapter_id: "codex",
      host_id: "host-1",
      client_scope_id: "c:/users/test/.codex",
      provider_account_scope: "acc-1",
      canonical_model_id: "gpt-4o",
      workspace_identity: resolveWorkspaceIdentity(targetRoot),
      conversation_id: "conv-other",
      workspace_root: targetRoot,
      source_root: repoDir,
      repo_id: "main",
      revision: 1,
      generation: 1,
      state: "bound",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      metadata: {},
    };
    const targetKey = computeSessionBindingKey(conflictingBinding);
    store.put("session_binding", targetKey, workflowId, conflictingBinding);

    const preview = service.preview({
      workflowId,
      workspaceId,
      mode: "move_worktree",
      explicitTargetRoot: targetRoot,
    });

    await expect(
      service.apply({
        workflow_id: workflowId,
        workspace_id: workspaceId,
        request_id: "req-conf-bind-1",
        mode: "move_worktree",
        expected_workspace_version: 1,
        expected_preview_digest: preview.preview_digest,
        target_root: targetRoot,
      }),
    ).rejects.toThrow(/目标工作区已有其他会话绑定/);
  });
});
