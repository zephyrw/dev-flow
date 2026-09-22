import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { ReadonlyStore } from "../packages/store/src/store.js";
import { SessionBindingRepairService } from "../packages/core/src/session-binding-repair.js";
import type { SessionBinding } from "../packages/contracts/src/session-binding.js";

/**
 * 依据 CW2-F16 / §9.4 规范：
 * 废弃直接改库的旧算法，强制通过 API 客户端提交受管 mutation
 */
export function applyCliSessionBindingMigration(_store: any): never {
  throw new Error("applyCliSessionBindingMigration 已废弃：禁止直接改库，必须通过服务端 mutation API 提交修复");
}

export function previewCliSessionBindingMigration(_store: any) {
  return {
    scannedAt: new Date().toISOString(),
    totalWorkflows: 0,
    candidates: [],
    readyCount: 0,
    migratedCount: 0,
  };
}

/**
 * CLI 命令行入口解析 (CW2-D06 / §9.4: preview / apply / rollback)
 */
export async function runCli(args: string[] = process.argv.slice(2)): Promise<number> {
  const command = args[0];
  if (!command || !["preview", "apply", "rollback"].includes(command)) {
    console.error("用法: migrate-cli-session-bindings <preview|apply|rollback> [选项]");
    console.error("  preview:  --db <path> --workflow <id> --expected-workflow-version <num>");
    console.error("  apply:    --workflow <id> --api-base <url> --request-file <path>");
    console.error("  rollback: --workflow <id> --api-base <url> --request-file <path>");
    return 1;
  }

  function getArg(flag: string): string | undefined {
    const idx = args.indexOf(flag);
    if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
    return undefined;
  }

  const workflowId = getArg("--workflow");
  if (!workflowId) {
    console.error("错误: 缺少必填参数 --workflow <id>");
    return 1;
  }

  if (command === "preview") {
    const dbPath = getArg("--db");
    const expectedVerStr = getArg("--expected-workflow-version");

    if (!dbPath || !expectedVerStr) {
      console.error("错误: preview 必须提供必填参数 --db, --workflow 与 --expected-workflow-version");
      return 1;
    }

    if (!existsSync(dbPath)) {
      console.error(`错误: 数据库文件不存在: ${dbPath}`);
      return 1;
    }

    const expectedVersion = parseInt(expectedVerStr, 10);
    if (isNaN(expectedVersion)) {
      console.error("错误: --expected-workflow-version 必须为有效数字");
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
      const service = new SessionBindingRepairService(store as any);
      const result = service.previewRepair(workflowId, expectedVersion);
      console.log(JSON.stringify(result, null, 2));
      return 0;
    } catch (err: any) {
      console.error("预览失败:", err.message);
      return 1;
    } finally {
      store.close();
    }
  }

  const apiBase = getArg("--api-base");
  const requestFile = getArg("--request-file");
  if (!apiBase || !requestFile) {
    console.error(`错误: ${command} 命令必须提供 --api-base 与 --request-file`);
    return 1;
  }

  if (!existsSync(requestFile)) {
    console.error(`错误: 请求文件不存在: ${requestFile}`);
    return 1;
  }

  let payload: any;
  try {
    payload = JSON.parse(readFileSync(requestFile, "utf-8"));
  } catch (err: any) {
    console.error("解析请求文件失败:", err.message);
    return 1;
  }

  const endpoint = command === "apply" ? "repair" : "repair-rollback";
  const url = `${apiBase.replace(/\/+$/, "")}/api/workflows/${workflowId}/session-bindings/${endpoint}`;

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
    let json: any;
    try {
      json = JSON.parse(bodyText);
    } catch {
      json = bodyText;
    }

    if (!res.ok) {
      console.error(`请求失败 [${res.status}]:`, typeof json === "object" ? JSON.stringify(json) : json);
      return 1;
    }

    console.log(JSON.stringify(json, null, 2));
    return 0;
  } catch (err: any) {
    console.error("网络请求失败:", err.message);
    return 1;
  }
}

if (process.argv[1] && basename(process.argv[1]).includes("migrate-cli-session-bindings")) {
  runCli().then((code) => {
    if (code !== 0) process.exit(code);
  });
}
