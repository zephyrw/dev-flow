import { readFileSync, existsSync } from "node:fs";
import type { TestExecution } from "../../contracts/src/index.js";

export interface HostToolExecutionFact {
  aliases?: string[];
  workflow_id?: string;
  run_id?: string;
  plan_hash?: string;
  input_fingerprints?: Record<string, string>;
  report_hashes?: Record<string, string>;
  evidence_error?: string;
  tool_call_id: string;
  command: string;
  cwd: string;
  conversation_id?: string;
  started_at?: string;
  ended_at?: string;
  exit_code?: number; // 严格可空，未知严禁当作0！
  status?: string;
  output?: string;
  output_path?: string;
}

export class NativeRunRecordReader {
  private facts = new Map<string, HostToolExecutionFact>();

  constructor(facts: HostToolExecutionFact[] = []) {
    for (const f of facts) {
      if (this.facts.has(f.tool_call_id)) {
        this.facts.set(f.tool_call_id, {
          ...f,
          exit_code: undefined,
          status: "AMBIGUOUS",
        });
      } else this.facts.set(f.tool_call_id, { ...f });
    }
  }

  /**
   * 从 AGY 运行日志 (.jsonl) 或 transcript 文件解析真实的工具执行记录
   */
  static fromLogFile(filePath: string): NativeRunRecordReader {
    if (!existsSync(filePath)) {
      return new NativeRunRecordReader([]);
    }
    const content = readFileSync(filePath, "utf8");
    return NativeRunRecordReader.fromString(content);
  }

  static fromString(content: string): NativeRunRecordReader {
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    const toolCalls = new Map<
      string,
      {
        command: string;
        cwd: string;
        started_at?: string;
        conversation_id?: string;
      }
    >();
    const facts: HostToolExecutionFact[] = [];
    const commandIdToCallId = new Map<string, string>();
    const factsByCallId = new Map<string, HostToolExecutionFact>();

    const parseExitCodeFromOutput = (output?: string): number | undefined => {
      if (!output) return undefined;
      // 若处于运行中状态，绝对不视为退出
      if (
        /process\s+still\s+running/i.test(output) ||
        /running\s+as\s+a\s+background/i.test(output)
      ) {
        return undefined;
      }
      // 严格匹配宿主完成元数据，绝不匹配任意业务输出的 code: 0
      const match =
        output.match(/command\s+completed[.\s]+exit\s+code[:\s]+(\d+)/i) ??
        output.match(/(?:the\s+)?command\s+exited\s+with\s+code[:\s]+(\d+)/i) ??
        output.match(
          /task\s+id\s+"[^"]+"\s+finished\s+with\s+result:.*exited\s+with\s+code[:\s]+(\d+)/is,
        ) ??
        output.match(/^exit\s+code[:\s]+(\d+)$/im);
      if (match && match[1]) {
        return parseInt(match[1], 10);
      }
      return undefined;
    };

