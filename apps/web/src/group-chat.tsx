import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { scoreTotal, tools, type Action, type Artifact, type Group, type Message, type Model, type Round, type Session } from "../../../packages/group-chat/src/contracts.js";
import type { ModelCatalog } from "../../../packages/contracts/src/model-catalog.js";
import { formatModelName } from "../../../packages/presentation/src/model-display.js";
import "./group-chat.css";

type View = { session: Session; round?: Round; messages: (Message & { seq: number })[]; artifacts: Artifact[]; next?: number };
type Page = { items: Session[]; next?: string };
type Document = Artifact & { body: string };
const toolNames = { codex: "Codex", agy: "Antigravity CLI", "claude-code": "Claude Code", opencode: "OpenCode" };
const sceneNames = { open: "开放讨论", fiction: "小说选题与大纲", design: "方案设计" };
const stageNames = {
  reply: "成员回复", summary: "管理员整理", ideas: "独立选题", idea_vote: "点子投票",
  questions: "提出关键问题", question_vote: "问题投票", outline: "整理大纲",
  plans: "独立出方案", reviews: "方案互评", final: "整理成稿",
};
const label = (artifact: Artifact) => artifact.author + " · " + artifact.title;
function modelName(member: Pick<Model, "tool" | "model" | "effort">, catalogLabel?: string) {
  const id = member.model.split("/").at(-1) ?? member.model;
  const catalogName = catalogLabel?.trim();
  const name = catalogName && catalogName !== member.model && catalogName !== id ? catalogName : formatModelName(member.tool, id);
  const effort = member.effort ?? (member.tool === "agy" ? id.match(/-(low|medium|high|max)$/i)?.[1] : undefined);
  return effort && !name.toLowerCase().endsWith(effort.toLowerCase()) ? name + " " + effort : name;
}
const messageTime = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false });
const sessionUrl = (id: string) => "/api/group-sessions/" + id;

async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(path, { method, ...(body === undefined ? {} : {
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }) });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message ?? `请求失败（${response.status}）`);
  }
  return response.json();
}

function Menu({ label, children }: { label: string; children: ReactNode }) {
  return <details className="gc-menu" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
  }} onKeyDown={event => {
    if (event.key === "Escape") {
      event.currentTarget.open = false;
      event.currentTarget.querySelector("summary")?.focus();
    }
  }}>
    <summary aria-label={label} title={label}>···</summary>
    <div className="gc-menu-panel" onClick={event => {
      if ((event.target as HTMLElement).closest("button")) event.currentTarget.closest("details")!.open = false;
    }}>{children}</div>
  </details>;
}

function Modal({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} aria-label={title} className="gc-modal" onCancel={close}>
    <div className="gc-modal-heading"><h2>{title}</h2><button type="button" onClick={close} aria-label="关闭">×</button></div>
    {children}
  </dialog>;
}

