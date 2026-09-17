import { BaseClientRenderer } from "./types.js";
import type { SupportedAdapterId } from "../../../contracts/src/execution-spec.js";
import { join } from "node:path";

export class GrokRenderer extends BaseClientRenderer {
  clientId: SupportedAdapterId = "grok-build";
  configRelativePath = join(".grok", "config.json");
}

export const grokRenderer = new GrokRenderer();
