import { mkdirSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { z } from "zod";
import type { Engine } from "../../core/src/engine.js";
import { profileForRun, bindProfile, invocationFingerprintFromProfile, permissionCategoryForPurpose } from "../../core/src/run-profile.js";
import { beginRunConversation, retainRunConversation, boundConversationContinuation, continuationSessionToResume } from "../../core/src/conversation-lineage.js";
export { sessionFamily, conversationLineageKey } from "../../core/src/conversation-lineage.js";
import {
  diagnosisOutputSchema,
  parseDiagnosisOutput,
} from "../../contracts/src/diagnosis-output.js";
import {
  atomicWrite,
  hash,
  now,
  objectHash,
  redact,
  id,
} from "../../core/src/util.js";
import { executionScopeInstructions, executionScopeWithoutTests, roleBoundaryInstructionsFor } from "../../core/src/role-boundaries.js";
import {
  verifyAndResolveExecutionInstructions,
  formatExecutionInstructionsForPrompt,
} from "../../core/src/execution-instructions.js";
import { usesPolicyV2 } from "../../core/src/quality-policy-migration.js";
import { composeRoleGuidance, type RecoveryGuidanceRole } from "../../core/src/conversation-guidance.js";
import {
  ATTACHMENT_HANDOFF_NOTICE,
  CONVERSATION_ENTITY,
  type ConversationFile,
  type RecoveryManifest,
  type ToolProfile,
  type Workflow,
  type Run,
  type Workspace,
  type Snapshot,
  ReviewSchema,
  reviewOutputSchema,
  ExecutorRoundOutputSchema,
  ExecutorRoundResultSchema,
  requireCondition,
  FlowError,
  MergeConflictReceiptSchema,
  type MergeConflictRequest,
  type MergeConflictReceipt,
  type AcceptanceCarry,
} from "../../contracts/src/index.js";
import { git, repositoryInfo } from "../../git/src/git.js";
import { NativePlanSchema } from "../../contracts/src/native-plan.js";
import {
  modelOutputSchema,
  normalizeModelOutput,
} from "../../contracts/src/review-output.js";
import { createDefaultAdapterRegistry, resolveSessionIdentity } from "../../adapters/sdk/src/index.js";
import { ExecutionSessionStore } from "../../core/src/execution-session-store.js";
import { CliDispatchManager, type CliDispatchRecord } from "./cli-dispatch.js";
import { computeSessionBindingKey } from "../../contracts/src/session-binding.js";
import { readOnlyPurpose } from "../../adapters/sdk/src/invocation.js";
import type {
  HostChunk,
  NativeAgentAdapter,
  NativeConversationEvent,
  NormalizedEvent,
  PreparedInvocation,
} from "../../adapters/sdk/src/interface.js";
import {
  ConversationService,
  type ConversationApplyContext,
} from "../../core/src/conversation-service.js";
import type { Store } from "../../store/src/store.js";
import {
  RunTelemetry,
  shouldApplyRootSessionIdentity,
  type ConversationTelemetryRoute,
} from "./run-telemetry.js";
import { ConversationObserver } from "./conversation-observer.js";
import type { ConversationRecordSource } from "../../adapters/sdk/src/conversation-source.js";
import {
  unknownSubagentCapabilities,
  type ConversationNode,
} from "../../contracts/src/conversation.js";
import { resolveConversationInputAttachments } from "./conversation-inputs.js";
import { AgyNativeRecordSource } from "../../adapters/agy/src/native-record-source.js";
import { NativeExecutionObserver } from "../../evidence/src/native-execution-observer.js";
import type { HostToolExecutionFact } from "../../evidence/src/native-run-records.js";
import type { ProcessManager } from "../../process/src/manager.js";
import { classifyFailure, normalizeRuntimeFailure } from "./errors.js";
import { CodexSessionObserver } from "./codex-session-observer.js";
import { observeCodexAccountQuota } from "./codex-account-quota.js";
import type { AgyWorkflowBridge } from "./agy-workflow-bridge.js";
import {
  classifyAgyFailure,
  type AgyFailureFact,
} from "../../adapters/agy/src/failure-fact.js";
import { CurrentTurn } from "../../adapters/agy/src/current-turn.js";
import { readPlanMaterial } from "../../core/src/plan-review.js";
import type { SourceInput } from "../../core/src/source-change.js";
import {
  asideRecoveryGuidance,
  batchExecutionInstructions,
  executeRecoveryGuidance,
  planningRecoveryGuidance,
  repairRecoveryGuidance,
  reviewRecoveryGuidance,
  type RecoveryGuidanceAttachment,
  type RecoveryGuidanceOptions,
} from "../../core/src/execution-guidance.js";
import { ConversationControlService } from "../../core/src/conversation-control.js";
import { saveRunContinuation } from "../../core/src/waiting-context.js";
import {
  ConversationRecovery,
  storeRecoveryRunPort,
  type RecoveryRunPort,
} from "./conversation-recovery.js";
import {
  reviewSkillResources,
  reviewContractContext,
  reviewInstructions,
} from "./review-materials.js";
import type {
  PlanningHandoff,
  RunContinuation,
} from "../../contracts/src/tr-handoff.js";
import {
  INTENT_CLARIFICATION_INSTRUCTION,
  applyContinuationMaterials,
  applyPlanningHandoffMaterials,
} from "../../core/src/round-intent.js";

async function adapterForToolProfile(
  profile: ToolProfile,
): Promise<NativeAgentAdapter> {
  const adapter = createDefaultAdapterRegistry().mustGet(profile.adapterId);
  await adapter.probe({ toolProfile: profile });
  return adapter;
}

export class ProfileRuntime {
  private executionSessionStore: ExecutionSessionStore;
  constructor(
    private engine: Engine,
    private processes: ProcessManager,
    private accountBridge?: AgyWorkflowBridge,
  ) {
    this.executionSessionStore = new ExecutionSessionStore(this.engine.store);
  }
  async plan(w: Workflow, run: Run) {
    const workspaces = await this.planningWorkspaces(w);
    const selectedSource = this.engine.store.get<SourceInput>(
      "source_input",
      w.id,
    );
    const schema = z.object({
      markdown: z.string().min(1),
      plan: NativePlanSchema,
    });
    const response = await this.invoke(
      w,
      run,
      this.planMaterials(w, workspaces, selectedSource),
      modelOutputSchema(
        schema,
        workspaces.map((ws) => ws.repo_id),
      ),
      undefined,
      workspaces,
    );
    const value = response as { markdown: string; plan: any };
    requireCondition(
      value && typeof value.markdown === "string",
      "PLAN_DOCUMENT_MISSING",
      "缺少完整规划正文",
    );
    value.plan = {
      ...value.plan,
      revision: w.plan_revision + 1,
      baselines: Object.fromEntries(
        workspaces.map((ws) => [ws.repo_id, ws.baseline]),
      ),
      project_config_hash: objectHash(this.engine.project(w.project_id)),
      design_ref: {
        ...value.plan?.design_ref,
        content_hash: hash(value.markdown.replace(/\r\n/g, "\n")),
      },
    };
    return schema.parse(value);
  }
  async diagnose(w: Workflow, error: string) {
    const binding = bindProfile(
      this.engine.store,
      this.engine.config,
      w.id,
      "diagnose",
    );
    const run: Run = {
      ...binding,
      id: id("diagnosis"),
      workflow_id: w.id,
      plan_revision: w.plan_revision,
      adapter: binding.profile.adapterId,
      stage: "diagnosis",
      status: "running",
      started_at: now(),
      deadline_at: Date.now() + 300000,
      package_hash: objectHash({ error, plan: w.plan_hash }),
    };
    this.engine.store.put("run", run.id, w.id, run);
    this.engine.store.put("check_process", run.id, w.run_id!, { id: run.id });
    try {
      const result = parseDiagnosisOutput(
        await this.invoke(
          w,
          run,
          {
            instructions:
              "只读诊断故障。按当前唯一正式计划定位真实运行或环境故障根因，给出确定修复步骤；诊断不是代码质量审核，不能产出测试真实性核验或证明工具任务；需要改变范围时返回完整正式计划并等待批准。禁止另建替代计划。",
            error,
            plan: this.engine.plan(w.id),
            authorities: this.engine.planSelfCheck.authorities(w),
            evidence: this.engine.getEvidence(w.id),
          },
          diagnosisOutputSchema(this.workspaces(w).map((ws) => ws.repo_id)),
        ),
      );
      this.engine.store.put("run", run.id, w.id, {
        ...this.engine.store.must<Run>("run", run.id),
        status: "completed",
        ended_at: now(),
      });
      return result;
    } catch (error) {
      this.engine.store.put("run", run.id, w.id, {
        ...this.engine.store.must<Run>("run", run.id),
        status: "failed",
        ended_at: now(),
      });
      throw error;
    }
  }
  async aside(
    w: Workflow,
    run: Run,
    question: {
      question: string;
      refs: unknown[];
      plan_revision?: number;
      plan_hash?: string;
    },
  ) {
    const revision = question.plan_revision ?? w.plan_revision;
    const plan = revision
      ? readPlanMaterial(this.engine.store, w.id, revision)
      : null;
    requireCondition(
      !question.plan_hash || plan?.hash === question.plan_hash,
      "PLAN_CHANGED",
      "提问绑定的计划版本不一致",
      409,
    );
    const value = await this.invoke(
      w,
      run,
      asideQuestionMaterials(this.engine, w, question, plan),
      modelOutputSchema(z.object({ answer: z.string().min(1) }), []),
    );
    return requireAsideAnswer(value);
  }
  async execute(w: Workflow, run: Run, token: string) {
    const materials = this.executeMaterials(w, run);
    const value = await this.invoke(
      w,
      run,
      materials,
      modelOutputSchema(
        ExecutorRoundOutputSchema,
        this.workspaces(w).map((ws) => ws.repo_id),
      ),
      token,
    );
    requireCondition(
      this.engine.get(w.id).run_id === run.id &&
        this.engine.get(w.id).state === "EXECUTING",
      "RUN_REVOKED",
      "运行阶段已变化",
    );
    const parsed = ExecutorRoundResultSchema.safeParse(value);
    const currentRun = this.engine.store.must<Run>("run", run.id);
    const payload = parsed.success
      ? parsed.data
      : {
          status: "unclear",
          summary:
            typeof value === "object"
              ? JSON.stringify(value)
              : String(value ?? ""),
        };
    await this.engine.receiveRoundResult(w.id, run.id, {
      schema_version: "v2",
      workflow_id: w.id,
      run_id: run.id,
      conversation_id: currentRun.conversation_id,
      plan_revision: w.plan_revision,
      plan_hash: w.plan_hash,
      ...payload,
    });
  }
  async resolveMergeConflict(
    w: Workflow,
    run: Run,
    request: MergeConflictRequest,
    token?: string,
  ): Promise<MergeConflictReceipt> {
    const plan = this.engine.plan(w.id);
    let diff = "";
    try {
      diff = await git(request.worktree_root, [
        "diff",
        `${request.source_commit}...${request.candidate_commit}`,
      ]);
    } catch {}
    const materials = {
      instructions: [
        executionScopeInstructions,
        "合并发生代码冲突。严格在原批准计划和正式整改范围内解决冲突，主动补齐解决冲突所必需的接线与调整，同时保留双方有效需求。禁止统一使用 ours/theirs、reset、stash 或删除历史。完成后返回结构化回执，不得自行提交 Git 或删除工作树。",
      ].join("\n\n"),
      workflow: w,
      run,
      request,
      request_id: request.id,
      plan,
      conflict_paths: request.conflict_paths,
      merge_head: request.source_commit,
      candidate_commit: request.candidate_commit,
      source_commit: request.source_commit,
      diff,
      forbidden_actions: [
        "git checkout --ours",
        "git checkout --theirs",
        "git reset",
        "git stash",
        "git merge --abort",
      ],
    };
    const value = await this.invoke(
      w,
      run,
      materials,
      modelOutputSchema(
        z.object({ receipt: MergeConflictReceiptSchema }),
        this.workspaces(w).map((ws) => ws.repo_id),
      ),
      token,
    );
    const parsed = z
      .object({ receipt: MergeConflictReceiptSchema })
      .parse(value);
    return parsed.receipt;
  }
  async review(w: Workflow, run: Run) {
    const snapshot = w.snapshot_id
      ? this.engine.store.get<Snapshot>("snapshot", w.snapshot_id)
      : undefined;
    const value = await this.invoke(
      w,
      run,
      await this.reviewMaterials(w, run, snapshot),
      reviewOutputSchema(this.workspaces(w).map((ws) => ws.repo_id)),
    );
    return normalizeModelOutput(value);
  }
  private reviewSkill() {
    const dir = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolve(dir, "../../skills/devflow-review/SKILL.md"),
      resolve(dir, "../../../../packages/skills/devflow-review/SKILL.md"),
    ];
    const found = candidates.find(existsSync);
    requireCondition(found, "SKILL_MISSING", "安装缺少 devflow-review Skill");
    return found;
  }
  private workspaces(w: Workflow) {
    return this.engine.store.list<Workspace>("workspace", w.id);
  }
  private async planningWorkspaces(w: Workflow): Promise<Workspace[]> {
    const existing = this.workspaces(w);
    const context = this.engine.store.get<{ roots: Record<string, string> }>(
      "entry_context",
      w.id,
    );
    let baselines = w.plan_revision
      ? this.engine.plan(w.id).plan.baselines
      : {};
    const selected = this.engine.store.get<SourceInput>("source_input", w.id);
    if (
      w.state === "PLANNING" &&
      selected?.choice === "replan" &&
      selected.plan_hash === w.plan_hash
    )
      baselines = Object.fromEntries(
        selected.repositories.map((r) => [r.repo_id, r.current_commit]),
      );
    // Externally submitted plans may not have execution workspaces until approval.
    // Read the registered source in place without creating or persisting a worktree.
    return Promise.all(
      this.engine.project(w.project_id).repositories.map(async (repo) => {
        const workspace = existing.find((ws) => ws.repo_id === repo.id);
        if (workspace) return workspace;
        const info = await repositoryInfo(context?.roots[repo.id] ?? repo.path);
        return {
          id: `readonly-${w.id}-${repo.id}`,
          workflow_id: w.id,
          repo_id: repo.id,
          root: info.path,
          common_dir: info.common_dir,
          branch: info.branch,
          baseline: baselines[repo.id] ?? info.head,
          owned: false,
        };
      }),
    );
  }
  private planMaterials(
    w: Workflow,
    workspaces: Workspace[],
    selectedSource: SourceInput | undefined,
  ) {
    return applyPlanningHandoffMaterials(
      {
        instructions:
          "你是规划模型。读取需求及引用的真实工作区文件，返回唯一正式计划。包含完整需求、确定实施步骤、单元/集成/E2E场景及受影响旧功能回归；等待用户批准后才实施。只读，不修改代码。如果提供 current_plan，须在同一任务中按用户的规划反馈修正该计划，逐条回应修改意见并提交完整新版，不能自行批准或启动实施。",
        current_plan: w.plan_revision
          ? readPlanMaterial(this.engine.store, w.id, w.plan_revision)
          : null,
        selected_source:
          selectedSource?.plan_hash === w.plan_hash ? selectedSource : null,
        requirements: this.engine.store.list("requirement_message", w.id),
        request: w.request,
        project: this.engine.project(w.project_id),
        feedback: this.engine.store.list("feedback_message", w.id),
        baselines: Object.fromEntries(
          workspaces.map((ws) => [ws.repo_id, ws.baseline]),
        ),
        project_config_hash: objectHash(this.engine.project(w.project_id)),
      },
      this.readPlanningHandoff(w.id),
    );
  }
  private executeMaterials(w: Workflow, run: Run) {
    const plan = this.engine.plan(w.id);
    const policy2 = usesPolicyV2({ quality_policy_version: run.quality_policy_version ?? w.quality_policy_version });
    const purpose = run.purpose ?? "implement";
    const roleSpecific = policy2 && purpose !== "implement";
    const assignment = this.engine.store.get<any>("repair_assignment", w.id);
    const repair = !policy2 || (assignment && assignment.assignment_id === run.assignment_id)
      ? assignment : null;

    const { instructions: extraInstructions, payload: extraPayload } =
      verifyAndResolveExecutionInstructions(
        this.engine.store,
        w.id,
        run,
        w.plan_revision,
        plan.hash,
      );
    const extraInstructionsPrompt =
      formatExecutionInstructionsForPrompt(extraInstructions);
    const baseInstructions = roleSpecific
      ? (purpose === "planner_commit" ? "" : executionScopeWithoutTests) + roleBoundaryInstructionsFor(purpose)
      : executionScopeInstructions + "完成本轮开发或整改及必要测试后交代码复核，不自行提交 Git，不代替人工验收。";

    return this.continuationMaterials(
      {
        instructions: baseInstructions + extraInstructionsPrompt,
        ...(roleSpecific ? {} : { execution_order: batchExecutionInstructions }),
        workflow: w,
        run,
        plan,
        ...(extraPayload ? { approved_execution_instructions: extraPayload } : {}),
        authorities: this.engine.planSelfCheck.authorities(w),
        feedback: this.engine.store.list("feedback_message", w.id),
        functional_issues: this.engine.store.list("functional_issue", w.id),
        project: this.engine.project(w.project_id),
        workspaces: this.workspaces(w),
        repair_assignment: repair,
        repair_instructions: policy2 ? repair?.instructions ?? null :
          this.engine.store.get<any>("repair_state", w.id)?.instructions ?? repair?.instructions ?? null,
        previous_completion: run.dispatch_context?.source_run_id
          ? this.engine.store.get("execution_completion", run.dispatch_context.source_run_id) ?? null : null,
        integration_repair: policy2 && purpose === "planner_takeover"
          ? this.engine.store.get("planner_integration_repair", w.id) ?? null : null,
        completion_instruction: purpose === "planner_commit" && policy2
          ? "完成实际提交后输出 JSON {status, summary, repositories: [{repo_id, commit}]}；无须新提交时在摘要说明。需要代码修复报告 need_planner；需要用户协助报告 need_user。"
          : "最终输出 JSON {status, summary, notes, artifacts}。status 只能是 completed、need_planner 或 need_user。未知状态不会被当成完成。",
      },
      run,
    );
  }
  private async reviewMaterials(
    w: Workflow,
    run: Run,
    snapshot: Snapshot | undefined,
  ) {
    const phase =
      w.stage === "quality_before_human" ? "before_human" : "after_human";
    const conflict_background = this.conflictReviewBackground(w.id);

    const { instructions: extraInstructions, payload: extraPayload } =
      verifyAndResolveExecutionInstructions(
        this.engine.store,
        w.id,
        run,
        w.plan_revision,
        this.engine.plan(w.id).hash,
      );
    const reviewExtraNotice = extraInstructions?.text
      ? `\n\n## 审批附加执行指令（只读验收依据）\n用户在批准计划时提出了以下附加执行约束，仅作为本次复核时的核验依据，不可越权修改代码：\n${extraInstructions.text}\n`
      : "";

    return this.continuationMaterials(
      {
        instructions: reviewInstructions + reviewExtraNotice,
        skill_resources: reviewSkillResources(),
        review_contract: reviewContractContext(this.engine, w, run),
        workflow: w,
        run,
        phase,
        cycle: this.engine.quality.getOrCreateGate(w.id, phase).cycle,
        plan: this.engine.plan(w.id),
        ...(extraPayload ? { approved_execution_instructions: extraPayload } : {}),
        authorities: this.engine.planSelfCheck.authorities(w),
        snapshot,
        diff: snapshot ? await this.engine.git.diff(snapshot) : "",
        completion: this.engine.store.list("delivery", w.id).at(-1),
        project: this.engine.project(w.project_id),
        skill: readFileSync(this.reviewSkill(), "utf8"),
        ...(conflict_background ? { conflict_background } : {}),
      },
      run,
    );
  }
  private conflictReviewBackground(workflowId: string) {
    const carry = this.engine.quality.readConflictBackground(workflowId);
    if (!carry) return undefined;
    const request = latestUpdated(
      this.engine.store.list<MergeConflictRequest>(
        "merge_conflict_request",
        workflowId,
      ),
    );
    return {
      reported_function_impact: carry.reported_function_impact,
      function_impact_explanation: carry.function_impact_explanation,
      requires_confirmation: carry.requires_confirmation,
      background_only: true,
      ...(request
        ? {
            request_summary: conflictRequestSummary(request),
            receipt_summary: conflictReceiptSummary(request, carry),
          }
        : {}),
    };
  }
  private readContinuation(run: Run): RunContinuation | undefined {
    return boundConversationContinuation(this.engine.store, run);
  }
  private readPlanningHandoff(workflowId: string) {
    return this.engine.store.get<PlanningHandoff>(
      "planning_handoff",
      workflowId,
    );
  }
  private continuationMaterials(materials: Record<string, unknown>, run: Run) {
    const continuation = this.readContinuation(run);
    if (continuation && !continuationSessionToResume(this.engine.store, run)) {
      // A changed binding gets a fresh native session with the complete handoff.
      // Keep the original intent; never ask the new model to repeat completed work.
      return {
        ...materials,
        continuation_handoff: continuation,
        original_text: continuation.original_text,
        questions: continuation.questions,
        answer: continuation.answer,
        ...(continuation.kind === "intent_clarification" ? {
          instructions: INTENT_CLARIFICATION_INSTRUCTION + "。依据交接中的原文和完整背景判断上一轮结果，不重新执行已完成的开发或测试。",
        } : {}),
      };
    }
    return applyContinuationMaterials(materials, continuation);
  }
  private async invoke(
    w: Workflow,
    run: Run,
    materials: unknown,
    schema: unknown,
    token?: string,
    planningWorkspaces?: Workspace[],
  ): Promise<any> {
    const profile = profileForRun(this.engine.store, run);
    const adapter = await adapterForToolProfile(profile);
    const root = join(this.engine.config.storage_root, "native-runs", run.id);
    mkdirSync(root, { recursive: true });
    const handoff = join(root, "HANDOFF.json"),
      output = join(root, "result.json"),
      schemaPath = join(root, "schema.json");
    const purpose = run.purpose!;
    const inputFiles = resolveRunConversationAttachments(
      this.engine,
      w,
      profile,
    );
    const recoveryGuidance = readRoleRecoveryGuidance(this.engine, w, run, {
      adapterId: profile.adapterId,
      attachments: recoveryAttachmentHints(inputFiles.attachments),
    });
    atomicWrite(
      handoff,
      JSON.stringify(
        withHandoffAttachments(
          withRecoveryMaterials(materials, recoveryGuidance),
          inputFiles.attachments,
        ),
        null,
        2,
      ),
    );
    atomicWrite(schemaPath, JSON.stringify(schema));
    const workspaces =
      planningWorkspaces ??
      (["planning", "aside"].includes(purpose)
        ? await this.planningWorkspaces(w)
        : this.workspaces(w));
    const fingerprint =
      run.invocation_fingerprint ??
      invocationFingerprintFromProfile(
        profile,
        w.id,
        permissionCategoryForPurpose(purpose),
      );
    const primaryWs = workspaces[0];
    const identity = await resolveSessionIdentity(adapter, {
      frozenProfile: profile,
      workspace: {
        root: primaryWs?.root ?? "",
        source_root: primaryWs?.source_root ?? primaryWs?.root,
        repo_id: primaryWs?.repo_id,
        common_dir: primaryWs?.common_dir,
        all_workspaces: workspaces.map((ws) => ({
          repo_id: ws.repo_id,
          root: ws.root,
          source_root: ws.source_root ?? ws.root,
          common_dir: ws.common_dir,
        })),
      },
      effectiveEnvironment: process.env as Record<string, string>,
    });
    if (!identity.resolved) {
      throw new FlowError(
        "SESSION_IDENTITY_UNRESOLVED",
        identity.unresolved_reason || "无法解析会话真实身份",
        422,
      );
    }
    const bindingKey = {
      workflow_id: w.id,
      adapter_id: identity.adapter_id,
      host_id: identity.host_id,
      client_scope_id: identity.client_scope_id,
      provider_account_scope: identity.provider_account_scope,
      canonical_model_id: identity.canonical_model_id,
      workspace_identity: identity.workspace_identity,
    };
    const sessionKey = computeSessionBindingKey(bindingKey);
    const taskStrategy: "unified" | "legacy" = (w as any).binding_strategy ?? "legacy";
    let sessionBinding: any;

    if (purpose !== "aside") {
      if (taskStrategy === "unified") {
        sessionBinding = this.executionSessionStore.getOrCreateBinding(bindingKey, {
          workspace_root: primaryWs?.root ?? "",
          source_root: primaryWs?.source_root ?? primaryWs?.root ?? "",
          repo_id: primaryWs?.repo_id ?? "primary",
        });
        if (sessionBinding.state === "unavailable" || sessionBinding.state === "retired") {
          throw new FlowError(
            "SESSION_BINDING_UNAVAILABLE",
            `会话绑定处于不可用状态 (${sessionBinding.state})，禁止启动`,
            409,
          );
        }
      } else {
        // CW3-F03: 缺策略的历史任务按 legacy 只读核验，未处理旧候选/pending 阻止误建根，绝不隐式建 binding
        const existingBindings = this.executionSessionStore.listBindings(w.id);
        const matchBinding = existingBindings.find((b) => computeSessionBindingKey(b) === sessionKey);
        if (matchBinding) {
          if (matchBinding.state === "unavailable" || matchBinding.state === "retired") {
            throw new FlowError(
              "SESSION_BINDING_UNAVAILABLE",
              `会话绑定处于不可用状态 (${matchBinding.state})，禁止启动`,
              409,
            );
          }
          sessionBinding = matchBinding;
        }
        const repairRecords = this.engine.store.list<any>("session_binding_repair_record", w.id);
        const hasUnresolvedRepair = repairRecords.some(
          (r) => r.status === "candidate" || r.status === "ambiguous" || r.status === "conflict",
        );
        if (hasUnresolvedRepair) {
          throw new FlowError(
            "UNRESOLVED_SESSION_CANDIDATE",
            "历史任务存在未解决的会话候选或歧义，禁止隐式启动新建根；请先完成会话修复",
            409,
          );
        }
      }
    }

    const continuation = this.readContinuation(run);
    // CW-D05: 统一绑定为唯一权威来源，对于统一策略任务不再使用旧指针优先覆盖
    let previous: { id: string } | undefined;
    if (purpose !== "aside") {
      if (sessionBinding?.conversation_id) {
        previous = { id: sessionBinding.conversation_id };
      } else if (taskStrategy === "legacy") {
        // CW4-F01: 历史任务只使用能匹配当前工具、模型、工作区及已知配置身份的旧记录；
        // 删掉不核对身份就采用任务级 conversation 的兜底，防止跨工具串用会话
        const legacyConv = this.engine.store.get<{ id: string }>("native_conversation", sessionKey);
        if (legacyConv?.id) {
          previous = { id: legacyConv.id };
        }
      }
    }
    const accountRecovery = this.engine.store.get<{
      decision: string;
      original_conversation_id?: string;
    }>("account_recovery_continuation", run.id) ?? (run as any).pending_model_retry?.account_recovery;
    if (accountRecovery && purpose !== "aside") {
      if (accountRecovery.decision === "manual_required") {
        throw new FlowError("ACCOUNT_RECOVERY_MANUAL_REQUIRED", "账号恢复需要人工处理", 409);
      }
      if (accountRecovery.decision === "exact_resume") {
        const original = accountRecovery.original_conversation_id;
        requireCondition(original && (!previous || previous.id === original),
          "CONVERSATION_MISMATCH", "账号恢复会话与当前绑定不一致", 409);
        previous = { id: original };
      } else if (accountRecovery.decision === "recreate_root") {
        requireCondition(!sessionBinding?.conversation_id,
          "CONVERSATION_ROOT_IMMUTABLE", "当前账号已有绑定会话，不能自动覆盖会话根", 409);
        previous = undefined;
      }
    }
    // Keep model handoff lineage without letting legacy pointers override the binding.
    beginRunConversation(this.engine.store, run, fingerprint);
    const context = {
      workflowId: w.id,
      runId: run.id,
      stage: run.stage,
      epoch: w.version,
      purpose,
      workspaceRoots: Object.fromEntries(
        workspaces.map((ws) => [ws.repo_id, ws.root]),
      ),
      allowedPaths: [
        ...(w.plan_revision
          ? this.engine.plan(w.id).plan.scope.allowed_paths
          : []),
        ...inputFiles.extraReadRoots,
      ],
      toolProfile: profile,
      frozenInvocation: run.frozen_invocation,
      handoffDocPath: handoff,
      outputPath: output,
      schemaPath,
      timeoutMs: Math.max(
        1,
        (run.deadline_at ?? Date.now() + 300000) - Date.now(),
      ),
      prompt: invokePrompt(
        purpose,
        handoff,
        schemaPath,
        continuation,
        nativePromptExtra(recoveryGuidance, inputFiles.attachments),
      ),
      inputAttachments: inputFiles.attachments,
    };
    if (adapter.prepareInputAttachments && inputFiles.attachments.length) {
      await adapter.prepareInputAttachments(inputFiles.attachments);
    }
    const prepared = previous
      ? await adapter.resume({
          ...context,
          previousConversationId: previous.id,
        })
      : await adapter.prepare(context);
    const invocation: PreparedInvocation & {
      attachments: typeof inputFiles.attachments;
    } = {
      ...prepared,
      attachments: inputFiles.attachments,
    };
    const pending = new Map<string, { fact: HostToolExecutionFact }>();
    const save = (fact: HostToolExecutionFact) =>
      this.engine.store.put(
        "native_execution",
        run.id + ":" + hash(fact.tool_call_id),
        run.id,
        fact,
      );
    adapter.onExecutionFact = (fact) => {
      if (!fact.ended_at && !pending.has(fact.tool_call_id)) {
        const entry: HostToolExecutionFact = {
          ...fact,
          workflow_id: w.id,
          run_id: run.id,
          plan_hash: w.plan_hash,
        };
        pending.set(fact.tool_call_id, {
          fact: entry,
        });
      } else if (fact.ended_at && pending.has(fact.tool_call_id)) {
        const before = pending.get(fact.tool_call_id)!;
        pending.delete(fact.tool_call_id);
        save({ ...before.fact, ...fact });
      }
    };
    const agyRecords = new AgyNativeRecordSource(homedir());
    const agy =
      profile.adapterId === "agy"
        ? new NativeExecutionObserver({
            workflow_id: w.id,
            run_id: run.id,
            plan_hash: w.plan_hash ?? "",
            workspaces,
            reports: this.engine.project(w.project_id).commands,
            readHostStep: (conversation, index) =>
              agyRecords.read(conversation, index),
            save,
          })
        : undefined;
    const asideCodexHome =
      purpose === "aside" && profile.adapterId === "codex"
        ? join(root, "codex-home")
        : undefined;
    if (asideCodexHome) mkdirSync(asideCodexHome, { recursive: true });

    // CW2-F08 / CW2-D04: 正式模型调用必须接入统一派发门面与占用管理
    const dispatchManager = new CliDispatchManager(this.engine.store, this.processes);
    const dispatchId = `disp_${w.id}_${run.id}`;
    let dispatchRecord: any;
    if (purpose !== "aside") {
      dispatchRecord = dispatchManager.prepareDispatch({
        dispatchId,
        workflowId: w.id,
        runId: run.id,
        bindingId: sessionBinding?.id,
        expectedConversationId: sessionBinding?.conversation_id,
        strategy: taskStrategy,
      });
    }

    const accountBinding =
      profile.adapterId === "agy"
        ? await this.accountBridge?.prepareProfileRun(
            w.id,
            run,
            run.frozen_invocation
              ? run.frozen_invocation.modelToken ?? undefined
              : profile.modelId,
            profile.id,
          )
        : undefined;
    let proc;
    try {
      if (dispatchRecord) dispatchManager.claimStarting(dispatchId);
      proc = this.processes.start({
        ...invocation,
        id: run.id,
        workflow_id: w.id,
        timeout_ms: context.timeoutMs,
        deadline_at: run.deadline_at,
        ...(accountBinding ? { agy_account: accountBinding } : {}),
        env: {
          ...invocation.env,
          ...(token ? { DEVFLOW_RUN_TOKEN: token } : {}),
          DEVFLOW_BASE_URL: "http://127.0.0.1:" + this.engine.config.server.port,
          ...(asideCodexHome ? { CODEX_HOME: asideCodexHome } : {}),
        },
      });
    } catch (err: any) {
      if (accountBinding) await this.accountBridge?.releaseRun(run.id, false, "spawn_failed");
      if (dispatchRecord) {
        dispatchManager.finishDispatch(dispatchId, { exitCode: 1, error: err.message });
      }
      throw err;
    }

    if (dispatchRecord && proc.pid) {
      dispatchManager.observeProcess(dispatchId, { pid: proc.pid });
    }
    proc.completion
      .then((res: any) => {
        if (dispatchRecord) {
          const code = typeof res?.code === "number" ? res.code : null;
          dispatchManager.finishDispatch(dispatchId, {
            exitCode: code,
            error: res?.error || (code === null ? "进程未返回有效退出码" : undefined),
          });
        }
      })
      .catch((err: any) => {
        if (dispatchRecord) {
          dispatchManager.finishDispatch(dispatchId, { exitCode: 1, error: String(err) });
        }
      });
    if (accountBinding)
      proc.on("host", (event) => {
        if (event.type === "started" && Number.isSafeInteger(event.pid))
          this.accountBridge?.attachProcess(accountBinding, event.pid);
      });
    let accountFailure: AgyFailureFact | undefined;
    let accountEventOffset = 0;
    const accountTurn = new CurrentTurn();
    const telemetry = new RunTelemetry(this.engine.store, w, run);
    const codexHome =
      asideCodexHome ??
      invocation.env.CODEX_HOME ??
      process.env.CODEX_HOME ??
      join(homedir(), ".codex");
    const stopQuota =
      profile.adapterId === "codex" && purpose !== "aside"
        ? observeCodexAccountQuota(
            {
              executable: invocation.executable,
              prefixArgs: Array.isArray(profile.options.prefixArgs)
                ? (profile.options.prefixArgs as string[])
                : [],
              cwd: invocation.cwd,
              home: codexHome,
            },
            telemetry,
          )
        : undefined;
    const sessionObserver =
      profile.adapterId === "codex"
        ? new CodexSessionObserver({
            home: codexHome,
            cwd: invocation.cwd,
            startedAt: run.started_at,
            telemetry,
          })
        : undefined;
    let final: unknown,
      text = "",
      conversation = previous?.id,
      failure: string | undefined,
      stderrTail = "";
    let permissionFailure: FlowError | undefined;
    const retainConversation = (session?: string) => {
      if (!session) return;
      if (previous && previous.id !== session) return;
      retainRunConversation(this.engine.store, run, session, fingerprint);
    };
    bindRunConversationObserver({
      store: this.engine.store,
      workflow: w,
      run,
      adapter,
      telemetry,
      previousNativeId: previous?.id,
      onRootSession: (nativeId) => {
        if (previous && nativeId !== previous.id) {
          failure = "会话 ID 与精确续接目标不一致";
          return;
        }
        conversation = nativeId;
        sessionObserver?.bind(nativeId);
        retainConversation(nativeId);
        try {
          this.engine.store.transaction(() => {
            // CW4-F01: init 回调排除 aside 对正式根指针的写入，临时提问不污染正式绑定
            if (purpose !== "aside") {
              if (taskStrategy === "unified") {
                if (sessionBinding && nativeId) {
                  this.executionSessionStore.bindConversationId(
                    sessionBinding.id,
                    nativeId,
                    run.id,
                  );
                }
              } else {
                // legacy 只确认旧来源和 Run/dispatch，不隐式造 binding
                this.engine.store.put("native_conversation", sessionKey, w.id, {
                  id: nativeId,
                  profile,
                  run_id: run.id,
                });
                this.engine.store.put("conversation", w.id, w.id, {
                  id: nativeId,
                  profile,
                  run_id: run.id,
                });
              }
            }

            // 同步记录 Run 根会话事实 (不等整轮结束)
            const existingRun = this.engine.store.get<Run>("run", run.id);
            if (existingRun) {
              this.engine.store.put("run", run.id, w.id, {
                ...existingRun,
                conversation_id: nativeId,
                root_session_id: nativeId,
              });
            }

            // 同步记录 dispatch 观察到的根会话 ID
            if (dispatchRecord) {
              const currentDisp = this.engine.store.get<CliDispatchRecord>("cli_dispatch_record", dispatchId);
              if (currentDisp) {
                this.engine.store.put("cli_dispatch_record", dispatchId, w.id, {
                  ...currentDisp,
                  observed_conversation_id: nativeId,
                });
              }
            }
          });
        } catch (err: any) {
          failure = err.message || "会话根绑定失败";
        }
      },
    });
    const handle = (event: NormalizedEvent, decodedConversation = false) => {
      const v = event.raw as any;
      if (v && typeof v === "object") {
        if (accountBinding) {
          this.accountBridge?.observeNativeEvent(run.id, v);
          accountTurn.accept(v);
          const eventType = v.event ?? v.type;
          const candidate = classifyAgyFailure({
            realmId: accountBinding.realm_id,
            accountId: accountBinding.account_id,
            authEpoch: accountBinding.auth_epoch,
            runId: run.id,
            conversationId: conversation,
            event: { ...v, type: eventType, error: v.error ?? v.result?.error },
            eventOffset: accountEventOffset++,
            currentTurn:
              !previous || accountTurn.canAttributeFailureToCurrentTurn(),
          });
          if (candidate.can_switch_account) accountFailure = candidate;
        }
        if (!decodedConversation) telemetry.accept(v);
        if (
          profile.adapterId === "agy" &&
          v.event === "result" &&
          Array.isArray(v.result?.denied_actions) &&
          v.result.denied_actions.length
        ) {
          const denied = redact(
            JSON.stringify({ denied_actions: v.result.denied_actions }),
          );
          const cause = classifyFailure(denied);
          permissionFailure = new FlowError(
            cause.code,
            cause.message + " " + denied.slice(0, 1500),
            422,
          );
        }
        agy?.accept(v);
        if (
          v.is_error === true ||
          v.type === "error" ||
          v.event === "error" ||
          v.type === "turn.failed" ||
          (v.event === "result" && v.result?.error)
        )
          failure ??=
            "CLI 返回错误：" + redact(JSON.stringify(v)).slice(0, 8000);
        if (v.structured_output) final = v.structured_output;
        if (v.type === "result" && typeof v.result === "string")
          text = v.result;
        if (v.event === "result" && typeof v.result?.response === "string")
          text = v.result.response;
        if (v.type === "item.completed" && v.item?.type === "agent_message")
          text = v.item.text;
        if (v.type === "text" && typeof v.part?.text === "string")
          text += v.part.text;
        if (v.type === "assistant" && Array.isArray(v.message?.content)) {
          const content = v.message.content
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("");
          if (content) text = content;
        }
        if (v.type === "message" && typeof v.content === "string")
          text = v.content;
      }
      if (text.length > 16 * 1024 * 1024)
        throw new Error("模型最终回答超出上限");
    };
    const consume = (
      stream: "stdout" | "stderr",
      data: Buffer | string,
      finalChunk = false,
    ) => {
      if (data.length)
        appendFileSync(
          join(root, stream + ".jsonl"),
          redact(typeof data === "string" ? data : data.toString("utf8")),
        );
      const chunk: HostChunk = {
        stream,
        data,
        timestamp: now(),
        runId: run.id,
        final: finalChunk,
      };
      const decodedConversation = adapter.decodeConversation?.(chunk) ?? [];
      acceptDecodedConversation(telemetry, decodedConversation);
      for (const event of adapter.decode(chunk)) {
        if (stream === "stdout")
          handle(event, decodedConversation.length > 0);
      }
    };
    proc.on("stdout", (data: Buffer) => {
      try {
        consume("stdout", data);
      } catch (e) {
        failure = String(e);
        void proc.stop();
      }
    });
    proc.on("stderr", (data: Buffer) => {
      try {
        stderrTail = (stderrTail + data.toString("utf8")).slice(-16000);
        consume("stderr", data);
      } catch (e) {
        failure = String(e);
        void proc.stop();
      }
    });
    // Process Host startup failures arrive as diagnostics rather than stderr.
    proc.on("diagnostic", (data: unknown) => {
      const diagnostic = redact(String(data));
      stderrTail = (stderrTail + "\n" + diagnostic).slice(-16000);
      try {
        appendFileSync(join(root, "stderr.jsonl"), diagnostic + "\n");
      } catch (error) {
        failure ??= String(error);
        void proc.stop();
      }
    });
    let exit;
    try {
      exit = await proc.completion;
      consume("stdout", "", true);
      consume("stderr", "", true);
    } finally {
      stopQuota?.();
      await sessionObserver?.close();
      telemetry.finish(
        !exit ||
          exit.code !== 0 ||
          !!exit.termination_reason ||
          !!failure ||
          !!permissionFailure,
      );
      if (!exit && accountBinding)
        await this.accountBridge?.releaseRun(run.id, false, "process_failed");
    }
    // Native session scanning may discover the ID without a stdout init event.
    conversation ??= this.engine.store.get<Run>("run", run.id)?.conversation_id;
    retainConversation(conversation);
    this.engine.store.put("run", run.id, w.id, {
      ...this.engine.store.must<Run>("run", run.id),
      exit_code: exit.code,
      conversation_id: conversation,
    });
    let accountWaiting = exit.termination_reason === "account_switch";
    try {
      if (
        accountBinding &&
        accountFailure &&
        !permissionFailure &&
        !this.engine.store.get("run_stop", run.id) &&
        !exit.termination_reason &&
        (!previous || accountTurn.canAttributeFailureToCurrentTurn()) &&
        (exit.code !== 0 || failure)
      )
        accountWaiting = await this.accountBridge!.observeFailure(
          accountBinding,
          accountFailure,
        );
    } finally {
      if (accountBinding)
        await this.accountBridge?.releaseRun(
          run.id,
          exit.code === 0 && !failure,
          accountWaiting ? "account_switch" : undefined,
        );
    }
    if (permissionFailure) {
      retainConversation(conversation);
      throw permissionFailure;
    }
    if (
      exit.code !== 0 ||
      exit.termination_reason ||
      failure ||
      this.engine.store.get("run_stop", run.id)
    ) {
      const recovered =
        purpose === "aside" && !exit.termination_reason
          ? recoverAsideAnswer(final, text)
          : undefined;
      if (recovered) return { answer: recovered };
      const diagnostic =
        failure ?? (redact(stderrTail).trim() || "CLI 未正常完成");
      const classified = classifyFailure(diagnostic);
      const code =
        this.engine.store.get("run_stop", run.id) ||
        exit.termination_reason === "manual"
          ? "RUN_REVOKED"
          : accountWaiting
            ? "AGY_ACCOUNT_WAIT"
            : exit.termination_reason === "timeout"
              ? "TIMEOUT"
              : classified.code === "EXECUTION_FAILED"
                ? "NATIVE_RUN_FAILED"
                : classified.code;
      retainConversation(conversation);
      throw normalizeRuntimeFailure(
        new FlowError(code, diagnostic, 422, {
          diagnostic,
          exit_code: exit.code,
          termination_reason: exit.termination_reason,
          adapter: profile.adapterId,
          executable: invocation.executable,
          executable_ref: profile.executableRef,
          model: profile.modelId,
        }),
      );
    }
    if (taskStrategy === "legacy" && conversation && purpose !== "aside") {
      this.engine.store.put("native_conversation", sessionKey, w.id, {
        id: conversation,
        profile,
        run_id: run.id,
      });
      if (!readOnlyPurpose(purpose))
        this.engine.store.put("conversation", w.id, w.id, {
          id: conversation,
          profile,
          run_id: run.id,
        });
    }
    if (existsSync(output)) {
      try {
        final = JSON.parse(readFileSync(output, "utf8"));
      } catch {
        if (purpose !== "aside")
          final = { summary: readFileSync(output, "utf8") };
      }
    }
    if (final === undefined) {
      const match = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
      try {
        final = JSON.parse(match?.[1] ?? text);
      } catch (error) {
        if (purpose === "aside") {
          const recovered = recoverAsideAnswer(undefined, text);
          if (recovered) final = { answer: recovered };
          else throw error;
        } else {
          final = { summary: text };
        }
      }
    }
    if (purpose === "aside") {
      const recovered = recoverAsideAnswer(final, text);
      if (recovered) {
        atomicWrite(output, JSON.stringify({ answer: recovered }, null, 2));
        return { answer: recovered };
      }
    }
    atomicWrite(output, JSON.stringify(final, null, 2));
    return normalizeModelOutput(final);
  }
}

