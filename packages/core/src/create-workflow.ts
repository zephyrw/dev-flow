import { TaskNameSchema } from "../../contracts/src/task-name.js";
import { captureInitialState } from "../../git/src/initial-state.js";
import { resolveWorktreePath, ensureWorktreeGitExcluded, sameWorkspacePath, canonicalWorkspacePath } from "../../git/src/workspace-paths.js";
import { canonicalGitPath, sameGitDirectory } from "../../git/src/git.js";
import { getDefaultTemplate } from "./templates/default-template.js";
import type { Store } from "../../store/src/store.js";
import type { Config } from "../../contracts/src/config.js";
import {
  ProjectSchema,
  Id,
  FlowError,
  requireCondition,
  RoleOverridesSchema,
  ToolProfileSchema,
  inheritRoleOverrides,
  specMode,
  type RoleOverrides,
  type ToolProfile,
  type Workflow,
  type Workspace,
  type WorkspaceReference,
  type Project,
} from "../../contracts/src/index.js";
import { WorkspaceReferenceSchema } from "../../contracts/src/feedback.js";
import { ExecutionSpecSchema } from "../../contracts/src/execution-spec.js";
import { resolveProfile } from "./run-profile.js";
import {
  executorProfileFromConfig,
  ModelDefaultsService,
  plannerProfileFromConfig,
} from "./model-defaults-service.js";
import { assertProfilesVerified, collectExplicitProfiles } from "./access-guard.js";
import { id, now, objectHash } from "./util.js";
import { mkdirSync, existsSync } from "node:fs";
import { gitAt, insideDirectory, resolveProjectLayout } from "./project-layout.js";
import { resolve, basename, join } from "node:path";
import { createHash } from "node:crypto";

export function generateWorkflowId(requestId: string): string {
  const hashHex = createHash("sha256")
    .update("devflow:create:v1\n" + requestId)
    .digest("hex");
  return `wf-${hashHex.slice(0, 32)}`;
}

export interface CreateWorkflowRequest {
  request_id: string;
  workspace_root: string;
  request_text: string;
  title?: string;
  refs?: WorkspaceReference[];
  workspace_mode?: "new_worktree" | "existing_workspace";
  worktree_path?: string;
  worktree_paths?: Record<string, string>;
  branch?: string;
  branches?: Record<string, string>;
  preview_digest?: string;
  planner_profile_id?: string;
  executor_profile_id?: string;
  planner_profile?: ToolProfile;
  executor_profile?: ToolProfile;
  role_overrides?: RoleOverrides;
  source_defaults_revision?: number;
}

type AccessGate = {
  requireVerified(profiles: ToolProfile[]): void;
};

function parseOptionalProfile(value: unknown): ToolProfile | undefined {
  if (value === undefined) return undefined;
  return ToolProfileSchema.parse(value);
}

function loadCreateDefaults(store: Store, config?: Config) {
  if (config || store.get("model_defaults", "global")) return new ModelDefaultsService(store).getOrImport(config);
  return {
    schema_version: 2 as const,
    revision: 0,
    plannerProfile: plannerProfileFromConfig(),
    executorProfile: executorProfileFromConfig(),
    reviewerBinding: { mode: "inherit" as const },
    updated_at: new Date().toISOString(),
  };
}

export function resolveCreateProfiles(
  store: Store,
  input: Partial<CreateWorkflowRequest>,
  config?: Config,
) {
  const defaults = loadCreateDefaults(store, config);
  const plannerFromBody = parseOptionalProfile(input.planner_profile);
  const executorFromBody = parseOptionalProfile(input.executor_profile);
  const usedSavedIds = Boolean(
    input.planner_profile_id || input.executor_profile_id,
  );
  const plannerProfile =
    plannerFromBody ??
    (input.planner_profile_id
      ? resolveProfile(store, input.planner_profile_id)
      : defaults.plannerProfile);
  const executorProfile =
    executorFromBody ??
    (input.executor_profile_id
      ? resolveProfile(store, input.executor_profile_id)
      : usedSavedIds && input.planner_profile_id
        ? resolveProfile(store, input.planner_profile_id)
        : defaults.executorProfile);
  let roleOverrides: RoleOverrides;
  if (input.role_overrides) {
    roleOverrides = RoleOverridesSchema.parse(input.role_overrides);
  } else {
    const baseOverrides = inheritRoleOverrides();
    if (defaults.reviewerBinding) {
      baseOverrides.reviewer = JSON.parse(
        JSON.stringify(defaults.reviewerBinding),
      );
    }
    roleOverrides = baseOverrides;
  }
  const usedOnlySavedIds =
    usedSavedIds && !plannerFromBody && !executorFromBody;
  const sourceDefaultsRevision = usedOnlySavedIds
    ? input.source_defaults_revision
    : (input.source_defaults_revision ?? defaults.revision);
  return {
    plannerProfile,
    executorProfile,
    roleOverrides,
    sourceDefaultsRevision,
  };
}
export function createWorkflowSpec(
  store: Store,
  workflowId: string,
  input: Partial<CreateWorkflowRequest>,
  config?: Config,
) {
  const { plannerProfile, executorProfile, roleOverrides, sourceDefaultsRevision } =
    resolveCreateProfiles(store, input, config);
  return ExecutionSpecSchema.parse({
    id: id("spec"), workflow_id: workflowId, revision: 1,
    plannerProfile, executorProfile, roleOverrides,
    mode: specMode({ plannerProfile, executorProfile, roleOverrides }),
    template_id: "native-development",
    template_revision: getDefaultTemplate().revision,
    quality_policy_version: getDefaultTemplate().quality_policy_version ?? 2,
    created_at: now(), source_defaults_revision: sourceDefaultsRevision,
  });
}

