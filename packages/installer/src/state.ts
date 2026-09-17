import { atomicWrite } from "../../core/src/util.js";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type ComponentLifecycleState =
  | "DISCOVERED"
  | "PLANNED"
  | "DOWNLOADED"
  | "INSTALLED"
  | "CONFIGURED"
  | "VERIFIED";

export const INSTALL_EXIT_CODES = {
  SUCCESS: 0,
  NEEDS_USER_ACTION: 10,
  DOWNLOAD_VERIFICATION_FAILED: 20,
  CONFIGURATION_CONFLICT: 30,
  UNSUPPORTED_ENVIRONMENT: 40,
  SERVICE_UNHEALTHY: 50,
} as const;

export interface ComponentStateRecord {
  name: string;
  version: string;
  state: ComponentLifecycleState;
  updated_at: string;
  error?: string;
}

export interface InstallerStateStorage {
  installed_components: Record<string, ComponentStateRecord>;
  current_version: string;
  last_exit_code?: number;
}

export class InstallationStateManager {
  constructor(private stateFilePath: string) {}

  load(): InstallerStateStorage {
    if (!existsSync(this.stateFilePath)) {
      return {
        installed_components: {},
        current_version: "0.2.0",
      };
    }
    try {
      return JSON.parse(readFileSync(this.stateFilePath, "utf8"));
    } catch {
      return {
        installed_components: {},
        current_version: "0.2.0",
      };
    }
  }

  save(state: InstallerStateStorage): void {
    mkdirSync(dirname(this.stateFilePath), { recursive: true });
    atomicWrite(this.stateFilePath, JSON.stringify(state, null, 2));
  }

  updateComponent(
    name: string,
    version: string,
    state: ComponentLifecycleState,
    error?: string,
  ): void {
    const current = this.load();
    current.installed_components[name] = {
      name,
      version,
      state,
      updated_at: new Date().toISOString(),
      error,
    };
    this.save(current);
  }
}
