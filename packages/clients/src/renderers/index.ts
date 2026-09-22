export * from "./types.js";
export * from "./agy.js";
export * from "./codex.js";
export * from "./claude.js";
export * from "./cursor.js";
export * from "./kimi.js";
export * from "./grok.js";
export * from "./qoder.js";
export * from "./opencode.js";
export * from "./mimo.js";

import { agyRenderer } from "./agy.js";
import { codexRenderer } from "./codex.js";
import { claudeRenderer } from "./claude.js";
import { cursorRenderer } from "./cursor.js";
import { kimiRenderer } from "./kimi.js";
import { grokRenderer } from "./grok.js";
import { qoderRenderer } from "./qoder.js";
import { opencodeRenderer } from "./opencode.js";
import { mimoRenderer } from "./mimo.js";
import type { SupportedAdapterId } from "../../../contracts/src/execution-spec.js";
import type { ClientRenderer } from "./types.js";

export const RENDERERS: Record<SupportedAdapterId, ClientRenderer> = {
  agy: agyRenderer,
  codex: codexRenderer,
  "claude-code": claudeRenderer,
  "cursor-agent": cursorRenderer,
  "kimi-code": kimiRenderer,
  "grok-build": grokRenderer,
  qoder: qoderRenderer,
  opencode: opencodeRenderer,
  "mimo-code": mimoRenderer,
};

export function getClientRenderer(
  id: SupportedAdapterId,
): ClientRenderer | undefined {
  return RENDERERS[id];
}