export function planWorkflowWorkspaces(store: Store, input: Partial<CreateWorkflowRequest> & { workspace_root: string }, workflowId: string) {
  const layout = resolveProjectLayout(store, input.workspace_root);
  const mode = input.workspace_mode ?? "existing_workspace";
  const executionRoot = layout.grouped
    ? canonicalWorkspacePath(mode === "new_worktree" ? join(layout.root, ".worktrees", workflowId) : layout.root)
    : undefined;
  if (layout.grouped && mode === "new_worktree") {
    requireCondition(insideDirectory(layout.root, executionRoot!) && !sameWorkspacePath(layout.root, executionRoot!),
      "WORKTREE_PATH_FORBIDDEN", "任务目录必须位于项目根目录的 .worktrees 下");
    requireCondition(!input.worktree_path && !input.branch, "AMBIGUOUS_WORKTREE_OVERRIDE",
      "多仓库任务需要分别指定仓库的路径和分支");
  }
  const repositories = layout.repositories.map(repo => {
    const explicit = input.worktree_paths?.[repo.id] ?? input.worktree_path;
    const target = mode === "existing_workspace" ? repo.path
      : resolveWorktreePath({
        sourceRoot: repo.path, workflowId, repoId: repo.id,
        explicitPath: explicit ?? (layout.grouped && !repo.worktree_base_path ? join(executionRoot!, repo.relativePath) : undefined),
        projectConfiguredPath: repo.worktree_base_path,
      });
    const taskBranch = mode === "new_worktree"
      ? input.branches?.[repo.id] ?? input.branch ?? `devflow/${workflowId}/${repo.id}`
      : repo.branch;
    if (mode === "new_worktree") gitAt(repo.path, ["check-ref-format", "refs/heads/" + taskBranch]);
    return { ...repo, target_path: target, task_branch: taskBranch };
  });
  if (layout.grouped && mode === "new_worktree") {
    for (const [index, repo] of repositories.entries()) {
      requireCondition(!repositories.some(source => insideDirectory(repo.target_path, source.path)
        || insideDirectory(source.path, repo.target_path))
        && !insideDirectory(repo.target_path, join(layout.root, "docs"))
        && !insideDirectory(join(layout.root, "docs"), repo.target_path)
        && !repositories.slice(0, index).some(other => insideDirectory(repo.target_path, other.target_path)
          || insideDirectory(other.target_path, repo.target_path)),
        "WORKTREE_PATH_CONFLICT", `工作树目标与项目目录冲突：${repo.target_path}`);
    }
  }
  const digest = objectHash({ root: layout.root, mode, executionRoot, repositories });
  return { ...layout, executionRoot, repositories, mode, digest };
}

type CreationIntent = {
  payload_hash: string;
  project: Project;
  workflow: Workflow;
  workspace?: Workspace;
  workspaces?: Workspace[];
  execution_root?: string;
  spec: ReturnType<typeof ExecutionSpecSchema.parse>;
};