function GroupForm({ save, close, group }: { save: (data: unknown) => Promise<void>; close: () => void; group?: Group }) {
  const [members, setMembers] = useState<Omit<Model, "id">[]>(group?.members.map(({ id: _id, ...member }) => member) ?? [{ nickname: "", tool: "codex", model: "" }]);
  const [catalogs, setCatalogs] = useState<Partial<Record<Model["tool"], ModelCatalog>>>({});
  const [admin, setAdmin] = useState(group?.members.findIndex(member => member.id === group.admin) ?? 0);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [refreshing, setRefreshing] = useState<Model["tool"]>();
  async function load(tool: Model["tool"]) {
    const data = await api<ModelCatalog>("/api/model-tools/" + tool + "/models");
    setCatalogs(value => ({ ...value, [tool]: data }));
    return data;
  }
  useEffect(() => { for (const tool of tools) void load(tool).catch(() => {}); }, []);
  function patch(index: number, value: Partial<Omit<Model, "id">>) {
    setMembers(rows => rows.map((row, i) => i === index ? { ...row, ...value } : row));
  }
  async function refresh(tool: Model["tool"]) {
    setRefreshing(tool);
    setError("");
    try {
      const operation = await api<{ id: string }>("/api/model-tools/" + tool + "/models/refresh", "POST", { request_id: crypto.randomUUID() });
      for (let attempt = 0; attempt < 45; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 700));
        const status = await api<{ status: string; error_message?: string }>("/api/model-operations/" + operation.id);
        if (status.status === "failed") throw new Error(status.error_message ?? "模型目录刷新失败");
        if (["committed", "partial", "completed", "succeeded"].includes(status.status)) { await load(tool); return; }
      }
      await load(tool);
    } catch (error) { setError(String(error instanceof Error ? error.message : error)); }
    finally { setRefreshing(undefined); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    setError("");
    const normalize = (name: string) => name.trim().normalize("NFKC").toLowerCase();
    const taken = new Set(["全部", "全部模型", normalize(String(data.get("human"))), ...members.map(member => normalize(member.nickname))]);
    const namedMembers = members.map(member => {
      if (member.nickname.trim()) return member;
      const base = modelName(member, catalogs[member.tool]?.entries.find(entry => entry.nativeId === member.model)?.label);
      let nickname = base.slice(0, 32).trimEnd();
      for (let count = 2; taken.has(normalize(nickname)); count++) {
        const suffix = " " + count;
        nickname = base.slice(0, 32 - suffix.length).trimEnd() + suffix;
      }
      taken.add(normalize(nickname));
      return { ...member, nickname };
    });
    try { await save({ title: data.get("title"), human: data.get("human"), members: namedMembers, admin, version: group?.version }); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setPending(false); }
  }
  return <Modal title={group ? "编辑群配置" : "新建群聊"} close={close}>
    <form onSubmit={submit} className="gc-form">
      <label>群名称<input name="title" required maxLength={100} defaultValue={group?.title} autoFocus /></label>
      <label>我的昵称<input name="human" required maxLength={32} defaultValue={group?.human ?? "我"} /></label>
      {members.map((member, index) => {
        const models = catalogs[member.tool]?.entries.filter(entry => !entry.hidden && entry.selectionKind === "fixed" && entry.availability !== "unavailable") ?? [];
        const model = models.find(entry => entry.nativeId === member.model);
        return <fieldset key={index} className="gc-member-form">
          <legend>模型成员 {index + 1}</legend>
          <label>昵称<input aria-label={`成员 ${index + 1} 昵称`} maxLength={32} value={member.nickname}
            placeholder={modelName(member, model?.label) || "留空使用模型名"} onInput={event => patch(index, { nickname: event.currentTarget.value })} /></label>
          <label>工具<select value={member.tool} onChange={e => patch(index, { tool: e.target.value as Model["tool"], model: "", effort: undefined })}>
            {tools.map(tool => <option value={tool} key={tool}>{toolNames[tool]}</option>)}
          </select></label>
          <label>模型<select required value={member.model} onChange={e => patch(index, { model: e.target.value, effort: undefined })}>
            <option value="">选择具体模型</option>{models.map(item => <option key={item.entryId} value={item.nativeId}>{item.label}</option>)}
          </select></label>
          <label>推理强度<select value={member.effort ?? ""} onChange={e => patch(index, { effort: e.target.value || undefined })}>
            <option value="">模型默认</option>{model?.effort.values.map(value => <option key={value}>{value}</option>)}
          </select></label>
          <div className="gc-actions">
            <label><input type="radio" name="admin" checked={admin === index} onChange={() => setAdmin(index)} /> 管理员</label>
            <button type="button" disabled={!!refreshing} onClick={() => void refresh(member.tool)}>{refreshing === member.tool ? "刷新中" : "刷新模型目录"}</button>
            {members.length > 1 && <button type="button" onClick={() => {
              setMembers(rows => rows.filter((_, i) => i !== index));
              setAdmin(value => value === index ? 0 : value > index ? value - 1 : value);
            }}>移除此成员</button>}
          </div>
        </fieldset>;
      })}
      {error && <p role="alert">{error}</p>}
      <div className="gc-actions">
        <button type="button" disabled={members.length >= 16} onClick={() => setMembers(rows => [...rows, { nickname: "", tool: "codex", model: "" }])}>添加模型成员</button>
        <button className="gc-primary" disabled={pending}>{group ? "保存群配置" : "创建群聊"}</button>
      </div>
    </form>
  </Modal>;
}

function RosterEditor({ row, save, admin, close, error }: { row: Group | Session; save: (id: string, name: string) => void; admin: (id: string) => void; close: () => void; error?: ReactNode }) {
  return <Modal title={"scene" in row ? "会话成员" : "群成员"} close={close}>
    {error}
    <div className="gc-form">
      {[{ id: "human", nickname: row.human, description: "群主" }, ...row.members.map(member => ({
        ...member, description: toolNames[member.tool] + " · " + modelName(member),
      }))].map(member => <form className="gc-roster-row" key={member.id + member.nickname} onSubmit={event => {
        event.preventDefault();
        const name = String(new FormData(event.currentTarget).get("nickname"));
        save(member.id, name);
      }}>
        <small>{member.description}</small>
        <label>昵称<input name="nickname" required maxLength={32} defaultValue={member.nickname} aria-label={member.nickname + "的昵称"} /></label>
        <div className="gc-actions"><button>保存昵称</button>
          {member.id !== "human" && (row.admin === member.id ? <span className="gc-tag">管理员</span> :
            <button type="button" onClick={() => admin(member.id)}>设为管理员</button>)}
        </div>
      </form>)}
    </div>
  </Modal>;
}

