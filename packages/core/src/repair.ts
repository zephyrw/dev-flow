import type { Engine } from "./engine.js";
import { FlowError } from "../../contracts/src/index.js";
import { id, now, redact, objectHash } from "./util.js";
import { failureSummary } from "../../presentation/src/failure.js";

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
      "RUN_REVOKED",
      "DISK_FULL",
      "PROJECT_CONFIG_CHANGED",
      "APPROVAL_STALE",
    ].includes(code)
  )
    return null;
  const prior = engine.store.get<any>("repair_state", key);
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
  let instructions = `本轮遇到 ${code}：${message}。读取 diagnostics 和 feedback 上下文，定位原因后修复。先运行能区分原因的检查，核对命令是否真的执行、退出码和完整错误；不要只改包装脚本或反复重报所有任务。需要未登记的诊断或安装命令时调用 devflow_request_operation。检查必须实际执行，不能重复声明完成后退出。`;
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
      instructions = `规划诊断：${result.diagnosis}\n修复步骤：${result.instructions}`;
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
      message: `${userSummary}执行模型正在排查并修复。`,
      instructions,
    },
    run,
  );
  return { retry: true, instructions };
}
