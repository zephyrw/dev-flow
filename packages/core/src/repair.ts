import type { Engine } from "./engine.js";
import { FlowError, resolveTaskModel } from "../../contracts/src/index.js";
import { id, now, redact, objectHash } from "./util.js";
import { failureSummary } from "../../presentation/src/failure.js";
import { rejectedDeliveryFeedback } from "./delivery-feedback.js";
import { batchExecutionInstructions } from "./execution-guidance.js";

export function prepareRepairResume(engine: Engine, key: string) {
  const w = engine.get(key);
  const previous = engine.store.get<any>("repair_state", key);
  if (
    w.state !== "BLOCKED" ||
    w.blocker?.code !== "REPAIR_EXHAUSTED" ||
    resolveTaskModel(engine.plan(key).plan) !== "native-v2" ||
    previous?.plan_revision !== w.plan_revision ||
    previous?.code !== "DELIVERY_REJECTED" ||
    (previous.executor_failures ?? previous.consecutive ?? 0) < 3
  )
    return;
  const assignment = engine.store.get<any>("repair_assignment", key);
  engine.store.put("repair_assignment", key, key, {
    ...assignment,
    planner: true,
    phase: assignment?.phase ?? "before_human",
    source: "execution_failure",
    plan_revision: w.plan_revision,
    instructions:
      "执行模型已多轮修复失败。本次恢复由规划模型在原批准范围内接手，完整核查全部拒绝原因，保留已有工作，完成整批修改后统一测试和交付。" + batchExecutionInstructions,
  });
  engine.store.remove("repair_state", key);
}

export async function repairFailure(
  engine: Engine,
  key: string,
  error: unknown,
  run: string,
) {
  const w = engine.get(key);
  if (w.run_id !== run || !["EXECUTING", "VERIFYING"].includes(w.state))
    return null;
  const code = error instanceof FlowError ? error.code : "INTERNAL_FAILURE";
  if (
    [
      "MODEL_QUOTA",
      "MODEL_AUTH",
      "UNAUTHORIZED",
      "NATIVE_PERMISSION_DENIED",
      "AUTHORIZATION_ROUTING_REQUIRED",
      "POLICY_FAILED",
      "RUN_REVOKED",
      "DISK_FULL",
      "PROJECT_CONFIG_CHANGED",
      "APPROVAL_STALE",
    ].includes(code)
  )
    return null;
  const prior = engine.store.get<any>("repair_state", key);
  if (resolveTaskModel(engine.plan(key).plan) === "native-v2") {
    return repairNativeFailure(engine, key, error, run);
  }
  const attempts =
    (prior?.plan_revision === w.plan_revision ? prior.attempts : 0) + 1;
  let diagnoses =
    prior?.plan_revision === w.plan_revision ? (prior.diagnoses ?? 0) : 0;
  const message = redact(
    error instanceof Error ? error.message : String(error),
  );
  const signature = objectHash({
    code,
    message: message
      .replace(/\b(?:port|端口)\s*\d+/gi, "port")
      .replace(/\b(?:wf|run|service|identity)-[a-f0-9-]+/g, "runtime"),
  });
  const consecutive =
    prior?.signature === signature ? (prior.consecutive ?? 0) + 1 : 1;
  let diagnosedSignature = prior?.diagnosed_signature;
  let diagnosisError: string | undefined;
  const userSummary = failureSummary(code, message);
  const executionGuidance =
    resolveTaskModel(engine.plan(key).plan) === "native-v2"
      ? "在正式批准范围内自主使用原生工具完成开发和自测，再提交真实交付证据。遇到权限拒绝时停止并报告具体操作，不得反复重试或换工具绕过。"
      : "需要未登记的诊断或安装命令时调用 devflow_request_operation。";
  let instructions = `本轮遇到 ${code}：${message}。完整读取 diagnostics、feedback 和已有执行记录，核对命令、退出码和全部错误，核清全部已知问题根因及影响后完成整批修复，再统一测试；不要只改包装脚本或反复重报所有任务。${batchExecutionInstructions}${executionGuidance}检查必须实际执行，不能重复声明完成后退出。`;
  const save = (status: string) =>
    engine.store.put("repair_state", key, key, {
      plan_revision: w.plan_revision,
      attempts,
      diagnoses,
      code,
      last_error: message,
      instructions,
      user_summary: userSummary,
      signature,
      consecutive,
      diagnosed_signature: diagnosedSignature,
      ...(diagnosisError ? { diagnosis_error: diagnosisError } : {}),
      status,
      updated_at: now(),
    });
  if (consecutive >= 6) {
    save("exhausted");
    engine.transition(key, [w.state], "BLOCKED", "repair_exhausted", {
      blocker: {
        code: "REPAIR_EXHAUSTED",
        message: `${userSummary}同一错误连续修复仍未解决，已保留现场，可继续自动排查。`,
      },
    });
    return { retry: false, instructions };
  }
  if (
    consecutive >= 3 &&
    diagnosedSignature !== signature &&
    engine.runtime?.diagnose
  ) {
    diagnoses++;
    diagnosedSignature = signature;
    save("diagnosing");
    try {
      const result = await engine.runtime.diagnose(engine.get(key), message);
      const current = engine.get(key);
      if (
        current.run_id !== run ||
        !["EXECUTING", "VERIFYING"].includes(current.state)
      )
        return { retry: false, instructions };
      instructions = `规划诊断：${result.diagnosis}\n修复步骤：${result.instructions}\n${batchExecutionInstructions}`;
      if (result.requires_plan_change) {
        engine.transition(
          key,
          [current.state],
          "REPAIR_RESEARCH_REQUIRED",
          "research",
        );
        await engine.submitValidatedPlan(
          key,
          result.repair_plan,
          engine.get(key).version,
          id("diagnostic-plan"),
        );
        save("awaiting_plan_approval");
        return { retry: false, instructions };
      }
    } catch (error) {
      const current = engine.get(key);
      if (
        current.run_id !== run ||
        !["EXECUTING", "VERIFYING", "REPAIR_RESEARCH_REQUIRED"].includes(
          current.state,
        )
      )
        return { retry: false, instructions };
      diagnosisError = redact(String(error));
      instructions += `\n辅助规划诊断暂时失败：${diagnosisError}。这不是缺少用户需求；继续在当前批准范围内排查原故障，不要求用户解释技术日志。`;
      if (current.state === "REPAIR_RESEARCH_REQUIRED") {
        engine.transition(key, [current.state], "EXECUTING", "repair");
      }
      engine.store.event(
        key,
        w.project_id,
        "DiagnosisDeferred",
        {
          message:
            "辅助诊断暂时未完成，执行模型将继续排查原故障，无需你补充技术信息。",
          diagnostic: diagnosisError,
        },
        run,
      );
    }
  }
  save("repairing");
  engine.store.event(
    key,
    w.project_id,
    "RepairScheduled",
    {
      attempt: attempts,
      code,
      message: `${userSummary}执行模型正在排查并修复。`,
      instructions,
    },
    run,
  );
  return { retry: true, instructions };
}