function Results({ view, preview, act }: { view: View; preview: (id: string) => void; act: (input: Action) => void }) {
  const { round, session, artifacts } = view;
  const [answer, setAnswer] = useState("");
  const [custom, setCustom] = useState("");
  const answerForm = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (session.chosenQuestion) answerForm.current?.scrollIntoView({ block: "nearest" });
  }, [session.chosenQuestion]);
  if (!round || round.status !== "waiting") return null;
  const docs = round.candidates.map(id => artifacts.find(item => item.id === id)).filter((item): item is Artifact => !!item);
  const reviewers = round.jobs.flatMap(job => artifacts.filter(item => item.id === job.artifact));
  const accepted = round.jobs.filter(job => job.state === "done").length;
  const question = artifacts.find(item => item.id === session.chosenQuestion);
  const voting = round.stage === "idea_vote" || round.stage === "question_vote";
  const valid = reviewers.filter(item => item.ballot?.choice).length;
  const byVotes = docs.map(doc => ({ doc, votes: reviewers.filter(item => item.ballot?.choice === doc.id) }))
    .sort((a, b) => b.votes.length - a.votes.length);
  const nameOf = (doc: Artifact) => {
    const member = session.members.find(item => item.id === doc.member);
    if (!member) return doc.author;
    const identity = modelName(member);
    return identity && identity !== member.nickname ? member.nickname + " · " + identity : member.nickname;
  };
  return <section className={voting ? "gc-results gc-poll" : "gc-results"}>
    <h3>{voting ? "投票结果" : round.stage === "reviews" ? "评分与简报" : "本轮成果"}</h3>
    {round.stage === "reviews" && <small>已收 {accepted}/{round.jobs.length} · 缺席 {round.jobs.length - accepted}</small>}
    {voting && <>
      <div className="gc-poll-summary">
        <span><strong>{valid}</strong> 有效票</span><span><strong>{accepted - valid}</strong> 弃权</span>
        <span><strong>{round.jobs.length - accepted}</strong> 未投</span>
        <small>票数供参考，由你决定下一步。</small>
      </div>
      {byVotes.map(({ doc, votes }) => {
        const selected = question?.id === doc.id;
        const share = valid ? Math.round(votes.length * 100 / valid) : 0;
        return <article className={selected ? "gc-vote-row gc-vote-selected" : "gc-vote-row"} key={doc.id}>
          <div className="gc-vote-heading">
            <div><button className="gc-text-button gc-vote-title" onClick={() => preview(doc.id)}>{doc.title}</button>
              <small>提案 · {nameOf(doc)}</small></div>
            <div className="gc-vote-tally"><strong>{votes.length} 票</strong>{valid > 0 && <small>有效票的 {share}%</small>}</div>
          </div>
          {valid > 0 && <div className="gc-vote-track" aria-hidden="true"><span style={{ width: share + "%" }} /></div>}
          <div className="gc-vote-footer">
            <div className="gc-vote-voters" aria-label="投给此候选的成员">
              {votes.length ? votes.map(voter => <button key={voter.id} className="gc-vote-voter" onClick={() => preview(voter.id)}
                aria-label={`查看${nameOf(voter)}的选票`}>{nameOf(voter)}{voter.member === doc.member && <small>自投</small>}</button>)
                : <small>暂无成员投票</small>}
            </div>
            <button className="gc-vote-choice" disabled={selected}
              onClick={() => {
                setAnswer("");
                act(round.stage === "idea_vote" ? { action: "premise", artifact: doc.id } : { action: "question", artifact: doc.id });
              }}>
              {selected ? "当前问题" : round.stage === "idea_vote" ? "采用这个点子" : "回答这个问题"}
            </button>
          </div>
        </article>;
      })}
      {!!reviewers.length && <details className="gc-vote-details"><summary>查看全部选票与理由</summary>
        <div className="gc-actions">{reviewers.map(item => <button key={item.id} onClick={() => preview(item.id)}>
          {nameOf(item)}{item.ballot?.choice === null ? " · 弃权" : ""}
        </button>)}</div>
      </details>}
    </>}
    {round.stage === "idea_vote" && <form className="gc-actions" onSubmit={event => {
      event.preventDefault(); if (custom.trim()) act({ action: "premise", text: custom });
    }}>
      <input aria-label="自拟故事前提" placeholder="自拟或组合故事前提" value={custom} onInput={event => setCustom(event.currentTarget.value)} />
      <button disabled={!custom.trim()}>采用自拟点子</button>
    </form>}
    {question && round.stage === "question_vote" && <form ref={answerForm} className="gc-form gc-vote-answer" onSubmit={event => {
      event.preventDefault(); if (answer.trim()) { act({ action: "answer", text: answer }); setAnswer(""); }
    }}>
      <h4>{question.title}</h4>
      <div className="gc-actions">{question.options?.map(option => <button type="button" key={option} onClick={() => setAnswer(option)}>{option}</button>)}</div>
      <textarea aria-label="我的回答" value={answer} onInput={event => setAnswer(event.currentTarget.value)} placeholder="可选、组合或填写自己的答案" />
      <button className="gc-primary" disabled={!answer.trim()}>提交回答</button>
    </form>}
    {round.stage === "reviews" && <>
      <small>满分 100 · 点击评审者姓名查看简报</small>
      {docs.map(doc => {
        const scores = round.jobs.map(job => {
          const review = reviewers.find(item => item.id === job.artifact);
          const score = review?.scores?.find(item => item.id === doc.id);
          return {
            member: job.member, review, self: job.member === doc.member,
            name: review?.author ?? session.members.find(item => item.id === job.member)?.nickname,
            value: score ? scoreTotal(score) : undefined,
          };
        });
        const peer = scores.flatMap(score => !score.self && score.value !== undefined ? [score.value] : []);
        const average = peer.length ? (peer.reduce((sum, value) => sum + value, 0) / peer.length).toFixed(1) : "—";
        return <article className="gc-score-card" key={doc.id}>
          <header>
            <button className="gc-text-button" onClick={() => preview(doc.id)}>{label(doc)}</button>
            <small>同伴均分 <strong>{average}</strong></small>
          </header>
          <ul aria-label={doc.author + "的方案评分"}>
            {scores.map(({ member, review, self, name, value }) => <li key={member}>
              <div className="gc-score-reviewer">
                {review ? <button className="gc-text-button" aria-label={`查看${name}的简报`} onClick={() => preview(review.id)}>{name}</button> : <small>{name}</small>}
                {self && <small className="gc-score-self">自评</small>}
              </div>
              {value === undefined ? <small>未评分</small> : <strong className="gc-score-value">{value.toFixed(1)}</strong>}
            </li>)}
          </ul>
        </article>;
      })}
    </>}
  </section>;
}

