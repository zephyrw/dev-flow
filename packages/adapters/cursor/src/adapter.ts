import { BaseNativeAgentAdapter } from "../../sdk/src/base-adapter.js";
export class CursorAgentNativeAdapter extends BaseNativeAgentAdapter {
  constructor() {
    super("cursor-agent", "agent", [
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
    return "cursor|agent";
  }
}
