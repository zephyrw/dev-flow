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
import {
  type Workflow,
  type Run,
  type Workspace,
  type Snapshot,
  ReviewSchema,
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
import { createDefaultAdapterRegistry } from "../../adapters/sdk/src/index.js";
import { readOnlyPurpose } from "../../adapters/sdk/src/invocation.js";
import type {
  NativeAgentAdapter,
  NormalizedEvent,
} from "../../adapters/sdk/src/interface.js";
import { AgyNativeRecordSource } from "../../adapters/agy/src/native-record-source.js";
import {
  NativeExecutionObserver,
} from "../../evidence/src/native-execution-observer.js";
import type { HostToolExecutionFact } from "../../evidence/src/native-run-records.js";
import type { ProcessManager } from "../../process/src/manager.js";
import { classifyFailure, normalizeRuntimeFailure } from "./errors.js";
import { RunTelemetry } from "./run-telemetry.js";
import { CodexSessionObserver } from "./codex-session-observer.js";
import { observeCodexAccountQuota } from "./codex-account-quota.js";
import { readPlanMaterial } from "../../core/src/plan-review.js";
import type { SourceInput } from "../../core/src/source-change.js";
import { batchExecutionInstructions } from "../../core/src/execution-guidance.js";
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

export class ProfileRuntime {
  constructor(
    private engine: Engine,
    private processes: ProcessManager,
  ) {}
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
              "只读诊断故障。按当前唯一正式计划定位根因，给出确定修复步骤；需要改变范围时返回完整正式计划并等待批准。禁止另建替代计划。",
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
      instructions:
        "合并发生代码冲突。严格在原批准计划和正式整改范围内解决冲突，同时保留双方有效需求。禁止统一使用 ours/theirs、reset、stash 或删除历史。完成后返回结构化回执，不得自行提交 Git 或删除工作树。",
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
      modelOutputSchema(
        ReviewSchema,
        this.workspaces(w).map((ws) => ws.repo_id),
      ),
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
    return this.continuationMaterials(
      {
        instructions:
          "严格按原始正式计划和批准的整改正文完成全部开发任务及测试代码，再由多个子 Agent 并行运行独立的单元、集成和 E2E 目标，各自修复并重跑。不得另建或执行替代计划。发现计划矛盾应报告阻塞。完成后说明本轮结果，直接交代码审查。报告可附，不为调用 ID、清单或 hash 重跑测试。不得自行提交 Git 或宣布人工验收通过。",
        execution_order: batchExecutionInstructions,
        workflow: w,
        run,
        plan,
        authorities: this.engine.planSelfCheck.authorities(w),
        feedback: this.engine.store.list("feedback_message", w.id),
        functional_issues: this.engine.store.list("functional_issue", w.id),
        project: this.engine.project(w.project_id),
        workspaces: this.workspaces(w),
        repair_assignment:
          this.engine.store.get("repair_assignment", w.id) ?? null,
        repair_instructions:
          this.engine.store.get<any>("repair_state", w.id)?.instructions ??
          this.engine.store.get<any>("repair_assignment", w.id)?.instructions ??
          null,
        completion_instruction:
          "最终输出 JSON {status, summary, notes, artifacts}。status 只能是 completed、need_planner 或 need_user。未知状态不会被当成完成。",
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
    return this.continuationMaterials(
      {
        instructions: reviewInstructions,
        skill_resources: reviewSkillResources(),
        review_contract: reviewContractContext(this.engine, w, run),
        workflow: w,
        run,
        phase,
        cycle: this.engine.quality.getOrCreateGate(w.id, phase).cycle,
        plan: this.engine.plan(w.id),
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
    return this.engine.store.get<PlanningHandoff>("planning_handoff", workflowId);
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
    const adapter = createDefaultAdapterRegistry().mustGet(profile.adapterId);
    const root = join(this.engine.config.storage_root, "native-runs", run.id);
    mkdirSync(root, { recursive: true });
    const handoff = join(root, "HANDOFF.json"),
      output = join(root, "result.json"),
      schemaPath = join(root, "schema.json");
    atomicWrite(handoff, JSON.stringify(materials, null, 2));
    atomicWrite(schemaPath, JSON.stringify(schema));
    const purpose = run.purpose!;
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
    const resume = beginRunConversation(this.engine.store, run, fingerprint);
    const continuation = this.readContinuation(run);
    const context = {
      workflowId: w.id,
      runId: run.id,
      stage: run.stage,
      epoch: w.version,
      purpose,
      workspaceRoots: Object.fromEntries(
        workspaces.map((ws) => [ws.repo_id, ws.root]),
      ),
      allowedPaths: w.plan_revision
        ? this.engine.plan(w.id).plan.scope.allowed_paths
        : [],
      toolProfile: profile,
      frozenInvocation: run.frozen_invocation,
      handoffDocPath: handoff,
      outputPath: output,
      schemaPath,
      timeoutMs: Math.max(
        1,
        (run.deadline_at ?? Date.now() + 300000) - Date.now(),
      ),
      prompt: invokePrompt(purpose, handoff, schemaPath, continuation),
    };
    const invocation = resume
      ? await adapter.resume({
          ...context,
          previousConversationId: resume.id,
        })
      : await adapter.prepare(context);
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
    const proc = this.processes.start({
      ...invocation,
      id: run.id,
      workflow_id: w.id,
      timeout_ms: context.timeoutMs,
      deadline_at: run.deadline_at,
      env: {
        ...invocation.env,
        ...(token ? { DEVFLOW_RUN_TOKEN: token } : {}),
        DEVFLOW_BASE_URL: "http://127.0.0.1:" + this.engine.config.server.port,
        ...(asideCodexHome ? { CODEX_HOME: asideCodexHome } : {}),
      },
    });
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
      conversation = resume?.id,
      failure: string | undefined,
      stderrTail = "";
    let permissionFailure: FlowError | undefined;
    const retainConversation = (session?: string) => {
      if (!session) return;
      if (resume && resume.id !== session) return;
      retainRunConversation(this.engine.store, run, session, fingerprint);
    };
    const handle = (event: NormalizedEvent) => {
      const v = event.raw as any;
      if (v && typeof v === "object") {
        telemetry.accept(v);
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
        const session =
          v.thread_id ??
          v.session_id ??
          v.sessionId ??
          v.conversation_id ??
          v.init?.conversation_id;
        if (typeof session === "string") {
          if (resume && session !== resume.id)
            failure = "会话 ID 与精确续接目标不一致";
          conversation = session;
          retainConversation(session);
          sessionObserver?.bind(session);
        }
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
      for (const event of adapter.decode({
        stream,
        data,
        timestamp: now(),
        runId: run.id,
        final: finalChunk,
      })) {
        if (stream === "stdout") handle(event);
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
        !exit || exit.code !== 0 || !!exit.termination_reason || !!failure || !!permissionFailure,
      );
    }
    // Native session scanning may discover the ID without a stdout init event.
    conversation ??= this.engine.store.get<Run>("run", run.id)?.conversation_id;
    retainConversation(conversation);
    this.engine.store.put("run", run.id, w.id, {
      ...this.engine.store.must<Run>("run", run.id),
      exit_code: exit.code,
      conversation_id: conversation,
    });
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
        purpose === "aside" ? recoverAsideAnswer(final, text) : undefined;
      if (recovered) return { answer: recovered };
      const diagnostic =
        failure ?? (redact(stderrTail).trim() || "CLI 未正常完成");
      const classified = classifyFailure(diagnostic);
      const code =
        this.engine.store.get("run_stop", run.id) ||
        exit.termination_reason === "manual"
          ? "RUN_REVOKED"
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
    retainConversation(conversation);
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

function invokePrompt(
  purpose: string,
  handoff: string,
  schemaPath: string,
  continuation?: RunContinuation,
) {
  if (purpose === "aside") return asidePrompt(handoff, schemaPath);
  if (continuation?.kind === "intent_clarification")
    return (
      INTENT_CLARIFICATION_INSTRUCTION +
      "。请读取工作包 " +
      handoff +
      "。必须按 " +
      schemaPath +
      " 返回一个 JSON 对象作为最终回答。"
    );
  return (
    "完整任务及唯一正式计划材料：" +
    handoff +
    "。必须先阅读全部材料和引用文件；按 " +
    schemaPath +
    " 返回一个 JSON 对象作为最终回答。禁止额外创建替代计划。"
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