function checkWorktree(workspace: Workspace, recovery: boolean) {
  const { root, source_root: source, baseline, branch, common_dir: common } = workspace;
  if (existsSync(root)) {
    requireCondition(recovery && sameGitDirectory(root, gitAt(root, ["rev-parse", "--show-toplevel"]))
      && sameGitDirectory(resolve(root, gitAt(root, ["rev-parse", "--git-common-dir"])), common)
      && gitAt(root, ["symbolic-ref", "--short", "HEAD"]) === branch
      && gitAt(root, ["rev-parse", "HEAD"]) === baseline
      && !gitAt(root, ["status", "--porcelain"]),
      "WORKTREE_INTENT_MISMATCH", `工作树目录已存在或与原创建记录不符：${root}`, 409);
    return { exists: true, branchExists: true };
  }
  const branchExists = gitAt(source!, ["for-each-ref", "--format=%(refname)", "refs/heads/" + branch])
    .split(/\r?\n/).includes("refs/heads/" + branch);
  requireCondition(!branchExists || (recovery && gitAt(source!, ["rev-parse", "refs/heads/" + branch]) === baseline),
    "WORKTREE_BRANCH_EXISTS", `任务分支已存在或已变化：${source} / ${branch}`, 409);
  return { exists: false, branchExists };
}

