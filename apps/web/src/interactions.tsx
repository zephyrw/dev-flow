import React, { useState } from "react";

export function TaskInteraction({
  detail,
  send,
  refresh,
}: {
  detail: any;
  send: (path: string, body: unknown) => Promise<any>;
  refresh: () => Promise<void>;
}) {
  const [text, setText] = useState(""),
    [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const w = detail.workflow;
  const requests = (detail.operations ?? []).filter(
    (r: any) => r.status === "pending",
  );
  const act = async (
    fn: () => Promise<any>,
    successMessage = "已保存，正在继续这个任务。",
  ) => {
    setPending(true);
    setError("");
    setNotice("");
    try {
      await fn();
      setText("");
      await refresh();
      setNotice(successMessage);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setPending(false);
    }
  };
  const canGuide = [
    "EXECUTING",
    "VERIFYING",
    "QUEUED",
    "HUMAN_PENDING",
    "BLOCKED",
    "STOPPED",
    "RECOVERY_REQUIRED",
    "WAITING_INPUT",
    "WAITING_AUTHORIZATION",
  ].includes(w.state);
  if (!requests.length && !canGuide) return null;
  return (
    <section className="task-interaction" aria-label="指导执行模型">
      {w.state === "BLOCKED" &&
        w.blocker?.code === "MODEL_QUOTA" &&
        detail.attention?.category === "queue" && (
          <button
            disabled={pending}
            onClick={() =>
              void act(
                () => send(`/workflows/${w.id}/stop`, {}),
                "已暂停，到点后不会自动继续。",
              )
            }
          >
            暂停自动继续
          </button>
        )}
      {!requests.length &&
        ["BLOCKED", "WAITING_INPUT"].includes(w.state) &&
        [
          "DIAGNOSIS_FAILED",
          "REPAIR_EXHAUSTED",
          "REPAIR_NEEDS_GUIDANCE",
        ].includes(w.blocker?.code) && (
          <button
            disabled={pending}
            onClick={() =>
              void act(() =>
                send(`/workflows/${w.id}/feedback`, {
                  text: "继续在原批准范围内自动排查。先核对上次真实错误与修复记录，运行诊断并验证改动效果，无需用户解释技术日志。",
                  scope: "within_plan",
                }),
              )
            }
          >
            继续自动排查
          </button>
        )}
      {requests.map((r: any) => (
        <article className="authorization-card" key={r.id}>
          <h3>操作等待你的授权</h3>
          <p>{r.operation.reason}</p>
          <dl>
            <dt>工作目录</dt>
            <dd>{r.cwd}</dd>
            <dt>执行程序</dt>
            <dd>{r.operation.executable}</dd>
            <dt>完整参数</dt>
            <dd>
              <pre>{JSON.stringify(r.operation.args, null, 2)}</pre>
            </dd>
          </dl>
          <p>
            此次决定只适用于上面这一次操作。批准后续接原模型会话；拒绝后模型会收到你的意见。
          </p>
          <p>影响范围由命令及参数决定，工作目录本身不是沙箱边界。</p>
          <div className="actions">
            <button
              disabled={pending}
              onClick={() =>
                void act(() =>
                  send(`/workflows/${w.id}/operations/${r.id}/decision`, {
                    approved: true,
                    fingerprint: r.fingerprint,
                    note: text,
                  }),
                )
              }
            >
              批准本次操作并继续
            </button>
            <button
              disabled={pending}
              onClick={() =>
                void act(() =>
                  send(`/workflows/${w.id}/operations/${r.id}/decision`, {
                    approved: false,
                    fingerprint: r.fingerprint,
                    note: text,
                  }),
                )
              }
            >
              拒绝并告知模型
            </button>
          </div>
        </article>
      ))}
      <label htmlFor={`guidance-${w.id}`}>
        {requests.length ? "授权处理意见（可选）" : "给执行模型补充指导"}
      </label>
      <textarea
        id={`guidance-${w.id}`}
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="例如：先读取后端启动日志，修复启动错误，再继续测试。"
      />
      {canGuide && !requests.length && (
        <button
          disabled={pending || !text.trim()}
          onClick={() =>
            void act(() =>
              send(`/workflows/${w.id}/feedback`, {
                text,
                scope: "within_plan",
              }),
            )
          }
        >
          {pending ? "正在交接…" : "发送指导并继续"}
        </button>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {detail.repair && (
        <details>
          <summary>最近一次自动修复</summary>
          <p>
            {detail.repair.user_summary ?? "已保存最近的修复过程和原始错误。"}
          </p>
          <details>
            <summary>技术诊断详情</summary>
            <pre>{detail.repair.instructions}</pre>
          </details>
          <small>
            已尝试 {detail.repair.attempts} 次，规划诊断{" "}
            {detail.repair.diagnoses ?? 0} 次
          </small>
        </details>
      )}
      {detail.queue?.owners?.length > 0 && (
        <p>
          占用任务：
          {detail.queue.owners
            .map((id: string) => (id === w.id ? "当前任务" : id))
            .join("、")}
        </p>
      )}
    </section>
  );
}
