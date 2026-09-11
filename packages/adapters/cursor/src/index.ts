import { FlowError } from "../../../contracts/src/index.js";
/** Reserved provider boundary. No implicit model or subscription fallback. */
export class CursorAdapter {
  readonly enabled = false;
  readonly model = "grok-4.6";
  start(): never {
    throw new FlowError(
      "ADAPTER_DISABLED",
      "Cursor Grok 4.6 适配器未启用；不能代替已指定的执行模型",
      503,
    );
  }
}
