import type { Engine } from "./engine.js";
import { FlowError, resolveTaskModel } from "../../contracts/src/index.js";
import { id, now, redact, objectHash } from "./util.js";
import { failureSummary } from "../../presentation/src/failure.js";
import { rejectedDeliveryFeedback } from "./delivery-feedback.js";
import { batchExecutionInstructions } from "./execution-guidance.js";
import { normalizeRuntimeFailure } from "../../runtime/src/errors.js";
import { runtimeFailureResolution } from "../../contracts/src/runtime-failure.js";

export function prepareRepairResume(engine: Engine, key: string) {
  if (resolveTaskModel(engine.plan(key).plan) !== "native-v2") return;
  const w = engine.get(key);
  if (w.state === "BLOCKED" && w.blocker?.code === "REPAIR_EXHAUSTED")
    engine.store.remove("repair_state", key);
  const assignment = engine.store.get<any>("repair_assignment", key);
  if (!assignment?.planner) return;
  if (
    assignment.source === "quality_review" &&
    assignment.plan_revision === w.plan_revision &&
    assignment.plan_hash === w.plan_hash &&
    assignment.source_review_id ===
      engine.quality.getGate(key, assignment.phase)?.current_review_id &&
    engine.quality.canTakeOver(key, assignment.phase)
  )
    return;
  // Old execution-failure counters never authorize planner ownership. Recheck
  // at resume/dispatch boundaries without interrupting an active model run.
  engine.store.remove("repair_assignment", key);
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
  error = normalizeRuntimeFailure(error);
  const code = error instanceof FlowError ? error.code : "INTERNAL_FAILURE";
  // Infrastructure failures do not consume either model's repair budget.
  if (runtimeFailureResolution(code)) return null;
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
  prepareRepairResume(engine, key);
  const assignment = engine.store.get<any>("repair_assignment", key);
  const planner =
    assignment?.planner === true &&
    ["planner_takeover", "plan_self_check"].includes(run?.purpose);
  const phase =
    run?.purpose === "plan_self_check" ? "plan_self_check" : "implementation";
  const saved = engine.store.get<any>("repair_state", key);
  const prior =
    saved?.plan_revision === w.plan_revision ? saved : null;
  const failures: Array<{ run_id: string; planner: boolean }> =
    prior?.failed_runs ?? [];
  if (!failures.some((f) => f.run_id === runId))
    failures.push({ run_id: runId, planner });
  const executorFailures = failures.filter((f) => !f.planner).length;
  const plannerFailures = failures.filter((f) => f.planner).length;
  // Execution recovery is bounded independently of quality remediation. It
  // retains the assigned owner and can never grant planner takeover.
  const exhausted = planner ? plannerFailures >= 3 : executorFailures >= 6;
  const code = error instanceof FlowError ? error.code : "INTERNAL_FAILURE";
  const message = redact(
    error instanceof Error ? error.message : String(error),
  );
  const delivery = rejectedDeliveryFeedback(engine.store, w);
  const owner = planner ? "规划模型" : "执行模型";
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
      : "repairing",
    updated_at: now(),
  });
  if (exhausted) {
    engine.transition(key, [w.state], "BLOCKED", "repair_exhausted", {
      blocker: {
        code: "REPAIR_EXHAUSTED",
        message: `${owner}执行恢复连续${planner ? "三" : "六"}轮仍未完成：${failureSummary(code, message)}已保留现场；执行异常不计入代码质量整改次数，不因此更换模型。`,
      },
    });
    return { retry: false, instructions };
  }
  engine.store.event(
    key,
    w.project_id,
    "RepairScheduled",
    {
      attempt: failures.length,
      code,
      message: `${failureSummary(code, message)}${owner}将继续修复；本次执行异常不计入质量整改次数。`,
      instructions,
    },
    runId,
  );
  return { retry: true, instructions };
}
