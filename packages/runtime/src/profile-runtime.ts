import { mkdirSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { z } from "zod";
import type { Engine } from "../../core/src/engine.js";
import { profileForRun, bindProfile } from "../../core/src/run-profile.js";
import {
  diagnosisOutputSchema,
  parseDiagnosisOutput,
} from "../../contracts/src/diagnosis-output.js";
import { PLAN_SELF_CHECK_STAGE } from "../../core/src/plan-self-check.js";
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
  DeliveryManifestSchema,
  requireCondition,
  FlowError,
  MergeConflictReceiptSchema,
  type MergeConflictRequest,
  type MergeConflictReceipt,
} from "../../contracts/src/index.js";
import { git, repositoryInfo } from "../../git/src/git.js";
import { NativePlanSchema } from "../../contracts/src/native-plan.js";
import { PlanSelfCheckReportSchema } from "../../contracts/src/plan-self-check.js";
import {
  modelOutputSchema,
  parseReviewOutput,
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
  captureInputs,
  captureReports,
} from "../../evidence/src/native-execution-observer.js";
import type { HostToolExecutionFact } from "../../evidence/src/native-run-records.js";
import type { ProcessManager } from "../../process/src/manager.js";
import { classifyFailure } from "./errors.js";
import { rejectedDeliveryFeedback } from "../../core/src/delivery-feedback.js";
import { readPlanMaterial } from "../../core/src/plan-review.js";
import type { SourceInput } from "../../core/src/source-change.js";
import { batchExecutionInstructions } from "../../core/src/execution-guidance.js";

