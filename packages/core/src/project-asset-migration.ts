import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve, normalize, relative, dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { Store } from "../../store/src/store.js";
import { FlowError, requireCondition, type Workspace, type Run, type WorkflowDispatchControl, type SessionBinding } from "../../contracts/src/index.js";
import { computeSessionBindingKey } from "../../contracts/src/session-binding.js";
import { resolveWorktreePath, ensureWorktreeGitExcluded } from "../../git/src/workspace-paths.js";
import { resolveWorkspaceIdentity } from "../../adapters/sdk/src/identity.js";
import { now } from "./util.js";

/**
 * CW4-F04: 统一使用完整工作区映射重算 workspace_identity 与 binding key，保留真实 source_root
 */
function syncWorkspaceBindings(
  store: Store,
  workflowId: string,
  workspaceId: string,
  newRoot: string,
  filterRoot: string,
) {
  const currentWs = store.get<Workspace>("workspace", workspaceId);
  const allWorkspaces = store.list<Workspace>("workspace", workflowId);
  const effectiveWorkspaces = allWorkspaces.map((w) =>
    w.id === workspaceId ? { ...w, root: newRoot } : w,
  );
  const previousWorkspaces = allWorkspaces.map((w) =>
    w.id === workspaceId ? { ...w, root: filterRoot } : w,
  );
  const oldWorkspaceIdentity = resolveWorkspaceIdentity(
    previousWorkspaces[0]?.root || filterRoot,
    previousWorkspaces,
  );
  const newWorkspaceIdentity = resolveWorkspaceIdentity(
    effectiveWorkspaces[0]?.root || newRoot,
    effectiveWorkspaces,
  );

  const bindings = store.list<SessionBinding>("session_binding", workflowId);
  for (const b of bindings) {
    const movesCwd = resolveWorkspaceIdentity(b.workspace_root) === resolveWorkspaceIdentity(filterRoot) ||
      (b as any).workspace_id === workspaceId;
    // 任一仓库移动都会改变完整映射，即使会话的主 cwd 位于另一仓库。
    if (movesCwd || b.workspace_identity === oldWorkspaceIdentity) {
      const oldKey = computeSessionBindingKey(b);
      const updatedBinding: SessionBinding = {
        ...b,
        workspace_identity: newWorkspaceIdentity,
        workspace_root: movesCwd ? newRoot : b.workspace_root,
        source_root: movesCwd ? currentWs?.source_root ?? b.source_root : b.source_root,
        revision: b.revision + 1,
        updated_at: now(),
      };
      const newKey = computeSessionBindingKey(updatedBinding);
      const targetBinding = store.get<SessionBinding>("session_binding", newKey);
      requireCondition(
        !targetBinding || targetBinding.id === b.id,
        "SESSION_BINDING_CONFLICT",
        "目标工作区已有其他会话绑定，保留原会话等待处理",
        409,
      );
      if (oldKey !== newKey) {
        store.remove("session_binding", oldKey);
      }
      store.put("session_binding", newKey, workflowId, updatedBinding);
      store.put("session_binding_by_id", b.id, workflowId, { keyStr: newKey });
    }
  }
}

export interface MaterialFileMapping {
  file_id: string;
  source_path: string;
  target_relative_path: string;
  copy_destination: string;
  final_destination: string;
  bytes: number;
  hash: string;
  source_kind: "plan" | "review" | "repair" | "process" | "evidence" | "other";
  status: "ready" | "reusable" | "conflict";
  conflict_reason?: string;
}

export interface ProjectAssetMigrationPreview {
  workflow_id: string;
  workspace_id: string;
  mode: "materials_only" | "move_worktree";
  source_root: string;
  current_root: string;
  target_root: string;
  preview_digest: string;
  expected_workspace_version: number;
  control_revision: number;
  is_linked_worktree: boolean;
  can_move_worktree: boolean;
  writer_state: "idle" | "active" | "unknown";
  file_mappings: MaterialFileMapping[];
  conflicts: string[];
  eligible: boolean;
}

export interface ApplyProjectAssetMigrationInput {
  workflow_id: string;
  workspace_id: string;
  request_id: string;
  mode?: "materials_only" | "move_worktree";
  expected_workspace_version: number;
  expected_control_revision?: number;
  expected_preview_digest: string;
  selected_material_ids?: string[];
  target_root?: string;
}

export interface ProjectAssetMigrationRecord {
  id: string;
  workflow_id: string;
  workspace_id: string;
  request_id: string;
  mode: "materials_only" | "move_worktree";
  source_root: string;
  initial_root: string;
  target_root: string;
  stage: "prepared" | "backed_up" | "materials_copied" | "worktree_moved" | "verified" | "committed" | "rolled_back";
  preview_digest: string;
  backup_dir?: string;
  files: MaterialFileMapping[];
  created_at: string;
  updated_at: string;
}