export function invokePrompt(
  purpose: string,
  handoff: string,
  schemaPath: string,
  continuation?: RunContinuation,
  recoveryGuidance?: string,
) {
  if (purpose === "aside")
    return joinPrompt(asidePrompt(handoff, schemaPath), recoveryGuidance);
  if (continuation?.kind === "intent_clarification")
    return joinPrompt(
      INTENT_CLARIFICATION_INSTRUCTION +
        "。请读取工作包 " +
        handoff +
        "。必须按 " +
        schemaPath +
        " 返回一个 JSON 对象作为最终回答。",
      recoveryGuidance,
    );
  if (purpose === "quality_review") {
    return joinPrompt(
      "任务工作包：" +
        handoff +
        "。先读取当前工作包中的角色职责、任务正文与批准设计；引用材料仅按本次任务及当前角色判断所必需的范围读取。" +
        "不要求遍历测试报告、执行日志、证明附件；这些缺失不触发代码整改。历史材料只作为背景，不自动产生新的流程或证明任务。" +
        "按 " +
        schemaPath +
        " 返回一个 JSON 对象作为最终回答。禁止额外创建替代计划。",
      recoveryGuidance,
    );
  }
  return joinPrompt(
    "任务工作包及唯一正式计划材料：" +
      handoff +
      "。先读取当前工作包中的角色职责、任务正文与批准设计；引用材料仅按本次任务及当前角色判断所必需的范围读取。" +
      "必要实现材料按当前需求读取，不将历史证明要求自动继承为新待办。历史材料只作为背景，不自动产生新的流程或证明任务。" +
      "按 " +
      schemaPath +
      " 返回一个 JSON 对象作为最终回答。禁止额外创建替代计划。",
    recoveryGuidance,
  );
}