function repairNativeFailure(
  engine: Engine,
  key: string,
  error: unknown,
  runId: string,
) {
  const w = engine.get(key);
  const run = engine.store.get<any>("run", runId);
  const assignment = engine.store.get<any>("repair_assignment", key);
  const planner =
    run?.purpose === "planner_takeover" ||
    (run?.purpose === "plan_self_check" && assignment?.planner === true);
  const phase =
    run?.purpose === "plan_self_check" ? "plan_self_check" : "implementation";
  const saved = engine.store.get<any>("repair_state", key);
  const prior =
    saved?.plan_revision === w.plan_revision && saved?.phase === phase
      ? saved
      : null;
  const failures: Array<{ run_id: string; planner: boolean }> =
    prior?.failed_runs ?? [];
  if (!failures.some((f) => f.run_id === runId))
    failures.push({ run_id: runId, planner });
  const executorFailures = failures.filter((f) => !f.planner).length;
  const plannerFailures = failures.filter((f) => f.planner).length;
  const takeover = planner || executorFailures >= 3;
  const exhausted = planner && plannerFailures >= 3;
  const code = error instanceof FlowError ? error.code : "INTERNAL_FAILURE";
  const message = redact(
    error instanceof Error ? error.message : String(error),
  );
  const delivery = rejectedDeliveryFeedback(engine.store, w);
  const owner = takeover ? "规划模型" : "执行模型";
  const instructions = `${owner}在原批准工作区和范围内实际修复 ${code}：${message}。保留已有实现，先完整核查本次全部核验拒绝原因及共因，再完成整批代码修改，最后统一测试并提交新的真实交付；不得只给诊断建议。${batchExecutionInstructions}不得更改原批准计划或伪造测试记录、调用编号和报告。需要改变范围、权限或外部条件时报告具体阻塞。`;
  engine.store.put("repair_state", key, key, {
    plan_revision: w.plan_revision,
    phase,
    failed_runs: failures,
    attempts: failures.length,
    executor_failures: executorFailures,
    planner_failures: plannerFailures,
    code,
    last_error: message,
    instructions,
    delivery_feedback: delivery,
    user_summary: failureSummary(code, message),
    status: exhausted
      ? "exhausted"
      : takeover
        ? "planner_takeover"
        : "repairing",
    updated_at: now(),
  });
  if (exhausted) {
    engine.transition(key, [w.state], "BLOCKED", "repair_exhausted", {
      blocker: {
        code: "REPAIR_EXHAUSTED",
        message: `规划模型接手后连续三轮仍未解决：${failureSummary(code, message)}已停止重复尝试并保留修复现场。`,
      },
    });
    return { retry: false, instructions };
  }
  if (takeover)
    engine.store.put("repair_assignment", key, key, {
      ...assignment,
      planner: true,
      phase: assignment?.phase ?? "before_human",
      source: "execution_failure",
      plan_revision: w.plan_revision,
    });
  engine.store.event(
    key,
    w.project_id,
    takeover ? "PlannerRepairScheduled" : "RepairScheduled",
    {
      attempt: failures.length,
      code,
      message: takeover
        ? "执行模型未能完成修复，已安排规划模型接手修改代码、补齐测试并重新核验。"
        : `${failureSummary(code, message)}执行模型将继续修复。`,
      instructions,
    },
    runId,
  );
  return { retry: true, instructions };
}
