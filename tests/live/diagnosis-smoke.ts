// External-model contract check using only a generated text fixture, never
// the user's database, project source, logs, snapshots or credentials.
import { writeFileSync } from "node:fs";
import { prepared } from "../helpers.js";
import { LocalRuntime } from "../../packages/runtime/src/runtime.js";
const s = await prepared();
const runtime = new LocalRuntime(s.engine);
try {
  const result = await runtime.diagnose(
    s.workflow,
    "这是纯合成夹具：app.txt 内容为 before。合成故障是 PowerShell 调用 batch.cmd 没有任何输出就结束；合成原因是父程序未传 ComSpec 与 PATHEXT。请核对合成文件，并返回原范围内的检查步骤，不需要新计划。只验证诊断协议。",
  );
  writeFileSync(
    ".cache/diagnosis-synthetic-live.json",
    JSON.stringify({ at: new Date().toISOString(), result }, null, 2),
  );
  console.log(
    JSON.stringify({
      success: true,
      requires_plan_change: result.requires_plan_change,
    }),
  );
} finally {
  await runtime.close();
  s.store.close();
}
