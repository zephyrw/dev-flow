import { resolveProfile } from "../../core/src/run-profile.js";
import {
  SupportedAdapters,
  type ToolProfile,
} from "../../contracts/src/execution-spec.js";
import { CreateWorkflowService } from "../../core/src/create-workflow.js";
import { ExecutionSpecService } from "../../core/src/execution-spec-service.js";
import { WorkspaceReferenceSchema } from "../../contracts/src/feedback.js";
import { startTask } from "../../core/src/progress.js";
import { repairFailure } from "../../core/src/repair.js";
import { batchExecutionInstructions } from "../../core/src/execution-guidance.js";
import {
  OperationSchema,
  requestOperation,
} from "../../core/src/interactions.js";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { containerHandoffFiles } from "../../adapters/agy/src/handoff.js";
import type { Engine } from "../../core/src/engine.js";
import type { Principal } from "../../core/src/auth.js";
import {
  IntakeSchema,
  intake,
  RegisterProjectSchema,
  registerIntakeProject,
} from "../../entry/src/intake.js";
import {
  Id,
  PlanSchema,
  RelativePath,
  NativeDeliveryManifestSchema,
  FlowError,
  requireCondition,
  resolveTaskModel,
  type Run,
} from "../../contracts/src/index.js";
import { isLegacyProtocol } from "../../core/src/run-profile.js";
export const workerNames = [
  "devflow_execute_context",
  "devflow_list_files",
  "devflow_read_file",
  "devflow_search_files",
  "devflow_apply_files",
  "devflow_claim_task",
  "devflow_start_task",
  "devflow_freeze",
  "devflow_run_check",
  "devflow_finish",
  "devflow_deliver",
  "devflow_report_conflict",
  "devflow_request_operation",
  "devflow_run_operation",
  "devflow_environment",
  "devflow_diagnose",
] as const;
export function makeMcp(engine: Engine, principal: Principal) {
  const toolContracts: Record<string, unknown> = {};
  const server = new McpServer({
    name: principal.role === "worker" ? "devflow_worker" : "devflow",
    version: "0.1.0",
  });
  const register = (
    name: string,
    description: string,
    schema: z.ZodObject,
    fn: (args: any) => unknown,
    readonly = false,
  ) => {
    toolContracts[name] = { description, input_schema: z.toJSONSchema(schema) };
    server.registerTool(
      name,
      {
        description,
        inputSchema: schema,
        annotations: {
          readOnlyHint: readonly,
          destructiveHint: !readonly,
          idempotentHint: readonly,
          openWorldHint: false,
        },
      },
      async (args) => {
        try {
          const value = await fn(args);
          const serialized = JSON.stringify(value);
          if (principal.role === "worker") {
            if (Buffer.byteLength(serialized) > 6000) {
              const responseId = crypto.randomUUID();
              engine.store.put(
                "worker_response",
                responseId,
                principal.run_id!,
                {
                  text: serialized,
                  workflow_id: principal.workflow_id,
                  run_id: principal.run_id,
                },
              );
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      response_id: responseId,
                      total_characters: serialized.length,
                      text: serialized.slice(0, 1000),
                      next_offset: 1000,
                      instruction:
                        "完整响应通过 devflow_execute_context(section=response,id=response_id,offset=next_offset) 分页读取；不要读取本地临时文件。",
                    }),
                  },
                ],
              };
            }
            return { content: [{ type: "text" as const, text: serialized }] };
          }
          return {
            content: [{ type: "text" as const, text: serialized }],
            structuredContent: { result: value },
          };
        } catch (e) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  code: e instanceof FlowError ? e.code : "INVALID_REQUEST",
                  message: e instanceof Error ? e.message : String(e),
                }),
              },
            ],
          };
        }
      },
    );
  };
  if (principal.role === "planner") {
    register(
      "devflow_create_native_task",
      "为尚无正式计划的新需求建立原生工作流，由已配置规划工具规划；已有指定计划禁止使用此入口重新规划。",
      z.object({
        request_id: Id,
        workspace_root: z.string().min(1),
        request_text: z.string().min(1),
        refs: z.array(WorkspaceReferenceSchema).default([]),
        workspace_mode: z
          .enum(["existing_workspace", "new_worktree"])
          .default("existing_workspace"),
        planner_profile_id: Id,
        executor_profile_id: Id,
      }),
      (a) => {
        const result = new CreateWorkflowService(engine.store).execute(a);
        void engine.dispatch();
        return {
          ...result,
          console_url:
            engine.config.server.human_origin +
            "/?workflow=" +
            result.workflow.id,
        };
      },
    );
    register(
      "devflow_list_tool_profiles",
      "列出已保存配置及使用客户端原生配置的内置配置 ID；列表不代表工具已安装或认证。",
      z.object({}),
      () => {
        const saved = engine.store.list<ToolProfile>("tool_profile");
        return [
          ...saved,
          ...SupportedAdapters.filter(
            (a) => !saved.some((p) => p.id === "profile-" + a),
          ).map((a) => resolveProfile(engine.store, "profile-" + a)),
        ];
      },
      true,
    );
    register(
      "devflow_start",
      "用户说用 DevFlow 时的统一入口。识别当前仓库、会话和任务阶段；自动引导首次接入，返回规划上下文或控制台链接。",
      IntakeSchema,
      (a) => intake(engine, a),
    );
    register(
      "devflow_register_project",
      "调研后登记当前项目的运行配置及固定浏览器场景；只保存配置，命令须等完整计划批准后执行。",
      RegisterProjectSchema,
      (a) => registerIntakeProject(engine, a),
    );
    register(
      "devflow_list_projects",
      "列出已由用户登记的项目、配置哈希和基线。",
      z.object({}),
      () => engine.store.list("project"),
      true,
    );
    register(
      "devflow_create_workflow",
      "为具体项目创建独立工作流；不启动执行。",
      z.object({
        project_id: Id,
        title: z.string().min(1),
        request: z.string().min(1),
        complexity: z.enum(["simple", "complex"]),
        workspace_mode: z.enum(["existing_workspace", "new_worktree"]),
        idempotency_key: Id,
      }),
      (a) => engine.create(a, a.idempotency_key),
    );
    register(
      "devflow_get_workflow",
      "仅在用户请求或规划复核时读取一次工作流；禁止执行期间轮询。",
      z.object({ workflow_id: Id }),
      (a) => engine.detail(a.workflow_id),
      true,
    );
    register(
      "devflow_update_execution_spec",
      "安全修订已有工作流的工具配置规格（Profile/模型），若有正在执行的活动 Run 先审计停止后再应用新规格。",
      z.object({
        workflow_id: Id,
        expected_version: z.number().int().optional(),
        planner_profile: z.any().optional(),
        executor_profile: z.any().optional(),
        template_id: z.string().optional(),
        template_revision: z.number().int().optional(),
        interrupt_requested: z.boolean().optional(),
      }),
      async (a) => {
        const w = engine.get(a.workflow_id);
        const specService = new ExecutionSpecService(engine.store);
        const result = specService.updateExecutionSpec({
          request_id: `req_${Date.now()}`,
          expected_version: a.expected_version ?? w.version,
          workflow_id: a.workflow_id,
          planner_profile: a.planner_profile,
          executor_profile: a.executor_profile,
          template_id: a.template_id,
          template_revision: a.template_revision,
          interrupt_requested: a.interrupt_requested,
        });
        if (a.interrupt_requested) {
          if (["EXECUTING", "VERIFYING", "QUEUED"].includes(w.state)) {
            await engine.stop(a.workflow_id, "local_console");
          }
        }
        return {
          ok: true,
          spec: result.spec,
          interrupt_required: result.interruptRequired,
        };
      },
    );
    register(
      "devflow_submit_plan",
      "提交确定计划及测试定义，进入人工审批；调用后结束本轮，不轮询。",
      z.object({
        workflow_id: Id,
        expected_version: z.number().int(),
        idempotency_key: Id,
        plan: PlanSchema,
      }),
      (a) =>
        engine.submitValidatedPlan(
          a.workflow_id,
          a.plan,
          a.expected_version,
          a.idempotency_key,
        ),
    );
  } else if (principal.role === "worker") {
    const workflow = principal.workflow_id!;
    let taskModel: "legacy" | "leaf-v1" | "native-v2" = "legacy";
    try {
      const planRecord = engine.plan(workflow);
      taskModel = resolveTaskModel(planRecord?.plan);
    } catch {
      taskModel = "legacy";
    }
    const isNativeV2 = taskModel === "native-v2";
    const legacyRound = () => {
      const run = principal.run_id
        ? engine.store.get<Run>("run", principal.run_id)
        : undefined;
      try {
        return isLegacyProtocol(run, engine.plan(workflow).plan);
      } catch {
        return !isNativeV2;
      }
    };
    const repo = z.object({ repo_id: Id });
    register(
      "devflow_execute_context",
      "分段读取批准上下文。先 overview，再 plan、skill、tasks、tests；tool + id 查询单个工具参数。按 next_offset 继续，禁止使用原生文件工具。",
      z.object({
        section: z
          .enum([
            "overview",
            "plan",
            "skill",
            "tasks",
            "tests",
            "scope",
            "feedback",
            "environment",
            "tool",
            "response",
            "operations",
            "diagnostics",
          ])
          .default("overview"),
        id: z.string().optional(),
        offset: z.number().int().nonnegative().default(0),
      }),
      (a) => {
        engine.worker(principal, workflow);
        const w = engine.get(workflow),
          record = engine.plan(workflow),
          plan = record.plan;
        if (a.section === "overview") {
          const files = containerHandoffFiles(
            join(engine.config.storage_root, "containers", workflow),
          );
          return {
            workflow_id: w.id,
            run_id: w.run_id,
            state: w.state,
            plan_revision: record.revision,
            plan_hash: record.hash,
            repositories: engine.store
              .list<any>("workspace", workflow)
              .map((ws) => ({ repo_id: ws.repo_id, root: ws.root })),
            task_model: taskModel,
            modules: plan.modules,
            task_progress: engine.taskStatus(workflow),
            active_task: engine.store.get("task_activity", workflow),
            task_count: plan.tasks.length,
            test_count: plan.tests.length,
            instructions: isNativeV2
              ? "原生开发模式：请使用原生文件查看工具阅读 " +
                files.markdown +
                " 与 " +
                files.json +
                " 完整设计与验收要求，完成全部实现和测试代码后由多个子 Agent 并行运行各自明确的独立测试目标，通过后使用 devflow_deliver 交付。" +
                batchExecutionInstructions
              : "使用本工具 section=plan/skill/tasks/tests/scope/feedback/environment 读取批准信息；每次响应 text 是内容分段，next_offset 非 null 时继续相同 section 和 id。section=tool,id=完整工具名 可读取准确参数 Schema。先完整读取计划、任务及测试再修改。禁止原生工具。",
          };
        }
        let value: unknown;
        if (a.section === "plan") value = plan.markdown;
        else if (a.section === "skill")
          value = readFileSync(
            resolve("packages/skills/devflow-execute/SKILL.md"),
            "utf8",
          );
        else if (a.section === "tasks") {
          const progress = engine.taskStatus(workflow);
          const tasks = plan.tasks.map((t) => ({
            ...t,
            progress: progress.find((p) => p.id === t.id),
          }));
          value = a.id ? tasks.find((t) => t.id === a.id) : tasks;
        } else if (a.section === "tests")
          value = a.id ? plan.tests.find((t) => t.id === a.id) : plan.tests;
        else if (a.section === "scope") value = plan.scope;
        else if (a.section === "feedback") value = w.feedback;
        else if (a.section === "operations")
          value = engine.store
            .list<any>("operation_request", workflow)
            .filter((o) => o.run_id === principal.run_id);
        else if (a.section === "diagnostics")
          value = engine.store.get("diagnostic_summary", workflow);
        else if (a.section === "environment")
          value = engine.store.get("environment", workflow);
        else if (a.section === "tool") {
          const tool = toolContracts[a.id ?? ""];
          requireCondition(tool, "TOOL_NOT_FOUND", "未知工具名");
          value = tool;
        } else if (a.section === "response") {
          const response = engine.store.must<any>(
            "worker_response",
            a.id ?? "",
          );
          requireCondition(
            response.workflow_id === workflow &&
              response.run_id === principal.run_id,
            "RESPONSE_DENIED",
            "响应不属于当前轮次",
          );
          value = response.text;
        }
        requireCondition(
          value !== undefined,
          "CONTEXT_NOT_FOUND",
          "未知上下文或工具编号",
        );
        const content =
          typeof value === "string" ? value : JSON.stringify(value);
        requireCondition(
          a.offset <= content.length,
          "OFFSET_INVALID",
          "读取偏移超出内容范围",
        );
        const end = Math.min(content.length, a.offset + 1000);
        return {
          section: a.section,
          id: a.id ?? null,
          plan_revision: record.revision,
          plan_hash: record.hash,
          total_characters: content.length,
          offset: a.offset,
          text: content.slice(a.offset, end),
          next_offset: end < content.length ? end : null,
        };
      },
      true,
    );
    if (!isNativeV2) {
      register(
        "devflow_list_files",
        "列出已绑定仓库内目录。",
        repo.extend({ path: RelativePath.optional() }),
        (a) => {
          requireCondition(
            legacyRound(),
            "INVALID_MODE",
            "新轮次请说明本轮结果后直接交代码审查，不能调用旧完成工具",
          );
          const f = engine.files(principal, workflow, a.repo_id);
          return f.broker.list(f.root, a.path);
        },
        true,
      );
      register(
        "devflow_read_file",
        "分页读取仓库文件，返回供并发校验的完整文件哈希。",
        repo.extend({
          path: RelativePath,
          start: z.number().int().positive().default(1),
          limit: z.number().int().positive().max(1000).default(300),
        }),
        (a) => {
          requireCondition(
            legacyRound(),
            "INVALID_MODE",
            "新轮次请说明本轮结果后直接交代码审查，不能调用旧完成工具",
          );
          const f = engine.files(principal, workflow, a.repo_id);
          return f.broker.read(f.root, a.path, a.start, a.limit);
        },
        true,
      );
      register(
        "devflow_search_files",
        "在当前仓库中按文本查询，不运行 shell。",
        repo.extend({ query: z.string().min(1).max(500) }),
        (a) => {
          requireCondition(
            legacyRound(),
            "INVALID_MODE",
            "新轮次请说明本轮结果后直接交代码审查，不能调用旧完成工具",
          );
          const f = engine.files(principal, workflow, a.repo_id);
          return f.broker.search(f.root, a.query);
        },
        true,
      );
      register(
        "devflow_apply_files",
        "按批准的精确路径修改文件。expected_hash 必须匹配当前内容；新文件为 null。",
        repo.extend({
          changes: z
            .array(
              z
                .object({
                  path: RelativePath,
                  expected_hash: z.string().nullable(),
                  content: z.string().nullable(),
                })
                .strict(),
            )
            .min(1)
            .max(50),
        }),
        (a) => {
          requireCondition(
            legacyRound(),
            "INVALID_MODE",
            "新轮次请说明本轮结果后直接交代码审查，不能调用旧完成工具",
          );
          const f = engine.files(principal, workflow, a.repo_id, true);
          const plan = engine.plan(workflow).plan,
            scope = plan.scope;
          if (plan.task_model === "leaf-v1") {
            const active = engine.store.get<any>("task_activity", workflow);
            const task = plan.tasks.find((t) => t.id === active?.task_id);
            requireCondition(
              active?.run_id === principal.run_id &&
                task &&
                (!task.repo_id || task.repo_id === a.repo_id),
              "TASK_NOT_STARTED",
              "修改前先开始当前仓库的细项任务",
            );
            requireCondition(
              a.changes.every((c: any) => task.paths.includes(c.path)),
              "TASK_SCOPE",
              "文件不属于当前细项，不能扩大修改范围",
            );
          }
          return f.broker.apply(
            f.root,
            {
              ...scope,
              allowed_paths:
                scope.repository_paths[a.repo_id] ?? scope.allowed_paths,
            },
            a.changes,
          );
        },
      );
      register(
        "devflow_start_task",
        "开始细项或更新当前细项进展；必须先完成依赖。",
        z.object({
          task_id: Id,
          summary: z.string().min(1).max(500).optional(),
        }),
        (a) => {
          requireCondition(
            legacyRound(),
            "INVALID_MODE",
            "新轮次请说明本轮结果后直接交代码审查，不能调用旧完成工具",
          );
          return startTask(engine, principal, workflow, a.task_id, a.summary);
        },
      );
      register(
        "devflow_claim_task",
        "提交当前细项的实际实现说明并检查完成条件；测试通过情况单独统计，尚未通过全部验收门禁不能交付。",
        z.object({ task_id: Id, summary: z.string().min(10) }),
        (a) => {
          requireCondition(
            legacyRound(),
            "INVALID_MODE",
            "新轮次请说明本轮结果后直接交代码审查，不能调用旧完成工具",
          );
          return engine.claimTask(principal, workflow, a.task_id, a.summary);
        },
      );
      register(
        "devflow_freeze",
        "结束代码修改并冻结当前快照，进入测试阶段。",
        z.object({}),
        () => {
          requireCondition(
            legacyRound(),
            "INVALID_MODE",
            "新轮次请说明本轮结果后直接交代码审查，不能调用旧完成工具",
          );
          return engine.freeze(workflow, principal);
        },
      );
      register(
        "devflow_run_check",
        "运行批准的测试编号，返回真实报告。失败会使旧证据失效并回到 EXECUTING：修复后先重跑该目标，再由负责的子 Agent 并行运行独立的受影响回归目标。",
        z.object({ test_id: Id }),
        (a) => {
          requireCondition(
            legacyRound(),
            "INVALID_MODE",
            "新轮次请说明本轮结果后直接交代码审查，不能调用旧完成工具",
          );
          return engine.runtime!.check(
            engine.get(workflow),
            a.test_id,
            principal,
          );
        },
      );
    }
    register(
      "devflow_request_operation",
      "需要未登记的安装、诊断等命令时，提交具体可执行文件、参数、任务仓库和理由，请用户在工作台授权。提交后本轮结束，系统在批准或拒绝后续接同一会话；不能使用原生终端绕过。",
      OperationSchema,
      (a) => requestOperation(engine, principal, workflow, a),
    );
    register(
      "devflow_run_operation",
      "执行用户批准的具体操作；一个授权请求只执行一次，重复读取返回原结果。拒绝时按用户意见调整。",
      z.object({ request_id: Id }),
      (a) =>
        engine.runtime!.operation!(
          engine.get(workflow),
          a.request_id,
          principal,
        ),
    );
    register(
      "devflow_environment",
      "开发过程中构建并启动/重启验证环境，或查询状态和最新日志。失败留在执行阶段，按诊断修复后重试。",
      z.object({ action: z.enum(["start", "restart", "status", "logs"]) }),
      async (a) => {
        engine.worker(principal, workflow);
        if (["start", "restart"].includes(a.action)) {
          engine.worker(principal, workflow, true);
          await engine.exclusive(workflow, async () => {
            try {
              await engine.runtime!.prepareVerification!(
                engine.get(workflow),
                principal,
              );
            } catch (error) {
              const repair = await repairFailure(
                engine,
                workflow,
                error,
                principal.run_id!,
              );
              if (repair?.retry)
                throw new FlowError(
                  error instanceof FlowError
                    ? error.code
                    : "ENVIRONMENT_FAILED",
                  repair.instructions,
                );
              if (repair) {
                engine.auth.revokeRun(principal.run_id!);
                setTimeout(
                  () =>
                    void engine.runtime
                      ?.stop(principal.run_id!)
                      .catch(() => {}),
                  100,
                );
              }
              throw error;
            }
          });
        }
        return {
          environment: engine.store.get("environment", workflow),
          logs: engine.store
            .recentEvents(workflow, 100)
            .filter((e) => /Build|Service|Environment/.test(e.type))
            .map((e) => engine.store.publicEvent(e)),
        };
      },
    );
    register(
      "devflow_diagnose",
      "多次修复没有进展时，调用规划模型进行一次只读故障诊断。诊断不会替代独立复核，也不会批准新增范围。",
      z.object({ problem: z.string().min(10).max(8000) }),
      async (a) => {
        engine.worker(principal, workflow);
        const result = await engine.runtime!.diagnose!(
          engine.get(workflow),
          a.problem,
        );
        engine.worker(principal, workflow);
        if (result.requires_plan_change) {
          const w = engine.get(workflow);
          engine.transition(
            workflow,
            [w.state],
            "REPAIR_RESEARCH_REQUIRED",
            "research",
          );
          await engine.submitValidatedPlan(
            workflow,
            result.repair_plan,
            engine.get(workflow).version,
            crypto.randomUUID(),
          );
          setTimeout(
            () => void engine.runtime?.stop(principal.run_id!).catch(() => {}),
            100,
          );
        }
        return result;
      },
    );
    if (!isNativeV2) {
      register(
        "devflow_finish",
        "核验本轮所有任务和证据；成功后结束模型进程，等待人工验收。",
        z.object({}),
        () => {
          requireCondition(
            legacyRound(),
            "INVALID_MODE",
            "新轮次请说明本轮结果后直接交代码审查，不能调用旧完成工具",
          );
          return engine.finish(workflow, principal);
        },
      );
    }
    register(
      "devflow_deliver",
      "说明本轮执行结果。status 为 completed 时交接代码质量审查；need_planner 进入规划澄清；need_user 等待用户。",
      NativeDeliveryManifestSchema,
      async (a) => {
        requireCondition(
          !legacyRound(),
          "INVALID_MODE",
          "当前轮次仍使用旧完成协议",
        );
        engine.worker(principal, workflow);
        return engine.receiveRoundResult(workflow, principal.run_id!, a);
      },
    );
    register(
      "devflow_report_conflict",
      "当架构、数据结构、外部接口或核心业务规则与规划设计存在真实冲突时上报具体证据，由规划模型修订原方案。",
      z.object({
        description: z.string().min(10),
        conflict_evidence: z.string().min(10),
        affected_modules: z.array(z.string()).default([]),
      }),
      async (a) => {
        requireCondition(
          !legacyRound(),
          "INVALID_MODE",
          "当前轮次仍使用旧完成协议",
        );
        engine.worker(principal, workflow);
        return engine.reportConflict(workflow, a);
      },
    );
  }
  return server;
}