function asideQuestionMaterials(
  engine: Engine,
  w: Workflow,
  question: {
    question: string;
    refs: unknown[];
    plan_revision?: number;
    plan_hash?: string;
  },
  plan: ReturnType<typeof readPlanMaterial> | null,
) {
  return {
    kind: "temporary_question",
    isolation:
      "独立临时问答，不是主任务。不得接管、续写或修改主流程、代码、计划或工作流。",
    question: {
      question: question.question,
      plan_revision: question.plan_revision,
      plan_hash: question.plan_hash,
    },
    refs: question.refs ?? [],
    workflow: {
      id: w.id,
      state: w.state,
      request: w.request,
      plan_revision: w.plan_revision,
    },
    main_run: asideMainRunSummary(engine, w),
    plan: plan
      ? {
          revision: plan.revision,
          hash: plan.hash,
          markdown: plan.markdown,
        }
      : null,
    plan_summary: asidePlanSummary(plan),
    previous_questions: asidePreviousAnswers(engine, w, question.plan_revision),
  };
}

function asideMainRunSummary(engine: Engine, w: Workflow) {
  if (!w.run_id) return null;
  const run = engine.store.get<Run>("run", w.run_id);
  if (!run) return null;
  return {
    id: run.id,
    purpose: run.purpose,
    stage: run.stage,
    status: run.status,
    adapter: run.adapter,
  };
}

