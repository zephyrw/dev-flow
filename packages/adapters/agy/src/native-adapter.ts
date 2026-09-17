import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../../../core/src/util.js";
import { agyArguments, observeAgy } from "./session.js";
import type {
  ProcessManager,
  ManagedProcess,
} from "../../../process/src/manager.js";
import type { Config } from "../../../contracts/src/config.js";
import type { Store } from "../../../store/src/store.js";
import type { Workflow, Run } from "../../../contracts/src/index.js";
import { FlowError } from "../../../contracts/src/index.js";
import { batchExecutionInstructions } from "../../../core/src/execution-guidance.js";
import { executablePath } from "../../../process/src/executable.js";

export function writeAgyNativeConfiguration(
  directory: string,
  node: string,
  bridge?: string,
) {
  mkdirSync(join(directory, ".agents"), { recursive: true });
  // 配置原生可用的 MCP 工具 (例如供最终交接交付清单的工具)
  if (bridge) {
    atomicWrite(
      join(directory, ".agents", "mcp_config.json"),
      JSON.stringify(
        { mcpServers: { devflow_worker: { command: node, args: [bridge] } } },
        null,
        2,
      ),
    );
  }
  // 原生执行模式：取消拦截客户端原生工具的 PreToolUse 链，开放原生终端与文件编辑
  atomicWrite(
    join(directory, ".agents", "hooks.json"),
    JSON.stringify({ enabled: false }, null, 2),
  );
}

export class AgyNativeAdapter {
  constructor(
    private processes: ProcessManager,
    private config: Config,
    private store: Store,
  ) {}

  writeConfig(directory: string, node: string, bridge?: string) {
    writeAgyNativeConfiguration(directory, node, bridge);
  }

  buildNativePrompt(options: {
    workflowId: string;
    runId: string;
    mode: "full" | "resume";
    planRevision: number;
    packageHash: string;
    conversationId?: string;
  }): string {
    const isResume = options.mode === "resume";
    return JSON.stringify({
      workflow_id: options.workflowId,
      run_id: options.runId,
      mode: options.mode,
      plan_revision: options.planRevision,
      package_hash: options.packageHash,
      instruction: isResume
        ? "会话恢复：请完整查看 handoff.json 中的全部反馈与 delivery_issues，核清全部已知问题根因，完成整批修复与测试代码后统一测试，再提交交付清单。"
        : "原生执行模式：请先阅读工作包 HANDOFF.md 与 handoff.json。使用原生工具完成批准范围内全部实现和测试代码，再统一运行测试。所有必需验收场景通过后，通过 devflow_deliver 或交付清单文件完成交接。",
      execution_order: batchExecutionInstructions,
    });
  }

  startSession(options: {
    workflow: Workflow;
    run: Run;
    directory: string;
    token: string;
    conversationId?: string;
    projectBindingId: string;
    prompt: string;
    remainingMs: number;
  }): ManagedProcess {
    const {
      workflow,
      run,
      directory,
      token,
      conversationId,
      projectBindingId,
      prompt,
      remainingMs,
    } = options;

    return this.processes.start({
      id: run.id,
      workflow_id: workflow.id,
      executable: executablePath(this.config.models.agy_executable),
      args: [
        ...agyArguments(
          this.config.models.executor,
          prompt,
          this.config.timeouts.agent_minutes,
          conversationId,
          projectBindingId,
          "accept-edits",
        ),
        "--add-dir",
        directory,
      ],
      cwd: directory,
      env: {
        DEVFLOW_RUN_TOKEN: token,
        DEVFLOW_WORKFLOW_ID: workflow.id,
        DEVFLOW_RUN_ID: run.id,
        DEVFLOW_BASE_URL: "http://127.0.0.1:" + this.config.server.port,
      },
      timeout_ms: remainingMs,
      deadline_at: run.deadline_at,
    });
  }

  async observeSession(
    proc: ManagedProcess,
    options: {
      workflow: Workflow;
      run: Run;
      directory: string;
      conversationId?: string;
      isWaiting?: () => boolean;
      onEvent?: (event: Record<string, unknown>) => void;
      onDiagnostic?: (text: string) => void;
    },
  ) {
    const { workflow, run, directory, conversationId } = options;
    return observeAgy(proc, {
      model: this.config.models.executor,
      conversation: conversationId,
      cwd: directory,
      log: join(directory, run.id + ".jsonl"),
      idle_ms: this.config.timeouts.idle_minutes * 60000,
      isWaiting: options.isWaiting,
      onEvent: (event) => {
        if (event.event === "init") {
          this.store.put("conversation", workflow.id, workflow.id, {
            id: event.conversation_id,
          });
        }
        if (options.onEvent) options.onEvent(event);
      },
      onDiagnostic: options.onDiagnostic ?? (() => {}),
    });
  }
}
