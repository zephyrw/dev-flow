import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import Database from "better-sqlite3";
import { atomicWrite } from "../../core/src/util.js";
export interface UpgradeOptions {
  installDir: string;
  targetVersion: string;
  backupDir?: string;
}
export class UpgradeManager {
  constructor(private options: UpgradeOptions) {}
  async backupData(sqlitePath: string): Promise<string | undefined> {
    if (!existsSync(sqlitePath)) return undefined;
    const target = join(
      this.options.backupDir ?? join(this.options.installDir, "backup"),
      "devflow-" + Date.now() + ".db",
    );
    mkdirSync(dirname(target), { recursive: true });
    const db = new Database(sqlitePath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      await db.backup(target);
      return target;
    } finally {
      db.close();
    }
  }
  atomicSwitchCurrent(meta: Record<string, unknown>) {
    try {
      atomicWrite(
        join(this.options.installDir, "current.json"),
        JSON.stringify(meta, null, 2),
      );
      return true;
    } catch {
      return false;
    }
  }
}
