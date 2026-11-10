import { BaseNativeAgentAdapter } from "../../sdk/src/base-adapter.js";
import { resolveAdapterExecutable } from "../../sdk/src/registry.js";

export class CodeBuddyNativeAdapter extends BaseNativeAgentAdapter {
  constructor() {
    super("codebuddy-code", "codebuddy");
  }

  protected resolveExecutable(customPath?: string) {
    return resolveAdapterExecutable("codebuddy-code", customPath);
  }

  getVersionArgs() {
    return ["--version"];
  }

  getProductFingerprint() {
    return "CodeBuddy Code";
  }
}
