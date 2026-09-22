import { captureInitialState } from "../../git/src/initial-state.js";
import { resolveWorktreePath, ensureWorktreeGitExcluded } from "../../git/src/workspace-paths.js";
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
import { realpathSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
  refs?: WorkspaceReference[];
  workspace_mode?: "new_worktree" | "existing_workspace";
  worktree_path?: string;
  worktree_paths?: Record<string, string>;
  branch?: string;
  branches?: Record<string, string>;
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
  if (config) return new ModelDefaultsService(store).getOrImport(config);
  return {
    revision: 0,
    plannerProfile: plannerProfileFromConfig(),
    executorProfile: executorProfileFromConfig(),
  };
}

function resolveCreateProfiles(
  store: Store,
  input: CreateWorkflowRequest,
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
  const roleOverrides = input.role_overrides
    ? RoleOverridesSchema.parse(input.role_overrides)
    : inheritRoleOverrides();
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
    const pending=this.store.get<{payload_hash:string;project:Project;workflow:Workflow;workspace:Workspace;spec:ReturnType<typeof ExecutionSpecSchema.parse>}>("workspace_creation",key);
    requireCondition(!pending || pending.payload_hash===payloadHash,"IDEMPOTENCY_CONFLICT","创建中断后只能重试原请求",409);
    const resolved = resolveCreateProfiles(this.store, input, this.config);
    const plannerProfile = pending?.spec.plannerProfile ?? resolved.plannerProfile;
    const executorProfile = pending?.spec.executorProfile ?? resolved.executorProfile;
    const roleOverrides = pending?.spec.roleOverrides ?? resolved.roleOverrides;
    const sourceDefaultsRevision =
      pending?.spec.source_defaults_revision ?? resolved.sourceDefaultsRevision;
    if (!pending) {
      assertProfilesVerified(
        this.store,
        collectExplicitProfiles(
          plannerProfile,
          executorProfile,
          roleOverrides,
        ),
      );
    }
    requireCondition(
      existsSync(input.workspace_root),
      "WORKSPACE_MISSING",
      "工作区不存在",
      422,
    );
    const source = realpathSync(input.workspace_root);
    const git = (args: string[]) =>
      execFileSync("git", args, {
        cwd: source,
        encoding: "utf8",
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    let root: string;
    try {
      root = realpathSync(git(["rev-parse", "--show-toplevel"]));
    } catch {
      throw new FlowError(
        "GIT_REPOSITORY_REQUIRED",
        "请选择已初始化且有提交的 Git 仓库根目录",
        422,
      );
    }
    requireCondition(
      root === source,
      "WORKSPACE_ROOT_REQUIRED",
      "请选择 Git 仓库根目录",
      422,
    );
    const baseline = pending?.workspace.baseline ?? git(["rev-parse", "HEAD"]);
    const branch = git(["symbolic-ref", "--short", "HEAD"]);
    const common = realpathSync(
      resolve(source, git(["rev-parse", "--git-common-dir"])),
    );
    const active = this.store
      .list<Workspace>("workspace")
      .find(
        (ws) =>
          ws.root.toLowerCase() === source.toLowerCase() &&
          !["COMMITTED", "COMPLETED"].includes(
            this.store.get<Workflow>("workflow", ws.workflow_id)?.state ?? "",
          ),
      );
    requireCondition(
      mode !== "existing_workspace" || !active,
      "WORKSPACE_BUSY",
      "该工作区已有未完成任务",
      409,
    );
    const existing = this.store
      .list<Project>("project")
      .find((p) =>
        p.repositories.some(
          (r) => resolve(r.path).toLowerCase() === source.toLowerCase(),
        ),
      );
    const project =
      pending?.project ??
      existing ??
      ProjectSchema.parse({
        id: id("proj"),
        name: basename(source),
        repositories: [{ id: "main", path: source }],
      });
    const effectiveRepo =
      project.repositories.find(
        (r) => resolve(r.path).toLowerCase() === source.toLowerCase(),
      ) ??
      (project.primary_repo_id
        ? project.repositories.find((r) => r.id === project.primary_repo_id)
        : project.repositories[0]);
    const repoId = effectiveRepo?.id ?? "main";
    const workflowId = pending?.workflow.id ?? generateWorkflowId(input.request_id);
    let target = source;
    let taskBranch = branch;
    if (mode === "new_worktree") {
      const explicit = input.worktree_paths?.[repoId] ?? input.worktree_path;
      target = resolveWorktreePath({
        sourceRoot: source,
        workflowId,
        repoId,
        explicitPath: explicit,
        projectConfiguredPath: effectiveRepo?.worktree_base_path,
      });
      ensureWorktreeGitExcluded(source);
      taskBranch = input.branches?.[repoId] ?? input.branch ?? `devflow/${workflowId}/${repoId}`;
    }
    const workflow: Workflow = pending?.workflow
      ? {
          ...pending.workflow,
          binding_strategy: pending.workflow.binding_strategy ?? "unified",
        }
      : {
          id: workflowId,
          project_id: project.id,
          title: input.request_text.slice(0, 60).replace(/[\r\n]+/g, " "),
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
    const workspace: Workspace = pending?.workspace ?? {
      id: id("ws"),
      workflow_id: workflowId,
      repo_id: repoId,
      root: target,
      common_dir: common,
      baseline,
      branch: taskBranch,
      owned: mode === "new_worktree",
      source_root: source,
      source_branch: branch,
      ...(mode === "existing_workspace" ? captureInitialState(source) : {}),
    };
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
    // Persist a recoverable creation intent before Git; never fall back to the source directory.
    if (workspace.owned) {
      requireCondition(workspace.source_root===source && workspace.source_branch===branch && workspace.common_dir===common,"WORKTREE_INTENT_MISMATCH","创建意图与当前仓库不符",409);
      this.store.put("workspace_creation", key, workflowId, {payload_hash:payloadHash,project,workflow,workspace,spec});
      mkdirSync(resolve(target, ".."), { recursive: true });
      if(existsSync(target)) {
        requireCondition(realpathSync(resolve(target,git(["-C",target,"rev-parse","--git-common-dir"])))===common && git(["-C",target,"symbolic-ref","--short","HEAD"])===taskBranch && git(["-C",target,"rev-parse","HEAD"])===baseline && !git(["-C",target,"status","--porcelain"]),"WORKTREE_INTENT_MISMATCH","创建中断后的工作树已变化，保留现场",409);
      } else {
        let tip:string|undefined;try{tip=git(["rev-parse","--verify","refs/heads/"+taskBranch]);}catch{}
        requireCondition(!tip || tip===baseline,"WORKTREE_INTENT_MISMATCH","临时分支已变化，不能覆盖",409);
        if(tip)git(["worktree","add",target,taskBranch]);else git(["worktree", "add", "-b", taskBranch, target, baseline]);
      }
    }
    return this.store.transaction(() => {
      if (!existing) this.store.put("project", project.id, "global", project);
      this.store.put("workflow", workflowId, project.id, workflow);
      this.store.put("workspace", workspace.id, workflowId, workspace);
      this.store.put("execution_spec", spec.id, workflowId, spec);
      this.store.put("entry_context", workflowId, workflowId, {
        roots: { [repoId]: source },
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