export interface CreateWorkflowResult {
  workflow: Workflow;
  is_existing: boolean;
}
export class CreateWorkflowService {
  constructor(
    private store: Store,
    private config?: Config,
    _access?: AccessGate,
  ) {}
  execute(input: CreateWorkflowRequest): CreateWorkflowResult {
    Id.parse(input.request_id);
    requireCondition(
      typeof input.request_text === "string" && !!input.request_text.trim(),
      "EMPTY_REQUIREMENT",
      "需求正文不能为空",
      422,
    );
    // Older internal callers may omit a name; public creation entries require one.
    const title = TaskNameSchema.parse(input.title ?? Array.from(input.request_text.replace(/[#*`\r\n]+/g, " ").trim()).slice(0, 10).join(""));
    const refs = (input.refs ?? []).map((r) =>
      WorkspaceReferenceSchema.parse(r),
    );
    const mode = input.workspace_mode ?? "existing_workspace";
    requireCondition(
      ["new_worktree", "existing_workspace"].includes(mode),
      "INVALID_WORKSPACE_MODE",
      "工作区模式无效",
      422,
    );
    const payloadHash = objectHash({ ...input, refs, workspace_mode: mode });
    const key = "create:" + input.request_id;
    const prior = this.store.get<{ workflow_id: string; payload_hash: string }>(
      "idempotency_record",
      key,
    );
    if (prior) {
      requireCondition(
        prior.payload_hash === payloadHash,
        "IDEMPOTENCY_CONFLICT",
        "相同请求 ID 的需求、引用或配置不同",
        409,
      );
      return {
        workflow: this.store.must("workflow", prior.workflow_id),
        is_existing: true,
      };
    }
    const pending = this.store.get<CreationIntent>("workspace_creation", key);
    requireCondition(!pending || pending.payload_hash===payloadHash,"IDEMPOTENCY_CONFLICT","创建中断后只能重试原请求",409);
    const resolved = resolveCreateProfiles(this.store, input, this.config);
    const plannerProfile = pending?.spec.plannerProfile ?? resolved.plannerProfile;
    const executorProfile = pending?.spec.executorProfile ?? resolved.executorProfile;
    const roleOverrides = pending?.spec.roleOverrides ?? resolved.roleOverrides;
    const sourceDefaultsRevision =
      pending?.spec.source_defaults_revision ?? resolved.sourceDefaultsRevision;

    const workflowId = pending?.workflow.id ?? generateWorkflowId(input.request_id);
    const layout = planWorkflowWorkspaces(this.store, input, workflowId);
    const { root, existing, repositories, executionRoot } = layout;
    if (!pending) {
      requireCondition(!input.preview_digest || input.preview_digest === layout.digest,
        "WORKSPACE_PREVIEW_CHANGED", "仓库或分支已变化，请重新预览后创建", 409);
      assertProfilesVerified(this.store, collectExplicitProfiles(plannerProfile, executorProfile, roleOverrides));
    }
    const active = this.store.list<Workspace>("workspace").find(ws =>
      repositories.some(repo => sameWorkspacePath(ws.root, repo.path))
      && !["COMMITTED", "COMPLETED"].includes(this.store.get<Workflow>("workflow", ws.workflow_id)?.state ?? ""));
    requireCondition(mode !== "existing_workspace" || !active,
      "WORKSPACE_BUSY", `仓库已有未完成任务：${active?.root ?? ""}`, 409);
    const project = pending?.project ?? existing ?? ProjectSchema.parse({
      id: id("proj"),
      name: basename(root),
      ...(layout.grouped ? { project_root: root, primary_repo_id: repositories[0]!.id } : {}),
      repositories: repositories.map(repo => ({ id: repo.id, path: repo.path })),
    });
    const workflow: Workflow = pending?.workflow
      ? {
          ...pending.workflow,
          binding_strategy: pending.workflow.binding_strategy ?? "unified",
        }
      : {
          id: workflowId,
          project_id: project.id,
          title,
          request: input.request_text,
          complexity: "simple",
          workspace_mode: mode,
          binding_strategy: "unified",
          quality_policy_version: getDefaultTemplate().quality_policy_version ?? 2,
          state: "PLANNING",
          stage: "planning",
          version: 1,
          plan_revision: 0,
          environment_revision: 1,
          created_at: now(),
          updated_at: now(),
          feedback: [],
        };

    const previous = pending?.workspaces ?? (pending?.workspace ? [pending.workspace] : undefined);
    const workspaces: Workspace[] = previous ?? repositories.map(repo => ({
      id: id("ws"),
      workflow_id: workflowId,
      repo_id: repo.id,
      root: repo.target_path,
      common_dir: repo.common_dir,
      baseline: repo.baseline,
      branch: repo.task_branch,
      owned: mode === "new_worktree",
      source_root: repo.path,
      source_branch: repo.branch,
      ...(mode === "existing_workspace" ? captureInitialState(repo.path) : {}),
    }));
    if (pending) {
      requireCondition(workspaces.length === repositories.length && workspaces.every(ws => repositories.some(repo =>
        ws.repo_id === repo.id && ws.source_root && sameWorkspacePath(ws.source_root, repo.path)
        && sameWorkspacePath(ws.common_dir, repo.common_dir) && ws.source_branch === repo.branch
        && sameWorkspacePath(ws.root, repo.target_path) && ws.branch === repo.task_branch)),
        "WORKTREE_INTENT_MISMATCH", "仓库或目标目录与原创建记录不符", 409);
    }
    const spec = pending?.spec ?? ExecutionSpecSchema.parse({
      id: id("spec"),
      workflow_id: workflowId,
      revision: 1,
      plannerProfile,
      executorProfile,
      roleOverrides,
      mode: specMode({ plannerProfile, executorProfile, roleOverrides }),
      template_id: "native-development",
      template_revision: getDefaultTemplate().revision,
      quality_policy_version: getDefaultTemplate().quality_policy_version ?? 2,
      created_at: now(),
      ...(sourceDefaultsRevision !== undefined
        ? { source_defaults_revision: sourceDefaultsRevision }
        : {}),
    });

    if (mode === "new_worktree") {
      const prepared = workspaces.map(ws => checkWorktree(ws, Boolean(pending)));
      const intent: CreationIntent = { payload_hash: payloadHash, project, workflow, workspaces, execution_root: executionRoot, spec };
      this.store.put("workspace_creation", key, workflowId, intent);
      if (executionRoot) mkdirSync(executionRoot, { recursive: true });
      for (const [index, ws] of workspaces.entries()) {
        const { exists, branchExists } = prepared[index]!;
        if (exists) continue;
        const source = ws.source_root!;
        if (insideDirectory(join(source, ".worktrees"), ws.root)) ensureWorktreeGitExcluded(source);
        mkdirSync(resolve(ws.root, ".."), { recursive: true });
        try {
          gitAt(source, branchExists ? ["worktree", "add", ws.root, ws.branch]
            : ["worktree", "add", "-b", ws.branch, ws.root, ws.baseline]);
        } catch (error) {
          const stderr = (error as { stderr?: string }).stderr?.trim();
          throw new FlowError("WORKTREE_CREATE_FAILED", `无法创建 ${ws.repo_id} 工作树：${stderr || ws.root}`, 409);
        }
      }
    }
    return this.store.transaction(() => {
      if (!existing) this.store.put("project", project.id, "global", project);
      const display = this.store.get<{ name?: string; detached?: boolean }>("project_display", project.id);
      if (display?.detached) this.store.put("project_display", project.id, project.id, { ...display, detached: false });
      this.store.put("workflow", workflowId, project.id, workflow);
      for (const workspace of workspaces) this.store.put("workspace", workspace.id, workflowId, workspace);
      this.store.put("execution_spec", spec.id, workflowId, spec);
      this.store.put("entry_context", workflowId, workflowId, {
        roots: Object.fromEntries(workspaces.map(ws => [ws.repo_id, ws.source_root])),
        ...(executionRoot ? { execution_root: executionRoot, project_root: root } : {}),
      });
      this.store.put("requirement_message", id("msg"), workflowId, {
        workflow_id: workflowId,
        text: input.request_text,
        refs,
        created_at: now(),
      });
      this.store.enqueue(workflowId, "dispatch_run", {
        workflow_id: workflowId,
        purpose: "planning",
        spec_id: spec.id,
      });
      this.store.put("idempotency_record", key, "global", {
        workflow_id: workflowId,
        payload_hash: payloadHash,
      });
      this.store.remove("workspace_creation", key);
      return { workflow, is_existing: false };
    });
  }
}
