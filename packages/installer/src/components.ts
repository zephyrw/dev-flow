import { InstallationStateManager } from "./state.js";
import { SupportedAdapters } from "../../contracts/src/execution-spec.js";
export interface ComponentResolution {
  name: string;
  required: boolean;
  alreadyInstalled: boolean;
  version: string;
}
export class ComponentManager {
  constructor(
    private stateManager: InstallationStateManager,
    private applicationVersion = "0.0.0",
  ) {}
  resolveRequiredComponents(selectedTools: string[]): ComponentResolution[] {
    // tools 空数组合法：默认不选客户端，稍后在界面中设置。
    if (selectedTools.some((x) => !SupportedAdapters.includes(x as any)))
      throw new Error("必须选择已支持的工具");
    const state = this.stateManager.load();
    return [
      "node",
      "service",
      "bootstrap",
      ...selectedTools.flatMap((t) => ["tool:" + t, "skills:" + t]),
    ].map((name) => ({
      name,
      required: true,
      alreadyInstalled: state.installed_components[name]?.state === "VERIFIED",
      version: name === "node" ? process.version : this.applicationVersion,
    }));
  }
}
