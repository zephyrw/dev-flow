#!/usr/bin/env node
/**
 * 合成 CLI - 模拟模型行为，用于测试进程管理
 *
 * 使用方法:
 *   node tests/fixtures/synthetic-cli.js [选项]
 *
 * 选项:
 *   --delay <ms>      模拟工作延迟 (默认 1000)
 *   --exit <code>     退出码 (默认 0)
 *   --marker <path>   创建标记文件 (用于测试 Job 归属前无副作用)
 *   --stdin           读取 stdin 并回显
 *   --verbose         输出详细信息
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    delay: { type: "string", default: "1000" },
    exit: { type: "string", default: "0" },
    marker: { type: "string" },
    stdin: { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
  },
  strict: false,
});

const delay = parseInt(values.delay, 10);
const exitCode = parseInt(values.exit, 10);

if (values.verbose) {
  console.error(`[synthetic-cli] Starting with delay=${delay}, exit=${exitCode}`);
}

// 输出初始化事件
console.log(JSON.stringify({
  type: "init",
  conversation_id: "test-conv-" + Date.now(),
  timestamp: new Date().toISOString(),
}));

// 如果需要读取 stdin
if (values.stdin) {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks).toString("utf8");
  console.log(JSON.stringify({
    type: "stdin_received",
    data: input,
    timestamp: new Date().toISOString(),
  }));
}

// 创建标记文件 (用于测试 Job 归属前无副作用)
if (values.marker) {
  try {
    mkdirSync(dirname(values.marker), { recursive: true });
    writeFileSync(values.marker, JSON.stringify({
      pid: process.pid,
      timestamp: new Date().toISOString(),
    }));
    if (values.verbose) {
      console.error(`[synthetic-cli] Marker created at ${values.marker}`);
    }
  } catch (err) {
    console.error(`[synthetic-cli] Failed to create marker: ${err}`);
  }
}

// 模拟工作
await new Promise(resolve => setTimeout(resolve, delay));

// 输出结果
console.log(JSON.stringify({
  type: "result",
  exit: exitCode,
  message: "Synthetic task completed",
  pid: process.pid,
  timestamp: new Date().toISOString(),
}));

if (values.verbose) {
  console.error(`[synthetic-cli] Exiting with code ${exitCode}`);
}

process.exit(exitCode);
