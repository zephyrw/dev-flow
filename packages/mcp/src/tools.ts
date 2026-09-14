import { startTask } from "../../core/src/progress.js";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  FlowError,
  requireCondition,
} from "../../contracts/src/index.js";
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
        if (a.section === "overview")
          return {
            workflow_id: w.id,
            run_id: w.run_id,
            state: w.state,
            plan_revision: record.revision,
            plan_hash: record.hash,
            repositories: engine.store
              .list<any>("workspace", workflow)
              .map((ws) => ({ repo_id: ws.repo_id, root: ws.root })),
            task_model: plan.task_model ?? "legacy",
            modules: plan.modules,
            task_progress: engine.taskStatus(workflow),
            active_task: engine.store.get("task_activity", workflow),
            task_count: plan.tasks.length,
            test_count: plan.tests.length,
            instructions:
              "使用本工具 section=plan/skill/tasks/tests/scope/feedback/environment 读取批准信息；每次响应 text 是内容分段，next_offset 非 null 时继续相同 section 和 id。section=tool,id=完整工具名 可读取准确参数 Schema。先完整读取计划、任务及测试再修改。禁止原生工具。",
          };
        let value: unknown;
        if (a.section === "plan") value = plan.markdown;
        else if (a.section === "skill")
          value = readFileSync(
            resolve("packages/skills/devflow-execute/SKILL.md"),
            "utf8",
          );
        else if (a.section === "tasks")
          value = a.id ? plan.tasks.find((t) => t.id === a.id) : plan.tasks;
        else if (a.section === "tests")
          value = a.id ? plan.tests.find((t) => t.id === a.id) : plan.tests;
        else if (a.section === "scope") value = plan.scope;
        else if (a.section === "feedback") value = w.feedback;
        else if (a.section === "environment")
          value = engine.store.get("environment", workflow) ?? null;
        else if (a.section === "tool") value = toolContracts[a.id];
        else if (a.section === "response") {
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
    register(
      "devflow_list_files",
      "列出已绑定仓库内目录。",
      repo.extend({ path: RelativePath.optional() }),
      (a) => {
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
      z.object({ task_id: Id, summary: z.string().min(1).max(500).optional() }),
      (a) => startTask(engine, principal, workflow, a.task_id, a.summary),
    );
    register(
      "devflow_claim_task",
      "提交当前细项的实际实现说明并检查完成条件；测试通过情况单独统计，尚未通过全部验收门禁不能交付。",
      z.object({ task_id: Id, summary: z.string().min(10) }),
      (a) => engine.claimTask(principal, workflow, a.task_id, a.summary),
    );
    register(
      "devflow_freeze",
      "结束代码修改并冻结当前快照，进入测试阶段。",
      z.object({}),
      () => engine.freeze(workflow, principal),
    );
    register(
      "devflow_run_check",
      "运行批准的测试编号，返回真实报告。失败会使旧证据失效并回到 EXECUTING：修复后重新 freeze 并重跑全部检查。",
      z.object({ test_id: Id }),
      (a) => engine.runtime!.check(engine.get(workflow), a.test_id, principal),
    );
    register(
      "devflow_finish",
      "核验本轮所有任务和证据；成功后结束模型进程，等待人工验收。",
      z.object({}),
      () => engine.finish(workflow, principal),
    );
  }
  return server;
}
