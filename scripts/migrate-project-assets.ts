import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { ReadonlyStore } from "../packages/store/src/store.js";
import type { Workspace } from "../packages/contracts/src/index.js";
import {
  ProjectAssetMigrationService,
  type ProjectAssetMigrationPreview,
} from "../packages/core/src/project-asset-migration.js";

/**
 * 依据 CW2-F03 / §5.1 / CW2-D02 规范：
 * 彻底删除旧 applyProjectAssetMigration 的离线写库算法；
 * 兼容保留导出名，但调用时抛出明确错误，禁止离线旁路改库。
 */
export function applyProjectAssetMigration(
  _store: any,
  _storageRoot: string = ".devflow",
): never {
  throw new Error("applyProjectAssetMigration 已废弃：禁止直接改库，必须通过服务端 mutation API 提交迁移");
}

export function previewProjectAssetMigration(
  store: ReadonlyStore,
  storageRoot: string = ".devflow",
) {
  const workspaces = store.list<Workspace>("workspace");
  return {
    scannedAt: new Date().toISOString(),
    totalWorkspaces: workspaces.length,
    workspaces,
  };
}

/**
 * 命令行执行入口：支持 preview / apply / resume / rollback (CW2-D02)
 */
export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    console.log("用法:");
    console.log("  preview:  migrate-project-assets preview --db <path> --workflow <id> --workspace <id> [--mode <materials_only|move_worktree>]");
    console.log("  mutation: migrate-project-assets <apply|resume|rollback> --api-base <url> --workflow <id> --request-file <path>");
    return 0;
  }

  const getArg = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  };

  if (command === "preview") {
    const dbPath = getArg("--db");
    const workflowId = getArg("--workflow");
    const workspaceId = getArg("--workspace");
    const mode = (getArg("--mode") as any) ?? "move_worktree";
    const storageRoot = getArg("--storage-root");

    if (!dbPath || !workflowId || !workspaceId) {
      console.error("缺少必填参数: preview 需要 --db, --workflow, --workspace");
      return 1;
    }

    if (!existsSync(dbPath)) {
      console.error(`数据库文件不存在: ${dbPath}`);
      return 1;
    }

    let store: ReadonlyStore;
    try {
      store = new ReadonlyStore(dbPath);
    } catch (err: any) {
      console.error("打开只读数据库失败:", err.message);
      return 1;
    }

    try {
      const service = new ProjectAssetMigrationService(store as any, storageRoot);
      const preview = service.preview({
        workflowId,
        workspaceId,
        mode,
      });
      console.log(JSON.stringify(preview, null, 2));
      return 0;
    } catch (err: any) {
      console.error("预览失败:", err.message);
      return 1;
    } finally {
      store.close();
    }
  } else if (["apply", "resume", "rollback"].includes(command)) {
    const apiBase = getArg("--api-base");
    const workflowId = getArg("--workflow");
    const requestFile = getArg("--request-file");

    if (!apiBase || !workflowId || !requestFile) {
      console.error(`缺少必填参数: ${command} 需要 --api-base, --workflow, --request-file`);
      return 1;
    }

    if (!existsSync(requestFile)) {
      console.error(`请求文件不存在: ${requestFile}`);
      return 1;
    }

    let payload: any;
    try {
      payload = JSON.parse(readFileSync(requestFile, "utf8"));
    } catch (err: any) {
      console.error("解析请求文件失败:", err.message);
      return 1;
    }

    const url = `${apiBase.replace(/\/+$/, "")}/api/workflows/${workflowId}/assets/${command}`;

    let normalizedOrigin: string;
    try {
      const rawOrigin = getArg("--human-origin") || process.env.DEVFLOW_HUMAN_ORIGIN || apiBase;
      normalizedOrigin = new URL(rawOrigin).origin;
    } catch {
      normalizedOrigin = apiBase.replace(/\/+$/, "");
    }

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: normalizedOrigin,
        },
        body: JSON.stringify(payload),
      });

      const bodyText = await res.text();
      let resultData: any;
      try {
        resultData = JSON.parse(bodyText);
      } catch {
        resultData = bodyText;
      }

      if (!res.ok) {
        console.error(`HTTP ${res.status}:`, typeof resultData === "object" ? JSON.stringify(resultData) : resultData);
        return 1;
      }

      console.log(JSON.stringify(resultData, null, 2));
      return 0;
    } catch (err: any) {
      console.error("请求失败:", err.message);
      return 1;
    }
  } else {
    console.error(`未知子命令: ${command}`);
    return 1;
  }
}

if (process.argv[1] && basename(process.argv[1]).includes("migrate-project-assets")) {
  runCli().then((code) => {
    if (code !== 0) process.exit(code);
  });
}
