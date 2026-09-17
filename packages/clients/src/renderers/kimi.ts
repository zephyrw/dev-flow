import { BaseClientRenderer } from "./types.js";
import type { SupportedAdapterId } from "../../../contracts/src/execution-spec.js";
import { join } from "node:path";

export class KimiRenderer extends BaseClientRenderer {
  clientId: SupportedAdapterId = "kimi-code";
  configRelativePath = join(".kimi", "config.json");
}

export const kimiRenderer = new KimiRenderer();
