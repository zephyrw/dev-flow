import type { RunContext, PreparedInvocation } from "./interface.js";
export const readOnlyPurpose = (p: string) =>
  ["planning", "quality_review", "aside"].includes(p);
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
  const model =
    input.toolProfile.modelSelection === "explicit"
      ? input.toolProfile.modelId
      : undefined;
  switch (adapter) {
    case "codex":
      args.push("exec");
      // exec resume has its own parser. Sandbox settings are global config overrides.
      args.push(
        "-c",
        "sandbox_mode=" +
          JSON.stringify(readonly ? "read-only" : "workspace-write"),
        "-c",
        'approval_policy="never"',
      );
      if (resume) args.push("resume", resume);
      args.push("--json", "--skip-git-repo-check");
      if (model) args.push("--model", model);
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
      if (model) args.push("--model", model);
      if (resume) args.push("--conversation", resume);
      else args.push("--new-project");
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
          "Read,Glob,Grep",
          "--disallowedTools",
          "Bash,Edit,Write,NotebookEdit,Agent",
        );
      if (resume) args.push("--resume", resume);
      if (model) args.push("--model", model);
      args.push(prompt);
      break;
    case "grok-build":
      args.push(
        "--output-format",
        "streaming-json",
        "--no-plan",
        "--no-subagents",
        "--no-auto-update",
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
          "MCPTool",
        );
      if (resume) args.push("--resume", resume);
      if (model) args.push("--model", model);
      args.push("-p", prompt);
      break;
    case "kimi-code":
      args.push("--output-format", "stream-json");
      if (resume) args.push("--session", resume);
      if (readonly) args.push("--plan");
      if (model) args.push("--model", model);
      args.push("-p", prompt);
      break;
    case "qoder":
      args.push(
        "--print",
        "--output-format",
        "stream-json",
        "--permission-mode",
        readonly ? "plan" : "accept_edits",
      );
      if (readonly) args.push("--tools", "Read,Glob,Grep");
      if (resume) args.push("--resume", resume);
      if (model) args.push("--model", model);
      args.push(prompt);
      break;
    case "opencode":
      args.push("run", "--format", "json");
      if (resume) args.push("--session", resume);
      if (model) args.push("--model", model);
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
      if (model) args.push("--model", model);
      args.push(prompt);
      break;
    default:
      throw new Error("未支持的适配器：" + adapter);
  }
  return { executable, args, cwd, env, conversationId: resume };
}