/** One native process per purpose. No model polling, scheduler or shadow execution plan. */
export class ProfileRuntime {
  constructor(
    private engine: Engine,
    private processes: ProcessManager,
  ) {}
  async plan(w: Workflow, run: Run) {
    const workspaces = await this.planningWorkspaces(w);
    const selectedSource = this.engine.store.get<SourceInput>("source_input", w.id);
    const schema = z.object({
      markdown: z.string().min(1),
      plan: NativePlanSchema,
    });
    const response = await this.invoke(
      w,
      run,
      {
        instructions:
          "你是规划模型。读取需求及引用的真实工作区文件，返回唯一正式计划。包含完整需求、确定实施步骤、单元/集成/E2E场景及受影响旧功能回归；等待用户批准后才实施。只读，不修改代码。如果提供 current_plan，须在同一任务中按用户的规划反馈修正该计划，逐条回应修改意见并提交完整新版，不能自行批准或启动实施。",
        current_plan: w.plan_revision
          ? readPlanMaterial(this.engine.store, w.id, w.plan_revision)
          : null,
        selected_source: selectedSource?.plan_hash === w.plan_hash ? selectedSource : null,
        requirements: this.engine.store.list("requirement_message", w.id),
        request: w.request,
        project: this.engine.project(w.project_id),
        feedback: this.engine.store.list("feedback_message", w.id),
        baselines: Object.fromEntries(
          workspaces.map((ws) => [ws.repo_id, ws.baseline]),
        ),
        project_config_hash: objectHash(this.engine.project(w.project_id)),
      },
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
      "quality_review",
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
      {
        instructions:
          "你是本任务的规划模型。只读回答当前问题，结合所附计划完整正文解释细节，尽量指出对应章节。提问不表示驳回或批准，不修改计划或代码，不接管主任务，不形成正式反馈。需要改变计划时只说明建议，由用户决定是否驳回修正。",
        question,
        request: w.request,
        current_state: w.state,
        plan,
        previous_questions: question.plan_revision
          ? this.engine.store
              .list<any>("aside_session", w.id)
              .filter(
                (q) =>
                  q.plan_revision === question.plan_revision &&
                  q.status === "completed",
              )
              .sort((a, b) => a.created_at.localeCompare(b.created_at))
              .slice(-10)
              .map((q) => ({ question: q.question, answer: q.answer }))
          : [],
      },
      modelOutputSchema(z.object({ answer: z.string().min(1) }), []),
    );
    return z.object({ answer: z.string().min(1) }).parse(value).answer;
  }
  async execute(w: Workflow, run: Run, token: string) {
    const plan = this.engine.plan(w.id);
    const check =
      run.stage === PLAN_SELF_CHECK_STAGE
        ? this.engine.planSelfCheck.current(w.id)
        : null;
    const materials = {
      instructions: check
        ? "程序强制计划自查：先完整核对原始正式计划与全部正式整改正文，按 check.check_ids 汇总全部遗漏及根因，再完成整批修复，最后统一测试。最终 delivery.plan_self_check 填写给定 schema。不得另建或执行 implementation_plan.md 等替代计划。"
        : "严格按原始正式计划和批准的整改正文完成全部开发与单元/集成/E2E测试，覆盖新流程及受影响旧逻辑。不得另建或执行替代计划。发现计划矛盾应报告阻塞。完成后返回 delivery 交付清单，不得自行提交 Git 或宣布人工验收通过。",
      execution_order: batchExecutionInstructions,
      workflow: w,
      run,
      plan,
      authorities: this.engine.planSelfCheck.authorities(w),
      check,
      check_schema: z.toJSONSchema(PlanSelfCheckReportSchema),
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
      delivery_feedback: rejectedDeliveryFeedback(this.engine.store, w),
      delivery_instruction:
        "测试报告放入 .reports/；测试声明须匹配本轮真实工具命令、退出码、报告及验收项，不能制造宿主记录。最终输出 JSON {delivery: ...}。",
    };
    const value = await this.invoke(
      w,
      run,
      materials,
      modelOutputSchema(
        z.object({ delivery: DeliveryManifestSchema }),
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
    const parsed = z.object({ delivery: DeliveryManifestSchema }).parse(value);
    const currentRun = this.engine.store.must<Run>("run", run.id);
    const delivery = {
      schema_version: "v2",
      workflow_id: w.id,
      run_id: run.id,
      conversation_id: currentRun.conversation_id,
      plan_revision: w.plan_revision,
      plan_hash: w.plan_hash,
      ...parsed.delivery,
    };
    const result = await this.engine.deliver(w.id, delivery);
    if (result.status !== "accepted")
      throw new FlowError("DELIVERY_REJECTED", result.message, 422, {
        delivery_id: result.delivery_id,
        issues: result.issues,
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
    const snapshot = this.engine.store.must<Snapshot>(
      "snapshot",
      w.snapshot_id!,
    );
    const phase =
      w.stage === "quality_before_human" ? "before_human" : "after_human";
    const value = await this.invoke(
      w,
      run,
      {
        instructions:
          "你是独立质量复核者。只读审查所有改动文件、原始计划及正式整改版本、上下游及真实测试证据。执行模型自查不是审查结论。全部覆盖才可通过；有问题必须返回完整 repair_plan、repair_document 正文及 quality 的逐项确定性整改合同。禁止另写局部替代计划。quality.document_hash 为完整 repair_document 的 SHA-256；每项绑定下一计划版本。",
        workflow: w,
        run,
        phase,
        cycle: this.engine.quality.getOrCreateGate(w.id, phase).cycle,
        feedback_cursor: Math.max(
          0,
          ...this.engine.store
            .list<any>("feedback_message", w.id)
            .map((m) => m.seq),
        ),
        plan: this.engine.plan(w.id),
        authorities: this.engine.planSelfCheck.authorities(w),
        executor_plan_check: this.engine.planSelfCheck.current(w.id),
        snapshot,
        diff: await this.engine.git.diff(snapshot),
        deliveries: this.engine.store.list("delivery", w.id),
        evidence: this.engine.getEvidence(w.id),
        acceptance: this.engine.store.get("acceptance", w.id) ?? null,
        project: this.engine.project(w.project_id),
        skill: readFileSync(this.reviewSkill(), "utf8"),
      },
      modelOutputSchema(
        ReviewSchema,
        this.workspaces(w).map((ws) => ws.repo_id),
      ),
    );
    return parseReviewOutput(value);
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
    // Read-only review/aside always starts a separate conversation; implementation resumes only the exact profile.
    const sessionKey =
      w.id +
      ":" +
      objectHash(profile) +
      ":" +
      (["implement", "plan_self_check", "functional_fix"].includes(purpose)
        ? "execution"
        : purpose);
    const previous =
      purpose === "planning" || !readOnlyPurpose(purpose)
        ? this.engine.store.get<{ id: string }>(
            "native_conversation",
            sessionKey,
          )
        : undefined;
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
      handoffDocPath: handoff,
      outputPath: output,
      schemaPath,
      timeoutMs: Math.max(
        1,
        (run.deadline_at ?? Date.now() + 300000) - Date.now(),
      ),
      prompt:
        "完整任务及唯一正式计划材料：" +
        handoff +
        "。必须先阅读全部材料和引用文件；按 " +
        schemaPath +
        " 返回一个 JSON 对象作为最终回答。禁止额外创建替代计划。",
    };
    const invocation = previous
      ? await adapter.resume({
          ...context,
          previousConversationId: previous.id,
        })
      : await adapter.prepare(context);
    const baseline = readOnlyPurpose(purpose)
      ? captureInputs(workspaces)
      : undefined;
    const pending = new Map<
      string,
      {
        fact: HostToolExecutionFact;
        reports: ReturnType<typeof captureReports>;
      }
    >();
    const save = (fact: HostToolExecutionFact) =>
      this.engine.store.put(
        "native_execution",
        run.id + ":" + hash(fact.tool_call_id),
        run.id,
        fact,
      );
    adapter.onExecutionFact = (fact) => {
      if (!fact.ended_at && !pending.has(fact.tool_call_id)) {
        let entry: HostToolExecutionFact = {
          ...fact,
          workflow_id: w.id,
          run_id: run.id,
          plan_hash: w.plan_hash,
        };
        try {
          entry.input_fingerprints = captureInputs(workspaces);
          pending.set(fact.tool_call_id, {
            fact: entry,
            reports: captureReports(
              workspaces,
              this.engine.project(w.project_id).commands,
            ),
          });
        } catch (e) {
          entry.evidence_error = String(e);
          pending.set(fact.tool_call_id, { fact: entry, reports: {} });
        }
      } else if (fact.ended_at && pending.has(fact.tool_call_id)) {
        const before = pending.get(fact.tool_call_id)!;
        pending.delete(fact.tool_call_id);
        const final = { ...before.fact, ...fact };
        try {
          requireCondition(
            objectHash(final.input_fingerprints) ===
              objectHash(captureInputs(workspaces)),
            "INPUT_CHANGED",
            "测试期间源码发生变化",
          );
          final.report_hashes = {};
          for (const [key, value] of Object.entries(
            captureReports(
              workspaces,
              this.engine.project(w.project_id).commands,
            ),
          ))
            if (before.reports[key]?.version !== value.version)
              final.report_hashes[key] = value.hash;
        } catch (e) {
          final.evidence_error = String(e);
        }
        save(final);
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
      },
    });
    let final: unknown,
      text = "",
      conversation = previous?.id,
      failure: string | undefined;
    let permissionFailure: FlowError | undefined;
    const handle = (event: NormalizedEvent) => {
      const v = event.raw as any;
      if (v && typeof v === "object") {
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
          if (previous && session !== previous.id)
            failure = "会话 ID 与精确续接目标不一致";
          conversation = session;
        }
        if (v.is_error === true || v.type === "error" || v.event === "error")
          failure = "CLI 返回错误：" + redact(JSON.stringify(v)).slice(0, 2000);
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
        consume("stderr", data);
      } catch (e) {
        failure = String(e);
        void proc.stop();
      }
    });
    const exit = await proc.completion;
    consume("stdout", "", true);
    consume("stderr", "", true);
    this.engine.store.put("run", run.id, w.id, {
      ...this.engine.store.must<Run>("run", run.id),
      exit_code: exit.code,
      conversation_id: conversation,
    });
    if (permissionFailure) {
      // A denied operation still belongs to a real session. Preserve its exact
      // identity for an explicitly authorized resume; never silently start over.
      if (
        !readOnlyPurpose(purpose) &&
        conversation &&
        !failure &&
        (!previous || previous.id === conversation)
      ) {
        this.engine.store.put("native_conversation", sessionKey, w.id, {
          id: conversation,
          profile,
          run_id: run.id,
        });
        this.engine.store.put("conversation", w.id, w.id, {
          id: conversation,
          profile,
          run_id: run.id,
        });
      }
      throw permissionFailure;
    }
    requireCondition(
      exit.code === 0 &&
        !exit.termination_reason &&
        !failure &&
        !this.engine.store.get("run_stop", run.id),
      "NATIVE_RUN_FAILED",
      failure ?? "CLI 未正常完成",
    );
    if (baseline)
      requireCondition(
        objectHash(baseline) === objectHash(captureInputs(workspaces)),
        "READ_ONLY_VIOLATION",
        "只读阶段修改了工作区，结论作废",
      );
    if (conversation) {
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
    if (existsSync(output)) final = JSON.parse(readFileSync(output, "utf8"));
    if (final === undefined) {
      const match = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
      final = JSON.parse(match?.[1] ?? text);
    }
    atomicWrite(output, JSON.stringify(final, null, 2));
    return normalizeModelOutput(final);
  }
}