function asidePlanSummary(plan: ReturnType<typeof readPlanMaterial> | null) {
  if (!plan) return null;
  const native = plan.plan;
  return {
    revision: plan.revision,
    hash: plan.hash,
    design_summary: native.design_ref?.summary,
    modules: (native.modules ?? []).map((module) => ({
      id: module.id,
      title: module.title,
    })),
    work_items: (native.work_items ?? []).map((item) => ({
      id: item.id,
      title: item.title,
    })),
  };
}

function asidePreviousAnswers(
  engine: Engine,
  w: Workflow,
  planRevision?: number,
) {
  if (!planRevision) return [];
  return engine.store
    .list<any>("aside_session", w.id)
    .filter(
      (q) => q.plan_revision === planRevision && q.status === "completed",
    )
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(-10)
    .map((q) => ({ question: q.question, answer: q.answer }));
}

function asidePrompt(handoff: string, schemaPath: string) {
  return (
    "这是独立的临时问答，不是主任务执行。主任务仍在另一进程继续，你不得接管、续写、修改代码/计划/工作流，也不得把这个问题当成新的开发任务。只阅读工作包中的问题、任务摘要和用户引用，直接回答用户问题。请读取工作包 " +
    handoff +
    "。必须按 " +
    schemaPath +
    ' 返回 JSON 对象 {"answer":"..."} 作为最终回答。'
  );
}