function computeFileSha256(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

function scanDirectoryFiles(dir: string, baseDir: string = dir): Array<{ absPath: string; relPath: string; bytes: number; hash: string }> {
  if (!existsSync(dir)) return [];
  const results: Array<{ absPath: string; relPath: string; bytes: number; hash: string }> = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...scanDirectoryFiles(full, baseDir));
    } else if (entry.isFile()) {
      const stats = statSync(full);
      results.push({
        absPath: full,
        relPath: relative(baseDir, full).replaceAll("\\", "/"),
        bytes: stats.size,
        hash: computeFileSha256(full),
      });
    }
  }
  return results;
}

export class ProjectAssetMigrationService {
  constructor(
    private store: Store,
    private storageRoot: string = ".devflow",
  ) {}

  /**
   * 只读预览指定 workflow 与 workspace 的资产与工作树迁移 (CW2-D02)
   */
  preview(options: {
    workflowId: string;
    workspaceId: string;
    mode?: "materials_only" | "move_worktree";
    explicitTargetRoot?: string;
  }): ProjectAssetMigrationPreview {
    const { workflowId, workspaceId, explicitTargetRoot } = options;
    const mode = options.mode ?? "move_worktree";

    const ws = this.store
      .list<Workspace>("workspace", workflowId)
      .find((w) => w.id === workspaceId);
    requireCondition(ws, "WORKSPACE_NOT_FOUND", `未找到工作区: ${workspaceId}`, 404);

    const normCurrentRoot = normalize(resolve(ws.root));
    const sourceRoot = ws.source_root ? normalize(resolve(ws.source_root)) : normCurrentRoot;

    // 检查控制开关与写者状态
    const control = this.store.get<WorkflowDispatchControl>("workflow_dispatch_control", workflowId);
    const controlRevision = control?.revision ?? 1;

    const activeRuns = this.store
      .list<Run>("run", workflowId)
      .filter((r) => r.status === "running");
    const activeDispatches = this.store
      .list<any>("cli_dispatch_record", workflowId)
      .filter((d: any) => ["starting", "running", "stopping"].includes(d.state));

    let writerState: "idle" | "active" | "unknown" = "idle";
    if (activeRuns.length > 0 || activeDispatches.length > 0) {
      writerState = "active";
    } else if (control?.writer_state && control.writer_state !== "idle") {
      writerState = control.writer_state;
    }

    // 检查是否为可移动的 linked worktree
    let isLinkedWorktree = false;
    let canMoveWorktree = false;
    let moveBlockReason: string | undefined;

    try {
      const output = execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: sourceRoot,
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const entries = output.split(/\r?\n\r?\n/);
      // 第一项为主工作树，其余为 linked
      const matched = entries.slice(1).find((e) => {
        const lines = e.split(/\r?\n/);
        const pathLine = lines.find((l) => l.startsWith("worktree "));
        if (!pathLine) return false;
        const entryPath = normalize(resolve(pathLine.replace(/^worktree\s+/, "").trim()));
        return entryPath.toLowerCase() === normCurrentRoot.toLowerCase();
      });
      if (matched) {
        isLinkedWorktree = true;
        if (matched.includes("locked")) {
          moveBlockReason = "工作树已被 Git 锁定 (locked)";
        } else {
          canMoveWorktree = true;
        }
      } else {
        moveBlockReason = "当前目录不是可移动的 Git 登记 linked worktree（可能为主工作树）";
      }
    } catch {
      moveBlockReason = "非 Git 仓库或无法执行 Git 命令";
    }

    const conflicts: string[] = [];

    // 若请求 move_worktree 但不能移动，记录冲突
    if (mode === "move_worktree" && !canMoveWorktree) {
      conflicts.push(moveBlockReason || "工作树不支持 Git 移动操作");
    }

    // 目标路径解析
    const targetRoot = mode === "materials_only"
      ? normCurrentRoot
      : (explicitTargetRoot
          ? normalize(resolve(explicitTargetRoot))
          : resolveWorktreePath({
              sourceRoot,
              workflowId,
              repoId: ws.repo_id,
            }));

    // CW2-F01 关键保护：若为 move 模式且目标目录已存在不同于当前根的目录，必须阻断
    if (
      mode === "move_worktree" &&
      normCurrentRoot.toLowerCase() !== targetRoot.toLowerCase() &&
      existsSync(targetRoot)
    ) {
      conflicts.push(`目标路径已存在，Git 移动前目标目录必须为空: ${targetRoot}`);
    }

    // 清点平台历史 documents 目录中该任务的专有文件
    const docCacheDir = join(this.storageRoot, "documents", workflowId);
    const scannedFiles = scanDirectoryFiles(docCacheDir);

    const fileMappings: MaterialFileMapping[] = [];
    const targetRelSet = new Map<string, string>();

    const intermediateRoot = mode === "move_worktree" ? normCurrentRoot : targetRoot;

    for (let i = 0; i < scannedFiles.length; i++) {
      const f = scannedFiles[i]!;
      const targetRel = join("docs", "process", workflowId, "migrated", f.relPath).replaceAll("\\", "/");
      const copyDest = normalize(resolve(intermediateRoot, targetRel));
      const finalDest = normalize(resolve(targetRoot, targetRel));

      let status: MaterialFileMapping["status"] = "ready";
      let conflictReason: string | undefined;

      if (targetRelSet.has(targetRel)) {
        status = "conflict";
        conflictReason = `多个来源文件映射至相同目标: ${targetRel}`;
        conflicts.push(conflictReason);
      } else {
        targetRelSet.set(targetRel, f.absPath);
      }

      // CW3-F08 预检两端：1. 预检中间复制目标 copyDest (旧树对应位置)
      if (existsSync(copyDest)) {
        try {
          const copyHash = computeFileSha256(copyDest);
          if (copyHash === f.hash) {
            status = "reusable";
          } else {
            status = "conflict";
            conflictReason = `旧树中间写入位置已存在异内容原件，禁止覆盖: ${copyDest}`;
            conflicts.push(conflictReason);
          }
        } catch {
          status = "conflict";
          conflictReason = `中间目标状态无法访问: ${copyDest}`;
          conflicts.push(conflictReason);
        }
      }

      // CW3-F08 预检两端：2. 预检最终目标 finalDest (新 target 对应位置)
      if (finalDest.toLowerCase() !== copyDest.toLowerCase() && existsSync(finalDest)) {
        try {
          const destHash = computeFileSha256(finalDest);
          if (destHash === f.hash) {
            if (status !== "conflict") status = "reusable";
          } else {
            status = "conflict";
            conflictReason = `最终目标文件已存在且字节不一致: ${finalDest}`;
            conflicts.push(conflictReason);
          }
        } catch {
          status = "conflict";
          conflictReason = `最终目标文件状态无法访问: ${finalDest}`;
          conflicts.push(conflictReason);
        }
      }

      fileMappings.push({
        file_id: `file_${i}_${createHash("md5").update(f.relPath).digest("hex").slice(0, 8)}`,
        source_path: f.absPath,
        target_relative_path: targetRel,
        copy_destination: copyDest,
        final_destination: finalDest,
        bytes: f.bytes,
        hash: f.hash,
        source_kind: f.relPath.includes("review") ? "review" : f.relPath.includes("repair") ? "repair" : "plan",
        status,
        conflict_reason: conflictReason,
      });
    }

    const previewDigest = createHash("sha256")
      .update(
        JSON.stringify([
          workflowId,
          workspaceId,
          mode,
          normCurrentRoot,
          targetRoot,
          controlRevision,
          fileMappings.map((m) => [m.file_id, m.hash, m.copy_destination, m.final_destination]),
        ]),
      )
      .digest("hex");

    const eligible =
      conflicts.length === 0 &&
      writerState === "idle" &&
      (mode === "materials_only" ? fileMappings.length > 0 : canMoveWorktree);

    return {
      workflow_id: workflowId,
      workspace_id: workspaceId,
      mode,
      source_root: sourceRoot,
      current_root: normCurrentRoot,
      target_root: targetRoot,
      preview_digest: previewDigest,
      expected_workspace_version: (ws as any).version ?? 1,
      control_revision: controlRevision,
      is_linked_worktree: isLinkedWorktree,
      can_move_worktree: canMoveWorktree,
      writer_state: writerState,
      file_mappings: fileMappings,
      conflicts,
      eligible,
    };
  }

