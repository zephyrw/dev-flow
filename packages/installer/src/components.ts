import { InstallationStateManager } from "./state.js";
import { SupportedAdapters } from "../../contracts/src/execution-spec.js";
export interface ComponentResolution {
  name: string;
  required: boolean;
  alreadyInstalled: boolean;
  version: string;
}
export class ComponentManager {
  constructor(private stateManager: InstallationStateManager) {}
  resolveRequiredComponents(selectedTools: string[]): ComponentResolution[] {
    if (
      !selectedTools.length ||
      selectedTools.some((x) => !SupportedAdapters.includes(x as any))
    )
      throw new Error("必须选择已支持的工具");
    const state = this.stateManager.load();
    return [
      "node",
      "host",
      "service",
      ...selectedTools.flatMap((t) => ["tool:" + t, "skills:" + t]),
    ].map((name) => ({
      name,
      required: true,
      alreadyInstalled: state.installed_components[name]?.state === "VERIFIED",
      version: name === "node" ? process.version : "0.2.0",
    }));
  }
}