function recoverAsideAnswer(value: unknown, text = "") {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { answer?: unknown }).answer === "string"
  ) {
    const answer = (value as { answer: string }).answer.trim();
    if (answer) return answer;
  }
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(
      trimmed.replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/m, "$1"),
    );
    return recoverAsideAnswer(parsed, "");
  } catch {
    return trimmed;
  }
}

function requireAsideAnswer(value: unknown) {
  const answer = recoverAsideAnswer(value);
  if (!answer) throw new Error("模型没有返回提问回答");
  return answer;
}

const conversationServices = new WeakMap<Store, ConversationService>();

export function conversationServiceOf(store: Store): ConversationService {
  const existing = conversationServices.get(store);
  if (existing) return existing;
  const created = new ConversationService(store);
  conversationServices.set(store, created);
  return created;
}

export function acceptDecodedConversation(
  telemetry: RunTelemetry,
  decoded: NativeConversationEvent[],
  raw?: unknown,
) {
  if (decoded.length) {
    for (const event of decoded) telemetry.accept(event);
    return true;
  }
  if (raw !== undefined) telemetry.accept(raw);
  return false;
}

export function bindRunConversationObserver(input: {
  store: Store;
  workflow: Workflow;
  run: Run;
  adapter: NativeAgentAdapter;
  telemetry: RunTelemetry;
  previousNativeId?: string;
  onRootSession?: (nativeId: string) => void;
}) {
  const conversations = conversationServiceOf(input.store);
  if (input.adapter.subagents) {
    conversations.setCapabilities(input.workflow.id, input.adapter.subagents);
  }
  const ctx: ConversationApplyContext = {
    project_id: input.workflow.project_id,
    workflow_id: input.workflow.id,
    run_id: input.run.id,
    adapter_id: input.run.profile?.adapterId ?? input.run.adapter,
    scope: input.run.purpose ?? input.run.stage,
    lineage_id: `${input.workflow.id}:${input.run.purpose ?? input.run.stage}:${input.run.adapter}`,
    purpose: input.run.purpose ?? input.run.stage,
    root_native_id: input.previousNativeId,
  };
  const observer = new ConversationObserver({ service: conversations, context: ctx });
  observer.start();
  hookTelemetryObserverStop(input.telemetry, observer);
  input.telemetry.bindConversationObserver({
    applyConversationEvent(event, route) {
      const applied = conversations.applyEvent(ctx, event);
      if (applied.node && applied.attempt) {
        conversationRecoveryOf(input.store).observeAttempt(input.workflow.id, {
          conversation_id: applied.node.id,
          run_id: input.run.id,
          status: applied.attempt.status,
          native_session_id: applied.node.native_session_id,
          native_agent_id: applied.node.native_agent_id,
          parent_id: applied.node.parent_id,
        });
      }
      const child = applied.node;
      if (child && isAppliedConversationChild(child, route)) {
        addBoundConversationSource(observer, input.adapter, ctx, event, child);
      }
      if (!shouldApplyRootSessionIdentity(route)) return;
      const nativeId = route.nativeConversationId ?? route.nativeRootId;
      if (!nativeId) return;
      ctx.root_native_id = ctx.root_native_id ?? nativeId;
      if (applied.node) {
        ctx.conversation_id = applied.node.root_id;
        input.telemetry.bindConversationContext({
          conversation_id: applied.node.id,
          conversation_attempt_id: applied.attempt?.id,
          root_conversation_id: applied.node.root_id,
        });
      }
      input.onRootSession?.(nativeId);
    },
  });
}

