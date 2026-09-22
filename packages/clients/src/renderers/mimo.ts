import { BaseClientRenderer } from "./types.js";
import type { SupportedAdapterId } from "../../../contracts/src/execution-spec.js";
import { join } from "node:path";

export class MimoCodeRenderer extends BaseClientRenderer {
  clientId: SupportedAdapterId = "mimo-code";
  configRelativePath = join(".mimo", "config.json");
}

export const mimoRenderer = new MimoCodeRenderer();
