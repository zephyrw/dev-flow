import { BaseClientRenderer } from "./types.js";
import type { SupportedAdapterId } from "../../../contracts/src/execution-spec.js";
import { join } from "node:path";

export class CodexRenderer extends BaseClientRenderer {
  clientId: SupportedAdapterId = "codex";
  configRelativePath = join(".codex", "config.json");

  override locateConfig(): string | undefined {
    if (process.env.CODEX_HOME) {
      return join(process.env.CODEX_HOME, "config.json");
    }
    return super.locateConfig();
  }
}

export const codexRenderer = new CodexRenderer();
