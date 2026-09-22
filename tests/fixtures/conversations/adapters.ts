export const CONVERSATION_FIXTURE_ADAPTERS = [
  "codex",
  "agy",
  "claude-code",
  "cursor-agent",
  "grok-build",
  "kimi-code",
  "qoder",
  "opencode",
] as const;

export type ConversationFixtureAdapter =
  (typeof CONVERSATION_FIXTURE_ADAPTERS)[number];