    for (const line of lines) {
      try {
        const item = JSON.parse(line);

        // 1. 真实 AGY 适配器输出的 step_update 格式
        const stepUpdate =
          item.event === "step_update" ? item.step_update : item.step_update;

        if (stepUpdate && typeof stepUpdate === "object") {
          const toolInfo = stepUpdate.tool_info ?? {};
          const toolName = stepUpdate.tool_name ?? toolInfo.name;
          const params = toolInfo.parameters ?? toolInfo.args ?? {};

          // 异步命令状态查询关联 (如 command_status)
          if (toolName === "command_status") {
            const cmdId = String(
              params.CommandId ?? params.command_id ?? params.id ?? "",
            );
            const callId = commandIdToCallId.get(cmdId);
            const output =
              typeof toolInfo.output === "string" ? toolInfo.output : undefined;
            const code = parseExitCodeFromOutput(output);
            if (callId && factsByCallId.has(callId)) {
              const target = factsByCallId.get(callId)!;
              if (code !== undefined) {
                target.exit_code = code;
                target.status = "DONE";
                target.ended_at = item.timestamp ?? item.created_at;
              }
              if (output) {
                target.output =
                  (target.output ? target.output + "\n" : "") + output;
              }
            }
            continue;
          }

          if (
            stepUpdate.step_type === "tool" ||
            toolName === "run_command" ||
            toolName === "terminal" ||
            toolName === "exec"
          ) {
            const callId =
              stepUpdate.tool_call_id ??
              toolInfo.id ??
              toolInfo.tool_call_id ??
              stepUpdate.step_id ??
              (stepUpdate.step_index != null
                ? `step-${stepUpdate.step_index}`
                : undefined) ??
              item.id;

            const command = String(
              params.CommandLine ?? params.command ?? params.cmd ?? "",
            );
            const cwd = String(params.Cwd ?? params.cwd ?? "");
            const output =
              typeof toolInfo.output === "string" ? toolInfo.output : undefined;
            const state = stepUpdate.state;

            // 检查异步后台任务启动并记录 commandId 映射
            if (output) {
              const cmdMatch =
                output.match(/Command ID:\s*([\w-]+)/i) ??
                output.match(/task id[:\s]+"([^"]+)"/i);
              if (cmdMatch && cmdMatch[1] && callId) {
                commandIdToCallId.set(cmdMatch[1], String(callId));
              }
            }

            let exitCode: number | undefined;
            if (typeof toolInfo.exit_code === "number") {
              exitCode = toolInfo.exit_code;
            } else if (typeof stepUpdate.exit_code === "number") {
              exitCode = stepUpdate.exit_code;
            } else if (output) {
              exitCode = parseExitCodeFromOutput(output);
            }

            if (callId && command) {
              const factRecord: HostToolExecutionFact = {
                tool_call_id: String(callId),
                command,
                cwd,
                conversation_id: stepUpdate.conversation_id,
                started_at: item.timestamp ?? item.created_at,
                ended_at: item.timestamp ?? item.created_at,
                exit_code: exitCode,
                status: state,
                output,
              };
              facts.push(factRecord);
              factsByCallId.set(String(callId), factRecord);
              continue;
            }
          }
        }

        // 2. 标准 tool_call / tool_use 事件
        if (
          item.event === "tool_call" ||
          item.type === "tool_call" ||
          item.type === "tool_use"
        ) {
          const callId = item.tool_call_id ?? item.id;
          const name = item.name ?? item.tool ?? item.toolName;
          const args = item.args ?? item.parameters ?? item.input ?? {};
          if (
            callId &&
            (name === "run_command" || name === "terminal" || name === "exec")
          ) {
            const command = String(
              args.CommandLine ?? args.command ?? args.cmd ?? "",
            );
            const cwd = String(args.Cwd ?? args.cwd ?? "");
            toolCalls.set(callId, {
              command,
              cwd,
              started_at: item.timestamp ?? item.created_at,
              conversation_id: item.conversation_id,
            });
          }
        }

        // 3. 标准 tool_result / tool_return 事件
        if (
          item.event === "tool_result" ||
          item.type === "tool_result" ||
          item.type === "tool_return"
        ) {
          const callId = item.tool_call_id ?? item.id;
          if (callId && toolCalls.has(callId)) {
            const call = toolCalls.get(callId)!;
            const output =
              typeof item.output === "string"
                ? item.output
                : typeof item.content === "string"
                  ? item.content
                  : undefined;

            let exitCode: number | undefined;
            if (typeof item.exit_code === "number") {
              exitCode = item.exit_code;
            } else if (typeof item.code === "number") {
              exitCode = item.code;
            } else if (
              item.result &&
              typeof item.result.exit_code === "number"
            ) {
              exitCode = item.result.exit_code;
            } else {
              exitCode = parseExitCodeFromOutput(output);
            }

            facts.push({
              tool_call_id: callId,
              command: call.command,
              cwd: call.cwd,
              conversation_id: call.conversation_id,
              started_at: call.started_at,
              ended_at: item.timestamp ?? item.created_at,
              exit_code: exitCode,
              status: item.status,
              output,
            });
          }
        }

        // 4. 宿主直接输出的已完成执行记录
        if (item.type === "command_execution" && item.tool_call_id) {
          facts.push({
            tool_call_id: item.tool_call_id,
            command: item.command,
            cwd: item.cwd ?? "",
            started_at: item.started_at,
            ended_at: item.ended_at,
            exit_code:
              typeof item.exit_code === "number" ? item.exit_code : undefined,
            output_path: item.output_path,
          });
        }
      } catch {
        // 忽略非 JSON 行
      }
    }

    return new NativeRunRecordReader(facts);
  }

  getFact(toolCallId: string): HostToolExecutionFact | undefined {
    const matches = this.getAllFacts().filter(
      (f) => f.tool_call_id === toolCallId || f.aliases?.includes(toolCallId),
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  getAllFacts(): HostToolExecutionFact[] {
    return Array.from(this.facts.values());
  }

  readRecords(runId?: string): HostToolExecutionFact[] {
    return this.getAllFacts().filter((f) => !runId || f.run_id === runId);
  }

  /**
   * 校验清单中声明的测试执行是否与宿主真实记录一致
   */
  verify(declared: { tool_call_id: string; command: string; cwd?: string }): {
    valid: boolean;
    actualExitCode?: number;
    reason?: string;
  } {
    const fact = this.getFact(declared.tool_call_id);
    if (!fact) {
      return {
        valid: false,
        reason: `宿主未找到标识为 '${declared.tool_call_id}' 的原始工具调用记录`,
      };
    }

    // 1. 核对命令内容 (规范化空白与斜杠，全字严格比对)
    const normDeclaredCmd = declared.command.trim();
    const normFactCmd = fact.command.trim();
    if (normDeclaredCmd !== normFactCmd) {
      return {
        valid: false,
        reason: `宿主原始命令 '${fact.command}' 与声明的测试命令 '${declared.command}' 不匹配`,
      };
    }

    // 2. 核对工作目录 (若声明或宿主事实存在)
    if (declared.cwd && fact.cwd) {
      const normDeclaredCwd = declared.cwd
        .replaceAll("\\", "/")
        .replace(/\/+$/, "")
        .toLowerCase();
      const normFactCwd = fact.cwd
        .replaceAll("\\", "/")
        .replace(/\/+$/, "")
        .toLowerCase();
      if (normDeclaredCwd !== normFactCwd) {
        return {
          valid: false,
          reason: `宿主工具执行工作目录 '${fact.cwd}' 与声明目录 '${declared.cwd}' 不一致`,
        };
      }
    }

    // 3. 核对退出码（必须确定且为 0）
    if (fact.exit_code === undefined) {
      return {
        valid: false,
        reason: `宿主原始执行 '${declared.command}' 尚未完成或未取得明确退出码 (状态: ${fact.status ?? "unknown"})`,
      };
    }

    if (fact.exit_code !== 0) {
      return {
        valid: false,
        actualExitCode: fact.exit_code,
        reason: `宿主原始执行 '${declared.command}' 退出码为 ${fact.exit_code}，执行未成功`,
      };
    }

    // 4. 核对完成状态
    if (
      fact.status &&
      fact.status !== "DONE" &&
      fact.status !== "passed" &&
      fact.status !== "SUCCESS"
    ) {
      return {
        valid: false,
        reason: `宿主原始执行状态为 '${fact.status}'，非正常完成状态`,
      };
    }

    return { valid: true, actualExitCode: 0 };
  }
}
