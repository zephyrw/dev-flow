import { BaseNativeAgentAdapter } from "../../sdk/src/base-adapter.js";
import { QODER_PRODUCT_IDENTITY } from "../../sdk/src/registry.js";
export class QoderNativeAdapter extends BaseNativeAgentAdapter {
  constructor() {
    super("qoder", "qodercli", [
      ...(process.env.LOCALAPPDATA
        ? [
            process.env.LOCALAPPDATA + "/agy/bin",
            process.env.LOCALAPPDATA + "/cursor-agent",
          ]
        : []),
      ...(process.env.APPDATA ? [process.env.APPDATA + "/npm"] : []),
      ...(process.env.HOME ? [process.env.HOME + "/.local/bin"] : []),
      "/usr/local/bin",
      "/opt/homebrew/bin",
    ]);
  }
  getVersionArgs() {
    return ["--version"];
  }
  getProductFingerprint() {
    return QODER_PRODUCT_IDENTITY;
  }
}
