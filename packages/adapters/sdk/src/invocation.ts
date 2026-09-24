import type {
  ModelSelectionCapability,
  PreparedInvocation,
  RunContext,
} from "./interface.js";
import { resolveRunSelection } from "./frozen-invocation.js";
import { FlowError } from "../../../contracts/src/index.js";

export const readOnlyPurpose = (p: string) =>
  ["planning", "quality_review", "aside", "diagnose"].includes(p);

export function capabilityFromAdapter(
  _adapter: string,
  _profile: unknown,
  extras: ModelSelectionCapability = {},
): ModelSelectionCapability {
  return { ...extras };
}

function nativeProfileName(input: RunContext): string | undefined {
  const name = input.frozenInvocation
    ? input.frozenInvocation.nativeConfigProfile?.trim()
    : input.toolProfile.nativeConfigProfile?.trim();
  if (!name || name === "default") return undefined;
  return name;
}

function pushNativeProfile(adapter: string, args: string[], input: RunContext) {
  const name = nativeProfileName(input);
  if (!name) return;
  if (adapter !== "codex") {
    throw new FlowError("CLI_PARAMETER_UNSUPPORTED", "当前工具不支持命名原生配置", 422);
  }
  args.push("--profile", name);
}

function pushFrozenSelection(
  args: string[],
  env: Record<string, string>,
  input: RunContext,
): void {
  const selection = resolveRunSelection(input);
  for (const [key, value] of Object.entries(selection.effortEnv)) {
    env[key] = value;
  }
  if (selection.modelToken) {
    args.push("--model", selection.modelToken);
  }
  args.push(...selection.effortArgs);
}