function hookTelemetryObserverStop(
  telemetry: RunTelemetry,
  observer: ConversationObserver,
) {
  const finish = telemetry.finish.bind(telemetry);
  telemetry.finish = (failed = false) => {
    void observer.stop();
    finish(failed);
  };
}

function isAppliedConversationChild(
  node: ConversationNode | undefined,
  route: ConversationTelemetryRoute,
): boolean {
  if (!node) return false;
  if (node.parent_id) return true;
  if (node.kind === "subagent") return true;
  return route.scope === "child";
}

function addBoundConversationSource(
  observer: ConversationObserver,
  adapter: NativeAgentAdapter,
  ctx: ConversationApplyContext,
  event: NativeConversationEvent,
  node: ConversationNode,
) {
  if (!adapter.readConversationEvents) return;
  const recordSource: ConversationRecordSource = {
    adapterId: ctx.adapter_id,
    capabilities: () => adapter.subagents ?? unknownSubagentCapabilities(),
    readEvents: (cursor) => adapter.readConversationEvents!(cursor),
  };
  for (const sourceId of childObserverSourceIds(ctx.adapter_id, event, node)) {
    observer.addSource({
      source_id: sourceId,
      adapter_id: ctx.adapter_id,
      conversation_id: node.id,
      record_source: recordSource,
    });
  }
}

