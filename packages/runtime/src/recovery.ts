import { execFileSync } from "node:child_process";
import type { Engine } from "../../core/src/engine.js";
import { requireCondition } from "../../contracts/src/index.js";
import type { Lease } from "../../scheduler/src/scheduler.js";
import { now } from "../../core/src/util.js";
export function reconcileProcesses(engine: Engine, key: string) {
  const w = engine.get(key);
  requireCondition(
    ["RECOVERY_REQUIRED", "BLOCKED", "STOPPED", "COMMIT_PARTIAL"].includes(
      w.state,
    ),
    "INVALID_STATE",
    "当前不能进行恢复对账",
  );
  const records = engine.store.list<{
    id: string;
    status: string;
    confirmed?: boolean;
  }>("process_record", key);
  const results = records.map((record) => {
    const result = JSON.parse(
      execFileSync(engine.config.host.executable, ["job-status", record.id], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10000,
        env: {
          ...process.env,
          DOTNET_ROOT:
            process.env.DOTNET_ROOT ?? process.cwd() + "/.cache/dotnet",
        },
      }),
    );
    requireCondition(
      result.id === record.id && !result.alive,
      "PROCESS_STILL_ACTIVE",
      `受管进程 ${record.id} 尚未退出`,
    );
    return result;
  });
  const leases = engine.store.list<Lease>("lease", key);
  requireCondition(
    !leases.some((l) => l.id === "browser:shared"),
    "BROWSER_RECONCILIATION_REQUIRED",
    "浏览器租约需要先检查并关闭本轮创建的标签页",
  );
  requireCondition(
    records.length > 0 || !leases.some((l) => l.status === "suspect"),
    "PROCESS_RECORD_MISSING",
    "缺少旧运行的进程登记，不能凭租约超时释放资源",
  );
  engine.store.transaction(() => {
    for (const record of records)
      engine.store.put("process_record", record.id, key, {
        ...record,
        status: "exited",
        confirmed: true,
        reconciled_at: now(),
      });
    for (const lease of leases)
      engine.scheduler.release(key, lease.run_id, [lease.id], true);
    const env = engine.store.get<Record<string, unknown>>("environment", key);
    if (env)
      engine.store.put("environment", key, key, { ...env, status: "stopped" });
    engine.store.event(key, w.project_id, "ProcessesReconciled", { results });
  });
  return results;
}
export function resumeApproved(engine: Engine, key: string) {
  engine.assertProjectConfiguration(key);
  reconcileProcesses(engine, key);
  const w = engine.get(key);
  requireCondition(
    w.state !== "COMMIT_PARTIAL",
    "COMMIT_RECOVERY_REQUIRED",
    "部分提交只能重试原提交，不能启动开发",
  );
  const approval = engine.store.get<{ plan_hash: string }>(
    "approval",
    `${key}-${w.plan_revision}`,
  );
  requireCondition(
    approval?.plan_hash === w.plan_hash,
    "PLAN_NOT_APPROVED",
    "当前计划未获批准",
  );
  engine.invalidate(key, "用户恢复执行，旧证据失效");
  engine.transition(key, [w.state], "QUEUED", "execute", {
    blocker: undefined,
  });
  engine.scheduler.enqueue(key, w.project_id);
  return engine.get(key);
}