export function GroupChatPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupId, setGroupId] = useState("");
  const [sessions, setSessions] = useState<Page>({ items: [] });
  const [query, setQuery] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [view, setView] = useState<View>();
  const [older, setOlder] = useState<View>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [modal, setModal] = useState<"group" | "edit-group" | "session" | "roster" | "group-roster" | "delete" | "final" | "outline" | "restart">();
  const [workspace, setWorkspace] = useState("");
  const [documents, setDocuments] = useState<Document[]>([]);
  const [compare, setCompare] = useState(false);
  const [reading, setReading] = useState(0);
  const [showNavigation, setShowNavigation] = useState(false);
  const [message, setMessage] = useState("");
  const thread = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [mode, setMode] = useState<"scene" | "reply" | "record" | "execute">("scene");
  const [targets, setTargets] = useState<string[]>([]);
  const [all, setAll] = useState(false);
  const [mentions, setMentions] = useState(false);
  const [memberQuery, setMemberQuery] = useState("");
  const composer = useRef<HTMLTextAreaElement>(null);
  const [pending, setPending] = useState(false);
  const [author, setAuthor] = useState("");
  const [base, setBase] = useState("");
  const [removal, setRemoval] = useState(false);
  const group = groups.find(item => item.id === groupId);
  const session = view?.session;
  const round = view?.round;
  const canChange = !session?.archived && !session?.deleting;
  const busy = round?.status === "running" || round?.status === "paused";
  const report = (error: unknown) => setError(error instanceof Error ? error.message : String(error));

  useEffect(() => {
    let live = true;
    void api<Group[]>("/api/groups").then(rows => {
      if (!live) return;
      setGroups(rows);
      setGroupId(rows[0]?.id ?? "");
    }).catch(report);
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!groupId) return;
    let live = true;
    const timer = setTimeout(() => void api<Page>(`/api/groups/${groupId}/sessions?query=${encodeURIComponent(query)}`)
      .then(page => { if (live) setSessions(page); }).catch(error => { if (live) report(error); }), 150);
    return () => { live = false; clearTimeout(timer); };
  }, [groupId, query]);
  useEffect(() => {
    follow.current = true;
    setView(undefined);
    setOlder(undefined);
    setDocuments([]);
    setCompare(false);
    setReading(0);
    setShowNavigation(false);
    setMessage("");
    setMode("scene");
    setTargets([]);
    setAll(false);
    setMentions(false);
    setMemberQuery("");
    if (!sessionId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const next = await api<View>(sessionUrl(sessionId));
        if (live) setView(prior => prior?.session.id === sessionId && prior.session.version >= next.session.version ? prior : next);
      } catch (error) { if (live) report(error); }
      if (live) timer = setTimeout(() => void refresh(), 950);
    }
    void refresh();
    return () => { live = false; clearTimeout(timer); };
  }, [sessionId]);

  useEffect(() => {
    if (follow.current && thread.current) thread.current.scrollTop = thread.current.scrollHeight;
  }, [view, documents.length, compare]);

  async function perform(callback: () => Promise<void>) {
    setError("");
    setPending(true);
    try { await callback(); }
    catch (error) { report(error); }
    finally { setPending(false); }
  }
  async function act(input: Action) {
    if (!session || pending) return;
    await perform(async () => {
      const next = await api<View>(sessionUrl(session.id) + "/actions", "POST", { version: session.version, request: crypto.randomUUID(), input });
      setView(prior => prior?.session.id === session.id && prior.session.version <= next.session.version ? next : prior);
      if (input.action === "send") { setMessage(""); setAll(false); setTargets([]); setMentions(false); }
      setModal(undefined);
    });
  }
  async function preview(id: string) {
    if (!session) return;
    try {
      const doc = await api<Document>(sessionUrl(session.id) + "/artifacts/" + id);
      setDocuments(prior => compare && prior[0] ? (prior[0].id === doc.id ? prior : [prior[0], doc]) : [doc]);
      setReading(compare && documents[0] && documents[0].id !== doc.id ? 1 : 0);
    } catch (error) { report(error); }
  }
  async function loadOlder() {
    const before = older?.next ?? (older ? undefined : view?.next);
    if (!session || !before) return;
    await perform(async () => {
      const page = await api<View>(sessionUrl(session.id) + "?before=" + before);
      setOlder(prior => ({ ...page, messages: [...page.messages, ...(prior?.messages ?? [])], artifacts: [...page.artifacts, ...(prior?.artifacts ?? [])] }));
    });
  }
  function manageRoster(isSession: boolean, field: "nickname" | "admin", member: string, nickname?: string) {
    const row = isSession ? session : group;
    if (!row) return;
    void perform(async () => {
      const route = isSession ? sessionUrl(row.id) : "/api/groups/" + row.id;
      const updated = await api<Group | Session>(route + "/" + field, "PATCH", { version: row.version, member, nickname });
      if ("scene" in updated) setView(prior => prior ? { ...prior, session: updated } : prior);
      else setGroups(items => items.map(item => item.id === updated.id ? updated : item));
    });
  }
  function send(event: FormEvent) {
    event.preventDefault();
    if (!message.trim()) return;
    const typed = [...(session?.members ?? [])].sort((a, b) => b.nickname.length - a.nickname.length)
      .find(member => message.startsWith("@" + member.nickname + " ") || message.startsWith("@" + member.nickname + "\n"));
    const targeted = [...new Set([...targets, ...(typed ? [typed.id] : [])])];
    const broadcast = all || /^@全部(?:模型)?(?:\s|$)/u.test(message);
    if (mode !== "record" && session?.scene === "design" && round?.stage === "reviews" && round.status === "waiting" && targeted.length === 1 && !broadcast && /成稿|定稿/u.test(message)) {
      void act({ action: "final", member: targeted[0], text: message });
      return;
    }
    if (mode === "scene" && !broadcast && !targeted.length && session?.scene === "fiction") {
      if (round?.status === "waiting" && /^(?:都不行|都不要|全部重想|重新想)[，。！、：\s]*$/u.test(message.trim())) {
        void act({ action: "restart", text: "" }).then(() => setMessage(""));
        return;
      }
      if (session.chosenQuestion) {
        void act({ action: "answer", text: message.trim() }).then(() => setMessage(""));
        return;
      }
    }
    if (mode !== "record" && /^@[^@\s]/u.test(message) && !broadcast && !targeted.length) {
      setError("没有识别到该昵称，请从提及列表选择成员");
      return;
    }
    void act({ action: "send", text: message, targets: targeted, all: broadcast, mode });
  }
  const messages = [...new Map([...(older?.messages ?? []), ...(view?.messages ?? [])].map(item => [item.id, item])).values()];
  const artifacts = [...new Map([...(older?.artifacts ?? []), ...(view?.artifacts ?? [])].map(item => [item.id, item])).values()];
  const artifactsById = new Map(artifacts.map(item => [item.id, item]));
  const nextAction = session?.scene === "fiction" ? "整理大纲" : "指定成员成稿";
  const canDraft = !!session?.brief && (session.scene === "fiction" || session.scene === "design") && !busy;
  const canRestart = !!session?.brief && session.scene !== "open" && round?.status !== "running";
  const beginDraft = (artifact = "") => {
    if (!session) return;
    setAuthor(session.admin); setBase(artifact); setModal(session.scene === "fiction" ? "outline" : "final");
  };
  const errorMessage = error && <p className="gc-error" role="alert">{error}<button aria-label="关闭错误" onClick={() => setError("")}>×</button></p>;
  return <div className="gc-shell">
    <header className="gc-top">
      <a href="/" className="gc-back" aria-label="返回任务工作台">‹ <span>任务工作台</span></a>
      <h1>模型群聊</h1>
      <button className="gc-mobile-nav" aria-expanded={showNavigation} onClick={() => setShowNavigation(value => !value)}>会话列表</button>
    </header>
    {!modal && errorMessage}
    {notice && <div role="status" className="gc-notice"><span>{notice}</span><button aria-label="关闭提示" onClick={() => setNotice("")}>×</button></div>}
    <div className={`gc-layout ${documents.length ? "gc-with-preview" : ""} ${compare ? "gc-reading-compare" : ""}`}>
      <aside className={`gc-sidebar ${showNavigation || !session ? "gc-nav-open" : ""}`} aria-label="群聊导航">
        <div className="gc-nav-heading"><h2>群聊</h2><button aria-label="新建群聊" title="新建群聊" onClick={() => setModal("group")}>＋</button></div>
        <div className="gc-nav-list">
          {groups.map(item => <button className={item.id === groupId ? "gc-selected" : ""} key={item.id}
            aria-current={item.id === groupId ? "true" : undefined} onClick={() => {
              if (groupId === item.id) return;
              setGroupId(item.id); setSessions({ items: [] }); setSessionId(""); setQuery("");
            }}><span className="gc-group-mark" aria-hidden="true">{item.title.slice(0, 1)}</span><span>{item.title}<small>{item.members.length} 个模型</small></span></button>)}
        </div>
        {group && <section className="gc-sessions">
          <div className="gc-nav-heading"><h2>会话</h2><div className="gc-actions">
            <button aria-label="新建会话" title="新建会话" onClick={() => setModal("session")}>＋</button>
            <Menu label="群设置"><button onClick={() => setModal("group-roster")}>群成员</button><button onClick={() => setModal("edit-group")}>编辑群配置</button></Menu>
          </div></div>
          <input aria-label="搜索会话" placeholder="搜索会话" value={query} onInput={event => setQuery(event.currentTarget.value)} />
          <div className="gc-nav-list">
            {sessions.items.map(item => <button key={item.id} className={item.id === sessionId ? "gc-selected" : ""}
              aria-current={item.id === sessionId ? "page" : undefined} onClick={() => { setSessionId(item.id); setShowNavigation(false); }}>
              <span>{item.title}<small>{sceneNames[item.id === session?.id ? session.scene : item.scene]}{(item.id === session?.id ? session.archived : item.archived) && " · 已归档"}</small></span>
            </button>)}
            {!sessions.items.length && <small>{query ? "没有匹配的会话" : "暂无会话"}</small>}
          </div>
          {sessions.next && <button onClick={() => void perform(async () => {
            const page = await api<Page>(`/api/groups/${groupId}/sessions?before=${sessions.next}&query=${encodeURIComponent(query)}`);
            setSessions(prior => ({ ...page, items: [...prior.items, ...page.items] }));
          })}>更多会话</button>}
        </section>}
      </aside>
      <main className="gc-chat">
        {!session ? <div className="gc-empty"><div className="gc-empty-mark" aria-hidden="true">◫</div><h2>{sessionId ? "正在加载会话" : group ? "选择或新建会话" : "开始一次模型协作"}</h2><p>和模型讨论问题、构思小说，或比较不同方案。</p>
          {!sessionId && <button className="gc-primary" onClick={() => setModal(group ? "session" : "group")}>{group ? "创建第一个会话" : "创建第一个群聊"}</button>}
        </div> : <>
          <div className="gc-chat-header">
            <div className="gc-session-heading"><small>{group?.title ?? "模型群聊"}</small><h2>{session.title}</h2>
              <label className="gc-scene"><span className="gc-sr">场景</span><select disabled={pending || round?.status === "running" || !canChange} value={session.scene}
                onChange={e => void act({ action: "scene", scene: e.target.value as Session["scene"] })}>
                {Object.entries(sceneNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select></label>{session.archived && <small>已归档</small>}
            </div>
            <div className="gc-actions">
              <button className="gc-members" aria-label="会话成员" title="会话成员" onClick={() => setModal("roster")}>
                <span aria-hidden="true" className="gc-avatar-stack">{session.members.slice(0, 3).map((member, index) => <span className={`gc-avatar gc-tone-${index}`} key={member.id}>{member.nickname.slice(0, 1)}</span>)}</span>
                <span>{session.members.length + 1} 人</span>
              </button>
              <Menu label="会话选项">
                <button disabled={busy || pending || !canChange} onClick={() => void act({ action: "summary" })}>请管理员整理</button>
                <button disabled={busy || pending || !canChange} onClick={() => void act({ action: "sync" })}>同步群成员</button>
                <button onClick={() => void perform(async () => {
                  const { path } = await api<{ path: string }>(sessionUrl(session.id) + "/workspace");
                  setNotice("本地目录 " + path);
                })}>本地目录</button>
                <button disabled={pending || busy || session.deleting} onClick={() => void act({ action: session.archived ? "restore" : "archive" })}>{session.archived ? "恢复会话" : "归档"}</button>
                <button className="gc-destructive-item" onClick={() => void perform(async () => {
                  setWorkspace((await api<{ path: string }>(sessionUrl(session.id) + "/workspace")).path);
                  setRemoval(false); setModal("delete");
                })}>{session.deletionError ? "重试删除" : "删除"}</button>
              </Menu>
            </div>
          </div>
          {session.deletionError && <p role="alert">删除未完成。{session.deletionError}</p>}
          <div className="gc-thread" ref={thread} onScroll={event => {
            const box = event.currentTarget;
            follow.current = box.scrollHeight - box.scrollTop - box.clientHeight < 72;
          }}>
            {(older ? older.next : view?.next) && <button onClick={() => void loadOlder()}>加载更早消息</button>}
            {!messages.length && <div className="gc-thread-start"><h3>{sceneNames[session.scene]}</h3><p>{session.scene === "fiction" ? "写下故事素材或想探索的方向，成员会分别提出点子。" : session.scene === "design" ? "写下目标和约束，成员会独立出稿并相互评审。" : "输入消息开始讨论，或用 @ 选择本次回应的成员。"}</p></div>}
            {messages.map(item => {
              const artifact = item.artifact ? artifactsById.get(item.artifact) : undefined;
              const reply = artifact?.stage === "reply";
              const member = artifact?.author === item.author ? session.members.find(model => model.id === artifact.member) : undefined;
              const identity = member ? modelName(member) : "";
              return <article className={`gc-message ${item.author === session.human ? "gc-message-own" : ""}`} key={item.id}>
                <div className="gc-avatar" aria-hidden="true">{item.author.slice(0, 1)}</div>
                <div className="gc-message-content"><header>{item.author}{identity && identity !== item.author && <small>{identity}</small>}<small title={item.created}>{messageTime.format(new Date(item.created))}</small></header>
                  {!item.artifact && <p>{item.text}</p>}
                  {reply && <div className="gc-message-bubble"><Markdown remarkPlugins={[remarkGfm]} skipHtml
                    components={{ img: ({ alt }) => <span>{alt}</span> }}>{item.text}</Markdown></div>}
                  {item.artifact && <button className={reply ? "gc-reply-source" : "gc-doc-card"} onClick={() => void preview(item.artifact!)}>
                    {reply ? "查看原文" : <><span className="gc-file-icon" aria-hidden="true">▤</span><span>{item.text.slice(0, 110)}<small>Markdown · 打开预览</small></span></>}
                  </button>}
                </div>
              </article>;
            })}
            {round && <section className="gc-status">
              <h3>{stageNames[round.stage]} <small>{round.status === "paused" ? "已暂停" : round.status === "running" ? "进行中" : round.status === "waiting" ? "待您决定" : "已完成"}</small></h3>
              <div className="gc-jobs">{round.jobs.map(job => <div key={job.member}>
                <span>{session.members.find(item => item.id === job.member)?.nickname} · {{ queued: "排队", running: "运行中", done: "完成", failed: "需处理", skipped: "已跳过" }[job.state]}</span>
                {job.error && <small>{job.error}</small>}
                {canChange && job.state === "failed" && <div className="gc-actions">
                  <button disabled={pending} onClick={() => void act({ action: "retry", member: job.member })}>重试</button>
                  <button disabled={pending} onClick={() => void act({ action: "skip", member: job.member })}>跳过</button>
                </div>}
              </div>)}</div>
              {canChange && round.status === "running" && <button disabled={pending} onClick={() => void act({ action: "pause" })}>暂停本轮</button>}
              {canChange && round.status === "paused" && <div className="gc-actions">
                <button disabled={pending} onClick={() => void act({ action: "resume" })}>继续排队任务</button>
                <button disabled={pending} onClick={() => void act({ action: "cancel" })}>结束本轮</button>
              </div>}
            </section>}
            {view && <Results key={round?.id} view={view} preview={id => void preview(id)} act={input => { if (canChange) void act(input); }} />}
            {canChange && (canDraft || canRestart) && <div className="gc-next">
              <span>{round?.status === "waiting" ? "本轮已结束，您可以决定下一步" : "当前会话"}</span>
              <div className="gc-actions">
                {canRestart && <button disabled={pending} onClick={() => setModal("restart")}>{session.scene === "fiction" ? (session.premise ? "换一批问题" : "全部重想") : "全部重做"}</button>}
                {canDraft && <button className="gc-primary" disabled={pending} onClick={() => beginDraft()}>{nextAction}</button>}
              </div>
            </div>}
            {round?.status === "waiting" && ["outline", "final"].includes(round.stage) && round.jobs.map(job => job.artifact && <button key={job.artifact}
              disabled={session.adopted === job.artifact || !canChange} onClick={() => void act({ action: "adopt", artifact: job.artifact! })}>
              {session.adopted === job.artifact ? "已采用" : "采用此稿"}</button>)}
          </div>
          {canChange && <form className="gc-composer" onSubmit={send}>
            {(all || targets.length > 0) && <div className="gc-chips" aria-label="当前提及">
              {all ? <button type="button" onClick={() => setAll(false)}>＠全部模型 <span aria-hidden="true">×</span></button> :
                session.members.filter(member => targets.includes(member.id)).map(member => <button type="button" key={member.id}
                  onClick={() => setTargets(ids => ids.filter(id => id !== member.id))}>＠{member.nickname} <span aria-hidden="true">×</span></button>)}
            </div>}
            {mentions && <div className="gc-mentions" aria-label="提及成员" onKeyDown={event => {
              if (event.key === "Escape") { setMentions(false); composer.current?.focus(); }
            }}>
              <label className="gc-sr" htmlFor="gc-member-search">搜索成员</label>
              <input id="gc-member-search" autoFocus placeholder="搜索成员" value={memberQuery} onInput={event => setMemberQuery(event.currentTarget.value)} />
              <div className="gc-mention-list">
                <label><input type="checkbox" checked={all} onChange={e => { setAll(e.target.checked); setTargets([]); }} /> 全部模型</label>
                {session.members.filter(member => (member.nickname + " " + modelName(member)).toLowerCase().includes(memberQuery.toLowerCase())).map(member => <label key={member.id}>
                  <input type="checkbox" checked={targets.includes(member.id)} disabled={all} onChange={e =>
                    setTargets(prior => e.target.checked ? [...prior, member.id] : prior.filter(item => item !== member.id))} />
                  <span>{member.nickname}<small>{toolNames[member.tool]}{modelName(member) !== member.nickname && " · " + modelName(member)}</small></span>
                </label>)}
              </div>
              <button type="button" onClick={() => { setMentions(false); composer.current?.focus(); }}>完成选择</button>
            </div>}
            <textarea ref={composer} aria-label="群消息" value={message} onInput={event => {
              const value = event.currentTarget.value;
              if (value === "@") { setMemberQuery(""); setMentions(true); } else setMessage(value);
            }} onKeyDown={event => {
              if (!event.nativeEvent.isComposing && event.key === "Enter" && (event.metaKey || event.ctrlKey) &&
                message.trim() && !pending && (!busy || mode === "record")) {
                event.preventDefault(); event.currentTarget.form?.requestSubmit();
              }
            }} maxLength={20_000}
              placeholder={session.scene === "open" ? "输入群消息，或 @ 指定成员" : "输入需求以开始新一轮，或 @ 成员单独讨论"} />
            <div className="gc-compose-bar">
              <button type="button" aria-expanded={mentions} onClick={() => { setMemberQuery(""); setMentions(value => !value); }}>@ 成员</button>
              <label><span className="gc-sr">发送方式</span><select value={mode} onChange={e => setMode(e.target.value as typeof mode)}>
                <option value="scene">按场景响应</option><option value="reply">仅回答</option><option value="record">仅记录</option>
                <option value="execute">隔离执行</option>
              </select></label>
              <small className="gc-send-summary">{mode === "record" ? "全员可见 · 无调用" : all || /^@全部/u.test(message) ? "全体模型响应" : targets.length ? session.members.filter(item => targets.includes(item.id)).map(item => item.nickname).join("、") + " 响应" :
                session.members.some(item => message.startsWith("@" + item.nickname + " ")) ? "提及成员响应" :
                session.scene === "open" || mode !== "scene" ? "管理员响应" : "全员按场景响应"}</small>
              <button className="gc-primary" disabled={!message.trim() || pending || (busy && mode !== "record")}>发送</button>
            </div>
          </form>}
        </>}
      </main>
      {session && documents.length > 0 && <aside className="gc-preview" aria-label="文档阅读区">
        <div className="gc-preview-header"><h2>文档预览</h2><div className="gc-actions">
          <button aria-pressed={compare} onClick={() => {
            setCompare(value => !value); setReading(0);
            if (compare) setDocuments(items => items.slice(0, 1));
          }}>{compare ? "退出比较" : "并排比较"}</button>
          <button className="gc-close" aria-label="关闭预览" onClick={() => { setDocuments([]); setCompare(false); }}>×</button>
        </div></div>
        {compare && <div className="gc-compare-controls">
          <label><span className="gc-sr">第二份文档</span><select value={documents[1]?.id ?? ""} onChange={event => { if (event.target.value) void preview(event.target.value); }}>
            <option value="">选择第二份文档</option>
            {artifacts.filter(item => item.id !== documents[0]?.id).map(item => <option key={item.id} value={item.id}>{label(item)}</option>)}
          </select></label>
          {documents.length > 1 && <div className="gc-document-switch" aria-label="切换比较文档">
            {documents.map((doc, index) => <button key={doc.id} aria-pressed={reading === index} onClick={() => setReading(index)}>{doc.author} · {index === 0 ? "第一份" : "第二份"}</button>)}
          </div>}
        </div>}
        <div className={documents.length > 1 ? "gc-documents gc-compare" : "gc-documents"}>
          {documents.map((doc, index) => <article className={reading === index ? "gc-document-current" : ""} key={doc.id}>
            <header className="gc-document-heading"><small>{doc.author}</small><h3>{doc.title}</h3>
              <div className="gc-actions"><a href={sessionUrl(session.id) + "/artifacts/" + doc.id + "?download=1"}>下载 .md</a>
                {canChange && !busy && ["plans", "outline", "final"].includes(doc.stage) && <button onClick={() => beginDraft(doc.id)}>交给成员修订</button>}
              </div>
            </header>
            <div className="gc-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: ({ alt }) => <span>{alt}</span> }}>{doc.body}</Markdown></div>
          </article>)}
        </div>
      </aside>}
    </div>
    {modal === "group" && <GroupForm close={() => setModal(undefined)} save={async data => {
      const created = await api<Group>("/api/groups", "POST", data);
      setGroups(rows => [...rows, created]); setGroupId(created.id); setSessionId(""); setQuery(""); setModal("session");
    }} />}
    {modal === "edit-group" && group && <GroupForm group={group} close={() => setModal(undefined)} save={async data => {
      const updated = await api<Group>("/api/groups/" + group.id, "PUT", data);
      setGroups(rows => rows.map(row => row.id === updated.id ? updated : row)); setModal(undefined);
    }} />}
    {modal === "session" && group && <Modal title="新建会话" close={() => setModal(undefined)}>
      <form className="gc-form" onSubmit={event => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        void perform(async () => {
          const created = await api<Session>(`/api/groups/${group.id}/sessions`, "POST", { title: data.get("title"), scene: data.get("scene") });
          setSessions(prior => ({ ...prior, items: [created, ...prior.items] })); setSessionId(created.id); setModal(undefined);
        });
      }}>
        <label>会话名称<input name="title" required maxLength={100} autoFocus /></label>
        <label>场景<select name="scene">{Object.entries(sceneNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
        {errorMessage}<button className="gc-primary" disabled={pending}>创建会话</button>
      </form>
    </Modal>}
    {(modal === "roster" || modal === "group-roster") && (modal === "roster" ? session : group) && <RosterEditor
      row={(modal === "roster" ? session : group)!} error={errorMessage} close={() => setModal(undefined)}
      save={(id, nickname) => manageRoster(modal === "roster", "nickname", id, nickname)}
      admin={id => manageRoster(modal === "roster", "admin", id)} />}
    {modal === "delete" && session && <Modal title="删除会话" close={() => setModal(undefined)}>
      <p>将删除「{session.title}」的会话记录。{busy && "正在运行的任务会先停止。"}</p><p className="gc-path">{workspace}</p>
      <label><input type="checkbox" checked={removal} onChange={e => setRemoval(e.target.checked)} /> 同时删除此会话的全部受管文件</label>
      <p><small>工具自身的原生会话记录由原工具管理。</small></p>
      {errorMessage}<button className="gc-danger" disabled={pending} onClick={() => void perform(async () => {
        const deleted = await api<{ retainedPath?: string }>(sessionUrl(session.id), "DELETE", { version: session.version, files: removal });
        setSessions(prior => ({ ...prior, items: prior.items.filter(item => item.id !== session.id) }));
        setSessionId(""); setModal(undefined); setNotice(deleted.retainedPath ? "文件已保留在 " + deleted.retainedPath : "会话与受管文件已删除");
      })}>确认删除</button>
    </Modal>}
    {modal === "restart" && <Modal title="重新开始本轮" close={() => setModal(undefined)}>
      <form className="gc-form" onSubmit={event => {
        event.preventDefault(); void act({ action: "restart", text: String(new FormData(event.currentTarget).get("reason") ?? "") });
      }}><label>本轮要避开的方向<textarea name="reason" maxLength={3000} /></label>{errorMessage}<button disabled={pending} className="gc-primary">重新生成</button></form>
    </Modal>}
    {(modal === "outline" || modal === "final") && session && <Modal title={modal === "outline" ? "整理大纲" : "指定成员成稿"} close={() => setModal(undefined)}>
      <form className="gc-form" onSubmit={event => {
        event.preventDefault(); void act({ action: modal, member: author, artifact: base || undefined, text: String(new FormData(event.currentTarget).get("instructions") ?? "") });
      }}>
        <label>成稿成员<select value={author} onChange={e => setAuthor(e.target.value)}>
          {session.members.map(item => <option key={item.id} value={item.id}>@{item.nickname}</option>)}
        </select></label>
        <label>基础稿<select value={base} onChange={e => setBase(e.target.value)}>
          <option value="">使用当前轮材料</option>{artifacts.filter(item => ["plans", "outline", "final"].includes(item.stage)).map(item => <option value={item.id} key={item.id}>{label(item)}</option>)}
        </select></label>
        <label>修订要求<textarea name="instructions" maxLength={4000} /></label>
        {errorMessage}<button className="gc-primary" disabled={pending}>发送给指定成员</button>
      </form>
    </Modal>}
  </div>;
}
