import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../../../core/src/util.js";
import { nativeLaunchInstruction } from "./handoff.js";
import { agyArguments, agyRunLogFile, observeAgy } from "./session.js";
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
import { runLauncherSelection } from "../../../core/src/run-profile.js";
import { beginRunConversation, retainRunConversation } from "../../../core/src/conversation-lineage.js";

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
  private readonly resumedSessions = new Map<string, string | undefined>();
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
    directory: string;
    conversationId?: string;
  }): string {
    return JSON.stringify({
      workflow_id: options.workflowId,
      run_id: options.runId,
      mode: options.mode,
      plan_revision: options.planRevision,
      package_hash: options.packageHash,
      instruction: nativeLaunchInstruction(
        options.directory,
        options.mode === "resume" ? "resume" : "full",
      ),
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
      projectBindingId,
      prompt,
      remainingMs,
    } = options;

    const launcher = runLauncherSelection(run);
    const conversationId = beginRunConversation(this.store, run)?.id;
    this.resumedSessions.set(run.id, conversationId);
    return this.processes.start({
      id: run.id,
      workflow_id: workflow.id,
      executable: executablePath(launcher.executable),
      args: [
        ...agyArguments(
          launcher.modelToken ?? "",
          prompt,
          this.config.timeouts.agent_minutes,
          conversationId,
          projectBindingId,
          "accept-edits",
          launcher.effortArgs,
          agyRunLogFile(directory, run.id),
        ),
        "--add-dir",
        directory,
      ],
      cwd: directory,
      env: {
        ...launcher.effortEnv,
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
    const { run, directory } = options;
    const conversationId = this.resumedSessions.get(run.id);
    const launcher = runLauncherSelection(run);
    return observeAgy(proc, {
      model: launcher.modelToken ?? "",
      conversation: conversationId,
      cwd: directory,
      log: join(directory, run.id + ".jsonl"),
      idle_ms: this.config.timeouts.idle_minutes * 60000,
      isWaiting: options.isWaiting,
      onEvent: (event) => {
        if (event.event === "init" && typeof event.conversation_id === "string") {
          retainRunConversation(this.store, run, event.conversation_id);
        }
        if (options.onEvent) options.onEvent(event);
      },
      onDiagnostic: options.onDiagnostic ?? (() => {}),
    }).finally(() => this.resumedSessions.delete(run.id));
  }
}
