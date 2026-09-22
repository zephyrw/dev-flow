export * from "./interface.js";
export * from "./registry.js";
export * from "./base-adapter.js";
export * from "./model-selection.js";
export {
  capabilityFromAdapter,
  clientInvocation,
  readOnlyPurpose,
} from "./invocation.js";
export {
  applyFrozenSelection,
  buildFrozenInvocation,
  capabilityForSelection,
  resolveRunSelection,
  selectionCapabilityFromCatalog,
} from "./frozen-invocation.js";
export {
  parseProbeTerminal,
  parseStructuredProbeTerminal,
} from "./probe-terminal.js";
export {
  identityInputFromProfile,
  readNativeIdentity,
  readNativeIdentitySync,
} from "./native-identity.js";
export * from "./conversation-source.js";
export * from "./resume-instructions.js";
export * from "./identity.js";

import { AdapterRegistry } from "./registry.js";
import { CodexNativeAdapter } from "../../codex/src/adapter.js";
import { AgyNativeCliAdapter } from "../../agy/src/adapter.js";
import { GrokBuildNativeAdapter } from "../../grok/src/adapter.js";
import { ClaudeCodeNativeAdapter } from "../../claude/src/adapter.js";
import { KimiCodeNativeAdapter } from "../../kimi/src/adapter.js";
import { QoderNativeAdapter } from "../../qoder/src/adapter.js";
import { OpenCodeNativeAdapter } from "../../opencode/src/adapter.js";
import { CursorAgentNativeAdapter } from "../../cursor/src/adapter.js";
import { parseStructuredProbeTerminal } from "./probe-terminal.js";
import type { ProbeTerminalInput } from "./interface.js";

export function parseAdapterProbeTerminal(
  adapterId: string,
  input: ProbeTerminalInput,
) {
  return parseStructuredProbeTerminal({ ...input, adapterId });
}

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
