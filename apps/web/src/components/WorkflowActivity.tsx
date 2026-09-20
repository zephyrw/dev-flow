import React, { useEffect, useState } from "react";
export function WorkflowActivity({
  workflow,
  refresh,
}: {
  workflow: any;
  refresh: () => Promise<void>;
}) {
  const [issues, setIssues] = useState<any[]>([]),
    [error, setError] = useState(""),
    [tick, setTick] = useState(0);
  useEffect(() => {
    setIssues([]);
    setError("");
  }, [workflow.id]);
  useEffect(() => {
    const abort = new AbortController();
    fetch("/api/workflows/" + workflow.id + "/functional-issues", {
      signal: abort.signal,
    })
      .then(async (r) => {
        if (!r.ok) throw new Error("无法读取任务反馈");
        const value = await r.json();
        if (!Array.isArray(value))
          throw new Error("任务反馈响应格式无效，请刷新重试");
        return value;
      })
      .then((i) => {
        if (!abort.signal.aborted) {
          setIssues(i ?? []);
          setError("");
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(String(e));
      });
    return () => abort.abort();
  }, [workflow.id, workflow.version, tick]);
  useEffect(() => {
    const onActivity = () => setTick((t) => t + 1);
    window.addEventListener("devflow-activity", onActivity);
    return () => window.removeEventListener("devflow-activity", onActivity);
  }, []);
  async function act(path: string, body: any) {
    try {
      const r = await fetch("/api/workflows/" + workflow.id + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const value = await r.json();
      if (!r.ok) throw new Error(value.message ?? "操作失败");
      setTick((t) => t + 1);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }
  if (!issues.length && !error) return null;
  return (
    <div aria-label="任务反馈记录">
      {issues.length > 0 && (
        <details open>
          <summary>功能问题与复测</summary>
          {issues.map((i) => (
            <article key={i.issue_id}>
              <p>
                {i.description} ·{" "}
                {
                  (
                    {
                      open: "等待修复",
                      queued: "修复排队",
                      fixing: "修复中",
                      ready_for_retest: "待你复测",
                      confirmed: "已确认",
                    } as any
                  )[i.status]
                }
              </p>
              {i.status === "ready_for_retest" &&
                workflow.state === "HUMAN_PENDING" && (
                  <div className="actions">
                    <button
                      onClick={() =>
                        void act(
                          "/functional-issues/" + i.issue_id + "/confirm",
                          {
                            request_id: crypto.randomUUID(),
                            expected_version: workflow.version,
                            delivery_revision_id: i.fix_delivery_id,
                            passed: true,
                          },
                        )
                      }
                    >
                      复测通过
                    </button>
                    <button
                      onClick={() =>
                        void act(
                          "/functional-issues/" + i.issue_id + "/confirm",
                          {
                            request_id: crypto.randomUUID(),
                            expected_version: workflow.version,
                            delivery_revision_id: i.fix_delivery_id,
                            passed: false,
                            feedback: "复测仍然存在：" + i.description,
                          },
                        )
                      }
                    >
                      仍有问题，继续修复
                    </button>
                  </div>
                )}
            </article>
          ))}
        </details>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
