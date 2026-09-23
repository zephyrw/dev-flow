#!/usr/bin/env node
/**
 * 合成登录 - 模拟登录行为，不执行真实登录
 *
 * 使用方法:
 *   node tests/fixtures/synthetic-login.js [选项]
 *
 * 选项:
 *   --delay <ms>      模拟登录延迟 (默认 2000)
 *   --exit <code>     退出码 (默认 0)
 *   --marker <path>   创建标记文件
 *   --verbose         输出详细信息
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    delay: { type: "string", default: "2000" },
    exit: { type: "string", default: "0" },
    marker: { type: "string" },
    verbose: { type: "boolean", default: false },
  },
  strict: false,
});

const delay = parseInt(values.delay, 10);
const exitCode = parseInt(values.exit, 10);

if (values.verbose) {
  console.error(`[synthetic-login] Starting with delay=${delay}, exit=${exitCode}`);
}

console.log("Synthetic login started");
console.log("Waiting for user input...");

// 创建标记文件 (用于测试 Job 归属前无副作用)
if (values.marker) {
  try {
    mkdirSync(dirname(values.marker), { recursive: true });
    writeFileSync(values.marker, JSON.stringify({
      pid: process.pid,
      timestamp: new Date().toISOString(),
      phase: "login_started",
    }));
    if (values.verbose) {
      console.error(`[synthetic-login] Marker created at ${values.marker}`);
    }
  } catch (err) {
    console.error(`[synthetic-login] Failed to create marker: ${err}`);
  }
}

// 模拟等待用户输入
await new Promise(resolve => setTimeout(resolve, delay));

// 更新标记文件 (如果存在)
if (values.marker) {
  try {
    writeFileSync(values.marker, JSON.stringify({
      pid: process.pid,
      timestamp: new Date().toISOString(),
      phase: "login_completed",
    }));
  } catch {}
}

console.log("Login completed (synthetic)");
console.log(JSON.stringify({
  type: "login_result",
  success: exitCode === 0,
  exit_code: exitCode,
  pid: process.pid,
  timestamp: new Date().toISOString(),
}));

if (values.verbose) {
  console.error(`[synthetic-login] Exiting with code ${exitCode}`);
}

process.exit(exitCode);
