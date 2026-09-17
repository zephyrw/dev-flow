import { BaseClientRenderer } from "./types.js";
import type { SupportedAdapterId } from "../../../contracts/src/execution-spec.js";
import { join } from "node:path";

export class ClaudeRenderer extends BaseClientRenderer {
  clientId: SupportedAdapterId = "claude-code";
  configRelativePath = join(".claude", "config.json");
}

export const claudeRenderer = new ClaudeRenderer();
