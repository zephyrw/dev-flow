import guideText from "../../../docs/guide/使用指南.md?raw";
import { TaskTree, TestResults } from "./panels.js";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import mermaid from "mermaid";
import "./style.css";
import { readableLogs, mergeEvents, workflowProgress, stages } from "./logs.js";
const labels: Record<string, string> = {
  RESEARCHING: "调研中",
  PLAN_PENDING: "等待计划批准",
  QUEUED: "排队中",
  EXECUTING: "实施中",
  VERIFYING: "自动测试",
  HUMAN_PENDING: "等待你的验收",
  REVIEW_QUEUED: "等待独立复核",
  REVIEWING: "独立复核中",
  REPAIR_PLAN_PENDING: "等待修复计划批准",
  REPAIR_RESEARCH_REQUIRED: "需要补充调研",
  COMMITTING: "提交中",
  COMMITTED: "已提交",
  COMMIT_PARTIAL: "提交需要恢复",
  STOPPING: "正在停止",
  STOPPED: "已停止",
  BLOCKED: "需要处理",
  RECOVERY_REQUIRED: "需要恢复检查",
};
async function api(path: string, body?: unknown) {
  const r = await fetch("/api" + path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await r.json();
  if (!r.ok) throw Error(result.error?.message ?? "请求失败");
  return result;
}
function Diagram({ source }: { source: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setError("");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "neutral",
      fontFamily: "Microsoft YaHei, sans-serif",
    });
    void mermaid
      .render("diagram" + crypto.randomUUID().replaceAll("-", ""), source)
      .then(({ svg }) => {
        if (alive && ref.current) ref.current.innerHTML = svg;
      })
      .catch(() => {
        if (alive) setError("图表语法有误，请在批准前修正。");
      });
    return () => {
      alive = false;
    };
  }, [source]);
  return error ? (
    <p className="error">{error}</p>
  ) : (
    <div className="diagram" ref={ref} />
  );
}
function Document({ text }: { text: string }) {
  return (
    <div className="document">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: ({ className, children, ...props }) =>
            className === "language-mermaid" ? (
              <Diagram source={String(children)} />
            ) : (
              <code className={className} {...props}>
                {children}
              </code>
            ),
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
function App() {
  const [showGuide, setShowGuide] = useState(
    () => new URLSearchParams(location.search).get("view") === "guide",
  );
  const [fileDiff, setFileDiff] = useState<any>(null);
  useEffect(() => {
    if (!fileDiff) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFileDiff(null);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [fileDiff]);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [projects, setProjects] = useState<any[]>([]),
    [flows, setFlows] = useState<any[]>([]),
    [selected, setSelected] = useState(
      () => new URLSearchParams(location.search).get("workflow") ?? "",
    ),
    [detail, setDetail] = useState<any>(null),
    [tab, setTab] = useState("overview"),
    [modal, setModal] = useState(""),
    [text, setText] = useState(""),
    [pending, setPending] = useState(false),
    [scope, setScope] = useState("within_plan"),
    [diff, setDiff] = useState<any[]>([]);
  useEffect(() => {
    const url = new URL(location.href);
    if (selected) url.searchParams.set("workflow", selected);
    else url.searchParams.delete("workflow");
    if (showGuide) url.searchParams.set("view", "guide");
    else url.searchParams.delete("view");
    history.replaceState(null, "", url);
  }, [selected, showGuide]);
  const eventCursor = useRef(0);
  const eventBuffer = useRef<any[]>([]);
  const selection = useRef(selected);
  selection.current = selected;
  const logsRef = useRef<HTMLDivElement>(null);
  const [followLogs, setFollowLogs] = useState(true);
  useEffect(() => {
    if (followLogs && logsRef.current)
      logsRef.current.scrollTop = logsRef.current.scrollHeight;
  }, [detail?.events?.at(-1)?.event_seq, tab, followLogs]);
  const [connected, setConnected] = useState(false);
  const attempt = async (fn: () => Promise<unknown>) => {
    setError("");
    setNotice("");
    setPending(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };
  const refresh = async () => {
    const [p, f] = await Promise.all([api("/projects"), api("/workflows")]);
    setProjects(p);
    setFlows(f);
    if (selected) {
      const next = await api("/workflows/" + selected);
      if (selection.current === selected)
        setDetail((previous: any) => {
          const current = previous?.workflow.id === selected ? previous : null;
          const latest =
            current?.workflow.version > next.workflow.version ? current : next;
          return {
            ...latest,
            events: mergeEvents(
              selected,
              current?.events ?? [],
              next.events,
              eventBuffer.current,
            ),
          };
        });
    }
  };
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
  }, [selected]);
  useEffect(() => {
    let disposed = false,
      socket: WebSocket,
      retry: ReturnType<typeof setTimeout>,
      debounce: ReturnType<typeof setTimeout>;
    const update = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        void Promise.all([api("/projects"), api("/workflows")])
          .then(([p, f]) => {
            if (!disposed) {
              setProjects(p);
              setFlows(f);
            }
          })
          .catch((e) => setError(String(e)));
      }, 200);
    };
    const connect = () => {
      socket = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/notifications`,
      );
      socket.onopen = () => {
        setConnected(true);
        update();
      };
      socket.onmessage = update;
      socket.onclose = () => {
        if (!disposed) retry = setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      disposed = true;
      clearTimeout(retry);
      clearTimeout(debounce);
      socket?.close();
    };
  }, []);
  useEffect(() => {
    if (!selected) return;
    eventCursor.current = 0;
    eventBuffer.current = [];
    let ws: WebSocket,
      disposed = false,
      timer: ReturnType<typeof setTimeout>,
      refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      ws = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/events?workflow_id=${selected}&after=${eventCursor.current}`,
      );
      ws.onopen = () => setConnected(true);
      ws.onmessage = (e) => {
        if (disposed || selection.current !== selected) return;
        const event = JSON.parse(e.data);
        if (event.workflow_id !== selected) return;
        eventCursor.current = Math.max(eventCursor.current, event.event_seq);
        eventBuffer.current = mergeEvents(selected, eventBuffer.current, [
          event,
        ]);
        setDetail((previous: any) =>
          previous?.workflow.id === selected
            ? {
                ...previous,
                events: mergeEvents(selected, previous.events, [event]),
              }
            : previous,
        );
        // Stream output immediately. Only domain changes need an HTTP refresh;
        // a continuous token stream must never postpone displaying the log.
        if (
          !refreshTimer &&
          ![
            "AgentEvent",
            "AgentDiagnostic",
            "CheckOutput",
            "ServiceOutput",
            "FixtureOutput",
          ].includes(event.type)
        )
          refreshTimer = setTimeout(() => {
            refreshTimer = undefined;
            void refresh().catch((e) => {
              if (!disposed) setError(String(e));
            });
          }, 150);
      };
      ws.onclose = () => {
        setConnected(false);
        if (!disposed) timer = setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(refreshTimer);
      ws?.close();
    };
  }, [selected]);
  const approve = async (action: "approve" | "accept") => {
    const viewed = detail?.workflow;
    if (!viewed || viewed.id !== selected)
      throw Error("请先打开计划或验收内容。");
    await api(`/workflows/${selected}/${action}`, {
      binding: {
        workflow_id: selected,
        action,
        version: viewed.version,
        plan_revision: viewed.plan_revision,
        plan_hash: viewed.plan_hash ?? null,
        snapshot_id: viewed.snapshot_id ?? null,
        environment_revision: viewed.environment_revision,
        extra: {},
      },
    });
    await refresh();
    setNotice(
      action === "approve"
        ? "计划已批准，进入执行队列。"
        : "验收已记录，将启动独立复核。",
    );
  };
  const w = detail?.workflow.id === selected ? detail.workflow : undefined;
  const progress = w ? workflowProgress(w, detail.events) : undefined;
  const timeline = w ? readableLogs(detail.events, selected) : [];
  const latest = timeline
    .filter(
      (e) =>
        ![
          "RESEARCHING",
          "REPAIR_RESEARCH_REQUIRED",
          "PLAN_PENDING",
          "REPAIR_PLAN_PENDING",
        ].includes(w?.state) &&
        (e.kind === "tool" || e.kind === "message"),
    )
    .at(-1);
  const counts = {
    active: flows.filter((f) =>
      ["EXECUTING", "VERIFYING", "REVIEWING"].includes(f.state),
    ).length,
    waiting: flows.filter((f) =>
      ["HUMAN_PENDING", "PLAN_PENDING", "REPAIR_PLAN_PENDING"].includes(
        f.state,
      ),
    ).length,
    done: flows.filter((f) => f.state === "COMMITTED").length,
  };
  return (
    <div className="layout">
      <aside>
        <div className="brand">
          <span className="mark">D</span> DevFlow
        </div>
        <button
          className={!selected && !showGuide ? "nav active" : "nav"}
          onClick={() => {
            setShowGuide(false);
            setSelected("");
            setDetail(null);
          }}
        >
          ◫ 工作流总览
        </button>
        <div className="nav-heading">项目</div>
        {projects.map((p) => (
          <div key={p.id} className="project-nav">
            <span>▱ {p.name}</span>
            {flows
              .filter((f) => f.project_id === p.id)
              .map((f) => (
                <button
                  key={f.id}
                  className={
                    "flow-nav " +
                    (!showGuide && selected === f.id ? "active" : "")
                  }
                  onClick={() => {
                    setShowGuide(false);
                    setSelected(f.id);
                    setTab("overview");
                  }}
                >
                  <i className={"dot " + f.state} />
                  {f.title}
                </button>
              ))}
          </div>
        ))}
        <div className="sidebar-bottom">
          <button
            className={"nav " + (showGuide ? "active" : "")}
            onClick={() => setShowGuide(true)}
          >
            使用指南
          </button>
          <div className="connection-status">
            <span className={"dot " + (connected ? "COMMITTED" : "")} />{" "}
            {selected
              ? connected
                ? "实时连接已建立"
                : "正在连接事件流"
              : "本机工作台"}
          </div>
        </div>
      </aside>
      <main>
        <header>
          <div>
            <p className="eyebrow">
              {showGuide
                ? "DevFlow / 使用指南"
                : selected
                  ? "工作流 / " +
                    (projects.find((p) => p.id === w?.project_id)?.name ??
                      "加载中…")
                  : "开发工作台"}
            </p>
            <h1>
              {showGuide
                ? "使用指南"
                : selected
                  ? (w?.title ?? "加载中…")
                  : "工作流总览"}
            </h1>
          </div>
        </header>
        {error && (
          <div role="alert" className="error banner">
            {error}
            <button onClick={() => setError("")}>关闭</button>
          </div>
        )}
        {notice && (
          <div role="status" className="notice">
            {notice}
          </div>
        )}
        {showGuide ? (
          <section className="panel guide-page">
            <Document text={guideText} />
          </section>
        ) : !selected ? (
          <>
            <section className="stats">
              <div>
                <span>正在运行</span>
                <strong>{counts.active}</strong>
                <small>实施、测试与复核</small>
              </div>
              <div>
                <span>等待你处理</span>
                <strong>{counts.waiting}</strong>
                <small>计划批准与实际验收</small>
              </div>
              <div>
                <span>已完成提交</span>
                <strong>{counts.done}</strong>
                <small>完整通过交付检查</small>
              </div>
            </section>
            <section className="panel">
              <div className="section-title">
                <h2>全部工作流</h2>
                <span>{flows.length} 个工作流</span>
              </div>
              {!flows.length ? (
                <div className="empty">
                  <span>◇</span>
                  <h3>从一个明确的需求开始</h3>
                  <p>
                    在 Codex 的业务项目中说“用 DevFlow
                    帮我……”即可开始。计划批准后，这里会显示执行进度。
                  </p>
                  <button
                    onClick={() => {
                      setShowGuide(true);
                      setText("{}");
                    }}
                  >
                    阅读使用指南
                  </button>
                </div>
              ) : (
                <div className="flow-grid">
                  {flows.map((f) => (
                    <button
                      className="flow-card"
                      key={f.id}
                      onClick={() => {
                        setShowGuide(false);
                        setSelected(f.id);
                        setTab("overview");
                      }}
                    >
                      <div>
                        <span className="project-label">
                          {projects.find((p) => p.id === f.project_id)?.name}
                        </span>
                        <span className={"badge " + f.state}>
                          {labels[f.state]}
                        </span>
                      </div>
                      <h3>{f.title}</h3>
                      <p>{f.request}</p>
                      <footer>
                        <span>
                          {new Date(f.updated_at).toLocaleString("zh-CN")}
                        </span>
                      </footer>
                    </button>
                  ))}
                </div>
              )}
            </section>
          </>
        ) : (
          w && (
            <>
              <div className="workflow-bar">
                <span className={"badge " + w.state}>{labels[w.state]}</span>

                <div className="actions">
                  {["PLAN_PENDING", "REPAIR_PLAN_PENDING"].includes(
                    w.state,
                  ) && (
                    <button
                      className="primary"
                      disabled={pending}
                      onClick={() => void attempt(() => approve("approve"))}
                    >
                      批准当前计划
                    </button>
                  )}
                  {w.state === "HUMAN_PENDING" && (
                    <button
                      className="primary"
                      disabled={pending}
                      onClick={() => void attempt(() => approve("accept"))}
                    >
                      验收通过，启动复核
                    </button>
                  )}
                  {["HUMAN_PENDING", "BLOCKED", "STOPPED"].includes(
                    w.state,
                  ) && (
                    <button
                      onClick={() => {
                        setModal("feedback");
                        setText("");
                      }}
                    >
                      反馈问题
                    </button>
                  )}
                  {![
                    "COMMITTED",
                    "COMMITTING",
                    "COMMIT_PARTIAL",
                    "STOPPED",
                  ].includes(w.state) && (
                    <button
                      className="danger"
                      disabled={pending}
                      onClick={() =>
                        void attempt(async () => {
                          await api(`/workflows/${selected}/stop`, {});
                          await refresh();
                        })
                      }
                    >
                      停止执行
                    </button>
                  )}
                </div>
              </div>
              {[
                "BLOCKED",
                "STOPPED",
                "RECOVERY_REQUIRED",
                "COMMIT_PARTIAL",
              ].includes(w.state) && (
                <div className="actions">
                  <button
                    disabled={pending}
                    onClick={() =>
                      void attempt(async () => {
                        await api(
                          `/workflows/${selected}/browser/reconcile`,
                          {},
                        );
                        await api(
                          `/workflows/${selected}/${w.state === "COMMIT_PARTIAL" ? "commit/retry" : "recover"}`,
                          {},
                        );
                        await refresh();
                      })
                    }
                  >
                    {w.state === "COMMIT_PARTIAL"
                      ? "核实现场并重试原提交"
                      : "继续这个任务"}
                  </button>
                </div>
              )}
              {progress && (
                <section
                  className="execution-progress"
                  aria-label="当前执行进度"
                >
                  <div className="section-title">
                    <h2>
                      {progress.paused ? "已暂停 · " : "当前阶段 · "}
                      {progress.title}
                    </h2>
                    <span>
                      {detail.plan?.plan.task_model === "leaf-v1"
                        ? `已完成任务 ${detail.tasks.filter((t: any) => t.completed).length} / ${detail.tasks.length}`
                        : `${detail.tasks.length} 个工作包`}
                    </span>
                  </div>
                  <ol className="stage-track">
                    {stages.map((name, index) => (
                      <li
                        key={name}
                        aria-current={
                          index === progress.index ? "step" : undefined
                        }
                        className={index === progress.index ? "current" : ""}
                      >
                        <span>{index + 1}</span>
                        {name}
                      </li>
                    ))}
                  </ol>
                  {detail.active_task &&
                    ["EXECUTING", "VERIFYING"].includes(w.state) && (
                      <p className="current-action">
                        当前工作：{detail.active_task.title} ·{" "}
                        {detail.active_task.summary}
                      </p>
                    )}
                  {latest && (
                    <p className="current-action">
                      {progress.paused ? "中断前最后活动" : "最近活动"}：
                      {latest.title}
                      {latest.kind === "tool" && latest.text
                        ? ` · ${latest.text}`
                        : ""}
                    </p>
                  )}
                </section>
              )}
              {w.blocker && (
                <div className="error banner">
                  <b>任务已暂停，需要处理</b>
                  <p>
                    {w.blocker.code === "INTERNAL_FAILURE" &&
                    /JSON/.test(w.blocker.message)
                      ? "执行过程记录处理失败，任务已安全暂停。更新后的服务可通过“继续这个任务”恢复。"
                      : w.blocker.message}
                  </p>
                  <details>
                    <summary>错误详情</summary>
                    <pre>
                      {w.blocker.code}：{w.blocker.message}
                    </pre>
                  </details>
                </div>
              )}
              <div className="tabs">
                {[
                  ["overview", "概览"],
                  ["plan", "开发计划"],
                  ["tasks", "任务进度"],
                  ["tests", "测试结果"],
                  ["logs", "执行过程"],
                  ["diff", "代码变更"],
                  ["review", "代码复核"],
                  ["environment", "测试环境"],
                ].map(([key, title]) => (
                  <button
                    key={key}
                    className={tab === key ? "active" : ""}
                    onClick={() => {
                      setTab(key!);
                      if (key === "diff")
                        void attempt(async () =>
                          setDiff(await api(`/workflows/${selected}/diff`)),
                        );
                    }}
                  >
                    {title}
                  </button>
                ))}
              </div>
              {tab === "overview" && (
                <div className="two-column">
                  <section className="panel">
                    <h2>这次要解决什么</h2>
                    <p className="request">{w.title}</p>
                    <details>
                      <summary>完整需求</summary>
                      <p className="request">{w.request}</p>
                    </details>
                  </section>
                  <section className="panel">
                    <h2>进度概况</h2>
                    <div className="metric-row">
                      <span>已完成任务</span>
                      <b>
                        {detail.plan?.plan.task_model === "leaf-v1"
                          ? `${detail.tasks.filter((t: any) => t.completed).length} / ${detail.tasks.length}`
                          : "尚未建立细项清单"}
                      </b>
                    </div>
                    <div className="metric-row">
                      <span>已通过测试</span>
                      <b>
                        {detail.test_progress?.passed ?? 0} /{" "}
                        {detail.test_progress?.total ?? 0}
                      </b>
                    </div>
                    <h3>最近进展</h3>
                    {timeline
                      .filter(
                        (e) => e.kind !== "diagnostic" && e.kind !== "tool",
                      )
                      .slice(-5)
                      .reverse()
                      .map((e) => (
                        <div className="timeline" key={e.key}>
                          <small>
                            {new Date(e.created_at).toLocaleTimeString()}
                          </small>
                          <span>
                            {e.title}
                            {e.text ? ` · ${e.text.slice(0, 100)}` : ""}
                          </span>
                        </div>
                      ))}
                    <details>
                      <summary>执行历史与技术详情</summary>
                      <p>任务编号：{w.id}</p>
                      {detail.runs.map((r: any) => (
                        <p key={r.id}>
                          {new Date(r.started_at).toLocaleString()} ·{" "}
                          {(
                            {
                              running: "执行中",
                              failed: "失败",
                              completed: "已结束",
                              stopped: "已停止",
                            } as Record<string, string>
                          )[r.status] ?? "已结束"}
                        </p>
                      ))}
                    </details>
                  </section>
                </div>
              )}
              {tab === "plan" && (
                <section className="panel">
                  <div className="section-title">
                    <h2>开发计划 · 第 {w.plan_revision} 版</h2>
                    {w.plan_revision > 0 && (
                      <a href={`/api/workflows/${selected}/documents/plan`}>
                        下载 Markdown
                      </a>
                    )}
                  </div>
                  {detail.plan ? (
                    <>
                      <Document text={detail.plan.plan.markdown} />
                      <details>
                        <summary>本计划使用的运行配置</summary>
                        <p>
                          工作目录：
                          {w.workspace_mode === "new_worktree"
                            ? "独立 worktree"
                            : "当前目录"}
                          ；测试数据：
                          {detail.project?.data.mode === "directory"
                            ? "按任务独立目录"
                            : "共享数据按资源排队"}
                        </p>
                        {detail.project?.repositories.map((r: any) => (
                          <p key={r.id}>
                            {r.id}：{detail.context?.roots?.[r.id] ?? r.path}
                          </p>
                        ))}
                        {detail.project?.commands.map((c: any) => (
                          <p key={c.id}>
                            {c.id}：
                            <code>{[c.executable, ...c.args].join(" ")}</code>
                          </p>
                        ))}
                      </details>
                    </>
                  ) : (
                    <div className="empty">
                      计划尚未提交。先由 GPT-6 完成调研和任务拆解。
                    </div>
                  )}
                </section>
              )}
              {tab === "tasks" && (
                <section className="panel">
                  <h2>任务进度</h2>
                  <TaskTree detail={detail} />
                </section>
              )}
              {tab === "tests" && (
                <section className="panel">
                  <h2>测试结果</h2>
                  <TestResults detail={detail} />
                </section>
              )}
              {tab === "logs" && (
                <section className="panel">
                  <div className="section-title">
                    <h2>执行过程</h2>
                    <span>{connected ? "● 已连接" : "○ 重连中"}</span>
                    <button onClick={() => setFollowLogs(!followLogs)}>
                      {followLogs ? "暂停滚动" : "跟随最新日志"}
                    </button>
                  </div>

                  <div className="logs" ref={logsRef}>
                    {timeline.map((e) => (
                      <article
                        className={`activity ${e.kind ?? "event"}`}
                        key={e.key}
                      >
                        <div className="activity-heading">
                          <b>{e.title}</b>
                          <span className={`activity-status ${e.status ?? ""}`}>
                            {
                              (
                                {
                                  active: "进行中",
                                  done: "已完成",
                                  error: "失败",
                                  interrupted: "已中断",
                                } as Record<string, string>
                              )[e.status ?? ""]
                            }
                          </span>
                          <time>
                            {new Date(e.created_at).toLocaleTimeString()}
                          </time>
                        </div>
                        {e.kind === "message" ? (
                          <Markdown remarkPlugins={[remarkGfm]}>
                            {e.text}
                          </Markdown>
                        ) : (
                          e.kind !== "diagnostic" &&
                          e.text && (
                            <p className="activity-summary">
                              {e.text.slice(0, 600)}
                              {e.text.length > 600 ? "…" : ""}
                            </p>
                          )
                        )}
                        <details>
                          <summary>查看操作详情</summary>
                          <pre>
                            {e.kind === "diagnostic"
                              ? e.text
                              : JSON.stringify(e.raw, null, 2)}
                          </pre>
                        </details>
                      </article>
                    ))}
                    {!timeline.length && (
                      <p className="empty">
                        等待执行过程。计划批准后会在这里显示实时活动。
                      </p>
                    )}
                  </div>
                </section>
              )}
              {tab === "diff" && (
                <section className="panel">
                  <div className="section-title">
                    <h2>代码变更</h2>
                    <button
                      onClick={() =>
                        void attempt(async () =>
                          setDiff(await api(`/workflows/${selected}/diff`)),
                        )
                      }
                    >
                      刷新文件列表
                    </button>
                  </div>
                  {diff.map((d) => (
                    <div key={d.repo_id}>
                      <h3>{d.branch}</h3>
                      <p>
                        对比任务开始前提交{" "}
                        <code>{d.baseline?.slice(0, 8)}</code>
                        {d.frozen ? " · 测试版本" : " · 当前工作区"}
                      </p>
                      <div className="changed-files">
                        {d.files?.map((f: any) => (
                          <button
                            key={f.path}
                            onClick={() =>
                              void attempt(async () => {
                                const loading = {
                                  path: f.path,
                                  branch: d.branch,
                                  baseline: d.baseline,
                                  loading: true,
                                };
                                setFileDiff(loading);
                                try {
                                  const result = await api(
                                    `/workflows/${selected}/diff?repo_id=${encodeURIComponent(d.repo_id)}&path=${encodeURIComponent(f.path)}`,
                                  );
                                  setFileDiff((current: any) =>
                                    current === loading ? result : current,
                                  );
                                } catch (error) {
                                  setFileDiff((current: any) =>
                                    current === loading ? null : current,
                                  );
                                  throw error;
                                }
                              })
                            }
                          >
                            <span className="badge">
                              {(
                                {
                                  A: "新增",
                                  D: "删除",
                                  M: "修改",
                                  T: "类型变化",
                                } as Record<string, string>
                              )[f.status] ?? "修改"}
                            </span>
                            <span>{f.path}</span>
                            <span>查看差异 →</span>
                          </button>
                        ))}
                      </div>
                      {!d.files?.length && <p>没有文件变更</p>}
                    </div>
                  ))}
                  {!diff.length && (
                    <p className="empty">
                      {pending ? "正在读取变更文件…" : "尚无变更文件"}
                    </p>
                  )}
                </section>
              )}
              {tab === "review" && (
                <section className="panel">
                  <h2>独立复核结果</h2>
                  {detail.review ? (
                    <>
                      <p>
                        {detail.review.stale
                          ? "历史复核已失效，请以新一轮结果为准。"
                          : "本轮复核"}{" "}
                        · 第 {detail.review.plan_revision} 版计划 ·{" "}
                        {
                          (
                            {
                              pass: "通过",
                              findings: "发现问题",
                              incomplete: "验证不完整",
                            } as Record<string, string>
                          )[detail.review.verdict]
                        }
                      </p>
                      <details>
                        <summary>技术详情</summary>
                        <p className="mono">
                          快照：{detail.review.snapshot_id}
                        </p>
                      </details>
                      {detail.review.findings.map((f: any, index: number) => (
                        <article key={index} className="panel">
                          <h3>
                            {f.id} · {f.severity}
                          </h3>
                          <p>
                            {f.repo_id} / {f.path}:{f.line}
                          </p>
                          <p>触发条件：{f.trigger}</p>
                          <p>证据：{f.evidence}</p>
                          <p>影响：{f.consequence}</p>
                          <p>处置理由：{f.reason}</p>
                        </article>
                      ))}
                      {detail.review.unresolved_questions.length > 0 && (
                        <>
                          <h3>复核缺口</h3>
                          <ul>
                            {detail.review.unresolved_questions.map(
                              (q: string, i: number) => (
                                <li key={i}>{q}</li>
                              ),
                            )}
                          </ul>
                        </>
                      )}
                      <h3>覆盖文件</h3>
                      <ul>
                        {detail.review.coverage.files.map((p: string) => (
                          <li key={p}>{p}</li>
                        ))}
                      </ul>
                      {detail.review.repair_plan && (
                        <p>
                          修复计划已列入「计划与图解」，需要重新批准后才能执行。
                        </p>
                      )}
                    </>
                  ) : (
                    <div className="empty">
                      尚无独立复核结果。人工验收通过后会自动启动 GPT-6。
                    </div>
                  )}
                </section>
              )}
              {tab === "environment" && (
                <section className="panel">
                  <div className="section-title">
                    <h2>测试环境</h2>
                    {detail.environment && (
                      <button
                        onClick={() =>
                          void attempt(async () => {
                            await api(
                              `/workflows/${selected}/environment/stop`,
                              {},
                            );
                            await refresh();
                          })
                        }
                      >
                        释放环境
                      </button>
                    )}
                  </div>
                  {detail.environment ? (
                    <>
                      <p>
                        状态：{detail.environment.status} · 环境版本{" "}
                        {detail.environment.revision}
                      </p>
                      {detail.environment.services.map((s: any) => (
                        <div className="metric-row" key={s.id}>
                          <span>{s.id}</span>
                          <a href={s.origin} target="_blank" rel="noreferrer">
                            打开 {s.origin} ↗
                          </a>
                        </div>
                      ))}
                      {w.state === "HUMAN_PENDING" && (
                        <div className="actions">
                          <button
                            onClick={() =>
                              void attempt(async () => {
                                await api(
                                  `/workflows/${selected}/browser/lock`,
                                  {},
                                );
                                setNotice(
                                  "已保留共享浏览器，完成场景后请释放。",
                                );
                              })
                            }
                          >
                            开始浏览器验收
                          </button>
                          <button
                            onClick={() =>
                              void attempt(async () => {
                                await api(
                                  `/workflows/${selected}/browser/release`,
                                  {},
                                );
                                setNotice("浏览器已释放。");
                              })
                            }
                          >
                            结束浏览器验收
                          </button>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="empty">
                      代码实施完成后会自动准备本任务的端口和数据环境，供测试与实操验收。
                    </div>
                  )}
                </section>
              )}
            </>
          )
        )}
      </main>
      {fileDiff && (
        <div className="modal-backdrop" onClick={() => setFileDiff(null)}>
          <section
            className="modal file-diff-modal"
            role="dialog"
            aria-modal="true"
            aria-label="文件差异"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="section-title">
              <h2>{fileDiff.path}</h2>
              <button autoFocus onClick={() => setFileDiff(null)}>
                关闭差异
              </button>
            </div>
            <p>
              {fileDiff.branch} · 对比 {fileDiff.baseline?.slice(0, 8)}
            </p>
            {fileDiff.loading ? (
              <p role="status">正在读取文件差异…</p>
            ) : (
              <pre className="file-diff">
                {fileDiff.diff.split("\n").map((line: string, i: number) => (
                  <span
                    className={
                      line.startsWith("+")
                        ? "added"
                        : line.startsWith("-")
                          ? "removed"
                          : ""
                    }
                    key={i}
                  >
                    {line || " "}
                  </span>
                ))}
              </pre>
            )}
            {fileDiff.truncated && (
              <p>文件过大，显示部分差异；完整内容请在本地编辑器查看。</p>
            )}
          </section>
        </div>
      )}
      {modal && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
          >
            <div className="section-title">
              <h2 id="modal-title">反馈问题</h2>
              <button onClick={() => setModal("")}>关闭</button>
            </div>
            <>
              <p>说明实际操作、观察到的问题和期望结果。</p>
              <label>
                这次反馈属于
                <select
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                >
                  <option value="within_plan">原需求尚未做好</option>
                  <option value="new_scope">我想增加或改变需求</option>
                </select>
              </label>
              <textarea
                aria-label="问题反馈"
                rows={8}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              <button
                className="primary"
                disabled={pending || !text.trim()}
                onClick={() =>
                  void attempt(async () => {
                    await api(`/workflows/${selected}/feedback`, {
                      text,
                      scope,
                    });
                    setModal("");
                    await refresh();
                  })
                }
              >
                保存并继续
              </button>
            </>

            {error && <div className="error">{error}</div>}
          </section>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
