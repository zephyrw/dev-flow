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

export type SoftwareStatus =
  | "downloading"
  | "verifying"
  | "installed"
  | "failed";
export type SetupStatus =
  | "not_started"
  | "pending_login"
  | "pending_verification"
  | "done";
export type CapabilityStatus =
  | "discovered"
  | "verified"
  | "workflow_verified"
  | "unknown";

export interface InstallResultView {
  software: { status: SoftwareStatus; detail?: string };
  setup: { status: SetupStatus; detail?: string };
  capability: {
    status: CapabilityStatus;
    scope: string;
    detail?: string;
  };
}

export interface InstallerStateStorage {
  installed_components: Record<string, ComponentStateRecord>;
  current_version: string;
  last_exit_code?: number;
  /** Three-dimension result view (software / setup / capability). */
  result?: InstallResultView;
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

  updateResult(patch: Partial<InstallResultView>): InstallResultView {
    const current = this.load();
    const previous = current.result ?? {
      software: { status: "downloading" as const },
      setup: { status: "not_started" as const },
      capability: { status: "unknown" as const, scope: "none" },
    };
    const next: InstallResultView = {
      software: patch.software ?? previous.software,
      setup: patch.setup ?? previous.setup,
      capability: patch.capability ?? previous.capability,
    };
    current.result = next;
    this.save(current);
    return next;
  }
}
