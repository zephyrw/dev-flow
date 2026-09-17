import { BaseClientRenderer } from "./types.js";
import type { SupportedAdapterId } from "../../../contracts/src/execution-spec.js";
import { join } from "node:path";

export class CursorRenderer extends BaseClientRenderer {
  clientId: SupportedAdapterId = "cursor-agent";
  configRelativePath = join(".cursor", "config.json");
}

export const cursorRenderer = new CursorRenderer();