export function clientInvocation(
  adapter: string,
  input: RunContext,
  executable: string,
): PreparedInvocation {
  const cwd = Object.values(input.workspaceRoots)[0];
  if (!cwd) throw new Error("执行轮次没有工作区");
  const prompt =
    input.prompt ??
    "请读取工作包 " +
      input.handoffDocPath +
      "。严格按给定正式计划执行，不得另写替代计划。";
  const readonly = readOnlyPurpose(input.purpose);
  const resume = input.conversationId;
  const args: string[] = [];
  const env: Record<string, string> = {
    DEVFLOW_WORKFLOW_ID: input.workflowId,
    DEVFLOW_RUN_ID: input.runId,
    DEVFLOW_STAGE: input.stage,
  };
  pushNativeProfile(adapter, args, input);
  switch (adapter) {
    case "codex":
      args.push("exec");
      args.push(
        "-c",
        "sandbox_mode=" +
          JSON.stringify(readonly ? "read-only" : "workspace-write"),
        "-c",
        'approval_policy="never"',
      );
      if (resume) args.push("resume", resume);
      args.push("--json", "--skip-git-repo-check");
      pushFrozenSelection(args, env, input);
      if (input.outputPath)
        args.push("--output-last-message", input.outputPath);
      if (input.schemaPath) args.push("--output-schema", input.schemaPath);
      args.push("-");
      return {
        executable,
        args,
        cwd,
        env,
        stdin: prompt,
        conversationId: resume,
      };
    case "agy":
      args.push(
        "--output-format",
        "stream-json",
        "--print-timeout",
        Math.max(1, Math.ceil((input.timeoutMs ?? 300000) / 60000)) + "m",
      );
      pushFrozenSelection(args, env, input);
      if (resume) {
        args.push("--conversation", resume);
      } else if ((input as any).projectId) {
        args.push("--project", (input as any).projectId);
      }
      args.push("--mode", readonly ? "plan" : "accept-edits");
      for (const root of Object.values(input.workspaceRoots))
        args.push("--add-dir", root);
      if (input.schemaPath) args.push("--json-schema", input.schemaPath);
      args.push("-p", prompt);
      break;
    case "claude-code":
      args.push(
        "--print",
        "--verbose",
        "--output-format",
        "stream-json",
        "--permission-mode",
        readonly ? "plan" : "acceptEdits",
      );
      if (readonly)
        args.push(
          "--tools",
          "Read,Glob,Grep,Agent,Task",
          "--disallowedTools",
          "Bash,Edit,Write,NotebookEdit",
          "--agents",
          JSON.stringify({
            "devflow-readonly": {
              description: "DevFlow read-only subagent",
              tools: ["Read", "Glob", "Grep"],
            },
          }),
        );
      if (resume) args.push("--resume", resume);
      pushFrozenSelection(args, env, input);
      args.push("--", prompt);
      break;
    case "grok-build":
      args.push(
        "--output-format",
        "streaming-json",
        "--no-plan",
      );
      if (readonly)
        args.push(
          "--tools",
          "read,grep,glob",
          "--deny",
          "Bash",
          "--deny",
          "Edit",
          "--deny",
          "Write",
          "--deny",
          "MCPTool",
          "--agents",
          JSON.stringify({
            "devflow-readonly-child": {
              description: "DevFlow read-only subagent",
              tools: ["read", "grep", "glob"],
            },
          }),
        );
      if (resume) args.push("--resume", resume);
      pushFrozenSelection(args, env, input);
      args.push("-p", prompt);
      break;
    case "kimi-code":
      // CW-D09: Kimi headless 方案的 --plan 与 -p 冲突，只读角色在 spawn 前直接返回 READ_ONLY_UNSUPPORTED
      if (readonly) {
        throw new FlowError(
          "READ_ONLY_UNSUPPORTED",
          "Kimi Code 当前 headless 方案不支持只读执行（--plan 与 -p 冲突），无法安全执行只读角色",
          422,
        );
      }
      args.push("--output-format", "stream-json");
      if (resume) args.push("--session", resume);
      pushFrozenSelection(args, env, input);
      args.push("-p", prompt);
      break;
    case "qoder":
      args.push(
        "--print",
        "--output-format",
        "stream-json",
        "--permission-mode",
        readonly ? "dont_ask" : "accept_edits",
      );
      if (readonly) {
        args.push(
          "--tools",
          "Read,Glob,Grep",
          "--disallowed-tools",
          "Bash,Edit,Write,NotebookEdit,Task",
          "--agents",
          JSON.stringify({
            "devflow-readonly-child": {
              description: "DevFlow read-only subagent",
              tools: ["Read", "Glob", "Grep"],
            },
          }),
        );
      }
      if (resume) args.push("--resume", resume);
      pushFrozenSelection(args, env, input);
      args.push(prompt);
      break;
    case "mimo-code":
      // MiMo Code: independent identity; prompt via stdin; never shell-interpolate.
      // New tasks must not use --continue (would resume someone else's latest session).
      args.push("run", "--format", "json");
      if (resume) args.push("--session", resume);
      pushFrozenSelection(args, env, input);
      // 按用途显式选择原生 agent，确保只读权限由原生实现。
      if (readonly) {
        args.push("--agent", "devflow-review");
      } else if (
        input.purpose === "planner_takeover" ||
        input.purpose === "planner_commit"
      ) {
        args.push("--agent", "devflow-planner");
      } else {
        args.push("--agent", "devflow-executor");
      }
      // Role/permission config is scoped to this managed subprocess only.
      env.MIMOCODE_CONFIG_CONTENT = JSON.stringify(
        readonly
          ? {
              agent: {
                "devflow-review": {
                  mode: "primary",
                  description: "DevFlow read-only inspection",
                  permission: {
                    "*": "deny",
                    read: "allow",
                    glob: "allow",
                    grep: "allow",
                    list: "allow",
                    task: {
                      "*": "deny",
                      "devflow-review-child": "allow",
                    },
                  },
                },
                "devflow-review-child": {
                  mode: "subagent",
                  description: "DevFlow read-only subagent",
                  permission: {
                    "*": "deny",
                    read: "allow",
                    glob: "allow",
                    grep: "allow",
                    list: "allow",
                    edit: "deny",
                    write: "deny",
                    bash: "deny",
                    patch: "deny",
                  },
                },
              },
            }
          : {
              agent: {
                "devflow-executor": {
                  mode: "primary",
                  description: "DevFlow implement / test / fix",
                },
                "devflow-planner": {
                  mode: "primary",
                  description: "DevFlow planner repair / commit",
                },
              },
            },
      );
      // Pin in-flight CLI behavior; upgrades only apply at a later launch boundary.
      env.MIMOCODE_DISABLE_AUTOUPDATE = "1";
      return {
        executable,
        args,
        cwd,
        env,
        stdin: prompt,
        conversationId: resume,
      };
    case "opencode":
      args.push("run", "--format", "json");
      if (resume) args.push("--session", resume);
      pushFrozenSelection(args, env, input);
      if (readonly) {
        args.push("--agent", "devflow-review");
        env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
          agent: {
            "devflow-review": {
              mode: "primary",
              description: "DevFlow read-only inspection",
              permission: {
                "*": "deny",
                read: "allow",
                glob: "allow",
                grep: "allow",
                list: "allow",
                task: {
                  "*": "deny",
                  "devflow-review-child": "allow",
                },
              },
            },
            "devflow-review-child": {
              mode: "subagent",
              description: "DevFlow read-only subagent",
              permission: {
                "*": "deny",
                read: "allow",
                glob: "allow",
                grep: "allow",
                list: "allow",
                edit: "deny",
                write: "deny",
                bash: "deny",
                patch: "deny",
              },
            },
          },
        });
      }
      args.push(prompt);
      break;
    case "cursor-agent":
      args.push("--print", "--output-format", "stream-json");
      if (readonly) args.push("--mode", "ask");
      if (resume) args.push("--resume", resume);
      pushFrozenSelection(args, env, input);
      args.push(prompt);
      break;
    default:
      throw new Error("未支持的适配器：" + adapter);
  }
  return { executable, args, cwd, env, conversationId: resume };
}
