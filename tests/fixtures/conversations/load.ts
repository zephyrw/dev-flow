import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONVERSATION_FIXTURE_ADAPTERS,
  type ConversationFixtureAdapter,
} from "./adapters.js";

export {
  CONVERSATION_FIXTURE_ADAPTERS,
  type ConversationFixtureAdapter,
} from "./adapters.js";

export const CONVERSATION_FIXTURE_ROOT = dirname(
  fileURLToPath(import.meta.url),
);

export const CONVERSATION_FIXTURE_SCENARIOS = [
  "create",
  "nested",
  "activity",
  "pause",
  "resume",
  "quota",
  "attachment",
  "unknown-version",
] as const;

export type ConversationFixtureScenario =
  (typeof CONVERSATION_FIXTURE_SCENARIOS)[number];

export interface ConversationFixtureFile {
  adapter: ConversationFixtureAdapter;
  fileName: string;
  filePath: string;
  records: unknown[];
}

export function conversationFixtureDir(
  adapter: ConversationFixtureAdapter | string,
): string {
  return join(CONVERSATION_FIXTURE_ROOT, adapter);
}

export function conversationFixturePath(
  adapter: ConversationFixtureAdapter | string,
  fileName: string,
): string {
  return join(conversationFixtureDir(adapter), fileName);
}

export function listConversationJsonl(
  adapter: ConversationFixtureAdapter | string,
): string[] {
  const dir = conversationFixtureDir(adapter);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
}

export function loadConversationJsonl(
  adapter: ConversationFixtureAdapter | string,
  fileName: string,
): unknown[] {
  return parseJsonlFile(conversationFixturePath(adapter, fileName));
}

export function loadConversationFixtures(
  adapter: ConversationFixtureAdapter | string,
): ConversationFixtureFile[] {
  assertKnownAdapter(adapter);
  return listConversationJsonl(adapter).map((fileName) => ({
    adapter,
    fileName,
    filePath: conversationFixturePath(adapter, fileName),
    records: loadConversationJsonl(adapter, fileName),
  }));
}

export function loadConversationScenario(
  adapter: ConversationFixtureAdapter | string,
  scenario: ConversationFixtureScenario | string,
): unknown[] {
  const named = conversationFixturePath(adapter, `${scenario}.jsonl`);
  if (existsSync(named)) return parseJsonlFile(named);
  return loadConversationJsonl(adapter, "placeholder.jsonl").filter((record) =>
    recordHasScenario(record, scenario),
  );
}

export function parseJsonlFile(filePath: string): unknown[] {
  const text = readFileSync(filePath, "utf8");
  const records: unknown[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch (error) {
      throw new Error(
        `${filePath}:${index + 1} 不是合法 JSONL：${String(error)}`,
      );
    }
  }
  return records;
}

function recordHasScenario(record: unknown, scenario: string): boolean {
  return (
    !!record &&
    typeof record === "object" &&
    "scenario" in record &&
    (record as { scenario?: string }).scenario === scenario
  );
}

function assertKnownAdapter(
  adapter: string,
): asserts adapter is ConversationFixtureAdapter {
  if (
    !(CONVERSATION_FIXTURE_ADAPTERS as readonly string[]).includes(adapter)
  )
    throw new Error(`未知会话 fixture 适配器目录: ${adapter}`);
}
