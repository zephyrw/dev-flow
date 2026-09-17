import { BaseClientRenderer } from "./types.js";
import type { SupportedAdapterId } from "../../../contracts/src/execution-spec.js";
import { join } from "node:path";

export class QoderRenderer extends BaseClientRenderer {
  clientId: SupportedAdapterId = "qoder";
  configRelativePath = join(".qoder", "config.json");
}

export const qoderRenderer = new QoderRenderer();
