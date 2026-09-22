import { BEFORE_HUMAN_REVIEW_STAGE } from "../../core/src/plan-self-check.js";
import { AgyNativeRecordSource } from "../../adapters/agy/src/native-record-source.js";
import { RunTelemetry } from "./run-telemetry.js";
import { CodexSessionObserver } from "./codex-session-observer.js";
import { observeCodexAccountQuota } from "./codex-account-quota.js";
import { rejectedDeliveryFeedback } from "../../core/src/delivery-feedback.js";
import { batchExecutionInstructions } from "../../core/src/execution-guidance.js";
import { NativeExecutionObserver } from "../../evidence/src/native-execution-observer.js";
import { reconcileImplementationProofs } from "../../core/src/progress.js";
import { isLegacyProtocol } from "../../core/src/run-profile.js";
import { assertMeaningfulTestFiles } from "../../core/src/test-quality.js";
import type { OperationRequest } from "../../core/src/interactions.js";
import {
  diagnosisOutputSchema,
  parseDiagnosisOutput,
} from "../../contracts/src/diagnosis-output.js";
import {
  mkdirSync,
  readFileSync,
  existsSync,
  unlinkSync,
  appendFileSync,
} from "node:fs";
import { join, resolve, isAbsolute, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { z } from "zod";
import {
  reviewOutputSchema,
  normalizeModelOutput,
} from "../../contracts/src/review-output.js";
import type { Engine, Runtime } from "../../core/src/engine.js";
import type { Principal } from "../../core/src/auth.js";
import { CliDispatchManager } from "./cli-dispatch.js";
import {
  requireCondition,
  FlowError,
  ReviewSchema,
  resolveTaskModel,
  type Workflow,
  type Run,
  type ToolProfile,
  type Evidence,
  type Snapshot,
  type Workspace,
  type MergeConflictRequest,
} from "../../contracts/src/index.js";
import type { RuntimeFlavor } from "../../contracts/src/model-routing.js";
import {
  bindProfile,
  resolveRuntimeFlavor,
  runLauncherSelection,
  type RunPurpose,
} from "../../core/src/run-profile.js";
import { beginRunConversation, retainRunConversation } from "../../core/src/conversation-lineage.js";
import { ProcessManager, type ProcessStopResult } from "../../process/src/manager.js";
import { executablePath } from "../../process/src/executable.js";
import { JsonLines, AgyProtocol } from "../../adapters/agy/src/protocol.js";
import {
  atomicWrite,
  hash,
  id,
  now,
  objectHash,
  redact,
  publicEvent,
} from "../../core/src/util.js";
import { evaluateReport, parseReport } from "../../evidence/src/parse.js";
import { Environments, expand } from "./environment.js";
import { BrowserGateway } from "./browser.js";
import { takeReportSlot, cleanArchivedReports } from "./report-output.js";
import { safePath } from "../../workspace/src/files.js";
import {
  writeAgyConfiguration,
  agyArguments,
  observeAgy,
} from "../../adapters/agy/src/session.js";
import { writeAgyNativeConfiguration } from "../../adapters/agy/src/native-adapter.js";
import {
  HandoffBuilder,
  nativeLaunchInstruction,
} from "../../adapters/agy/src/handoff.js";
import { BufferedEventSink } from "../../core/src/buffered-sink.js";
import { AgyWorkflowBridge } from "./agy-workflow-bridge.js";
import { AgyAccountProcessHost } from "../../process/src/agy-account-processes.js";
import type { AgyAccountService } from "../../agy-accounts/src/service.js";
import { CurrentTurn } from "../../adapters/agy/src/current-turn.js";
import {
  classifyAgyFailure,
  type AgyFailureFact,
} from "../../adapters/agy/src/failure-fact.js";
import {
  ProfileRuntime,
  acceptDecodedConversation,
  bindRunConversationObserver,
  joinPrompt,
  readRoleRecoveryGuidance,
} from "./profile-runtime.js";
import {
  agyEventConversationId,
  decodeAgyConversationEvent,
} from "../../adapters/agy/src/conversation-source.js";
import {
  reviewSkillResources,
  reviewContractContext,
  reviewInstructions,
} from "./review-materials.js";
import {
  INTENT_CLARIFICATION_INSTRUCTION,
  applyContinuationMaterials,
  asRunContinuation,
} from "../../core/src/round-intent.js";


export function selectRuntimePath(
  engine: Engine,
  workflow: Workflow,
  run?: Run,
): RuntimeFlavor {
  if (run?.protocol === "lightweight") return "profile-native";
  if (run?.runtime_flavor) return run.runtime_flavor;
  if (run?.protocol === "legacy") return "legacy-managed";
  const current = workflow.run_id
    ? engine.store.get<Run>("run", workflow.run_id)
    : undefined;
  if (current?.protocol === "lightweight") return "profile-native";
  if (current?.runtime_flavor) return current.runtime_flavor;
  if (current?.protocol === "legacy") return "legacy-managed";
  const adapter = (run?.adapter ??
    current?.adapter ??
    "agy") as ToolProfile["adapterId"];
  const purpose = (run?.purpose ?? "implement") as RunPurpose;
  return resolveRuntimeFlavor(engine.store, workflow.id, adapter, purpose);
}

function usesProfileRuntime(engine: Engine, workflow: Workflow, run?: Run) {
  return selectRuntimePath(engine, workflow, run) === "profile-native";
}

function compatibleConversation(
  engine: Engine,
  run: Run,
) {
  return beginRunConversation(engine.store, run);
}

function diagnosisLauncher(engine: Engine, workflow: Workflow) {
  const binding = bindProfile(engine.store, engine.config, workflow.id, "diagnose");
  return {
    prefix: binding.profile.options?.prefixArgs ?? [],
    launcher: runLauncherSelection({
      ...binding,
      id: workflow.run_id ?? "diagnosis",
      workflow_id: workflow.id,
      plan_revision: workflow.plan_revision,
      adapter: binding.profile.adapterId,
      stage: "diagnosis",
      status: "running",
      started_at: now(),
      package_hash: "diagnosis",
    }),
  };
}
import { createDefaultAdapterRegistry } from "../../adapters/sdk/src/index.js";
import type { NativeAgentAdapter } from "../../adapters/sdk/src/interface.js";
import {
  CONVERSATION_ENTITY,
  type ConversationAttempt,
  type ConversationNode,
} from "../../contracts/src/index.js";
import type {
  StopPort,
  StopPortResult,
  StopPortTarget,
} from "../../core/src/conversation-control.js";
import type { Store } from "../../store/src/store.js";
export class LocalRuntime implements Runtime {
  private accountBridge?: AgyWorkflowBridge;
  attachAccountService(service: AgyAccountService): AgyWorkflowBridge {
    if (this.accountBridge)
      throw new Error("AGY_ACCOUNT_SERVICE_ALREADY_ATTACHED");
    const processHost = new AgyAccountProcessHost({
      store: this.engine.store,
      hostExecutable: this.engine.config.host.executable,
      agyExecutable: executablePath(this.engine.config.models.agy_executable),
      processManager: this.processes,
    });
    const bridge = new AgyWorkflowBridge(
      service,
      this.processes,
      undefined,
      this.engine,
      processHost,
    );
    this.processes.setAdmissionGuard((spec) => {
      if (!bridge.isManaged()) return;
      const isAgy =
        this.engine.store.get<Run>("run", spec.id)?.adapter === "agy" ||
        resolve(spec.executable).toLowerCase() ===
          resolve(
            executablePath(this.engine.config.models.agy_executable),
          ).toLowerCase() ||
        /(?:^|[\\/])agy(?:\.exe|\.cmd)?$/i.test(spec.executable);
      if (!isAgy && !spec.agy_account) return;
      if (!spec.agy_account)
        throw new FlowError(
          "AGY_ACCOUNT_PERMIT_REQUIRED",
          "受管 AGY 启动缺少账号许可",
          409,
        );
      try {
        service.markUsageStarted(spec.agy_account.permit_id);
      } catch {
        throw new FlowError(
          "AGY_ACCOUNT_PERMIT_REVOKED",
          "账号许可已失效，本轮未启动",
          409,
        );
      }
    });
    this.accountBridge = bridge;
    return bridge;
  }
  private get native() {
    return new ProfileRuntime(this.engine, this.processes, this.accountBridge);
  }
  async plan(workflow: Workflow, run: Run) {
    return this.native.plan(workflow, run);
  }
  async aside(
    workflow: Workflow,
    run: Run,
    question: { question: string; refs: unknown[] },
  ) {
    return this.native.aside(workflow, run, question);
  }
  async resolveMergeConflict(
    workflow: Workflow,
    run: Run,
    request: MergeConflictRequest,
  ) {
    return this.native.resolveMergeConflict(workflow, run, request);
  }
  processes: ProcessManager;
  environments: Environments;
  browser: BrowserGateway;
  private checking = new Set<string>();
  private cancelledRuns = new Set<string>();
  private preparing = new Map<string, Promise<void>>();
  private preparationProcesses = new Map<string, Set<string>>();
  private adapters = createDefaultAdapterRegistry();
  async validateEnvironment(workflow: Workflow) {
    if (!this.engine.project(workflow.project_id).services.length) return;
    const env = this.engine.store.get<any>("environment", workflow.id);
    requireCondition(
      env?.status === "ready",
      "ENVIRONMENT_NOT_READY",
      "验证服务尚未就绪或已经退出，修复并重新验证后才能交付",
    );
    await this.environments.health(env);
  }
  async diagnose(workflow: Workflow, error: string) {
    if (usesProfileRuntime(this.engine, workflow))
      return this.native.diagnose(workflow, error);
    const root = join(
      this.engine.config.storage_root,
      "diagnostics",
      id("diagnosis"),
    );
    mkdirSync(root, { recursive: true });
    const snapshot = await this.engine.git.snapshot(
      workflow.id,
      workflow.environment_revision,
    );
    const manifest = join(root, "materials.json"),
      schema = join(root, "schema.json"),
      output = join(root, "diagnosis.json");
    atomicWrite(
      manifest,
      JSON.stringify({
        plan: this.engine.plan(workflow.id).plan,
        plan_record: this.engine.plan(workflow.id),
        project: this.engine.project(workflow.project_id),
        snapshot,
        workspaces: this.engine.store.list("workspace", workflow.id),
        evidence: [
          ...this.engine.store.list("evidence", workflow.id),
          ...this.engine.store.list("development_evidence", workflow.id),
        ],
        diff: await this.engine.git.diff(snapshot),
        claims: this.engine.taskStatus(workflow.id),
        skill:
          "你是故障规划诊断者，只读定位错误并提供确定修复步骤。不是交付复核，不得宣布验收或复核通过。使用 devflow_review 只读材料工具调查相关代码。当前允许范围内的修复返回 requires_plan_change=false,repair_plan=null；必须扩大范围时提供完整 Plan 合同并保持现有项目配置哈希和基线，等待用户审批。诊断失败不能伪造成功。",
      }),
    );
    atomicWrite(
      schema,
      JSON.stringify(
        diagnosisOutputSchema(snapshot.repositories.map((r) => r.repo_id)),
      ),
    );
    const processId = id("planner-diagnosis");
    this.engine.store.put("check_process", processId, workflow.run_id!, {
      id: processId,
    });
    this.engine.store.event(
      workflow.id,
      workflow.project_id,
      "DiagnosisStarted",
      { message: "执行修复未解决问题，规划模型正在只读诊断" },
      workflow.run_id,
    );
    try {
      let diagnosticOutput = "";
      let result: ReturnType<typeof parseDiagnosisOutput> | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        requireCondition(
          !this.cancelledRuns.has(workflow.run_id!),
          "RUN_REVOKED",
          "诊断所属轮次已停止",
        );
        const currentProcess = attempt ? processId + "-retry" : processId;
        this.engine.store.put(
          "check_process",
          currentProcess,
          workflow.run_id!,
          { id: currentProcess },
        );
        diagnosticOutput = "";
        if (existsSync(output)) unlinkSync(output);
        const selected = diagnosisLauncher(this.engine, workflow);
        const proc = this.processes.start({
          id: currentProcess,
          workflow_id: workflow.id,
          executable: executablePath(selected.launcher.executable),
          args: [
            ...selected.prefix,
            "exec",
            "--ignore-user-config",
            "--ignore-rules",
            "--ephemeral",
            ...(selected.launcher.modelToken
              ? ["--model", selected.launcher.modelToken]
              : []),
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
            ...(attempt === 0 ? ["--output-schema", schema] : []),
            "--output-last-message",
            output,
            ...selected.launcher.effortArgs,
            "-c",
            `mcp_servers.devflow_review.command=${JSON.stringify(process.execPath)}`,
            "-c",
            `mcp_servers.devflow_review.args=${JSON.stringify([resolve("dist/packages/bridge/src/review.js")])}`,
            "-c",
            `mcp_servers.devflow_review.env={ DEVFLOW_REVIEW_MANIFEST = ${JSON.stringify(manifest)} }`,
            "-c",
            "mcp_servers.devflow_review.required=true",
            "-",
          ],
          cwd: root,
          env: { ...selected.launcher.effortEnv },
          stdin: JSON.stringify({
            instruction: joinPrompt(
              "先读取 section=skill，再读取 plan、project、相关源码；只读诊断，最后只返回 JSON 对象，字段为 diagnosis、instructions、requires_plan_change、repair_plan。不改变范围时 repair_plan=null；需要改变范围时提交完整 Plan 合同。",
              readRoleRecoveryGuidance(this.engine, workflow, {
                id: workflow.run_id ?? workflow.id,
                purpose: "quality_review",
                stage: "diagnosis",
                adapter: "codex",
              }),
            ),
            error,
            logs: this.engine.store
              .recentEvents(workflow.id, 160)
              .filter((e) =>
                /EnvironmentFailed|ServiceOutput|BuildFailed|BuildOutput|CheckCompleted|PrepareVerificationFailed/.test(
                  e.type,
                ),
              )
              .slice(-20)
              .map((e) => this.engine.store.publicEvent(e)),
          }),
          timeout_ms: 600000,
        });
        for (const stream of ["stdout", "stderr", "diagnostic"])
          proc.on(stream, (b: Buffer | string) => {
            diagnosticOutput = (diagnosticOutput + redact(b.toString())).slice(
              -24000,
            );
            this.engine.store.event(
              workflow.id,
              workflow.project_id,
              "DiagnosisOutput",
              { text: redact(b.toString()) },
              workflow.run_id,
            );
          });
        const exit = await proc.completion;
        if (
          attempt === 0 &&
          /invalid_json_schema|Invalid schema for response_format/.test(
            diagnosticOutput,
          )
        ) {
          this.engine.store.event(
            workflow.id,
            workflow.project_id,
            "DiagnosisRetrying",
            {
              message: "诊断接口返回格式不兼容，系统正在自动调整后重试。",
            },
            workflow.run_id,
          );
          continue;
        }
        requireCondition(
          exit.code === 0 && existsSync(output),
          "DIAGNOSIS_FAILED",
          `规划诊断进程未完成（退出码 ${exit.code}）：${diagnosticOutput.slice(-8000)}`,
        );
        const raw = readFileSync(output, "utf8")
          .trim()
          .replace(/^```(?:json)?\s*\n?/, "")
          .replace(/\n?```$/, "");
        result = parseDiagnosisOutput(JSON.parse(raw));
        break;
      }
      requireCondition(
        result,
        "DIAGNOSIS_FAILED",
        "规划诊断没有返回可校验的结果",
      );
      requireCondition(
        !result.requires_plan_change || result.repair_plan,
        "REPAIR_PLAN_REQUIRED",
        "诊断指出需扩大范围，但没有给出完整修订计划",
      );
      this.engine.store.event(
        workflow.id,
        workflow.project_id,
        "DiagnosisCompleted",
        result,
        workflow.run_id,
      );
      return { ...result, repair_plan: result.repair_plan ?? undefined };
    } finally {
      this.engine.store.remove("check_process", processId);
      this.engine.store.remove("check_process", processId + "-retry");
    }
  }
  async operation(workflow: Workflow, requestId: string, principal: Principal) {
    this.engine.worker(principal, workflow.id, true);
    const request = this.engine.store.must<OperationRequest>(
      "operation_request",
      requestId,
    );
    requireCondition(
      request.workflow_id === workflow.id &&
        request.plan_revision === workflow.plan_revision &&
        request.plan_hash === workflow.plan_hash,
      "AUTHORIZATION_STALE",
      "操作授权不属于当前任务和计划",
    );
    if (["completed", "failed", "denied"].includes(request.status))
      return request;
    requireCondition(
      request.status === "approved",
      "AUTHORIZATION_REQUIRED",
      "操作尚未获批，或已经在执行",
    );
    const ws = this.engine.store
      .list<Workspace>("workspace", workflow.id)
      .find((x) => x.repo_id === request.operation.repo_id);
    requireCondition(
      ws &&
        (request.operation.cwd
          ? safePath(ws.root, request.operation.cwd)
          : ws.root) === request.cwd,
      "WORKSPACE_CHANGED",
      "操作工作目录发生变化，需要重新授权",
    );
    const running: OperationRequest = { ...request, status: "running" };
    this.engine.store.put(
      "operation_request",
      request.id,
      workflow.id,
      running,
    );
    const processId = id("operation-run");
    this.engine.store.put("check_process", processId, principal.run_id!, {
      id: processId,
    });
    this.engine.store.put("check_lock", workflow.id, workflow.id, {
      run_id: principal.run_id,
    });
    let output = "";
    try {
      const proc = this.processes.start({
        id: processId,
        workflow_id: workflow.id,
        executable: request.operation.executable,
        args: request.operation.args,
        cwd: request.cwd,
        env: {},
        timeout_ms: request.operation.timeout_seconds * 1000,
      });
      for (const stream of ["stdout", "stderr", "diagnostic"])
        proc.on(stream, (b: Buffer | string) => {
          const text = redact(b.toString());
          output = (output + text).slice(-16000);
          this.engine.store.event(
            workflow.id,
            workflow.project_id,
            "OperationOutput",
            { request_id: request.id, text },
            principal.run_id,
          );
        });
      const exit = await proc.completion;
      const result: OperationRequest = {
        ...running,
        status: exit.code === 0 ? "completed" : "failed",
        result: { exit_code: exit.code, output },
      };
      this.engine.store.put(
        "operation_request",
        request.id,
        workflow.id,
        result,
      );
      this.engine.invalidate(workflow.id, "已授权操作完成");
      this.engine.store.event(
        workflow.id,
        workflow.project_id,
        "OperationCompleted",
        result,
        principal.run_id,
      );
      return result;
    } catch (error) {
      const result: OperationRequest = {
        ...running,
        status: "failed",
        result: { error: String(error), output },
      };
      this.engine.store.put(
        "operation_request",
        request.id,
        workflow.id,
        result,
      );
      throw error;
    } finally {
      this.engine.store.remove("check_process", processId);
      this.engine.store.remove("check_lock", workflow.id);
    }
  }
  constructor(private engine: Engine) {
    this.processes = new ProcessManager(
      (spec, event) =>
        engine.store.put(
          "process_record",
          spec.id,
          spec.workflow_id ?? "system",
          {
            ...engine.store.get<Record<string, unknown>>(
              "process_record",
              spec.id,
            ),
            id: spec.id,
            workflow_id: spec.workflow_id,
            executable: spec.executable,
            cwd: spec.cwd,
            ...(spec.agy_account ? { agy_account: spec.agy_account } : {}),
            ...event,
            updated_at: now(),
          },
        ),
    );
    this.environments = new Environments(engine, this.processes);
    this.browser = new BrowserGateway(engine);
  }
  private assertRun(
    workflow: string,
    run: string,
    states: Workflow["state"][],
  ) {
    const current = this.engine.get(workflow);
    requireCondition(
      !this.cancelledRuns.has(run) &&
        current.run_id === run &&
        states.includes(current.state),
      "RUN_REVOKED",
      "执行轮次已经停止或阶段已经变化",
      403,
    );
    return current;
  }
  async execute(workflow: Workflow, run: Run, token: string) {
    if (run.deadline_at && Date.now() >= run.deadline_at) {
      throw new FlowError("TIMEOUT", "执行启动前已达到截止时间");
    }
    const planRecord = this.engine.plan(workflow.id);
    const plan = planRecord.plan;
    if (!isLegacyProtocol(run, plan) || (run.protocol !== "legacy" && usesProfileRuntime(this.engine, workflow, run)))
      return this.native.execute(workflow, run, token);
    reconcileImplementationProofs(this.engine, workflow.id);
    this.assertRun(workflow.id, run.id, ["EXECUTING"]);
    const directory = join(
      this.engine.config.storage_root,
      "containers",
      workflow.id,
    );
    const bridge = fileURLToPath(
      new URL("../../bridge/src/worker.js", import.meta.url),
    );
    const hook = fileURLToPath(
      new URL("../../bridge/src/hook.js", import.meta.url),
    );
    requireCondition(
      existsSync(bridge) && existsSync(hook),
      "BUILD_REQUIRED",
      "请先完成生产构建",
    );
    const isNativeV2 = resolveTaskModel(plan) === "native-v2";

    if (isNativeV2) {
      writeAgyNativeConfiguration(directory, process.execPath, bridge);
    } else {
      writeAgyConfiguration(directory, process.execPath, bridge, hook);
    }
    const projectBinding = this.engine.store.get<{ id: string }>(
      "agy_project",
      workflow.id,
    );
    const launcher = runLauncherSelection(run);
    const conversation = compatibleConversation(this.engine, run);
    const recoveryGuidance = readRoleRecoveryGuidance(
      this.engine,
      workflow,
      run,
    );

    if (isNativeV2) {
      const workspaces = this.engine.store.list<Workspace>(
        "workspace",
        workflow.id,
      );
      if (!conversation?.id) {
        const fullPkg = HandoffBuilder.buildFullHandoff({
          workflow: this.engine.get(workflow.id),
          plan,
          runId: run.id,
          packageHash: run.package_hash,
          directory,
          workspaces,
        });
        if (recoveryGuidance)
          fullPkg.instructions = joinPrompt(
            fullPkg.instructions,
            recoveryGuidance,
          );
        HandoffBuilder.writeHandoffFiles(directory, fullPkg, plan.markdown);
      } else {
        const issues =
          rejectedDeliveryFeedback(this.engine.store, workflow)?.issues ?? [];
        const cursor = this.engine.store.get<{
          plan_hash: string;
          feedback_count: number;
        }>("handoff_cursor", workflow.id);
        const resumePkg = HandoffBuilder.buildResumeHandoff({
          workflow: this.engine.get(workflow.id),
          plan,
          runId: run.id,
          conversationId: conversation.id,
          packageHash: run.package_hash,
          directory,
          workspaces,
          deliveryIssues: issues,
        });
        resumePkg.feedback = resumePkg.feedback?.slice(
          cursor?.feedback_count ?? 0,
        );
        resumePkg.design_changed = cursor?.plan_hash !== workflow.plan_hash;
        if (!resumePkg.design_changed) {
          resumePkg.index = {
            ...resumePkg.index,
            modules: [],
            tasks: [],
            acceptance_items: [],
          };
          resumePkg.instructions +=
            " 设计和索引未变，沿用前轮完整工作包；本轮仅提供新增反馈和未解决事项。";
        }
        if (recoveryGuidance)
          resumePkg.instructions = joinPrompt(
            resumePkg.instructions,
            recoveryGuidance,
          );
        HandoffBuilder.writeHandoffFiles(
          directory,
          resumePkg,
          resumePkg.design_changed ? plan.markdown : undefined,
        );
      }
    } else {
      const bundle = {
        workflow: this.engine.get(workflow.id),
        plan: planRecord,
        environment: this.engine.store.get("environment", workflow.id),
        package_hash: run.package_hash,
      };
      atomicWrite(
        join(directory, "handoff.json"),
        JSON.stringify(bundle, null, 2),
      );
    }

    const prompt = isNativeV2
      ? JSON.stringify({
          workflow_id: workflow.id,
          run_id: run.id,
          plan_revision: workflow.plan_revision,
          plan_hash: workflow.plan_hash,
          package_hash: run.package_hash,
          instruction: joinPrompt(
            conversation?.id
              ? nativeLaunchInstruction(directory, "resume")
              : nativeLaunchInstruction(directory, "full"),
            recoveryGuidance,
          ),
          execution_order: batchExecutionInstructions,
        })
      : JSON.stringify({
          workflow_id: workflow.id,
          run_id: run.id,
          plan_revision: workflow.plan_revision,
          plan_hash: workflow.plan_hash,
          package_hash: run.package_hash,
          instruction: joinPrompt(
            "首先调用 devflow_execute_context，读取完整批准计划与 Skill。按既定设计完成开发并主动补齐必要遗漏，逐任务实施，仅使用 devflow_worker 工具。报告任务后 devflow_freeze，逐项 devflow_run_check，全部通过后 devflow_finish。遇到关键设计冲突或必须超范围时报告阻塞并结束。",
            recoveryGuidance,
          ),
          execution_order: batchExecutionInstructions,
        });
    this.assertRun(workflow.id, run.id, ["EXECUTING"]);
    const remainingMs = run.deadline_at
      ? Math.max(0, run.deadline_at - Date.now())
      : this.engine.config.timeouts.agent_minutes * 60000;
    const dispatchManager = new CliDispatchManager(this.engine.store, this.processes);
    const dispatchId = `disp_${workflow.id}_${run.id}`;
    let dispatchRecord: any;
    try {
      dispatchRecord = dispatchManager.prepareDispatch({
        dispatchId,
        workflowId: workflow.id,
        runId: run.id,
        strategy: "legacy",
      });
    } catch (err: any) {
      // 若派发门禁拒绝则抛出错误
      throw err;
    }
    const accountBinding = await this.accountBridge?.prepareProfileRun(
      workflow.id,
      run,
      launcher.modelToken ?? undefined,
      run.profile?.id,
    );
    let proc;
    try {
      if (dispatchRecord) dispatchManager.claimStarting(dispatchId);
      proc = this.processes.start({
        id: run.id,
        workflow_id: workflow.id,
        ...(accountBinding ? { agy_account: accountBinding } : {}),
        executable: executablePath(launcher.executable),
        args: [
          ...agyArguments(
            launcher.modelToken ?? "",
            prompt,
            this.engine.config.timeouts.agent_minutes,
            conversation?.id,
            projectBinding?.id,
            isNativeV2 ? "accept-edits" : undefined,
            launcher.effortArgs,
          ),
          "--add-dir",
          directory,
          ...this.engine.store
            .list<Workspace>("workspace", workflow.id)
            .flatMap((ws) => ["--add-dir", ws.root]),
        ],
        cwd: directory,
        env: {
          ...launcher.effortEnv,
          DEVFLOW_RUN_TOKEN: token,
          DEVFLOW_WORKFLOW_ID: workflow.id,
          DEVFLOW_RUN_ID: run.id,
          DEVFLOW_BASE_URL:
            "http://127.0.0.1:" + this.engine.config.server.port,
        },
        timeout_ms: remainingMs,
        deadline_at: run.deadline_at,
      });
    } catch (error) {
      if (dispatchRecord) dispatchManager.finishDispatch(dispatchId, { exitCode: 1, error: String(error) });
      if (accountBinding)
        await this.accountBridge?.releaseRun(run.id, false, "spawn_failed");
      throw error;
    }
    if (accountBinding)
      proc.on("host", (event) => {
        if (event.type === "started" && Number.isSafeInteger(event.pid))
          this.accountBridge?.attachProcess(accountBinding, event.pid);
      });
    const accountTurn = new CurrentTurn();
    let accountFailure: AgyFailureFact | undefined;
    let accountEventOffset = 0;
    let accountRunSucceeded = false;
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
    const telemetry = new RunTelemetry(this.engine.store, workflow, run);
    bindRunConversationObserver({
      store: this.engine.store,
      workflow,
      run,
      adapter: this.adapters.mustGet("agy"),
      telemetry,
      previousNativeId: conversation?.id,
      onRootSession: (nativeId) => {
        this.engine.store.put("conversation", workflow.id, workflow.id, {
          id: nativeId,
        });
      },
    });
    const nativeRecords = new AgyNativeRecordSource(homedir());
    const nativeObserver = isNativeV2
      ? new NativeExecutionObserver({
          workflow_id: workflow.id,
          run_id: run.id,
          plan_hash: workflow.plan_hash!,
          workspaces: this.engine.store.list<Workspace>(
            "workspace",
            workflow.id,
          ),
          reports: this.engine.project(workflow.project_id).commands,
          readHostStep: (conversation, index) =>
            nativeRecords.read(conversation, index),
          save: (fact) =>
            this.engine.store.put(
              "native_execution",
              run.id + ":" + hash(fact.tool_call_id),
              run.id,
              fact,
            ),
        })
      : undefined;
    let conversationRoot = conversation?.id;
    const result = await observeAgy(proc, {
      model: launcher.modelToken ?? "",
      conversation: conversation?.id,
      cwd: directory,
      log: join(directory, run.id + ".jsonl"),
      idle_ms: this.engine.config.timeouts.idle_minutes * 60000,
      isWaiting: () =>
        !!this.engine.store.get("resource_wait", workflow.id) ||
        this.preparing.has(run.id) ||
        this.checking.has(workflow.id),
      onEvent: (event) => {
        if (accountBinding) {
          this.accountBridge?.observeNativeEvent(run.id, event);
          accountTurn.accept(event);
          const result = event.result as Record<string, unknown> | undefined;
          const candidate = classifyAgyFailure({
            realmId: accountBinding.realm_id,
            accountId: accountBinding.account_id,
            authEpoch: accountBinding.auth_epoch,
            runId: run.id,
            conversationId: conversation?.id,
            event: {
              ...event,
              type: event.event ?? event.type,
              error: event.error ?? result?.error,
            },
            eventOffset: accountEventOffset++,
            currentTurn:
              !conversation || accountTurn.canAttributeFailureToCurrentTurn(),
          });
          if (candidate.can_switch_account) accountFailure = candidate;
        }
        if (event.event === "init" && typeof event.conversation_id === "string")
          retainRunConversation(this.engine.store, run, event.conversation_id);
        nativeObserver?.accept(event);
        conversationRoot = acceptAgyLiveTelemetry(
          telemetry,
          event,
          conversationRoot,
        );
      },
      onDiagnostic: (text) =>
        this.engine.store.event(
          workflow.id,
          workflow.project_id,
          "AgentDiagnostic",
          { text },
          run.id,
        ),
    })
      .then(
        (result) => {
          telemetry.finish(false);
          accountRunSucceeded = result.exit === 0;
          return result;
        },
        async (error) => {
          telemetry.finish(true);
          if (
            proc.termination_reason === "account_switch" &&
            !this.engine.store.get("run_stop", run.id)
          )
            throw new FlowError(
              "AGY_ACCOUNT_WAIT",
              "账号切换暂停，等待继续原任务",
              409,
            );
          if (
            accountBinding &&
            accountFailure &&
            !this.engine.store.get("run_stop", run.id) &&
            !proc.termination_reason &&
            (!conversation || accountTurn.canAttributeFailureToCurrentTurn()) &&
            (await this.accountBridge!.observeFailure(
              accountBinding,
              accountFailure,
            ))
          )
            throw new FlowError(
              "AGY_ACCOUNT_WAIT",
              "账号额度或授权不可用，等待切换后继续原任务",
              409,
            );
          throw error;
        },
      )
      .finally(async () => {
        if (accountBinding)
          await this.accountBridge?.releaseRun(
            run.id,
            accountRunSucceeded,
            proc.termination_reason,
          );
      });
    this.engine.store.put("run", run.id, workflow.id, {
      ...this.engine.store.must<Run>("run", run.id),
      exit_code: result.exit,
    });
    retainRunConversation(this.engine.store, run, result.conversation);
    if (isNativeV2)
      this.engine.store.put("handoff_cursor", workflow.id, workflow.id, {
        plan_hash: workflow.plan_hash,
        feedback_count: this.engine.get(workflow.id).feedback.length,
      });
  }
  async prepareVerification(workflow: Workflow, principal: Principal) {
    const run = principal.run_id!;
    const processes = new Set<string>();
    this.preparationProcesses.set(run, processes);
    const prepare = async () => {
      this.assertRun(workflow.id, principal.run_id!, ["EXECUTING"]);
      // Initial onboarding adapters must be implemented before their servers start.
      await cleanArchivedReports(this.engine, workflow.id);
      // Restart retained servers after edits so acceptance sees the current code.
      await this.environments.stop(workflow.id);
      this.assertRun(workflow.id, principal.run_id!, ["EXECUTING"]);
      // Build the current worktree once before allocating ports or starting
      // preview servers. Service retries must never retry a failed compiler.
      const project = this.engine.project(workflow.project_id);
      const build = project.commands.find(
        (c) => c.id === "build" && c.lifecycle === "check",
      );
      if (build) {
        const workspaces = this.engine.store.list<Workspace>(
          "workspace",
          workflow.id,
        );
        const workspace = build.repo_id
          ? workspaces.find((w) => w.repo_id === build.repo_id)
          : workspaces[0];
        requireCondition(workspace, "WORKSPACE_MISSING", "构建仓库未绑定");
        const variables = {
          DEVFLOW_WORKFLOW_ID: workflow.id,
          DEVFLOW_DATA_DIR: join(
            this.engine.config.storage_root,
            "data",
            workflow.id,
          ),
        };
        const processId = id("build");
        const event = (type: string, payload: Record<string, unknown>) =>
          this.engine.store.event(
            workflow.id,
            workflow.project_id,
            type,
            { process_id: processId, ...payload },
            run,
          );
        event("BuildStarted", { message: "构建当前任务代码" });
        let output = "";
        try {
          const proc = this.processes.start({
            workflow_id: workflow.id,
            id: processId,
            executable: build.executable,
            args: build.args.map((a) => expand(a, variables)),
            cwd: build.cwd
              ? safePath(workspace.root, build.cwd)
              : workspace.root,
            env: { ...build.env, ...variables },
            timeout_ms: build.timeout_seconds * 1000,
          });
          processes.add(proc.id);
          for (const stream of ["stdout", "stderr", "diagnostic"])
            proc.on(stream, (data: Buffer | string) => {
              const text = redact(data.toString());
              output = (output + text).slice(0, 16000);
              event("BuildOutput", { stream, text });
            });
          const result = await proc.completion;
          this.assertRun(workflow.id, run, ["EXECUTING"]);
          requireCondition(
            result.code === 0,
            "BUILD_FAILED",
            `当前任务构建失败（退出码 ${result.code ?? result.signal ?? "未知"}）：${output.trim() || "没有诊断输出"}`,
          );
          event("BuildReady", { message: "构建通过，准备本机验证副本" });
        } catch (error) {
          this.assertRun(workflow.id, run, ["EXECUTING"]);
          event("BuildFailed", {
            message: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      }
      await this.environments.ensure(
        this.engine.get(workflow.id),
        () => {
          this.assertRun(workflow.id, principal.run_id!, ["EXECUTING"]);
        },
        (processId) => {
          processes.add(processId);
        },
      );
      this.assertRun(workflow.id, principal.run_id!, ["EXECUTING"]);
    };
    const pending = prepare();
    this.preparing.set(run, pending);
    try {
      await pending;
    } finally {
      this.preparing.delete(run);
      this.preparationProcesses.delete(run);
    }
  }
  async check(
    workflow: Workflow,
    testId: string,
    principal: Principal,
  ): Promise<Evidence> {
    this.engine.worker(principal, workflow.id);
    const development = workflow.state === "EXECUTING";
    requireCondition(
      development || workflow.state === "VERIFYING",
      "SNAPSHOT_REQUIRED",
      "请先冻结代码快照",
    );
    const test = this.engine
      .plan(workflow.id)
      .plan.tests.find((t) => t.id === testId);
    requireCondition(test, "TEST_MISSING", "未知测试");
    const checkPlan = this.engine.plan(workflow.id).plan;
    for (const ws of test.layer === "e2e"
      ? this.engine.store.list<Workspace>("workspace", workflow.id)
      : []) {
      const paths = checkPlan.tasks
        .filter(
          (t) =>
            test.task_ids.includes(t.id) &&
            (!t.repo_id || t.repo_id === ws.repo_id),
        )
        .flatMap((t) => t.paths);
      assertMeaningfulTestFiles(ws.root, [...new Set(paths)]);
    }
    // A workflow shares its frozen phase and may share command report paths.
    // Different workflows remain independent users of the global test slots.
    const unique = workflow.id;
    requireCondition(
      !this.checking.has(unique),
      "CHECK_RUNNING",
      "该工作流已有检查正在执行，请等待完成后运行下一项",
    );
    this.checking.add(unique);
    let slot: string;
    try {
      slot = await this.engine.scheduler.waitForCapacity(
        "test",
        this.engine.config.scheduler.heavy_tests,
        workflow.id,
        principal.run_id!,
        () => {
          this.engine.worker(principal, workflow.id);
          this.assertRun(workflow.id, principal.run_id!, [
            development ? "EXECUTING" : "VERIFYING",
          ]);
        },
      );
    } catch (error) {
      this.checking.delete(unique);
      throw error;
    }
    this.checking.add(unique);
    this.engine.store.put("check_lock", workflow.id, workflow.id, {
      run_id: principal.run_id,
    });
    const assertCurrent = () => {
      const current = this.assertRun(workflow.id, principal.run_id!, [
        "EXECUTING",
        "VERIFYING",
      ]);
      this.engine.worker(principal, workflow.id);
      requireCondition(
        current.state === (development ? "EXECUTING" : "VERIFYING") &&
          current.version === workflow.version &&
          (development || current.snapshot_id === workflow.snapshot_id) &&
          current.environment_revision === workflow.environment_revision,
        "CHECK_SUPERSEDED",
        "验证轮次已经变化，本次检查结果不能沿用",
      );
    };
    let attempted = false;
    let processId: string | undefined;
    let report: string | undefined;
    let restoreReport: ReturnType<typeof takeReportSlot> | undefined;
    let log: string | undefined;
    let observedExit: number | null = null;
    const dir = join(
      this.engine.config.storage_root,
      "evidence",
      workflow.id,
      id("check"),
    );
    try {
      assertCurrent();
      if (development) {
        const snapshot = await this.engine.git.snapshot(
          workflow.id,
          workflow.environment_revision,
        );
        workflow = { ...workflow, snapshot_id: snapshot.id };
        assertCurrent();
      }
      const snapshot = this.engine.store.must<Snapshot>(
        "snapshot",
        workflow.snapshot_id!,
      );
      requireCondition(
        await this.engine.git.matches(snapshot),
        "SNAPSHOT_CHANGED",
        "代码快照变化",
      );
      assertCurrent();
      this.engine.store.event(
        workflow.id,
        workflow.project_id,
        "CheckStarted",
        { test_id: testId, task_ids: test.task_ids },
        principal.run_id,
      );
      mkdirSync(dir, { recursive: true });
      let stats: {
        cases?: Evidence["cases"];
        status: "passed" | "failed";
        case_ids: string[];
        passed: number;
        failed: number;
        skipped: number;
        discovered: number;
      };
      let files: { path: string; hash: string }[] = [];
      let exit = 0;
      if (test.layer === "opentabs") {
        attempted = true;
        const output = await this.browser.run(
          workflow.id,
          principal.run_id!,
          test.scene_id!,
        );
        files = [output];
        requireCondition(
          test.expected_case_ids.every((c) => output.case_ids.includes(c)),
          "BROWSER_CASES_MISSING",
          "浏览器证据未覆盖批准用例",
        );
        stats = {
          status: "passed",
          case_ids: output.case_ids,
          cases: output.case_ids.map((id) => ({
            id,
            status: "passed" as const,
          })),
          passed: output.case_ids.length,
          failed: 0,
          skipped: 0,
          discovered: output.case_ids.length,
        };
      } else {
        const command = this.engine
          .project(workflow.project_id)
          .commands.find((c) => c.id === test.command_id)!;
        const workspaces = this.engine.store.list<Workspace>(
          "workspace",
          workflow.id,
        );
        const workspace = command.repo_id
          ? workspaces.find((w) => w.repo_id === command.repo_id)!
          : workspaces[0]!;
        report = safePath(workspace.root, command.report_path!, true);
        restoreReport = takeReportSlot(report);
        mkdirSync(dirname(report), { recursive: true });
        const env = this.engine.store.get<{
          data_dir: string;
          services: { origin: string }[];
        }>("environment", workflow.id);
        const variables = {
          DEVFLOW_REPORT_PATH: report,
          DEVFLOW_WORKFLOW_ID: workflow.id,
          DEVFLOW_SNAPSHOT_ID: snapshot.id,
          DEVFLOW_DATA_DIR: env?.data_dir ?? "",
          DEVFLOW_BASE_URL: env?.services.at(-1)?.origin ?? "",
        };
        processId = id("check");
        this.engine.store.put("check_process", processId, principal.run_id!, {
          id: processId,
        });
        assertCurrent();
        attempted = true;
        const proc = this.processes.start({
          workflow_id: workflow.id,
          id: processId,
          executable: command.executable,
          args: command.args.map((a) => expand(a, variables)),
          cwd: command.cwd
            ? safePath(workspace.root, command.cwd)
            : workspace.root,
          env: { ...command.env, ...variables },
          timeout_ms: test.timeout_seconds * 1000,
        });
        log = join(dir, "output.log");
        proc.on("stdout", (b: Buffer) => {
          appendFileSync(log!, b);
          this.engine.store.event(
            workflow.id,
            workflow.project_id,
            "CheckOutput",
            { test_id: testId, text: redact(b.toString("utf8")) },
            principal.run_id,
          );
        });
        proc.on("stderr", (b: Buffer) => appendFileSync(log!, b));
        exit = (await proc.completion).code ?? -1;
        observedExit = exit;
        assertCurrent();
        this.engine.store.remove("check_process", processId);
        requireCondition(
          existsSync(report),
          "REPORT_MISSING",
          "检查没有生成新报告",
        );
        const raw = readFileSync(report, "utf8");
        const output = join(
          dir,
          "report." + (command.parser === "junit" ? "xml" : "json"),
        );
        atomicWrite(output, raw);
        stats = evaluateReport(
          parseReport(command.parser, raw),
          test.expected_case_ids,
          exit,
        );
        files = [
          { path: output, hash: hash(raw) },
          ...(existsSync(log)
            ? [{ path: log, hash: hash(readFileSync(log)) }]
            : []),
        ];
        restoreReport();
        await cleanArchivedReports(this.engine, workflow.id, {
          files,
          preservePaths: restoreReport.preservePaths,
          directory: dirname(report),
        });
      }
      this.engine.worker(principal, workflow.id);
      requireCondition(
        await this.engine.git.matches(snapshot),
        "SNAPSHOT_CHANGED",
        "测试修改了源文件，证据失效",
      );
      assertCurrent();
      const evidence: Evidence = {
        phase: development ? "development" : "delivery",
        id: id("evidence"),
        workflow_id: workflow.id,
        run_id: principal.run_id!,
        snapshot_id: snapshot.id,
        environment_revision: workflow.environment_revision,
        test_id: testId,
        plan_revision: workflow.plan_revision,
        layer: test.layer,
        ...stats,
        exit_code: exit,
        files,
        created_at: now(),
      };
      this.engine.store.put(
        development ? "development_evidence" : "evidence",
        evidence.id,
        workflow.id,
        evidence,
      );
      this.engine.store.event(
        workflow.id,
        workflow.project_id,
        "CheckCompleted",
        evidence,
        principal.run_id,
      );
      if (evidence.status === "failed") {
        // A failed assertion changes validation, not the recorded source bytes.
        // Only a real source change invalidates an implementation proof.
        if (!development) {
          this.engine.invalidate(
            workflow.id,
            "检查失败，在批准范围内修复后先重跑该测试，再由负责的子 Agent 并行运行独立的受影响回归目标",
          );
          this.engine.transition(
            workflow.id,
            ["VERIFYING"],
            "EXECUTING",
            "repair_tests",
          );
        }
      }
      this.engine.exportDocuments(workflow.id);
      return evidence;
    } catch (error) {
      if (!attempted) throw error;
      if (
        error instanceof FlowError &&
        ["BROWSER_BUSY", "SCENE_MISSING", "SCENE_NOT_CALIBRATED"].includes(
          error.code,
        )
      )
        throw error;
      // Cancellation or another phase owns the workflow now. Never reopen it
      // or attach this attempt's result to that newer verification phase.
      assertCurrent();
      const failure = {
        code: error instanceof FlowError ? error.code : "CHECK_FAILED",
        message: redact(error instanceof Error ? error.message : String(error)),
      };
      const errorPath = join(dir, "error.json");
      atomicWrite(
        errorPath,
        JSON.stringify(
          {
            workflow_id: workflow.id,
            run_id: principal.run_id,
            test_id: testId,
            snapshot_id: workflow.snapshot_id,
            observed_exit_code: observedExit,
            error: failure,
          },
          null,
          2,
        ),
      );
      const paths = [errorPath];
      if (log && existsSync(log)) paths.push(log);
      if (report && existsSync(report)) {
        const rawPath = join(dir, "unparsed-report.txt");
        atomicWrite(rawPath, readFileSync(report));
        paths.push(rawPath);
      }
      const evidence: Evidence & { error: typeof failure } = {
        phase: development ? "development" : "delivery",
        id: id("evidence"),
        workflow_id: workflow.id,
        run_id: principal.run_id!,
        snapshot_id: workflow.snapshot_id!,
        environment_revision: workflow.environment_revision,
        test_id: testId,
        plan_revision: workflow.plan_revision,
        layer: test.layer,
        status: "failed",
        case_ids: [],
        passed: 0,
        failed: 0,
        skipped: 0,
        discovered: 0,
        exit_code: observedExit ?? -1,
        files: paths.map((path) => ({ path, hash: hash(readFileSync(path)) })),
        created_at: now(),
        error: failure,
      };
      this.engine.store.put(
        development ? "development_evidence" : "evidence",
        evidence.id,
        workflow.id,
        evidence,
      );
      this.engine.store.event(
        workflow.id,
        workflow.project_id,
        "CheckCompleted",
        evidence,
        principal.run_id,
      );
      if (!development) {
        this.engine.invalidate(workflow.id, "检查执行异常，返回批准范围内修复");
        this.engine.transition(
          workflow.id,
          ["VERIFYING"],
          "EXECUTING",
          "repair_tests",
        );
      }
      this.engine.exportDocuments(workflow.id);
      return evidence;
    } finally {
      restoreReport?.();
      if (processId) this.engine.store.remove("check_process", processId);
      this.checking.delete(unique);
      this.engine.store.remove("check_lock", workflow.id);
      this.engine.scheduler.release(
        workflow.id,
        principal.run_id!,
        [slot!],
        true,
      );
    }
  }
  async review(workflow: Workflow, run: Run) {
    const plan = this.engine.plan(workflow.id).plan;
    if (!isLegacyProtocol(run, plan)) return this.native.review(workflow, run);
    return this.legacyReview(workflow, run);
  }
  private async legacyReview(workflow: Workflow, run: Run) {
    this.assertRun(workflow.id, run.id, ["REVIEWING"]);
    const snapshot = workflow.snapshot_id
      ? this.engine.store.get<Snapshot>("snapshot", workflow.snapshot_id)
      : undefined;
    const root = join(this.engine.config.storage_root, "reviews", run.id);
    mkdirSync(root, { recursive: true });
    const schema = join(root, "schema.json"),
      output = join(root, "review.json");
    const manifest = join(root, "materials.json");
    const continuation =
      asRunContinuation(run.continuation) ??
      asRunContinuation(
        this.engine.store.get("run_continuation", workflow.id),
      ) ??
      asRunContinuation(this.engine.store.get("run_continuation", run.id));
    const materials = applyContinuationMaterials(
      {
        skill_resources: reviewSkillResources(),
        review_contract: reviewContractContext(this.engine, workflow, run),
        plan: this.engine.plan(workflow.id).plan,
        plan_record: this.engine.plan(workflow.id),
        plan_authorities: this.engine.planSelfCheck.authorities(workflow),
        approval:
          this.engine.store.get(
            "approval",
            workflow.id + "-" + workflow.plan_revision,
          ) ?? null,
        project: this.engine.project(workflow.project_id),
        skill: readFileSync(
          resolve("packages/skills/devflow-review/SKILL.md"),
          "utf8",
        ),
        diff: snapshot ? await this.engine.git.diff(snapshot) : "",
        snapshot,
        workspaces: this.engine.store.list<Workspace>("workspace", workflow.id),
      },
      continuation,
    );
    atomicWrite(manifest, JSON.stringify(materials));
    atomicWrite(
      schema,
      JSON.stringify(
        reviewOutputSchema(snapshot?.repositories.map((r) => r.repo_id) ?? []),
      ),
    );
    const recoveryGuidance = readRoleRecoveryGuidance(
      this.engine,
      workflow,
      run,
    );
    const prompt = JSON.stringify(
      continuation?.kind === "intent_clarification"
        ? {
            instruction: joinPrompt(
              INTENT_CLARIFICATION_INSTRUCTION,
              recoveryGuidance,
            ),
            original_text: continuation.original_text,
          }
        : {
            instruction: joinPrompt(reviewInstructions, recoveryGuidance),
            review_contract: reviewContractContext(this.engine, workflow, run),
            phase:
              workflow.stage === BEFORE_HUMAN_REVIEW_STAGE
                ? "before_human"
                : "after_human",
            review_request_id: workflow.review_request_id,
            workflow_id: workflow.id,
            plan_revision: workflow.plan_revision,
            snapshot_id: snapshot?.id,
            plan: this.engine.plan(workflow.id).plan,
            diff: snapshot ? await this.engine.git.diff(snapshot) : "",
            workspaces: this.engine.store
              .list<Workspace>("workspace", workflow.id)
              .map((item) => ({ repo_id: item.repo_id, path: item.root })),
            questions: continuation?.questions,
            answer: continuation?.answer,
          },
    );
    const launcher = runLauncherSelection(run);
    const prefix = run.profile?.options?.prefixArgs ?? [];
    const args = [
      ...prefix,
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      "--json",
      ...(launcher.modelToken ? ["--model", launcher.modelToken] : []),
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--output-schema",
      schema,
      "--output-last-message",
      output,
      ...launcher.effortArgs,
      "-c",
      `mcp_servers.devflow_review.command=${JSON.stringify(process.execPath)}`,
      "-c",
      `mcp_servers.devflow_review.args=${JSON.stringify([resolve("dist/packages/bridge/src/review.js")])}`,
      "-c",
      `mcp_servers.devflow_review.env={ DEVFLOW_REVIEW_MANIFEST = ${JSON.stringify(manifest)} }`,
      "-c",
      "mcp_servers.devflow_review.required=true",
      "-",
    ];
    this.assertRun(workflow.id, run.id, ["REVIEWING"]);
    let codexBin: string | undefined;
    try {
      codexBin = executablePath(launcher.executable);
    } catch {
      codexBin = undefined;
    }
    requireCondition(
      codexBin,
      "REVIEWER_UNAVAILABLE",
      "独立复核程序不可用，不能生成通过结论；修复后重试复核",
    );
    const dispatchManager = new CliDispatchManager(this.engine.store, this.processes);
    const dispatchId = `disp_${workflow.id}_${run.id}`;
    let dispatchRecord: any;
    try {
      dispatchRecord = dispatchManager.prepareDispatch({
        dispatchId,
        workflowId: workflow.id,
        runId: run.id,
        strategy: "legacy",
      });
      dispatchManager.claimStarting(dispatchId);
    } catch (err: any) {
      throw err;
    }

    const proc = this.processes.start({
      id: run.id,
      workflow_id: workflow.id,
      executable: codexBin,
      args,
      cwd: root,
      env: { ...launcher.effortEnv },
      stdin: prompt,
      timeout_ms: this.engine.config.timeouts.agent_minutes * 60000,
    });

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
    const telemetry = new RunTelemetry(this.engine.store, workflow, run);
    const stopQuota = observeCodexAccountQuota({ executable: codexBin, prefixArgs: this.engine.config.models.codex_prefix_args, cwd: root, home: process.env.CODEX_HOME ?? join(homedir(), ".codex") }, telemetry);
    const observer = new CodexSessionObserver({
      home: process.env.CODEX_HOME ?? join(homedir(), ".codex"),
      cwd: root,
      startedAt: run.started_at,
      telemetry,
    });
    const adapter = this.adapters.mustGet("codex");
    bindRunConversationObserver({
      store: this.engine.store,
      workflow,
      run,
      adapter,
      telemetry,
      onRootSession: (nativeId) => observer.bind(nativeId),
    });
    const lines = new JsonLines((event) => {
      acceptCodexLiveTelemetry(telemetry, adapter, event, run.id);
    });
    let streamError: unknown;
    proc.on("stdout", (b: Buffer) => {
      appendFileSync(join(root, "stdout.jsonl"), redact(b.toString("utf8")));
      try { lines.push(b); } catch (error) { streamError ??= error; }
    });
    proc.on("stderr", (b: Buffer) =>
      this.engine.store.event(
        workflow.id,
        workflow.project_id,
        "ReviewDiagnostic",
        { text: redact(b.toString("utf8")) },
        run.id,
      ),
    );
    proc.on("diagnostic", (text) =>
      this.engine.store.event(
        workflow.id,
        workflow.project_id,
        "ReviewDiagnostic",
        { text: redact(String(text)) },
        run.id,
      ),
    );
    let exit: Awaited<typeof proc.completion> | undefined;
    try {
      exit = await proc.completion;
      try {
        lines.finish();
      } catch (error) {
        streamError ??= error;
      }
    } finally {
      stopQuota();
      await observer.close();
      telemetry.finish(!exit || exit.code !== 0 || !!streamError);
    }
    requireCondition(
      exit.code === 0 && !streamError && existsSync(output),
      "REVIEW_FAILED",
      "复核进程失败或未返回结构化报告",
    );
    return normalizeModelOutput(JSON.parse(readFileSync(output, "utf8")));
  }
  async stop(run: string, options?: { stopEnvironment?: boolean }) {
    this.cancelledRuns.add(run);
    const existingStop = this.engine.store.get<ProcessStopResult>("stop_result", run);
    if (
      existingStop &&
      (existingStop.status === "confirmed_exited" ||
        existingStop.status === "confirmed_not_started")
    ) {
      return existingStop;
    }

    for (const processId of this.preparationProcesses.get(run) ?? [])
      await this.processes.stop(processId);
    await this.preparing.get(run)?.catch(() => {});
    await this.browser.stop(run);
    let stopResult = await this.processes.stop(run);

    const record = this.engine.store.get<Run>("run", run);
    if (stopResult.status === "unknown" && record) {
      const procRecord = this.engine.store.get<{ status: string; confirmed?: boolean }>(
        "process_record",
        run,
      );
      if (procRecord && procRecord.status === "exited" && procRecord.confirmed) {
        stopResult = { status: "confirmed_exited" };
      }
    }

    if (
      stopResult.status === "confirmed_exited" ||
      stopResult.status === "confirmed_not_started"
    ) {
      this.engine.store.put("stop_result", run, record?.workflow_id ?? run, stopResult);
    }

    const isSingleRunStop = options?.stopEnvironment === false || record?.purpose === "aside";
    if (
      !isSingleRunStop &&
      record &&
      record.plan_revision > 0 &&
      !this.engine.config.retain_services_on_stop &&
      resolveTaskModel(this.engine.plan(record.workflow_id).plan) ===
        "native-v2"
    )
      await this.environments.stop(record.workflow_id);
    for (const p of this.engine.store.list<{ id: string }>(
      "check_process",
      run,
    ))
      await this.processes.stop(p.id);
    return stopResult;
  }
  async stopConversation(target: StopPortTarget): Promise<StopPortResult> {
    const node = this.engine.store.get<ConversationNode>(
      CONVERSATION_ENTITY.node,
      target.conversation_id,
    );
    const attempt = readStopAttempt(this.engine.store, target, node);
    const adapterId = node?.adapter_id ?? attemptAdapter(this.engine.store, attempt);
    const adapter = adapterId ? this.adapters.get(adapterId as never) : undefined;
    if (adapter?.stopConversation) {
      await adapter.stopConversation({
        conversation_id: target.conversation_id,
        native_session_id: target.native_session_id,
        native_agent_id: target.native_agent_id,
      });
    }
    const runId = attempt?.run_id ?? workflowRunId(this.engine.store, node);
    if (!runId) return { accepted: false, confirmation: "unknown" };
    const stopResult = await this.processes.stop(runId);
    if (stopResult.status === "confirmed_exited") {
      return { accepted: true, confirmation: "exited" };
    }
    if (stopResult.status === "confirmed_not_started") {
      return { accepted: true, confirmation: "exited" };
    }
    return { accepted: false, confirmation: "unknown" };
  }
  async close() {
    await this.processes.close();
  }
}

export function runtimeStopPort(runtime?: LocalRuntime): StopPort {
  if (typeof runtime?.stopConversation !== "function") {
    return {
      async stopConversation() {
        return { accepted: false, confirmation: "unknown" };
      },
    };
  }
  return {
    stopConversation: (target) => runtime.stopConversation(target),
  };
}

function readStopAttempt(
  store: Store,
  target: StopPortTarget,
  node?: ConversationNode,
): ConversationAttempt | undefined {
  if (target.attempt_id) {
    return store.get<ConversationAttempt>(
      CONVERSATION_ENTITY.attempt,
      target.attempt_id,
    );
  }
  if (!node?.current_attempt_id) return undefined;
  return store.get<ConversationAttempt>(
    CONVERSATION_ENTITY.attempt,
    node.current_attempt_id,
  );
}

function attemptAdapter(
  store: Store,
  attempt?: ConversationAttempt,
): string | undefined {
  if (!attempt?.run_id) return undefined;
  return store.get<Run>("run", attempt.run_id)?.adapter;
}

function workflowRunId(store: Store, node?: ConversationNode) {
  if (!node?.workflow_id) return undefined;
  return store.get<{ run_id?: string }>("workflow", node.workflow_id)?.run_id;
}

function acceptAgyLiveTelemetry(
  telemetry: RunTelemetry,
  event: unknown,
  rootNativeId?: string,
) {
  const root = rootNativeId ?? agyEventConversationId(event);
  acceptDecodedConversation(
    telemetry,
    root ? decodeAgyConversationEvent(event, { rootNativeId: root }) : [],
    event,
  );
  return root;
}

function acceptCodexLiveTelemetry(
  telemetry: RunTelemetry,
  adapter: NativeAgentAdapter,
  event: Record<string, unknown>,
  runId: string,
) {
  acceptDecodedConversation(
    telemetry,
    adapter.decodeConversation?.({
      stream: "stdout",
      data: JSON.stringify(event) + "\n",
      timestamp: now(),
      runId,
    }) ?? [],
    event,
  );
}
