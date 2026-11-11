import Database from "better-sqlite3";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ConversationStatus } from "../../../contracts/src/conversation.js";
import { toolSummary } from "../../../presentation/src/tool-summary.js";
import { parseJsonLine } from "../../sdk/src/conversation-source.js";
import { isAgyConversationId, isAgyDelegationTool } from "./native-record-source.js";

const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;

interface TranscriptStep {
  step_index: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  content?: string;
  tool_calls?: unknown[];
}

interface AgySummary {
  conversation_id: string;
  parent_conversation_id: string;
  agent_name: string;
  status: string;
  not_fully_idle: number;
  killed: number;
}

export class AgySubagentRecords {
  private readonly base: string;

  constructor(home: string) {
    this.base = join(home, ".gemini", "antigravity-cli");
  }

  async readDelegation(parent: string, step: number) {
    if (!isAgyConversationId(parent) || !Number.isSafeInteger(step) || step < 0) return;
    const path = join(this.generated(parent), "steps", String(step), "output.txt");
    const output = await readBounded(path, 64 * 1024);
    return readAgyDelegationReceipt(output);
  }

  async readDelegationNames(parent: string) {
    const names = new Map<number, string>();
    for (const step of await this.readTranscript(parent)) {
      for (const call of toolCalls(step)) {
        if (!isAgyDelegationTool(call.name)) continue;
        const role = argumentValue(call.args?.Role);
        if (typeof role === "string" && role.trim()) names.set(step.step_index + 1, role.trim());
      }
    }
    return names;
  }

  readSummaries(sessions: string[]): Map<string, AgySummary> {
    const result = new Map<string, AgySummary>();
    if (sessions.length === 0) return result;
    let db: Database.Database | undefined;
    try {
      db = new Database(join(this.base, "conversation_summaries.db"), {
        readonly: true, fileMustExist: true, timeout: 100,
      });
      const get = db.prepare(
        "SELECT conversation_id, parent_conversation_id, agent_name, status, not_fully_idle, killed " +
        "FROM conversation_summaries WHERE conversation_id = ?",
      );
      for (const session of sessions) {
        const row = get.get(session) as AgySummary | undefined;
        if (row) result.set(session, row);
      }
    } catch {
      // Native summaries can be absent, locked or use a different schema.
    } finally {
      db?.close();
    }
    return result;
  }

  async readActivities(session: string) {
    const rows = [];
    for (const step of await this.readTranscript(session)) {
      if (step.source !== "MODEL" || step.type !== "PLANNER_RESPONSE" || !step.created_at) continue;
      const sequence = step.step_index * 256 + 1;
      const status = activityStatus(step.status);
      if (typeof step.content === "string" && step.content.trim()) {
        rows.push({ sequence, created_at: step.created_at, title: "模型回复",
          public_text: step.content.slice(0, 16000), status, kind: "message" as const });
      }
      for (const [index, call] of toolCalls(step).slice(0, 254).entries()) {
        const args = Object.fromEntries(Object.entries(call.args ?? {}).map(([name, value]) => [name, argumentValue(value)]));
        const summary = toolSummary(call.name, args);
        if (summary.hidden) continue;
        rows.push({ sequence: sequence + index + 1, created_at: step.created_at,
          title: summary.title ?? call.name.slice(0, 200), public_text: summary.text.slice(0, 16000),
          command: summary.command?.slice(0, 32000), cwd: summary.cwd?.slice(0, 4000),
          kind: "tool" as const });
      }
    }
    return rows.sort((a, b) => a.sequence - b.sequence);
  }

  private generated(session: string): string {
    return join(this.base, "brain", session, ".system_generated");
  }

  private async readTranscript(session: string): Promise<TranscriptStep[]> {
    if (!isAgyConversationId(session)) return [];
    const path = join(this.generated(session), "logs", "transcript.jsonl");
    const content = await readBounded(path, MAX_TRANSCRIPT_BYTES);
    if (!content) return [];
    const steps = new Map<number, TranscriptStep>();
    for (const line of content.split("\n")) {
      const step = parseJsonLine(line) as TranscriptStep | undefined;
      if (!Number.isSafeInteger(step?.step_index) || step!.step_index < 0 || step!.step_index >= Number.MAX_SAFE_INTEGER / 256)
        continue;
      steps.set(step!.step_index, step!);
    }
    return [...steps.values()];
  }
}

export function readAgyDelegationReceipt(output?: string): string | undefined {
  const match = /^Created the following subagent:\r?\n(\{[\s\S]*?\r?\n\})(?:\r?\n|$)/.exec(output ?? "");
  if (!match) return;
  const receipt = parseJsonLine(match[1]!) as { conversationId?: unknown } | undefined;
  return isAgyConversationId(receipt?.conversationId) ? receipt.conversationId : undefined;
}

export function agySubagentStatus(summary?: AgySummary): ConversationStatus | undefined {
  if (!summary) return;
  if (summary.killed) return "cancelled";
  switch (summary.status) {
    case "CASCADE_RUN_STATUS_RUNNING": return "running";
    case "CASCADE_RUN_STATUS_IDLE": return summary.not_fully_idle ? "running" : "waiting";
    case "CASCADE_RUN_STATUS_COMPLETED": return "completed";
    case "CASCADE_RUN_STATUS_ERROR": return "failed";
  }
}

function toolCalls(step: TranscriptStep) {
  if (!Array.isArray(step.tool_calls)) return [];
  return step.tool_calls.filter((call): call is { name: string; args?: Record<string, unknown> } =>
    Boolean(call && typeof call === "object" && "name" in call && typeof call.name === "string" && call.name));
}

function argumentValue(value: unknown): unknown {
  if (typeof value !== "string" || !value.startsWith('"')) return value;
  return parseJsonLine(value) ?? value;
}

function activityStatus(status?: string): ConversationStatus | undefined {
  if (status === "DONE") return "completed";
  if (status === "ERROR") return "failed";
  if (status === "RUNNING") return "running";
}

async function readBounded(path: string, maxBytes: number): Promise<string | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > maxBytes) return;
    const data = await readFile(path);
    if (data.length <= maxBytes) return data.toString("utf8");
  } catch {
    // AGY may publish the file after the first discovery or rotate it.
  }
}
