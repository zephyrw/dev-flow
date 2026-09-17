import { BaseClientRenderer } from "./types.js";
import type { SupportedAdapterId } from "../../../contracts/src/execution-spec.js";
import { join } from "node:path";

export class AgyRenderer extends BaseClientRenderer {
  clientId: SupportedAdapterId = "agy";
  configRelativePath = join(".gemini", "antigravity", "antigravity.json");
}

export const agyRenderer = new AgyRenderer();