function childObserverSourceIds(
  adapterId: string,
  event: NativeConversationEvent,
  node: ConversationNode,
): string[] {
  const ids = [event.source_id];
  if (node.native_agent_id) {
    ids.push(`${adapterId}:transcript:${node.native_agent_id}`);
  }
  if (node.native_session_id) {
    ids.push(`${adapterId}:session:${node.native_session_id}`);
  }
  return [...new Set(ids)];
}

function attachmentIdsFromConversation(
  engine: Engine,
  workflowId: string,
): Set<string> {
  const ids = new Set<string>();
  for (const file of engine.store.list<ConversationFile>(
    CONVERSATION_ENTITY.file,
    workflowId,
  )) {
    if ((file.referenced_message_ids?.length ?? 0) > 0) ids.add(file.id);
  }
  for (const message of engine.store.list<{ attachment_ids?: string[] }>(
    CONVERSATION_ENTITY.message,
    workflowId,
  )) {
    for (const fileId of message.attachment_ids ?? []) ids.add(fileId);
  }
  for (const message of engine.store.list<{ attachment_ids?: string[] }>(
    "feedback_message",
    workflowId,
  )) {
    for (const fileId of message.attachment_ids ?? []) ids.add(fileId);
  }
  return ids;
}

function readyConversationInputFiles(engine: Engine, workflow: Workflow) {
  const wanted = attachmentIdsFromConversation(engine, workflow.id);
  return engine.store
    .list<ConversationFile>(CONVERSATION_ENTITY.file, workflow.id)
    .filter((file) => file.status === "ready" && wanted.has(file.id));
}