  /**
   * 应用资产迁移与工作树移动（带检查点阶段推进与真实备份）(CW2-D02)
   */
  async apply(input: ApplyProjectAssetMigrationInput): Promise<ProjectAssetMigrationRecord> {
    const workflowId = input.workflow_id;
    const workspaceId = input.workspace_id;
    const { request_id } = input;
    const mode = input.mode ?? "move_worktree";

    // 幂等查询：同 request_id 先查是否有既有记录 (CW3-F10: 异正文同 request 报错冲突)
    const existingMigration = this.store
      .list<ProjectAssetMigrationRecord>("project_asset_migration", workflowId)
      .find((m) => m.request_id === request_id);
    if (existingMigration) {
      if (
        existingMigration.workspace_id !== workspaceId ||
        existingMigration.mode !== mode ||
        (input.target_root && normalize(resolve(existingMigration.target_root)) !== normalize(resolve(input.target_root))) ||
        (input.expected_preview_digest && existingMigration.preview_digest !== input.expected_preview_digest)
      ) {
        throw new FlowError(
          "REQUEST_ID_CONFLICT",
          `同 request_id (${request_id}) 已存在但请求参数不一致`,
          409,
        );
      }
      return existingMigration;
    }

    // 重新运行最新权威预览并校验 digest
    const preview = this.preview({
      workflowId,
      workspaceId,
      mode,
      explicitTargetRoot: input.target_root,
    });
    requireCondition(preview.eligible, "MIGRATION_NOT_ELIGIBLE", `当前资产迁移存在冲突或不满足条件: ${preview.conflicts.join("; ")}`, 422);

    if (input.expected_preview_digest) {
      requireCondition(
        preview.preview_digest === input.expected_preview_digest,
        "MIGRATION_STALE",
        "迁移预览已过期，请刷新预览后重试",
        409,
      );
    }

    if (input.expected_workspace_version !== undefined) {
      requireCondition(
        preview.expected_workspace_version === input.expected_workspace_version,
        "WORKSPACE_VERSION_CONFLICT",
        `工作区版本冲突: 期望 v${input.expected_workspace_version}, 实际 v${preview.expected_workspace_version}`,
        409,
      );
    }

    if (input.expected_control_revision !== undefined) {
      requireCondition(
        preview.control_revision === input.expected_control_revision,
        "CONTROL_REVISION_CONFLICT",
        `控制版本冲突: 期望 r${input.expected_control_revision}, 实际 r${preview.control_revision}`,
        409,
      );
    }

    requireCondition(
      preview.writer_state === "idle",
      "WRITER_ACTIVE",
      `当前写者非空闲 (状态: ${preview.writer_state})，禁止资产迁移`,
      409,
    );

    // CW3-F10: 过滤用户选择的材料，空数组 [] 明确表示不选择任何材料，禁止默认全选；拒绝重复材料 ID
    let activeFiles: MaterialFileMapping[];
    if (input.selected_material_ids !== undefined) {
      const seen = new Set<string>();
      for (const id of input.selected_material_ids) {
        if (seen.has(id)) {
          throw new FlowError("DUPLICATE_MATERIAL_ID", `重复指定的材料 ID: ${id}`, 400);
        }
        seen.add(id);
        requireCondition(
          preview.file_mappings.some((f) => f.file_id === id),
          "INVALID_MATERIAL_ID",
          `未知的材料 ID: ${id}`,
          400,
        );
      }
      activeFiles = preview.file_mappings.filter((f) => seen.has(f.file_id));
    } else {
      activeFiles = preview.file_mappings;
    }

    const migrationId = `mig_${Date.now()}_${createHash("md5").update(request_id).digest("hex").slice(0, 8)}`;

    // 1. prepared 阶段：增加 migration 控制原因并保存记录
    const backupSubtreeRel = `docs/process/${workflowId}/migration-backup/${migrationId}`;
    const backupDir = join(preview.source_root, backupSubtreeRel);

    // CW3-F09: 在备份写入前，精确在 Git exclude 中登记备份排除目录
    try {
      const excludeFile = join(preview.source_root, ".git", "info", "exclude");
      if (existsSync(join(preview.source_root, ".git"))) {
        mkdirSync(dirname(excludeFile), { recursive: true });
        const existingRules = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
        if (!existingRules.includes(`docs/process/${workflowId}/migration-backup`)) {
          writeFileSync(
            excludeFile,
            `${existingRules}\n# DevFlow asset migration backup\ndocs/process/${workflowId}/migration-backup/\n`,
            "utf8",
          );
        }
      }
    } catch {}

    // 阻止业务派发 (CW2-D04 / §5.2 prepared 阶段规范)
    const currentControl = this.store.get<WorkflowDispatchControl>("workflow_dispatch_control", workflowId);
    const existingReasons = currentControl?.reasons ?? [];
    const updatedReasons = [
      ...existingReasons.filter((r) => r.reason !== "migration"),
      {
        reason: "migration" as const,
        request_id,
        migration_id: migrationId,
        created_at: now(),
        message: "资产迁移进行中",
      },
    ];
    this.store.put("workflow_dispatch_control", workflowId, workflowId, {
      workflow_id: workflowId,
      revision: (currentControl?.revision ?? 1) + 1,
      dispatch_enabled: false,
      writer_state: currentControl?.writer_state ?? "idle",
      reasons: updatedReasons,
      updated_at: now(),
    });

    const record: ProjectAssetMigrationRecord = {
      id: migrationId,
      workflow_id: workflowId,
      workspace_id: workspaceId,
      request_id,
      mode,
      source_root: preview.source_root,
      initial_root: preview.current_root,
      target_root: preview.target_root,
      stage: "prepared",
      preview_digest: preview.preview_digest,
      backup_dir: backupDir,
      files: activeFiles,
      created_at: now(),
      updated_at: now(),
    };
    this.store.put("project_asset_migration", migrationId, workflowId, record);

    // 2. backed_up 阶段：真实备份 SQLite 数据库及原工作树重要数据
    mkdirSync(backupDir, { recursive: true });

    // CW3-F09: SQLite 一致性 backup，任何失败停留在原阶段，删掉主文件直接拷贝兜底
    const dbBackupPath = join(backupDir, "store.db");
    if (typeof (this.store as any).db?.backup === "function") {
      try {
        await (this.store as any).db.backup(dbBackupPath);
      } catch (err: any) {
        throw new FlowError("BACKUP_FAILED", `SQLite 数据库备份失败: ${err.message}`, 500);
      }
    } else {
      throw new FlowError("BACKUP_UNSUPPORTED", "SQLite 引擎不支持一致性备份 API", 500);
    }
    requireCondition(
      existsSync(dbBackupPath) && statSync(dbBackupPath).size > 0,
      "BACKUP_FAILED",
      "SQLite 备份文件生成异常或为空",
      500,
    );

    // 保全选中的工作树材料文件
    for (const m of activeFiles) {
      if (existsSync(m.source_path)) {
        const fileBackupTarget = join(backupDir, "files", m.target_relative_path);
        mkdirSync(dirname(fileBackupTarget), { recursive: true });
        copyFileSync(m.source_path, fileBackupTarget);
      }
    }

    // 写入清单文件
    const manifest = {
      migration_id: migrationId,
      workspace_id: workspaceId,
      mode,
      source_root: preview.source_root,
      initial_root: preview.current_root,
      target_root: preview.target_root,
      files: activeFiles,
      db_backup: dbBackupPath,
      backed_up_at: now(),
    };
    writeFileSync(join(backupDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

    // 校验备份完整性 (CW2-F02)
    requireCondition(
      existsSync(join(backupDir, "manifest.json")),
      "BACKUP_MANIFEST_MISSING",
      "迁移备份清单创建失败",
    );

    record.stage = "backed_up";
    record.updated_at = now();
    this.store.put("project_asset_migration", migrationId, workflowId, record);

    // 3. materials_copied 阶段：逐文件原子 no-replace 写入材料
    // CW2-F01 & CW3-F08: move_worktree 模式下写中间位置 copy_destination (旧工作树)
    for (const m of activeFiles) {
      if (m.status === "reusable") continue;
      const copyDest = m.copy_destination;
      const tempDest = `${copyDest}.tmp-${migrationId}`;
      mkdirSync(dirname(copyDest), { recursive: true });
      copyFileSync(m.source_path, tempDest);
      const copiedHash = computeFileSha256(tempDest);
      requireCondition(
        copiedHash === m.hash,
        "MATERIAL_COPY_CORRUPTED",
        `复制文件哈希校验失败: ${m.source_path}`,
      );

      // CW3-F08 原子 no-replace 独占发布：若目标已存在异内容，拒绝覆盖
      if (existsSync(copyDest)) {
        const existingHash = computeFileSha256(copyDest);
        if (existingHash !== m.hash) {
          try { unlinkSync(tempDest); } catch {}
          throw new FlowError(
            "TARGET_FILE_CONFLICT",
            `目标文件已存在异内容，禁止覆盖: ${copyDest}`,
            409,
          );
        }
      } else {
        writeFileSync(copyDest, readFileSync(tempDest));
      }
      try {
        unlinkSync(tempDest);
      } catch {}
    }
    record.stage = "materials_copied";
    record.updated_at = now();
    this.store.put("project_asset_migration", migrationId, workflowId, record);

    // 4. worktree_moved 阶段：执行真正的 Git worktree move
    if (mode === "move_worktree" && preview.current_root.toLowerCase() !== preview.target_root.toLowerCase()) {
      ensureWorktreeGitExcluded(preview.source_root);
      requireCondition(
        !existsSync(preview.target_root),
        "TARGET_DIRECTORY_EXISTS",
        `Git 移动前目标目录必须不存在: ${preview.target_root}`,
        409,
      );
      mkdirSync(dirname(preview.target_root), { recursive: true });
      try {
        execFileSync("git", ["worktree", "move", preview.current_root, preview.target_root], {
          cwd: preview.source_root,
          encoding: "utf8",
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
        record.stage = "worktree_moved";
        record.updated_at = now();
        this.store.put("project_asset_migration", migrationId, workflowId, record);
      } catch (err: any) {
        throw new FlowError(
          "GIT_WORKTREE_MOVE_FAILED",
          `Git 工作树移动失败: ${err.stderr || err.message}`,
          422,
        );
      }
    }

    // 5. verified 阶段：核验移动后的工作树目录与材料
    const activeRoot = mode === "move_worktree" ? preview.target_root : preview.current_root;
    requireCondition(existsSync(activeRoot), "MIGRATION_VERIFY_FAILED", "迁移后工作区目录不存在");
    for (const m of activeFiles) {
      const checkPath = normalize(resolve(activeRoot, m.target_relative_path));
      requireCondition(
        existsSync(checkPath),
        "MIGRATION_FILE_MISSING",
        `迁移后核验文件缺失: ${checkPath}`,
      );
      const h = computeFileSha256(checkPath);
      requireCondition(
        h === m.hash,
        "MIGRATION_FILE_HASH_MISMATCH",
        `迁移后核验文件哈希不一致: ${checkPath}`,
      );
    }
    record.stage = "verified";
    record.updated_at = now();
    this.store.put("project_asset_migration", migrationId, workflowId, record);

    // 6. committed 阶段：同步事务 CAS 更新 Workspace、绑定、材料引用与解除控制原因 (CW3-F10)
    this.store.transaction(() => {
      const currentWs = this.store.must<Workspace>("workspace", workspaceId);
      if (input.expected_workspace_version !== undefined) {
        requireCondition(
          (currentWs as any).version === input.expected_workspace_version ||
            (currentWs as any).version === undefined,
          "WORKSPACE_VERSION_CONFLICT",
          `工作区版本冲突: 期望 v${input.expected_workspace_version}, 当前 v${(currentWs as any).version}`,
          409,
        );
      }

      if (mode === "move_worktree") {
        const nextWsVersion = ((currentWs as any).version ?? 1) + 1;
        this.store.put("workspace", workspaceId, workflowId, {
          ...currentWs,
          root: preview.target_root,
          version: nextWsVersion,
          updated_at: now(),
        });

        // CW3-F10 / CW4-F04: 同步迁移该工作区关联的会话绑定并重算真实 workspace_identity 与 key
        syncWorkspaceBindings(
          this.store,
          workflowId,
          workspaceId,
          preview.target_root,
          preview.current_root,
        );

        // CW3-F10: 同步更新材料的绝对路径
        const materials = this.store.list<any>("project_material", workflowId);
        for (const mat of materials) {
          if (mat.workspace_id === workspaceId) {
            const newAbs = normalize(resolve(preview.target_root, mat.path));
            this.store.put("project_material", mat.id, workflowId, {
              ...mat,
              workspace_root: preview.target_root,
              absolute_path: newAbs,
              updated_at: now(),
            });
          }
        }
      }

      record.stage = "committed";
      record.updated_at = now();
      this.store.put("project_asset_migration", migrationId, workflowId, record);
    });

    return record;
  }

  /**
   * 恢复未完成的迁移操作 (CW2-D02 / CW3-F07: 严格按阶段推进器补齐步骤，核验 workflow 归属)
   */
  async resume(
    workflowId: string,
    migrationId: string,
    requestId: string,
  ): Promise<ProjectAssetMigrationRecord> {
    const record = this.store.must<ProjectAssetMigrationRecord>("project_asset_migration", migrationId);
    requireCondition(
      record.workflow_id === workflowId,
      "WORKFLOW_MISMATCH",
      `迁移记录归属工作流 (${record.workflow_id}) 与请求工作流 (${workflowId}) 不一致`,
      403,
    );
    requireCondition(
      record.request_id === requestId,
      "REQUEST_ID_MISMATCH",
      "请求 ID 与迁移记录不匹配",
      409,
    );

    if (record.stage === "committed") {
      return record;
    }

    const backupDir =
      record.backup_dir ??
      join(record.source_root, "docs", "process", workflowId, "migration-backup", migrationId);

    // 阶段 1 -> 2: 若卡在 prepared，补全备份
    if (record.stage === "prepared") {
      mkdirSync(backupDir, { recursive: true });
      const dbBackupPath = join(backupDir, "store.db");
      if (typeof (this.store as any).db?.backup === "function") {
        try {
          await (this.store as any).db.backup(dbBackupPath);
        } catch (err: any) {
          throw new FlowError("BACKUP_FAILED", `SQLite 数据库恢复备份失败: ${err.message}`, 500);
        }
      } else {
        throw new FlowError("BACKUP_UNSUPPORTED", "SQLite 引擎不支持一致性备份 API", 500);
      }
      requireCondition(
        existsSync(dbBackupPath) && statSync(dbBackupPath).size > 0,
        "BACKUP_FAILED",
        "SQLite 备份文件生成异常或为空",
        500,
      );

      for (const m of record.files) {
        if (existsSync(m.source_path)) {
          const fileBackupTarget = join(backupDir, "files", m.target_relative_path);
          mkdirSync(dirname(fileBackupTarget), { recursive: true });
          copyFileSync(m.source_path, fileBackupTarget);
        }
      }

      const manifest = {
        migration_id: migrationId,
        workspace_id: record.workspace_id,
        mode: record.mode,
        source_root: record.source_root,
        initial_root: record.initial_root,
        target_root: record.target_root,
        files: record.files,
        db_backup: dbBackupPath,
        backed_up_at: now(),
      };
      writeFileSync(join(backupDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
      record.stage = "backed_up";
      record.backup_dir = backupDir;
      record.updated_at = now();
      this.store.put("project_asset_migration", migrationId, workflowId, record);
    }

    // 阶段 2 -> 3: 若卡在 backed_up，补全材料写入
    if (record.stage === "backed_up") {
      for (const m of record.files) {
        if (m.status === "reusable") continue;
        const copyDest = m.copy_destination || normalize(resolve(record.initial_root, m.target_relative_path));
        const tempDest = `${copyDest}.tmp-${migrationId}`;
        mkdirSync(dirname(copyDest), { recursive: true });
        copyFileSync(m.source_path, tempDest);
        const copiedHash = computeFileSha256(tempDest);
        requireCondition(
          copiedHash === m.hash,
          "MATERIAL_COPY_CORRUPTED",
          `复制文件哈希校验失败: ${m.source_path}`,
        );
        if (existsSync(copyDest)) {
          const existingHash = computeFileSha256(copyDest);
          if (existingHash !== m.hash) {
            try { unlinkSync(tempDest); } catch {}
            throw new FlowError(
              "TARGET_FILE_CONFLICT",
              `目标文件已存在异内容，禁止覆盖: ${copyDest}`,
              409,
            );
          }
        } else {
          writeFileSync(copyDest, readFileSync(tempDest));
        }
        try { unlinkSync(tempDest); } catch {}
      }
      record.stage = "materials_copied";
      record.updated_at = now();
      this.store.put("project_asset_migration", migrationId, workflowId, record);
    }

    // 阶段 3 -> 4: 若卡在 materials_copied，执行移动
    if (record.stage === "materials_copied") {
      let isAlreadyMoved = false;
      try {
        const output = execFileSync("git", ["worktree", "list", "--porcelain"], {
          cwd: record.source_root,
          encoding: "utf8",
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
        const entries = output.split(/\r?\n\r?\n/);
        isAlreadyMoved = entries.some((e) => {
          const lines = e.split(/\r?\n/);
          const pathLine = lines.find((l) => l.startsWith("worktree "));
          if (!pathLine) return false;
          const entryPath = normalize(resolve(pathLine.replace(/^worktree\s+/, "").trim()));
          return entryPath.toLowerCase() === record.target_root.toLowerCase();
        });
      } catch {}

      if (record.mode === "move_worktree" && !isAlreadyMoved) {
        requireCondition(
          existsSync(record.initial_root),
          "INITIAL_ROOT_MISSING",
          `原工作树目录已不存在: ${record.initial_root}`,
          409,
        );
        requireCondition(
          !existsSync(record.target_root),
          "TARGET_DIRECTORY_EXISTS",
          `移动目标目录已存在: ${record.target_root}`,
          409,
        );
        mkdirSync(dirname(record.target_root), { recursive: true });
        execFileSync("git", ["worktree", "move", record.initial_root, record.target_root], {
          cwd: record.source_root,
          encoding: "utf8",
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      }
      record.stage = "worktree_moved";
      record.updated_at = now();
      this.store.put("project_asset_migration", migrationId, workflowId, record);
    }

    // 阶段 4 -> 5: verified 核验
    if (record.stage === "worktree_moved") {
      const activeRoot = record.mode === "move_worktree" ? record.target_root : record.initial_root;
      requireCondition(existsSync(activeRoot), "MIGRATION_VERIFY_FAILED", "迁移后工作区目录不存在");
      for (const m of record.files) {
        const checkPath = normalize(resolve(activeRoot, m.target_relative_path));
        requireCondition(
          existsSync(checkPath),
          "MIGRATION_FILE_MISSING",
          `迁移后核验文件缺失: ${checkPath}`,
        );
        const h = computeFileSha256(checkPath);
        requireCondition(
          h === m.hash,
          "MIGRATION_FILE_HASH_MISMATCH",
          `迁移后核验文件哈希不一致: ${checkPath}`,
        );
      }
      record.stage = "verified";
      record.updated_at = now();
      this.store.put("project_asset_migration", migrationId, workflowId, record);
    }

    // 阶段 5 -> 6: committed 事务提交
    if (record.stage === "verified") {
      this.store.transaction(() => {
        const currentWs = this.store.must<Workspace>("workspace", record.workspace_id);
        if (record.mode === "move_worktree") {
          const nextWsVersion = ((currentWs as any).version ?? 1) + 1;
          this.store.put("workspace", record.workspace_id, workflowId, {
            ...currentWs,
            root: record.target_root,
            version: nextWsVersion,
            updated_at: now(),
          });

          // CW4-F04: 同步迁移会话绑定并重算真实 workspace_identity 与 key
          syncWorkspaceBindings(
            this.store,
            workflowId,
            record.workspace_id,
            record.target_root,
            record.initial_root,
          );

          // 同步更新材料绝对路径
          const materials = this.store.list<any>("project_material", workflowId);
          for (const mat of materials) {
            if (mat.workspace_id === record.workspace_id) {
              const newAbs = normalize(resolve(record.target_root, mat.path));
              this.store.put("project_material", mat.id, workflowId, {
                ...mat,
                workspace_root: record.target_root,
                absolute_path: newAbs,
                updated_at: now(),
              });
            }
          }
        }

        record.stage = "committed";
        record.updated_at = now();
        this.store.put("project_asset_migration", migrationId, workflowId, record);
      });
    }

    return record;
  }

  /**
   * 安全回滚已执行的迁移 (CW2-D02 / CW3-F07: 核验 workflow 归属、无后续使用、事务恢复)
   */
  async rollback(
    workflowId: string,
    migrationId: string,
    requestId: string,
  ): Promise<ProjectAssetMigrationRecord> {
    const record = this.store.must<ProjectAssetMigrationRecord>("project_asset_migration", migrationId);
    requireCondition(
      record.workflow_id === workflowId,
      "WORKFLOW_MISMATCH",
      `迁移记录归属工作流 (${record.workflow_id}) 与请求工作流 (${workflowId}) 不一致`,
      403,
    );
    requireCondition(record.request_id === requestId, "REQUEST_ID_MISMATCH", "请求 ID 不匹配", 409);
    requireCondition(record.stage !== "rolled_back", "ALREADY_ROLLED_BACK", "该迁移记录已经回滚", 409);
    requireCondition(record.stage === "committed", "INVALID_ROLLBACK_STAGE", "只能回滚已 committed 的迁移", 409);

    // 检查迁移完成后是否有后续 Run 使用该工作区
    const runs = this.store.list<Run>("run", record.workflow_id);
    const recordTime = new Date(record.updated_at).getTime();
    const subsequentRuns = runs.filter((r) => {
      const rawTime = (r as any).created_at ?? r.started_at;
      if (!rawTime) return false;
      const runTime = typeof rawTime === "number" ? rawTime : new Date(rawTime).getTime();
      return runTime > recordTime;
    });
    requireCondition(
      subsequentRuns.length === 0,
      "CANNOT_ROLLBACK_AFTER_NEW_RUNS",
      "迁移后已发生新的执行 Run，禁止安全回滚",
      409,
    );

    // 若曾移动过工作树，执行反向 move
    if (record.mode === "move_worktree" && existsSync(record.target_root)) {
      requireCondition(
        !existsSync(record.initial_root),
        "INITIAL_ROOT_OCCUPIED",
        `回滚目标位置已存在文件或目录: ${record.initial_root}`,
        409,
      );
      execFileSync("git", ["worktree", "move", record.target_root, record.initial_root], {
        cwd: record.source_root,
        encoding: "utf8",
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    }

    this.store.transaction(() => {
      const currentWs = this.store.must<Workspace>("workspace", record.workspace_id);
      const nextWsVersion = ((currentWs as any).version ?? 1) + 1;
      this.store.put("workspace", record.workspace_id, record.workflow_id, {
        ...currentWs,
        root: record.initial_root,
        version: nextWsVersion,
        updated_at: now(),
      });

      // CW4-F04: 同步回滚会话绑定并重算真实 workspace_identity 与 key
      syncWorkspaceBindings(
        this.store,
        record.workflow_id,
        record.workspace_id,
        record.initial_root,
        record.target_root,
      );

      // 同步回滚材料绝对路径
      const materials = this.store.list<any>("project_material", record.workflow_id);
      for (const mat of materials) {
        if (mat.workspace_id === record.workspace_id) {
          const origAbs = normalize(resolve(record.initial_root, mat.path));
          this.store.put("project_material", mat.id, record.workflow_id, {
            ...mat,
            workspace_root: record.initial_root,
            absolute_path: origAbs,
            updated_at: now(),
          });
        }
      }

      record.stage = "rolled_back";
      record.updated_at = now();
      this.store.put("project_asset_migration", migrationId, record.workflow_id, record);
    });

    return record;
  }
}
