import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SupportedAdapterId } from "../../../contracts/src/execution-spec.js";

export interface ClientRenderer {
  clientId: SupportedAdapterId;
  detect(): boolean;
  locateConfig(): string | undefined;
  render(skills: string[]): Record<string, unknown>;
  diff(skills: string[]): { changed: boolean; details: string[] };
  apply(skills: string[]): boolean;
  verify(): boolean;
  uninstall(): boolean;
}

export abstract class BaseClientRenderer implements ClientRenderer {
  abstract clientId: SupportedAdapterId;
  abstract configRelativePath: string;

  protected getHomeDir(): string {
    return process.env.USERPROFILE || process.env.HOME || "";
  }

  locateConfig(): string | undefined {
    const home = this.getHomeDir();
    if (!home) return undefined;
    return join(home, this.configRelativePath);
  }

  detect(): boolean {
    const p = this.locateConfig();
    return p ? existsSync(p) : false;
  }

  render(skills: string[]): Record<string, unknown> {
    return {
      client: this.clientId,
      skills,
      mcpServers: {
        devflow: {
          command: "node",
          args: ["dist/apps/api/src/main.js"],
        },
      },
    };
  }

  diff(skills: string[]): { changed: boolean; details: string[] } {
    const cfgPath = this.locateConfig();
    if (!cfgPath || !existsSync(cfgPath)) {
      return { changed: true, details: ["配置文件不存在，将新建配置"] };
    }
    return { changed: false, details: [] };
  }

  apply(skills: string[]): boolean {
    const cfgPath = this.locateConfig();
    if (!cfgPath) return false;
    const rendered = this.render(skills);
    try {
      writeFileSync(cfgPath, JSON.stringify(rendered, null, 2), "utf8");
      return true;
    } catch {
      return false;
    }
  }

  verify(): boolean {
    const cfgPath = this.locateConfig();
    return !!cfgPath && existsSync(cfgPath);
  }

  uninstall(): boolean {
    return true;
  }
}
