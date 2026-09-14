import type { Engine, PlanRecord } from "./engine.js";

// Read-only presentation of authoritative state; never infer an actor from logs.
export function workflowAttention(engine: Engine, key: string) {
  const w = engine.get(key);
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
          e.type === "StateChanged" &&
          (e.payload as any)?.to === "STOPPED",
      );
      if (stateEvent) {
        interruption = {
          category: "pause",
          source: "local_console",
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
          ? (w.blocker?.message ?? "执行遇到问题")
          : w.state === "RECOVERY_REQUIRED"
            ? "服务重启后，需要核实中断的执行再继续"
            : (interruption?.message ?? "执行已暂停，等待处理");
    return {
      category: w.state === "BLOCKED" ? "error" : "paused",
      message,
      at: interruption?.at ?? w.updated_at,
      action: "查看执行过程",
      interruption,
    };
  }
  if (w.state === "HUMAN_PENDING")
    return {
      category: "acceptance",
      message: "等待你实际操作验收",
      action: "查看测试环境",
      at: w.updated_at,
    };
  if (["QUEUED", "REVIEW_QUEUED"].includes(w.state))
    return {
      category: "queue",
      message: "正在排队，等待执行名额或共享资源释放",
      action: "查看执行过程",
      at: w.updated_at,
    };
  return null;
}
