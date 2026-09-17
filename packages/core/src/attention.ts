import type { Engine, PlanRecord } from "./engine.js";
import { failureSummary } from "../../presentation/src/failure.js";
import { canResolveSourceChange } from "./source-change.js";
import { runtimeFailureResolution } from "../../contracts/src/runtime-failure.js";
import { reviewCompletionContext } from "./review-completion.js";

// Present authoritative state; legacy recovery must not invent a human actor.
export function workflowAttention(engine: Engine, key: string) {
  const w = engine.get(key);
  if (
    ["REVIEW_QUEUED", "REVIEWING"].includes(w.state) &&
    reviewCompletionContext(engine, w)
  )
    return {
      category: "queue",
      message: "规划模型正在补齐详细整改计划，无需你编写；完成后继续质量流程。",
      action: "查看执行过程",
      at: w.updated_at,
    };
  if (canResolveSourceChange(engine, w))
    return {
      category: "source_change",
      message:
        "项目代码在计划制定后发生了更新。请查看变化，选择使用当前代码继续，或重新规划。",
      action: "处理代码更新",
      at: w.updated_at,
    };
  if (w.state === "BLOCKED") {
    const repair = engine.store.get<any>("repair_state", key);
    const resolution =
      runtimeFailureResolution(w.blocker?.code, w.blocker?.message) ??
      (w.blocker?.code === "REPAIR_EXHAUSTED" &&
      repair?.plan_revision === w.plan_revision
        ? runtimeFailureResolution(repair.code, repair.last_error)
        : undefined);
    if (resolution && resolution.code !== "MODEL_QUOTA") {
      const interruption = engine.store.get<any>("interruption", key);
      const run = w.run_id ? engine.store.get<any>("run", w.run_id) : undefined;
      return {
        category: "error",
        message: `${resolution.title}：${resolution.message}`,
        action: "查看处理方法",
        at: w.updated_at,
        resolution,
        runtime_context:
          interruption?.run_id === w.run_id ? interruption?.details : undefined,
        profile: run?.profile,
      };
    }
  }
  const modelRetry = engine.store.get<{ retry_at: number }>("model_retry", key);
  if (w.state === "BLOCKED" && w.blocker?.code === "MODEL_QUOTA" && modelRetry)
    return {
      category: "queue",
      message: `执行模型额度暂时用完。预计 ${new Date(modelRetry.retry_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })} 自动继续，无需补充指导。`,
      action: "查看执行过程",
      at: w.updated_at,
    };
  const resource = engine.store.get<any>("resource_wait", key);
  if (resource)
    return {
      category: "queue",
      message: resource.message,
      action: "查看等待资源",
      at: w.updated_at,
    };
  let interruption = engine.store.get<any>("interruption", key);
  if (!interruption && w.run_id) {
    interruption = engine.store.get<any>("run_stop", w.run_id);
  }
  if (!interruption && ["STOPPED", "STOPPING"].includes(w.state)) {
    const recent = engine.store.recentEvents(key, 200);
    let stoppedEvent = recent.find((e) => e.type === "Stopped");
    if (!stoppedEvent) {
      try {
        const row = (engine.store as any).db
          ?.prepare(
            "SELECT data FROM events WHERE workflow_id=? AND json_extract(data, '$.type')='Stopped' ORDER BY seq DESC LIMIT 1",
          )
          ?.get(key);
        if (row) stoppedEvent = JSON.parse(row.data);
      } catch {}
    }
    if (stoppedEvent) {
      const p = (stoppedEvent.payload ?? {}) as any;
      interruption = {
        category: p.category ?? "pause",
        source: p.source ?? (p.agent_stopped ? "local_console" : "controller"),
        at: stoppedEvent.created_at,
        prior_stage: w.stage,
        run_id: w.run_id,
        message:
          p.message ??
          (p.agent_stopped || p.source === "local_console"
            ? "你在控制台暂停了执行"
            : "执行已暂停，等待处理"),
        next_action: "核实后继续这个任务",
      };
      try {
        engine.store.put("interruption", key, key, interruption);
      } catch {}
    } else {
      const stateEvent = recent.find(
        (e) =>
          e.type === "StateChanged" && (e.payload as any)?.to === "STOPPED",
      );
      if (stateEvent) {
        interruption = {
          category: "pause",
          source: "controller",
          at: stateEvent.created_at,
          prior_stage: w.stage,
          run_id: w.run_id,
          message: "执行已暂停，等待处理",
          next_action: "核实后继续这个任务",
        };
        try {
          engine.store.put("interruption", key, key, interruption);
        } catch {}
      }
    }
  }

  if (["PLAN_PENDING", "REPAIR_PLAN_PENDING"].includes(w.state)) {
    const plan = engine.plan(key).plan;
    const previous = engine.store
      .list<PlanRecord>("plan", key)
      .find((p) => p.revision === w.plan_revision - 1);
    const revised =
      previous &&
      previous.plan.task_model !== "leaf-v1" &&
      plan.task_model === "leaf-v1";
    return {
      category: "approval",
      message: revised
        ? `等待你确认细项清单：${previous.plan.tasks.length} 个工作包已拆为 ${plan.tasks.length} 项任务`
        : "等待你确认开发计划",
      action: "查看开发计划",
      at: w.updated_at,
    };
  }
  if (
    ["STOPPED", "STOPPING", "BLOCKED", "RECOVERY_REQUIRED"].includes(w.state)
  ) {
    const message =
      w.state === "STOPPING"
        ? "正在暂停执行"
        : w.state === "BLOCKED"
          ? failureSummary(w.blocker?.code, w.blocker?.message)
          : w.state === "RECOVERY_REQUIRED"
            ? "服务重启后，需要核实中断的执行再继续"
            : (interruption?.message ?? "执行已暂停，等待处理");
    return {
      category: w.state === "BLOCKED" ? "error" : "paused",
      message,
      at:
        w.state === "BLOCKED"
          ? w.updated_at
          : (interruption?.at ?? w.updated_at),
      action: "查看执行过程",
      interruption: w.state === "BLOCKED" ? undefined : interruption,
    };
  }
  if (
    w.stage === "executor_plan_self_check" &&
    ["QUEUED", "EXECUTING", "VERIFYING"].includes(w.state)
  )
    return {
      category: "queue",
      message:
        w.state === "QUEUED"
          ? "等待执行模型逐项复核正式计划"
          : "执行模型正在对照正式计划复核、修复和自测",
      action: "查看执行过程",
      at: w.updated_at,
    };
  if (
    w.stage === "quality_before_human" &&
    ["REVIEW_QUEUED", "REVIEWING"].includes(w.state)
  )
    return {
      category: "queue",
      message:
        w.state === "REVIEWING"
          ? "规划模型正在审查代码质量与测试证据，无需手动启动"
          : (engine.store.get<any>("queue_wait", key)?.message ??
            "计划复核已通过，已自动排队等待规划模型审查"),
      action: "查看执行过程",
      at: w.updated_at,
    };
  if (w.state === "HUMAN_PENDING")
    return {
      category: "acceptance",
      message: "等待你实际操作验收",
      action: "查看本机验证副本",
      at: w.updated_at,
    };
  if (["QUEUED", "REVIEW_QUEUED"].includes(w.state))
    return {
      category: "queue",
      message:
        engine.store.get<any>("queue_wait", key)?.message ??
        "已提交，正在安排执行",
      action: "查看执行过程",
      at: w.updated_at,
    };
  if (w.state === "WAITING_AUTHORIZATION")
    return {
      category: "authorization",
      message: "有具体操作等待你授权，模型会话已保留",
      action: "查看待授权操作",
      at: w.updated_at,
    };
  if (w.state === "WAITING_INPUT")
    return {
      category: "guidance",
      message:
        w.blocker?.code === "DIAGNOSIS_FAILED"
          ? "平台的故障诊断调用失败，尚未完成排查。可继续自动排查，无需你解释技术日志。"
          : w.blocker?.code === "REPAIR_NEEDS_GUIDANCE"
            ? "多次自动排查仍未解决问题，现场已保留，可以继续自动排查。"
            : (w.blocker?.message ?? "需要你补充指导后继续"),
      action: "输入指导并继续",
      at: w.updated_at,
    };
  return null;
}