function resolveRunConversationAttachments(
  engine: Engine,
  workflow: Workflow,
  profile: ToolProfile,
) {
  const files = readyConversationInputFiles(engine, workflow);
  if (!files.length) {
    return { attachments: [], extraReadRoots: [] as string[] };
  }
  const tree = conversationServiceOf(engine.store).getTree(workflow.id);
  const resolved = resolveConversationInputAttachments({
    files,
    storageRoot: engine.config.storage_root,
    workflowId: workflow.id,
    profile,
    fileInput: tree.capabilities.file_input,
  });
  if (!resolved.ok) {
    throw new FlowError(resolved.code, resolved.message, 422);
  }
  return {
    attachments: resolved.attachments,
    extraReadRoots: resolved.extraReadRoots,
  };
}

const conversationRecoveries = new WeakMap<Store, ConversationRecovery>();

export function bindConversationRecovery(
  store: Store,
  recovery: ConversationRecovery,
) {
  conversationRecoveries.set(store, recovery);
}

export function conversationRecoveryOf(store: Store): ConversationRecovery {
  const existing = conversationRecoveries.get(store);
  if (existing) return existing;
  const conversations = conversationServiceOf(store);
  const created = new ConversationRecovery({
    store,
    conversations,
    controls: new ConversationControlService(store, conversations, {
      async stopConversation() {
        return { accepted: false, confirmation: "unknown" };
      },
    }),
    runPort: storeRecoveryRunPort(store),
  });
  conversationRecoveries.set(store, created);
  return created;
}

export function engineRecoveryRunPort(engine: Engine): RecoveryRunPort {
  const stored = storeRecoveryRunPort(engine.store);
  return {
    createRun(request) {
      const run = stored.createRun(request);
      if (request.continuation) {
        saveRunContinuation(
          engine.store,
          request.run_id,
          request.workflow_id,
          request.continuation,
        );
      }
      return run;
    },
    observeAttempt(observation) {
      if (!observation.run_id || observation.parent_id) return;
      const run = engine.store.get<Run>("run", observation.run_id);
      if (!run) return;
      engine.store.put("run", run.id, run.workflow_id, {
        ...run,
        conversation_id: observation.conversation_id,
      });
    },
  };
}

export function readRoleRecoveryGuidance(
  engine: Engine,
  workflow: Workflow,
  run: Pick<
    Run,
    "id" | "purpose" | "stage" | "adapter" | "conversation_id" | "quality_policy_version"
  > & { profile?: Run["profile"] },
  extra?: RecoveryGuidanceOptions,
): string | undefined {
  const manifest = latestRecoveryManifest(engine.store, workflow.id, run);
  if (!manifest) return undefined;
  const capabilities = conversationServiceOf(engine.store).getTree(
    workflow.id,
  ).capabilities;
  const options = {
    adapterId: extra?.adapterId ?? run.profile?.adapterId ?? run.adapter,
    attachments: extra?.attachments,
  };
  return guidanceForRunPurpose(
    run,
    workflow,
    engine,
    manifest,
    capabilities,
    options,
  );
}

export function joinPrompt(base: string, extra?: string) {
  if (!extra) return base;
  return `${base}\n${extra}`;
}

function attachmentPromptNote(
  attachments: Array<{ display_name: string }>,
): string | undefined {
  if (!attachments.length) return undefined;
  return (
    ATTACHMENT_HANDOFF_NOTICE +
    " 本次输入附件：" +
    attachments.map((item) => item.display_name).join("、") +
    "。"
  );
}

function nativePromptExtra(
  recoveryGuidance: string | undefined,
  attachments: Array<{ display_name: string }>,
): string | undefined {
  const parts = [recoveryGuidance, attachmentPromptNote(attachments)].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length ? parts.join("\n") : undefined;
}

function withHandoffAttachments(
  materials: unknown,
  attachments: Array<{ display_name: string; absolute_path: string }>,
) {
  if (!attachments.length || !materials || typeof materials !== "object")
    return materials;
  return { ...(materials as object), attachments };
}

function withRecoveryMaterials(materials: unknown, extra?: string) {
  if (!extra || !materials || typeof materials !== "object") return materials;
  return { ...(materials as object), recovery_guidance: extra };
}

function recoveryAttachmentHints(
  attachments: Array<{ display_name: string; read_mode: "text" | "image" | "binary" }>,
): RecoveryGuidanceAttachment[] | undefined {
  if (!attachments.length) return undefined;
  return attachments.map((item) => ({
    display_name: item.display_name,
    read_mode: item.read_mode,
  }));
}

function latestRecoveryManifest(
  store: Store,
  workflowId: string,
  run: Pick<Run, "id" | "conversation_id">,
): RecoveryManifest | undefined {
  const items = store.list<RecoveryManifest>(
    CONVERSATION_ENTITY.recovery,
    workflowId,
  );
  if (!items.length) return undefined;
  const matched = items.filter(
    (item) =>
      item.target_run_id === run.id ||
      item.source_run_id === run.id ||
      item.root_conversation_id === run.conversation_id,
  );
  const pool = matched.length ? matched : items;
  return pool.sort((a, b) => b.recovery_id.localeCompare(a.recovery_id))[0];
}

function guidanceForRunPurpose(
  run: Pick<Run, "purpose" | "stage" | "quality_policy_version">,
  workflow: Workflow,
  engine: Engine,
  manifest: RecoveryManifest,
  capabilities: ReturnType<ConversationService["getTree"]>["capabilities"],
  extra?: RecoveryGuidanceOptions,
) {
  const purpose = run.purpose ?? run.stage ?? "";
  if (usesPolicyV2({ quality_policy_version: run.quality_policy_version ?? workflow.quality_policy_version }) &&
      ["planner_takeover", "executor_test", "planner_commit", "functional_fix"].includes(purpose))
    return composeRoleGuidance(purpose as RecoveryGuidanceRole, manifest, capabilities, extra);
  if (purpose === "planning" || purpose === "planner_takeover")
    return planningRecoveryGuidance(manifest, capabilities, extra);
  if (purpose === "aside")
    return asideRecoveryGuidance(manifest, capabilities, extra);
  if (
    purpose === "quality_review" ||
    purpose === "review" ||
    purpose === "diagnosis"
  )
    return reviewRecoveryGuidance(manifest, capabilities, extra);
  if (
    purpose === "functional_fix" ||
    !!engine.store.get("repair_assignment", workflow.id) ||
    !!engine.store.get("repair_state", workflow.id)
  )
    return repairRecoveryGuidance(manifest, capabilities, extra);
  return executeRecoveryGuidance(manifest, capabilities, extra);
}

function latestUpdated<T extends { updated_at?: string }>(items: T[]) {
  let latest: T | undefined;
  for (const item of items) {
    if (!latest || (item.updated_at ?? "") > (latest.updated_at ?? ""))
      latest = item;
  }
  return latest;
}

function conflictRequestSummary(request: MergeConflictRequest) {
  return {
    id: request.id,
    status: request.status,
    repo_id: request.repo_id,
    conflict_paths: request.conflict_paths,
    candidate_commit: request.candidate_commit,
    source_commit: request.source_commit,
    quality_phase: request.quality_phase,
  };
}

function conflictReceiptSummary(
  request: MergeConflictRequest,
  carry: AcceptanceCarry,
) {
  return {
    status: request.status,
    conflict_paths: request.conflict_paths,
    reported_function_impact:
      request.reported_function_impact ?? carry.reported_function_impact,
    function_impact_explanation:
      request.function_impact_explanation ?? carry.function_impact_explanation,
  };
}
