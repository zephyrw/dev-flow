import { restoreHistoricalReply } from "../../packages/core/src/history-recovery.js";
import { resolve } from "node:path";

const target = {
  sqlitePath: "C:/Code/system-handle/.devflow/devflow.sqlite",
  workflowId: "wf-731fe4d1-a601-4c98-9af9-054b96e38a51",
  eventSeq: 16879,
  runId: "run-8be110bd-4421-412b-af0c-3729695125ad",
  conversationId: "cnv-d05fd823-cbe8-4101-82c5-c16b91cdecca",
  activityId: "d39a5c95-f76b-4556-8944-9c5916cf0f0b:reply",
  rawResultPath: "C:/Code/system-handle/.devflow/native-runs/run-8be110bd-4421-412b-af0c-3729695125ad/raw-result.txt",
  resultJsonPath: "C:/Code/system-handle/.devflow/native-runs/run-8be110bd-4421-412b-af0c-3729695125ad/result.json",
};

console.log("准备执行历史回复精准恢复，目标参数：", JSON.stringify(target, null, 2));
const outcome = restoreHistoricalReply(target);
console.log("恢复执行结果：", JSON.stringify(outcome, null, 2));

if (!outcome.success) {
  process.exit(1);
}
