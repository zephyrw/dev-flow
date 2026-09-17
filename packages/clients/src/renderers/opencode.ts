import { BaseClientRenderer } from "./types.js";
import type { SupportedAdapterId } from "../../../contracts/src/execution-spec.js";
import { join } from "node:path";

export class OpenCodeRenderer extends BaseClientRenderer {
  clientId: SupportedAdapterId = "opencode";
  configRelativePath = join(".opencode", "config.json");
}

export const opencodeRenderer = new OpenCodeRenderer();
