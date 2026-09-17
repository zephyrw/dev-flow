export * from "./interface.js";
export * from "./registry.js";
export * from "./base-adapter.js";

import { AdapterRegistry } from "./registry.js";
import { CodexNativeAdapter } from "../../codex/src/adapter.js";
import { AgyNativeCliAdapter } from "../../agy/src/adapter.js";
import { GrokBuildNativeAdapter } from "../../grok/src/adapter.js";
import { ClaudeCodeNativeAdapter } from "../../claude/src/adapter.js";
import { KimiCodeNativeAdapter } from "../../kimi/src/adapter.js";
import { QoderNativeAdapter } from "../../qoder/src/adapter.js";
import { OpenCodeNativeAdapter } from "../../opencode/src/adapter.js";
import { CursorAgentNativeAdapter } from "../../cursor/src/adapter.js";

export function createDefaultAdapterRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register("codex", new CodexNativeAdapter());
  registry.register("agy", new AgyNativeCliAdapter());
  registry.register("grok-build", new GrokBuildNativeAdapter());
  registry.register("claude-code", new ClaudeCodeNativeAdapter());
  registry.register("kimi-code", new KimiCodeNativeAdapter());
  registry.register("qoder", new QoderNativeAdapter());
  registry.register("opencode", new OpenCodeNativeAdapter());
  registry.register("cursor-agent", new CursorAgentNativeAdapter());
  return registry;
}
