import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { scoreTotal, tools, type Action, type Artifact, type Group, type Message, type Model, type Round, type Session } from "../../../packages/group-chat/src/contracts.js";
import { formatModelName, type ModelChoice } from "../../../packages/presentation/src/model-display.js";
import { formatApiError, toolLabel } from "./components/model-api.js";
import { fetchToolModelsWithSWR } from "./components/group-model-catalog.js";
import "./group-chat.css";

type View = { session: Session; round?: Round; messages: (Message & { seq: number })[]; artifacts: Artifact[]; next?: number };
type Page = { items: Session[]; next?: string };
type Document = Artifact & { body: string };

const defaultMembers: Omit<Model, "id">[] = [
  { nickname: "", tool: "codex", model: "gpt-6-astra", effort: "max" },
  { nickname: "", tool: "codex", model: "gpt-6.1-sol", effort: "high" },
  { nickname: "", tool: "agy", model: "gemini-3.8-flash-high", effort: "high" },
  { nickname: "", tool: "agy", model: "gemini-4-argon-high", effort: "high" },
];
const sceneNames = { open: "开放讨论", fiction: "小说选题与大纲", design: "方案设计" };
const stageNames = {
  reply: "成员回复", summary: "管理员整理", ideas: "独立选题", idea_vote: "点子投票",
  questions: "提出关键问题", question_vote: "问题投票", outline: "整理大纲",
  plans: "独立出方案", reviews: "方案互评", final: "整理成稿",
};
const label = (artifact: Artifact) => artifact.author + " · " + artifact.title;

export function getModelAbbr(name: string): string {
  if (!name) return "AI";
  const trimmed = name.trim();
  if (/^[\u4e00-\u9fa5]+$/.test(trimmed)) return trimmed.slice(0, 2);
  const match = trimmed.match(/[a-zA-Z]+/g);
  if (match) {
    const letters = match.join("");
    if (letters.length >= 3) return letters.slice(0, 3).toUpperCase();
    if (letters.length > 0) return letters.toUpperCase();
  }
  return trimmed.slice(0, 3).toUpperCase();
}

// 素雅低饱和莫兰迪冷灰 / 浅灰质感色板，干净素净、绝不花哨刺眼
const AVATAR_PALETTES = [
  { bg: "#f1f5f9", color: "#334155" }, // 典雅浅冷灰 (Slate)
  { bg: "#f3f4f6", color: "#374151" }, // 沉稳冷烟灰 (Gray)
  { bg: "#f8fafc", color: "#475569" }, // 极浅素白灰 (Slate Light)
  { bg: "#f5f5f4", color: "#44403c" }, // 质感素暖灰 (Stone)
  { bg: "#edf2f7", color: "#2d3748" }, // 极低饱和度青灰
  { bg: "#eef2f6", color: "#34495e" }, // 极淡素墨蓝
];

function hashString(str: string) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  return hash;
}

export function GroupAvatar({ members = [], title = "" }: { members?: Pick<Model, "nickname" | "model" | "tool">[]; title?: string }) {
  const count = members.length;
  if (count === 0) {
    const text = getModelAbbr(title) || "群";
    const palette = AVATAR_PALETTES[hashString(title) % AVATAR_PALETTES.length]!;
    return <div className="gc-group-avatar gc-grid-1" style={{ background: palette.bg, color: palette.color }}>{text}</div>;
  }
  if (count === 1) {
    const member = members[0]!;
    const text = getModelAbbr(member.nickname || member.model);
    const palette = AVATAR_PALETTES[hashString(text) % AVATAR_PALETTES.length]!;
    return <div className="gc-group-avatar gc-grid-1" style={{ background: palette.bg, color: palette.color }}>{text}</div>;
  }
  if (count === 2) {
    return (
      <div className="gc-group-avatar gc-grid-2">
        {members.slice(0, 2).map((m, idx) => {
          const text = getModelAbbr(m.nickname || m.model);
          const p = AVATAR_PALETTES[(hashString(text) + idx) % AVATAR_PALETTES.length]!;
          return <span key={idx} className="gc-avatar-cell" style={{ background: p.bg, color: p.color }}>{text}</span>;
        })}
      </div>
    );
  }
  if (count <= 4) {
    return (
      <div className="gc-group-avatar gc-grid-4">
        {members.slice(0, 4).map((m, idx) => {
          const text = getModelAbbr(m.nickname || m.model);
          const p = AVATAR_PALETTES[(hashString(text) + idx) % AVATAR_PALETTES.length]!;
          return <span key={idx} className="gc-avatar-cell" style={{ background: p.bg, color: p.color }}>{text}</span>;
        })}
      </div>
    );
  }
  return (
    <div className="gc-group-avatar gc-grid-9">
      {members.slice(0, 9).map((m, idx) => {
        const text = getModelAbbr(m.nickname || m.model);
        const p = AVATAR_PALETTES[(hashString(text) + idx) % AVATAR_PALETTES.length]!;
        return <span key={idx} className="gc-avatar-cell" style={{ background: p.bg, color: p.color }}>{text}</span>;
      })}
    </div>
  );
}

function modelName(member: Pick<Model, "tool" | "model" | "effort">, catalogLabel?: string) {
  const id = member.model.split("/").at(-1) ?? member.model;
  const catalogName = catalogLabel?.trim();
  const name = catalogName && catalogName !== member.model && catalogName !== id ? catalogName : formatModelName(member.tool, id);
  const effort = member.effort ?? (member.tool === "agy" ? id.match(/-(low|medium|high|max)$/i)?.[1] : undefined);
  return effort && !name.toLowerCase().endsWith(effort.toLowerCase()) ? name + " " + effort : name;
}

const messageTime = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false });
const sessionUrl = (id: string) => "/api/group-sessions/" + id;

function memberChoice(member: Pick<Model, "model">, choices: ModelChoice[] = []) {
  return choices.find(choice => choice.nativeId === member.model ||
    Object.values(choice.variantByEffort).includes(member.model));
}

class GroupConnectionError extends Error {
  constructor(cause: unknown) {
    super("暂时无法连接 DevFlow 服务，请稍后重试。", { cause });
  }
}

async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(path, { method, ...(body === undefined ? {} : {
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }) }).catch(error => { throw new GroupConnectionError(error); });
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
    <summary aria-label={label} title={label} className="gc-menu-trigger-btn">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
        <circle cx="12" cy="12" r="2.2" />
        <circle cx="19" cy="12" r="2.2" />
        <circle cx="5" cy="12" r="2.2" />
      </svg>
    </summary>
    <div className="gc-menu-panel" onClick={event => {
      if ((event.target as HTMLElement).closest("button")) event.currentTarget.closest("details")!.open = false;
    }}>{children}</div>
  </details>;
}

function Modal({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} aria-label={title} className="gc-modal" onCancel={close}>
    <div className="gc-modal-heading">
      <h2>{title}</h2>
      <button type="button" onClick={close} aria-label="关闭" className="gc-modal-close-btn">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 6 6 18M6 6l12 12"/>
        </svg>
      </button>
    </div>
    {children}
  </dialog>;
}

function GroupForm({ save, close, group, existingGroups = [] }: { save: (data: unknown) => Promise<void>; close: () => void; group?: Group; existingGroups?: Group[] }) {
  const [members, setMembers] = useState<Omit<Model, "id">[]>(() =>
    group ? group.members.map(({ id: _id, ...member }) => member) : defaultMembers,
  );
  const [modelWorkspace, setModelWorkspace] = useState(group?.model_workspace ?? "");
  const [catalogs, setCatalogs] = useState<Partial<Record<Model["tool"], ModelChoice[]>>>({});
  const [catalogKeys, setCatalogKeys] = useState<Partial<Record<Model["tool"], string>>>({});
  const [confirmedKeys, setConfirmedKeys] = useState<Partial<Record<Model["tool"], string>>>({});
  const catalogRequests = useRef<Partial<Record<Model["tool"], { key: string; controller: AbortController }>>>({});
  const workspaceRef = useRef(modelWorkspace.trim());
  workspaceRef.current = modelWorkspace.trim();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const request of Object.values(catalogRequests.current)) request?.controller.abort();
    };
  }, []);
  const [loading, setLoading] = useState<Partial<Record<Model["tool"], boolean>>>({});
  const [catalogErrors, setCatalogErrors] = useState<Partial<Record<Model["tool"], string>>>({});
  const [admin, setAdmin] = useState(group?.members.findIndex(member => member.id === group.admin) ?? 0);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [editor, setEditor] = useState<{ index: number; member: Omit<Model, "id">; admin: boolean }>();

  const isWorkspaceTool = (tool: Model["tool"]) => tool === "codebuddy-code";
  const keyFor = (tool: Model["tool"]) => JSON.stringify([tool, isWorkspaceTool(tool) ? modelWorkspace.trim() : "default"]);
  const catalogReady = (tool: Model["tool"]) => confirmedKeys[tool] === keyFor(tool) &&
    !loading[tool] && !catalogErrors[tool];

  function load(tool: Model["tool"], force = false) {
    catalogRequests.current[tool]?.controller.abort();
    const workspace = workspaceRef.current;
    const key = JSON.stringify([tool, isWorkspaceTool(tool) ? workspace : "default"]);
    const controller = new AbortController();
    const request = { key, controller };
    catalogRequests.current[tool] = request;
    const current = () => mounted.current && catalogRequests.current[tool] === request &&
      !controller.signal.aborted && (!isWorkspaceTool(tool) || workspaceRef.current === workspace);
    setCatalogKeys(value => ({ ...value, [tool]: key }));
    setConfirmedKeys(value => ({ ...value, [tool]: undefined }));
    setCatalogErrors(value => ({ ...value, [tool]: "" }));
    if (catalogKeys[tool] !== key) setCatalogs(value => ({ ...value, [tool]: [] }));
    if (isWorkspaceTool(tool) && !workspace) {
      setLoading(value => ({ ...value, [tool]: false }));
      setCatalogErrors(value => ({ ...value, [tool]: "请先填写 CodeBuddy 工作区。" }));
      return;
    }
    setLoading(value => ({ ...value, [tool]: true }));
    void fetchToolModelsWithSWR(tool, choices => {
      if (current()) setCatalogs(value => ({ ...value, [tool]: choices }));
    }, isWorkspaceTool(tool) ? "workspace:" + workspace : undefined, force, controller.signal)
      .then(choices => {
        if (!current()) return;
        setCatalogs(value => ({ ...value, [tool]: choices }));
        setConfirmedKeys(value => ({ ...value, [tool]: key }));
      })
      .catch(err => {
        if (current()) setCatalogErrors(value => ({ ...value, [tool]: formatApiError(err) }));
      })
      .finally(() => {
        if (current()) setLoading(value => ({ ...value, [tool]: false }));
      });
  }

  const memberTools = [...new Set([...members.map(member => member.tool), ...(editor ? [editor.member.tool] : [])])].join(",");
  useEffect(() => {
    const timer = setTimeout(() => {
      for (const tool of memberTools.split(",").filter(Boolean) as Model["tool"][]) {
        const key = JSON.stringify([tool, isWorkspaceTool(tool) ? workspaceRef.current : "default"]);
        if (catalogRequests.current[tool]?.key !== key) load(tool);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [memberTools, modelWorkspace]);

  useEffect(() => {
    const refresh = () => {
      for (const tool of memberTools.split(",").filter(Boolean) as Model["tool"][]) load(tool);
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [memberTools, modelWorkspace]);

  function isAvailable(member: Omit<Model, "id">) {
    if (!member.model || !catalogReady(member.tool)) return false;
    const choice = memberChoice(member, catalogs[member.tool]);
    if (!choice) return false;
    return !member.effort || (choice.effortStatus === "supported" && choice.effortValues.includes(member.effort));
  }

  const canSave = members.length > 0 && members.every(isAvailable);

  const workspaceField = (labelText: string) => <label className="gc-col-span-2">
    <span className="gc-form-label">{labelText}</span>
    <input value={modelWorkspace} onChange={event => setModelWorkspace(event.currentTarget.value)}
      placeholder="填写 CodeBuddy 使用的本机 Git 工作区绝对路径" required />
    <small>目录读取、模型核验和回复均使用此工作区；已有会话需同步群配置。</small>
  </label>;

  function patch(value: Partial<Omit<Model, "id">>) {
    setEditor(current => current && { ...current, member: { ...current.member, ...value } });
  }

  const taken = (tool: Model["tool"], choice: ModelChoice, except: number) =>
    members.some((member, index) => index !== except && member.tool === tool &&
      memberChoice(member, catalogs[tool]) === choice);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const title = String(data.get("title") ?? "").trim();
    if (!title) { setError("群名称不能为空"); return; }
    const isDuplicate = existingGroups.some(g => g.id !== group?.id && g.title.trim().toLowerCase() === title.toLowerCase());
    if (isDuplicate) {
      setError("群聊名称已存在，请使用其他名称");
      return;
    }
    if (!canSave) { setError("请等待模型目录加载完成，并选择当前可用的模型与推理强度"); return; }

    setPending(true);
    setError("");
    const normalize = (name: string) => name.trim().normalize("NFKC").toLowerCase();
    const humanName = group?.human ?? "我";
    const takenNames = new Set(["全部", "全部模型", normalize(humanName), ...members.map(member => normalize(member.nickname))]);
    const namedMembers = members.map(member => {
      if (member.nickname.trim()) return member;
      const base = modelName(member, memberChoice(member, catalogs[member.tool])?.label);
      let nickname = base.slice(0, 32).trimEnd();
      for (let count = 2; takenNames.has(normalize(nickname)); count++) {
        const suffix = " " + count;
        nickname = base.slice(0, 32 - suffix.length).trimEnd() + suffix;
      }
      takenNames.add(normalize(nickname));
      return { ...member, nickname };
    });
    try { await save({ title, human: humanName, members: namedMembers, admin, model_workspace: modelWorkspace.trim() || undefined, version: group?.version }); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setPending(false); }
  }

  return <><Modal title={group ? "编辑群配置" : "新建群聊"} close={close}>
    <form onSubmit={submit} className="gc-form">
      <label>
        <span className="gc-form-label">群名称</span>
        <input name="title" required maxLength={100} defaultValue={group?.title} placeholder="输入群聊名称（不可重名）" autoFocus />
      </label>
      {members.some(member => isWorkspaceTool(member.tool)) && workspaceField("模型工作区")}
      <div className="gc-member-section-header">
        <span className="gc-form-label">群内模型成员（{members.length}）</span>
        <small className="gc-text-muted">（当前用户为默认参与者，无需单独添加）</small>
      </div>
      <ul className="gc-member-list" aria-label="模型成员">
        {members.map((member, index) => {
          const name = modelName(member, memberChoice(member, catalogs[member.tool])?.label);
          const unavailable = catalogReady(member.tool) && !isAvailable(member);
          const abbr = getModelAbbr(member.nickname || member.model);
          return <li key={index} className="gc-member-item">
            <span className="gc-member-mini-avatar">{abbr}</span>
            <div className="gc-member-desc">
              <span className="gc-member-nickname">{member.nickname || name}</span>
              <small className="gc-member-model-tag">{toolLabel(member.tool)} · {name}</small>
            </div>
            {admin === index && <span className="gc-tag gc-tag-admin">管理员</span>}
            {unavailable && <small role="alert" className="gc-alert-text">当前目录不可用</small>}
            <div className="gc-member-controls">
              <button type="button" title="编辑成员" aria-label={`编辑成员 ${name}`}
                onClick={() => setEditor({ index, member, admin: admin === index })}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
                  <path d="m15 5 4 4"/>
                </svg>
              </button>
              <button type="button" title="移除成员" aria-label={`移除成员 ${name}`} onClick={() => {
                setMembers(rows => rows.filter((_, i) => i !== index));
                setAdmin(value => value === index ? 0 : value > index ? value - 1 : value);
              }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6 6 18M6 6l12 12"/>
                </svg>
              </button>
            </div>
          </li>;
        })}
      </ul>
      {[...new Set(members.map(member => member.tool))].map(tool => catalogErrors[tool] &&
        <div key={tool} className="gc-error-row">
          <p role="alert" className="gc-error-tip">{toolLabel(tool)}：{catalogErrors[tool]}</p>
          <button type="button" disabled={loading[tool]} onClick={() => load(tool, true)}>重试加载</button>
        </div>)}
      {error && <p role="alert" className="gc-error-tip">{error}</p>}
      <div className="gc-actions gc-form-actions">
        <button type="button" className="gc-btn-add-member" disabled={members.length >= 16} onClick={() => setEditor({
          index: members.length, member: { nickname: "", tool: "codex", model: "" }, admin: members.length === 0,
        })}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M5 12h14"/>
          </svg>
          <span>新增成员</span>
        </button>
        <button className="gc-primary" disabled={pending || !canSave}>{group ? "保存群配置" : "创建群聊"}</button>
      </div>
    </form>
  </Modal>
  {editor && (() => {
        const { member, index } = editor;
        const ready = catalogReady(member.tool);
        const models = catalogKeys[member.tool] === keyFor(member.tool) ? catalogs[member.tool] ?? [] : [];
        const model = memberChoice(member, models);
        const efforts = model?.effortStatus === "supported" ? model.effortValues : [];
        const effort = member.effort ?? Object.entries(model?.variantByEffort ?? {}).find(([, id]) => id === member.model)?.[0] ?? "";
        const adding = index === members.length;
        const duplicate = model && taken(member.tool, model, index) &&
          !(members[index]?.tool === member.tool && memberChoice(members[index], models) === model);
        return <Modal title={adding ? "新增成员" : "编辑成员"} close={() => setEditor(undefined)}>
        <form className="gc-form gc-member-form-pro" onSubmit={event => {
          event.preventDefault();
          if (!ready || !isAvailable(member) || duplicate) return;
          setMembers(rows => adding ? [...rows, member] : rows.map((row, i) => i === index ? member : row));
          if (editor.admin) setAdmin(index);
          setEditor(undefined);
        }}>
          <label>
            <span className="gc-form-label">成员昵称</span>
            <input maxLength={32} value={member.nickname}
              placeholder={modelName(member, model?.label) || "留空将使用模型名"} onInput={event => patch({ nickname: event.currentTarget.value })} />
          </label>
          <label>
            <span className="gc-form-label">接入工具</span>
            <select value={member.tool} onChange={e => {
              const nextTool = e.target.value as Model["tool"];
              load(nextTool);
              patch({ tool: nextTool, model: "", effort: undefined });
            }}>
              {tools.map(tool => <option value={tool} key={tool}>{toolLabel(tool)}</option>)}
            </select>
          </label>
          {isWorkspaceTool(member.tool) && workspaceField("CodeBuddy 工作区")}
          {/* 模型选择与推理强度同一行，比例合适紧凑 */}
          <div className="gc-col-span-2 gc-model-effort-row">
            <label className={`gc-model-col ${models.length > 0 ? "gc-model-col-adaptive" : "gc-model-col-empty"}`}>
              <span className="gc-form-label">模型选择</span>
              <select
                required
                disabled={!ready}
                value={model?.nativeId ?? member.model}
                style={models.length > 0 ? {
                  width: `${Math.max(
                    ...models.map(item => {
                      const text = item.label + (taken(member.tool, item, index) && item !== model ? "（已有成员）" : "");
                      let len = 0;
                      for (let i = 0; i < text.length; i++) {
                        len += text.charCodeAt(i) > 255 ? 15 : 8.5;
                      }
                      return len;
                    }),
                    140
                  ) + 48}px`,
                  maxWidth: "100%",
                } : undefined}
                onChange={e => patch({ model: e.target.value, effort: undefined })}
              >
                <option value="">{loading[member.tool] && !models.length ? "正在读取模型目录…" : "请选择具体模型"}</option>
                {member.model && !model && <option value={member.model} disabled>{formatModelName(member.tool, member.model)}（{ready ? "当前目录不可用" : "等待目录确认"}）</option>}
                {models.map(item => {
                  const used = taken(member.tool, item, index) && item !== model;
                  return <option key={item.entryIds.join("|")} value={item.nativeId} disabled={used}>{item.label}{used && "（已有成员）"}</option>;
                })}
              </select>
            </label>
            <label className="gc-effort-col">
              <span className="gc-form-label">推理强度</span>
              <select disabled={!model || (efforts.length === 0 && !member.effort)} value={effort} onChange={e => {
                const value = e.target.value;
                patch({ model: model?.variantByEffort[value] ?? model?.nativeId ?? member.model, effort: value || undefined });
              }}>
                <option value="">模型默认</option>
                {effort && !efforts.includes(effort) && <option value={effort} disabled>{effort}{model && "（当前模型不支持）"}</option>}
                {efforts.map(value => <option key={value}>{value}</option>)}
              </select>
            </label>
          </div>
          {catalogErrors[member.tool] && !/process_stop_unconfirmed/i.test(catalogErrors[member.tool]!) && (
            <div className="gc-col-span-2 gc-error-row" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <p role="alert" className="gc-error-tip" style={{ margin: 0 }}>{catalogErrors[member.tool]}</p>
              <button type="button" className="gc-btn-retry" style={{ fontSize: "12px", padding: "2px 8px", cursor: "pointer" }} onClick={() => load(member.tool, true)}>重试加载</button>
            </div>
          )}
          {!loading[member.tool] && models.length === 0 && !catalogErrors[member.tool] && (
            <div className="gc-col-span-2 gc-empty-tip" style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "var(--muted)" }}>
              <span>当前工具未读取到可用模型</span>
              <button type="button" className="gc-btn-retry" style={{ fontSize: "12px", padding: "2px 8px", cursor: "pointer" }} onClick={() => load(member.tool, true)}>刷新目录</button>
            </div>
          )}
          <div className="gc-col-span-2 gc-admin-switch-row">
            <label className="gc-switch-label">
              <input type="checkbox" checked={editor.admin} disabled={index === admin} onChange={event => {
                const checked = event.currentTarget.checked;
                setEditor(current => current && { ...current, admin: checked });
              }} />
              <span>设为群管理员</span>
            </label>
          </div>
          <div className="gc-col-span-2 gc-actions gc-dialog-footer">
            <button type="button" onClick={() => setEditor(undefined)}>取消</button>
            <button className="gc-primary" disabled={!isAvailable(member) || duplicate}>{adding ? "添加成员" : "保存成员"}</button>
          </div>
        </form></Modal>;
  })()}</>;
}

function RosterEditor({ row, save, admin, close, error }: { row: Group | Session; save: (id: string, name: string) => void; admin: (id: string) => void; close: () => void; error?: ReactNode }) {
  return <Modal title={"scene" in row ? "会话成员" : "群成员"} close={close}>
    {error}
    <div className="gc-form">
      {[{ id: "human", nickname: row.human, description: "当前用户" }, ...row.members.map(member => ({
        ...member, description: toolLabel(member.tool) + " · " + modelName(member),
      }))].map(member => <form className="gc-roster-row" key={member.id + member.nickname} onSubmit={event => {
        event.preventDefault();
        const name = String(new FormData(event.currentTarget).get("nickname"));
        save(member.id, name);
      }}>
        <small>{member.description}</small>
        <label><span className="gc-sr">昵称</span><input name="nickname" required maxLength={32} defaultValue={member.nickname} aria-label={member.nickname + "的昵称"} /></label>
        <div className="gc-actions"><button>保存昵称</button>
          {member.id !== "human" && (row.admin === member.id ? <span className="gc-tag gc-tag-admin">管理员</span> :
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
  const [refreshError, setRefreshError] = useState("");
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupId, setGroupId] = useState("");
  const [sessions, setSessions] = useState<Page>({ items: [] });
  const [query, setQuery] = useState("");
  const [sessionId, updateSessionId] = useState("");
  const [view, setView] = useState<View>();
  const [older, setOlder] = useState<View>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [modal, setModal] = useState<"group" | "edit-group" | "session" | "roster" | "group-roster" | "delete" | "final" | "outline" | "restart">();
  const [editingGroup, setEditingGroup] = useState<Group>();
  const [deletingGroup, setDeletingGroup] = useState<Group>();
  const [popoverGroup, setPopoverGroup] = useState<{ group: Group; rect: DOMRect } | null>(null);
  const [renamingSession, setRenamingSession] = useState<{ id: string; title: string; version: number }>();
  const [sessionTitleInput, setSessionTitleInput] = useState("");
  const [deletingSessionItem, setDeletingSessionItem] = useState<{ id: string; title: string; version: number }>();
  const [showRosterDrawer, setShowRosterDrawer] = useState(false);
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
  const [mentions, setMentions] = useState(false);
  const [memberQuery, setMemberQuery] = useState("");
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);
  const composer = useRef<HTMLTextAreaElement>(null);
  const [pending, setPending] = useState(false);
  const [author, setAuthor] = useState("");
  const [base, setBase] = useState("");
  const [removal, setRemoval] = useState(false);
  const selectionRef = useRef({ id: "", generation: 0 });

  function setSessionId(id: string) {
    if (selectionRef.current.id !== id) {
      selectionRef.current = { id, generation: selectionRef.current.generation + 1 };
      setOlder(undefined);
      setDocuments([]);
      setCompare(false);
      setReading(0);
    }
    updateSessionId(id);
  }
  const isCurrentSelection = (selection: typeof selectionRef.current) => selectionRef.current === selection;
  useEffect(() => () => {
    selectionRef.current = { ...selectionRef.current, generation: selectionRef.current.generation + 1 };
  }, []);

  const group = groups.find(item => item.id === groupId);
  const activeSessionSummary = sessions.items.find(item => item.id === sessionId);
  const activeView = view?.session.id === sessionId ? view : undefined;
  const activeOlder = older?.session.id === sessionId ? older : undefined;
  const session = activeView?.session ?? activeSessionSummary;
  const round = activeView?.round;
  const canChange = !session?.archived && !session?.deleting;
  const busy = round?.status === "running" || round?.status === "paused";
  const report = (err: unknown) => setError(err instanceof Error ? err.message : String(err));

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
    const selection = selectionRef.current;
    follow.current = true;
    if (!sessionId) {
      setView(undefined);
      return;
    }
    // 切换会话时若本地列表已有摘要，直接使用骨架即时秒呈，绝不让用户等待或呈现空状态
    const summary = sessions.items.find(s => s.id === sessionId);
    if (summary && view?.session?.id !== sessionId) {
      setView({
        session: summary,
        round: undefined,
        messages: [],
        artifacts: [],
      });
    }
    setOlder(undefined);
    setDocuments([]);
    setCompare(false);
    setReading(0);
    setShowNavigation(false);
    setMessage("");
    setMode("scene");
    setTargets([]);
    setMentions(false);
    setMemberQuery("");
    setRefreshError("");
    setShowRosterDrawer(false);
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const next = await api<View>(sessionUrl(sessionId));
        if (live && isCurrentSelection(selection)) {
          setView(prior => {
            if (!isCurrentSelection(selection)) return prior;
            if (prior?.session.id !== sessionId) return next;
            const isPriorSkeleton = prior.round === undefined && prior.messages.length === 0 && prior.artifacts.length === 0;
            if (isPriorSkeleton) return next;
            if (prior.session.version > next.session.version) return prior;
            return next;
          });
          setRefreshError("");
        }
      } catch (error) {
        if (!live || !isCurrentSelection(selection)) return;
        const msg = error instanceof Error ? error.message : String(error);
        if (/会话不存在|404|not found/i.test(msg)) {
          setView(undefined);
          setSessionId("");
          setSessions(prev => ({
            ...prev,
            items: prev.items.filter(item => item.id !== sessionId),
          }));
          setNotice("会话不存在或已删除");
          setRefreshError("会话不存在或已删除");
          return;
        }
        setRefreshError(error instanceof GroupConnectionError
          ? "群聊暂时无法连接服务，正在自动重连。"
          : msg);
      }
      if (live && isCurrentSelection(selection)) timer = setTimeout(() => void refresh(), 950);
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
    const selection = selectionRef.current;
    await perform(async () => {
      const next = await api<View>(sessionUrl(session.id) + "/actions", "POST", { version: session.version, request: crypto.randomUUID(), input });
      if (!isCurrentSelection(selection)) return;
      setView(prior => isCurrentSelection(selection) && prior?.session.id === session.id && prior.session.version <= next.session.version ? next : prior);
      if (input.action === "send") { setMessage(""); setTargets([]); setMentions(false); }
      setModal(undefined);
    });
  }

  async function preview(id: string) {
    if (!session) return;
    const selection = selectionRef.current;
    try {
      const doc = await api<Document>(sessionUrl(session.id) + "/artifacts/" + id);
      if (!isCurrentSelection(selection)) return;
      setDocuments(prior => !isCurrentSelection(selection) ? prior :
        compare && prior[0] ? (prior[0].id === doc.id ? prior : [prior[0], doc]) : [doc]);
      setReading(compare && documents[0] && documents[0].id !== doc.id ? 1 : 0);
    } catch (error) { if (isCurrentSelection(selection)) report(error); }
  }

  async function loadOlder() {
    const before = activeOlder ? activeOlder.next : activeView?.next;
    if (!session || !before) return;
    const selection = selectionRef.current;
    await perform(async () => {
      try {
        const page = await api<View>(sessionUrl(session.id) + "?before=" + before);
        if (!isCurrentSelection(selection) || page.session.id !== session.id) return;
        setOlder(prior => {
          if (!isCurrentSelection(selection)) return prior;
          const sameSession = prior?.session.id === session.id ? prior : undefined;
          return { ...page, messages: [...page.messages, ...(sameSession?.messages ?? [])],
            artifacts: [...page.artifacts, ...(sameSession?.artifacts ?? [])] };
        });
      } catch (error) { if (isCurrentSelection(selection)) throw error; }
    });
  }

  function manageRoster(isSession: boolean, field: "nickname" | "admin", member: string, nickname?: string) {
    const row = isSession ? session : group;
    if (!row) return;
    const selection = selectionRef.current;
    void perform(async () => {
      const route = isSession ? sessionUrl(row.id) : "/api/groups/" + row.id;
      const updated = await api<Group | Session>(route + "/" + field, "PATCH", { version: row.version, member, nickname });
      if ("scene" in updated) setView(prior => isCurrentSelection(selection) && prior?.session.id === updated.id ? { ...prior, session: updated } : prior);
      else setGroups(items => items.map(item => item.id === updated.id ? updated : item));
    });
  }

  async function handleDeleteGroup(target: Group) {
    await perform(async () => {
      await api(`/api/groups/${target.id}`, "DELETE");
      setGroups(rows => {
        const rest = rows.filter(r => r.id !== target.id);
        if (groupId === target.id) {
          const nextGroup = rest[0];
          setGroupId(nextGroup?.id ?? "");
          setSessions({ items: [] });
          setSessionId("");
        }
        return rest;
      });
      setDeletingGroup(undefined);
      setNotice(`群聊「${target.title}」及其全部会话已成功删除`);
    });
  }

  async function handleRenameSession(e: FormEvent) {
    e.preventDefault();
    if (!renamingSession || !sessionTitleInput.trim()) return;
    await perform(async () => {
      const updated = await api<Session>(`/api/group-sessions/${renamingSession.id}/title`, "PATCH", {
        version: renamingSession.version,
        title: sessionTitleInput.trim(),
      });
      setSessions(prior => ({
        ...prior,
        items: prior.items.map(s => s.id === updated.id ? { ...s, title: updated.title, version: updated.version } : s),
      }));
      if (sessionId === updated.id) {
        setView(prior => prior ? { ...prior, session: { ...prior.session, title: updated.title, version: updated.version } } : prior);
      }
      const title = updated.title;
      setRenamingSession(undefined);
      setNotice(`会话已重命名为「${title}」`);
    });
  }

  async function handleDeleteSessionItem() {
    if (!deletingSessionItem) return;
    await perform(async () => {
      await api(`/api/group-sessions/${deletingSessionItem.id}`, "DELETE", {
        version: deletingSessionItem.version,
        files: true,
      });
      setSessions(prior => ({
        ...prior,
        items: prior.items.filter(s => s.id !== deletingSessionItem.id),
      }));
      if (sessionId === deletingSessionItem.id) {
        setSessionId("");
        setView(undefined);
      }
      const title = deletingSessionItem.title;
      setDeletingSessionItem(undefined);
      setNotice(`会话「${title}」及其相关记录已删除`);
    });
  }

  function selectMentionMember(m: Model) {
    const mentionTag = `@${m.nickname} `;
    setTargets(prior => [...new Set([...prior, m.id])]);
    setMessage(prior => {
      const atIdx = prior.lastIndexOf("@");
      if (atIdx >= 0) {
        return prior.slice(0, atIdx) + mentionTag;
      }
      return prior + mentionTag;
    });
    setMentions(false);
    setTimeout(() => composer.current?.focus(), 50);
  }

  function send(event: FormEvent) {
    event.preventDefault();
    if (!message.trim() || !session) return;

    // 从文本中提取所有以 @ 开头的成员
    const mentionedMembers = session.members.filter(m => {
      const escaped = m.nickname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`@${escaped}(?:\\s|$)`, "u");
      return re.test(message);
    });

    let targeted = [...new Set([...targets, ...mentionedMembers.map(m => m.id)])];
    // 用户规则：没有 @ 模型默认是发给所有人的，所以不需要 @ 所有人功能
    const isBroadcast = targeted.length === 0;
    if (isBroadcast) {
      targeted = session.members.map(m => m.id);
    }

    if (mode !== "record" && session.scene === "design" && round?.stage === "reviews" && round.status === "waiting" && targeted.length === 1 && !isBroadcast && /成稿|定稿/u.test(message)) {
      void act({ action: "final", member: targeted[0], text: message });
      return;
    }
    if (mode === "scene" && !isBroadcast && !targeted.length && session.scene === "fiction") {
      if (round?.status === "waiting" && /^(?:都不行|都不要|全部重想|重新想)[，。！、：\s]*$/u.test(message.trim())) {
        void act({ action: "restart", text: "" }).then(() => setMessage(""));
        return;
      }
      if (session.chosenQuestion) {
        void act({ action: "answer", text: message.trim() }).then(() => setMessage(""));
        return;
      }
    }

    void act({ action: "send", text: message, targets: targeted, all: isBroadcast, mode });
  }

  const messages = [...new Map([...(activeOlder?.messages ?? []), ...(activeView?.messages ?? [])].map(item => [item.id, item])).values()];
  const artifacts = [...new Map([...(activeOlder?.artifacts ?? []), ...(activeView?.artifacts ?? [])].map(item => [item.id, item])).values()];
  const artifactsById = new Map(artifacts.map(item => [item.id, item]));
  const nextAction = session?.scene === "fiction" ? "整理大纲" : "指定成员成稿";
  const canDraft = !!session?.brief && (session.scene === "fiction" || session.scene === "design") && !busy;
  const canRestart = !!session?.brief && session.scene !== "open" && round?.status !== "running";
  const beginDraft = (artifact = "") => {
    if (!session) return;
    setAuthor(session.admin); setBase(artifact); setModal(session.scene === "fiction" ? "outline" : "final");
  };
  const errorMessage = (error || refreshError) && <p className="gc-error" role="alert">{error || refreshError}<button aria-label="关闭错误" onClick={() => {
    setError(""); setRefreshError("");
  }}>×</button></p>;

  const filteredMentionMembers = session?.members.filter(member =>
    (member.nickname + " " + modelName(member)).toLowerCase().includes(memberQuery.toLowerCase())
  ) ?? [];

  return <div className="gc-shell">
    <header className="gc-top">
      <a href="/" className="gc-back" aria-label="返回任务工作台">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m15 18-6-6 6-6"/>
        </svg>
        <span>任务工作台</span>
      </a>
      <h1 className="gc-title">
        <img
          className="gc-brand-logo"
          src="/devflow-logo.svg"
          alt=""
          width={22}
          height={22}
        />
        <span>模型群聊</span>
      </h1>
      <button className="gc-mobile-nav" aria-expanded={showNavigation} onClick={() => setShowNavigation(value => !value)}>会话列表</button>
    </header>
    {!modal && errorMessage}
    {notice && <div role="status" className="gc-notice"><span>{notice}</span><button aria-label="关闭提示" onClick={() => setNotice("")}>×</button></div>}

    <div className={`gc-layout ${documents.length ? "gc-with-preview" : ""} ${compare ? "gc-reading-compare" : ""}`}>
      {/* 左侧栏：群聊列表 + 选中群的会话列表 */}
      <aside className={`gc-sidebar ${showNavigation || !session ? "gc-nav-open" : ""}`} aria-label="群聊导航">
        <div className="gc-nav-section-groups">
          <div className="gc-nav-heading">
            <h2>群聊</h2>
            <button aria-label="新建群聊" title="新建群聊" className="gc-btn-icon gc-btn-header-add" onClick={() => setModal("group")}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14M5 12h14"/>
              </svg>
            </button>
          </div>
          <div className="gc-group-list">
            {groups.map(item => (
              <div
                key={item.id}
                className={`gc-group-card ${item.id === groupId ? "gc-selected" : ""}`}
                onMouseEnter={e => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setPopoverGroup({ group: item, rect });
                }}
                onMouseLeave={() => setPopoverGroup(null)}
                onClick={() => {
                  if (groupId === item.id) return;
                  setGroupId(item.id); setSessions({ items: [] }); setSessionId(""); setQuery("");
                }}
              >
                <div className="gc-group-avatar-wrapper">
                  <GroupAvatar members={item.members} title={item.title} />
                </div>
                <div className="gc-group-card-body">
                  <div className="gc-group-card-title">{item.title}</div>
                  <small className="gc-group-card-meta">{item.members.length} 个模型</small>
                </div>
                <div className="gc-group-hover-actions">
                  <button
                    type="button"
                    className="gc-icon-btn"
                    title="编辑群配置"
                    aria-label={`编辑群聊 ${item.title}`}
                    onClick={e => { e.stopPropagation(); setEditingGroup(item); }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
                      <path d="m15 5 4 4"/>
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="gc-icon-btn gc-btn-delete"
                    title="删除群聊"
                    aria-label={`删除群聊 ${item.title}`}
                    onClick={e => { e.stopPropagation(); setDeletingGroup(item); }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2M10 11v6M14 11v6"/>
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {group && <section className="gc-sessions">
          <div className="gc-session-section-header">
            <div className="gc-current-group-badge">
              <span className="gc-group-dot" />
              <h3 className="gc-group-title-highlight">{group.title}</h3>
            </div>
            <div className="gc-actions">
              <button aria-label="新建会话" title="新建会话" className="gc-btn-icon gc-btn-header-add" onClick={() => setModal("session")}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 5v14M5 12h14"/>
                </svg>
              </button>
            </div>
          </div>
          <div className="gc-search-box">
            <svg className="gc-search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/>
              <path d="m21 21-4.3-4.3"/>
            </svg>
            <input aria-label="搜索会话" placeholder="搜索会话…" value={query} onInput={event => setQuery(event.currentTarget.value)} />
          </div>
          <div className="gc-session-list">
            {sessions.items.map(item => (
              <div
                key={item.id}
                className={`gc-session-item ${item.id === sessionId ? "gc-selected" : ""}`}
                aria-current={item.id === sessionId ? "page" : undefined}
                onClick={() => { setSessionId(item.id); setShowNavigation(false); }}
              >
                <div className="gc-session-item-body">
                  <span className="gc-session-item-title">{item.title}</span>
                  <small className="gc-session-item-meta">
                    {sceneNames[item.id === session?.id ? session.scene : item.scene]}
                    {(item.id === session?.id ? session.archived : item.archived) && " · 已归档"}
                  </small>
                </div>
                <div className="gc-session-hover-actions">
                  <button
                    type="button"
                    className="gc-icon-btn"
                    title="重命名会话"
                    aria-label={`重命名会话 ${item.title}`}
                    onClick={e => {
                      e.stopPropagation();
                      setRenamingSession({ id: item.id, title: item.title, version: item.id === session?.id ? session.version : item.version });
                      setSessionTitleInput(item.title);
                    }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
                      <path d="m15 5 4 4"/>
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="gc-icon-btn gc-btn-delete"
                    title="删除会话"
                    aria-label={`删除会话 ${item.title}`}
                    onClick={e => {
                      e.stopPropagation();
                      setDeletingSessionItem({ id: item.id, title: item.title, version: item.id === session?.id ? session.version : item.version });
                    }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2M10 11v6M14 11v6"/>
                    </svg>
                  </button>
                </div>
              </div>
            ))}
            {!sessions.items.length && <div className="gc-empty-tip">{query ? "没有匹配的会话" : "暂无会话，点击右上 ＋ 新建"}</div>}
          </div>
          {sessions.next && <button className="gc-btn-more" onClick={() => void perform(async () => {
            const page = await api<Page>(`/api/groups/${groupId}/sessions?before=${sessions.next}&query=${encodeURIComponent(query)}`);
            setSessions(prior => ({ ...page, items: [...prior.items, ...page.items] }));
          })}>更多会话</button>}
        </section>}
      </aside>

      {/* 主聊天区 */}
      <main className="gc-chat">
        {!session ? <div className="gc-empty">
          <div className="gc-empty-chat-icon">
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>
            </svg>
          </div>
          <h2>{groupId ? "选择或新建会话" : "开始一次模型群聊"}</h2>
          <p>与多个 AI 模型在同一群聊中分工协作，体验微信般的流畅互动。</p>
          {!sessionId && <button className="gc-primary" onClick={() => setModal(group ? "session" : "group")}>{group ? "创建第一个会话" : "创建第一个群聊"}</button>}
        </div> : <>
          {/* 会话顶栏 */}
          <div className="gc-chat-header">
            <div className="gc-session-heading">
              <h2>{session.title}</h2>
              <label className="gc-scene">
                <span className="gc-sr">场景</span>
                <select disabled={pending || round?.status === "running" || !canChange} value={session.scene}
                  onChange={e => void act({ action: "scene", scene: e.target.value as Session["scene"] })}>
                  {Object.entries(sceneNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                </select>
              </label>
              {session.archived && <span className="gc-badge-archived">已归档</span>}
            </div>

            <div className="gc-header-actions">
              {/* 右上角成员折叠按钮（不包含“我”，仅显示模型成员） */}
              <button
                type="button"
                className={`gc-members-toggle-btn ${showRosterDrawer ? "gc-active" : ""}`}
                aria-expanded={showRosterDrawer}
                title="群模型成员列表"
                onClick={() => setShowRosterDrawer(v => !v)}
              >
                <div className="gc-avatar-stack">
                  {session.members.slice(0, 3).map((m, idx) => (
                    <span key={m.id} className="gc-stack-avatar" style={{ zIndex: 10 - idx }}>
                      {getModelAbbr(m.nickname || m.model)}
                    </span>
                  ))}
                </div>
                <span className="gc-members-count-text">{session.members.length} 位模型成员</span>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={`gc-chevron-icon ${showRosterDrawer ? "gc-rotate" : ""}`}>
                  <path d="m6 9 6 6 6-6"/>
                </svg>
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
                })}>{session.deletionError ? "重试删除" : "删除会话"}</button>
              </Menu>
            </div>
          </div>

          {session.deletionError && <p role="alert" className="gc-alert-bar">删除未完成。{session.deletionError}</p>}

          {/* 右上角抽屉面板（展示模型成员，可折叠） */}
          {showRosterDrawer && (
            <div className="gc-roster-drawer" role="complementary" aria-label="群模型成员">
              <div className="gc-drawer-header">
                <h3>群模型成员 ({session.members.length})</h3>
                <button type="button" className="gc-btn-close-drawer" onClick={() => setShowRosterDrawer(false)}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 6 6 18M6 6l12 12"/>
                  </svg>
                </button>
              </div>
              <div className="gc-drawer-list">
                {session.members.map(m => {
                  const abbr = getModelAbbr(m.nickname || m.model);
                  const isAdm = session.admin === m.id;
                  return (
                    <div key={m.id} className="gc-drawer-member-card" onClick={() => selectMentionMember(m)} title="点击在输入框 @ 此成员">
                      <span className="gc-drawer-member-avatar">{abbr}</span>
                      <div className="gc-drawer-member-info">
                        <div className="gc-drawer-member-name">
                          <strong>{m.nickname}</strong>
                          {isAdm && <span className="gc-tag-mini-admin">管理员</span>}
                        </div>
                        <small className="gc-drawer-member-detail">{toolLabel(m.tool)} · {modelName(m)}</small>
                      </div>
                      <button type="button" className="gc-drawer-mention-action" aria-label={`@ ${m.nickname}`}>@</button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 微信风格消息流 */}
          <div className="gc-thread" ref={thread} onScroll={event => {
            const box = event.currentTarget;
            follow.current = box.scrollHeight - box.scrollTop - box.clientHeight < 72;
          }}>
            {(activeOlder ? activeOlder.next : activeView?.next) && <button className="gc-btn-load-more" disabled={pending} onClick={() => void loadOlder()}>加载更早消息</button>}
            {!messages.length && <div className="gc-thread-start gc-thread-start-wechat">
              <div className="gc-welcome-chat-icon">
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
              </div>
              <h3>{session.title}</h3>
              <p>{session.scene === "fiction" ? "写下故事素材或构思方向，群内模型将协作分工并提出方案。" : session.scene === "design" ? "写下目标和约束，成员会独立出稿并相互评审。" : "向群内模型发送消息开启协作，未 @ 时默认全员协同响应。"}</p>
              <div className="gc-empty-start-hint">在下方输入框键入消息或 @ 成员即可开始</div>
            </div>}

            {messages.map((item, idx) => {
              const isOwn = item.author === session.human;
              const artifact = item.artifact ? artifactsById.get(item.artifact) : undefined;
              const reply = artifact?.stage === "reply";
              const member = artifact?.author === item.author ? session.members.find(model => model.id === artifact.member) : undefined;
              const identity = member ? modelName(member) : "";
              const showTime = idx === 0 || (new Date(item.created).getTime() - new Date(messages[idx - 1]!.created).getTime() > 5 * 60 * 1000);

              return (
                <div key={item.id} className="gc-message-wrapper">
                  {showTime && (
                    <div className="gc-message-timestamp">
                      <span>{messageTime.format(new Date(item.created))}</span>
                    </div>
                  )}
                  <article className={`gc-message-row ${isOwn ? "gc-message-own" : "gc-message-ai"}`}>
                    <div className="gc-msg-avatar" aria-hidden="true">
                      {isOwn ? "我" : getModelAbbr(item.author)}
                    </div>
                    <div className="gc-msg-body">
                      {!isOwn && (
                        <header className="gc-msg-author-header">
                          <span className="gc-msg-author-name">{item.author}</span>
                          {identity && identity !== item.author && <small className="gc-msg-identity">{identity}</small>}
                        </header>
                      )}
                      {!item.artifact && <div className="gc-msg-bubble"><p>{item.text}</p></div>}
                      {reply && (
                        <div className="gc-msg-bubble gc-msg-bubble-markdown">
                          <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: ({ alt }) => <span>{alt}</span> }}>
                            {item.text}
                          </Markdown>
                        </div>
                      )}
                      {item.artifact && (
                        <button className={reply ? "gc-reply-source" : "gc-doc-card-wechat"} onClick={() => void preview(item.artifact!)}>
                          {reply ? "查看原文" : <>
                            <span className="gc-doc-icon">📄</span>
                            <div className="gc-doc-info">
                              <span className="gc-doc-title">{item.text.slice(0, 80)}</span>
                              <small className="gc-doc-sub">Markdown 文档 · 点击预览</small>
                            </div>
                          </>}
                        </button>
                      )}
                    </div>
                  </article>
                </div>
              );
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

            {activeView && <Results key={round?.id} view={activeView} preview={id => void preview(id)} act={input => { if (canChange) void act(input); }} />}

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

          {/* 微信风格输入框区 */}
          {canChange && (
            <form className="gc-composer-wechat" onSubmit={send}>
              {/* @ 提及标签气泡 */}
              {targets.length > 0 && (
                <div className="gc-chips" aria-label="当前提及">
                  {session.members.filter(member => targets.includes(member.id)).map(member => (
                    <button type="button" key={member.id} className="gc-chip-item" onClick={() => setTargets(ids => ids.filter(id => id !== member.id))}>
                      @{member.nickname} <span aria-hidden="true">×</span>
                    </button>
                  ))}
                </div>
              )}

              {/* @ 弹出浮层菜单（仅列出模型成员） */}
              {mentions && (
                <div
                  className="gc-mention-popover"
                  aria-label="选择提及模型"
                  onKeyDown={event => {
                    if (event.key === "Escape") { setMentions(false); composer.current?.focus(); }
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      setMentionSelectedIndex(i => (i + 1) % Math.max(1, filteredMentionMembers.length));
                    }
                    if (event.key === "ArrowUp") {
                      event.preventDefault();
                      setMentionSelectedIndex(i => (i - 1 + filteredMentionMembers.length) % Math.max(1, filteredMentionMembers.length));
                    }
                    if (event.key === "Enter" && filteredMentionMembers[mentionSelectedIndex]) {
                      event.preventDefault();
                      selectMentionMember(filteredMentionMembers[mentionSelectedIndex]!);
                    }
                  }}
                >
                  <div className="gc-mention-search-bar">
                    <input
                      autoFocus
                      placeholder="搜索模型成员…"
                      value={memberQuery}
                      onInput={event => {
                        setMemberQuery(event.currentTarget.value);
                        setMentionSelectedIndex(0);
                      }}
                    />
                  </div>
                  <div className="gc-mention-items">
                    {filteredMentionMembers.map((member, index) => (
                      <div
                        key={member.id}
                        className={`gc-mention-item ${mentionSelectedIndex === index ? "gc-mention-active" : ""}`}
                        onClick={() => selectMentionMember(member)}
                      >
                        <span className="gc-mention-item-avatar">{getModelAbbr(member.nickname || member.model)}</span>
                        <div className="gc-mention-item-info">
                          <strong>{member.nickname}</strong>
                          <small>{toolLabel(member.tool)} · {modelName(member)}</small>
                        </div>
                      </div>
                    ))}
                    {!filteredMentionMembers.length && <div className="gc-mention-empty">未找到匹配的模型成员</div>}
                  </div>
                </div>
              )}

              {/* 输入文本框 */}
              <div className="gc-composer-input-area">
                <textarea
                  ref={composer}
                  aria-label="群消息输入框"
                  value={message}
                  onInput={event => {
                    const value = event.currentTarget.value;
                    setMessage(value);
                    const cursor = event.currentTarget.selectionStart ?? value.length;
                    const textBeforeCursor = value.slice(0, cursor);
                    const lastAt = textBeforeCursor.lastIndexOf("@");
                    if (lastAt >= 0 && !/\s/.test(textBeforeCursor.slice(lastAt + 1))) {
                      setMemberQuery(textBeforeCursor.slice(lastAt + 1));
                      setMentions(true);
                      setMentionSelectedIndex(0);
                    } else if (mentions) {
                      setMentions(false);
                    }
                  }}
                  onKeyDown={event => {
                    if (mentions) {
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        setMentionSelectedIndex(i => (i + 1) % Math.max(1, filteredMentionMembers.length));
                        return;
                      }
                      if (event.key === "ArrowUp") {
                        event.preventDefault();
                        setMentionSelectedIndex(i => (i - 1 + filteredMentionMembers.length) % Math.max(1, filteredMentionMembers.length));
                        return;
                      }
                      if (event.key === "Enter" && filteredMentionMembers[mentionSelectedIndex]) {
                        event.preventDefault();
                        selectMentionMember(filteredMentionMembers[mentionSelectedIndex]!);
                        return;
                      }
                      if (event.key === "Escape") {
                        setMentions(false);
                        return;
                      }
                    }
                    if (!event.nativeEvent.isComposing && event.key === "Enter" && !event.shiftKey &&
                      message.trim() && !pending && (!busy || mode === "record")) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  maxLength={20_000}
                  placeholder={session.scene === "open" ? "输入群消息，输入 @ 可指定模型分发任务（未 @ 则默认发给全体成员）…" : "输入需求开始新一轮，或 @ 成员单独处理…"}
                />
              </div>

              {/* 微信底栏工具与发送按钮 */}
              <div className="gc-composer-toolbar">
                <div className="gc-toolbar-left">
                  <button
                    type="button"
                    className="gc-toolbar-btn"
                    title="@ 提及模型"
                    onClick={() => {
                      setMemberQuery("");
                      setMentions(v => !v);
                      composer.current?.focus();
                    }}
                  >
                    @ 成员
                  </button>
                  <small className="gc-dispatch-hint">
                    {targets.length > 0 ? `定向派发给: ${session.members.filter(m => targets.includes(m.id)).map(m => m.nickname).join("、")}` :
                      session.members.some(m => message.includes("@" + m.nickname)) ? "按提及成员派发" :
                      "未指定成员 · 默认发给全体模型成员"}
                  </small>
                </div>

                <div className="gc-toolbar-right">
                  <small className="gc-send-hotkey-hint">Enter 发送 / Shift+Enter 换行</small>
                  <button className="gc-wechat-send-btn" disabled={!message.trim() || pending || busy}>
                    <span>{pending ? "发送中…" : "发送"}</span>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m22 2-7 20-4-9-9-4Z"/>
                      <path d="M22 2 11 13"/>
                    </svg>
                  </button>
                </div>
              </div>
            </form>
          )}
        </>}
      </main>

      {/* 文档预览区 */}
      {session && documents.length > 0 && <aside className="gc-preview" aria-label="文档阅读区">
        <div className="gc-preview-header">
          <h2>文档预览</h2>
          <div className="gc-actions">
            <button aria-pressed={compare} onClick={() => {
              setCompare(value => !value); setReading(0);
              if (compare) setDocuments(items => items.slice(0, 1));
            }}>{compare ? "退出比较" : "并排比较"}</button>
            <button className="gc-close" aria-label="关闭预览" onClick={() => { setDocuments([]); setCompare(false); }}>×</button>
          </div>
        </div>
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

    {/* 弹窗集合 */}
    {modal === "group" && <GroupForm
      close={() => setModal(undefined)}
      existingGroups={groups}
      save={async data => {
        const created = await api<Group>("/api/groups", "POST", data);
        setGroups(rows => [...rows, created]);
        setGroupId(created.id);
        setSessionId("");
        setQuery("");
        setModal("session");
      }}
    />}

    {editingGroup && <GroupForm
      group={editingGroup}
      existingGroups={groups}
      close={() => setEditingGroup(undefined)}
      save={async data => {
        const updated = await api<Group>("/api/groups/" + editingGroup.id, "PUT", data);
        setGroups(rows => rows.map(row => row.id === updated.id ? updated : row));
        setEditingGroup(undefined);
        setNotice(`群聊「${updated.title}」配置已更新`);
      }}
    />}

    {/* 删除群聊二次确认弹窗 */}
    {deletingGroup && (
      <Modal title="删除群聊确认" close={() => setDeletingGroup(undefined)}>
        <div className="gc-delete-confirm-box">
          <div className="gc-delete-icon">⚠️</div>
          <p className="gc-delete-msg">
            确定要删除群聊「<strong>{deletingGroup.title}</strong>」吗？
          </p>
          <div className="gc-delete-warning-callout">
            <strong>重要提示：</strong>删除群聊将同时永久删除该群下的<strong>全部会话及其相关历史记录与受管文件</strong>，此操作无法撤销，请谨慎确认。
          </div>
          {errorMessage}
          <div className="gc-actions gc-dialog-footer">
            <button type="button" onClick={() => setDeletingGroup(undefined)}>取消</button>
            <button type="button" className="gc-danger" disabled={pending} onClick={() => void handleDeleteGroup(deletingGroup)}>
              {pending ? "正在删除…" : "确认删除此群聊"}
            </button>
          </div>
        </div>
      </Modal>
    )}

    {modal === "session" && group && <Modal title="新建会话" close={() => setModal(undefined)}>
      <form className="gc-form" onSubmit={event => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        void perform(async () => {
          const created = await api<Session>(`/api/groups/${group.id}/sessions`, "POST", { title: data.get("title"), scene: data.get("scene") });
          setSessions(prior => ({ ...prior, items: [created, ...prior.items] }));
          setSessionId(created.id);
          setModal(undefined);
        });
      }}>
        <label>
          <span className="gc-form-label">会话名称</span>
          <input name="title" required maxLength={100} placeholder="输入会话主题或目标" autoFocus />
        </label>
        <label>
          <span className="gc-form-label">场景类型</span>
          <select name="scene">{Object.entries(sceneNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
        </label>
        {errorMessage}
        <div className="gc-actions gc-dialog-footer">
          <button type="button" onClick={() => setModal(undefined)}>取消</button>
          <button className="gc-primary" disabled={pending}>创建会话</button>
        </div>
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
      {errorMessage}
      <div className="gc-actions gc-dialog-footer">
        <button type="button" onClick={() => setModal(undefined)}>取消</button>
        <button className="gc-danger" disabled={pending} onClick={() => void perform(async () => {
          const deleted = await api<{ retainedPath?: string }>(sessionUrl(session.id), "DELETE", { version: session.version, files: removal });
          setSessions(prior => ({ ...prior, items: prior.items.filter(item => item.id !== session.id) }));
          setSessionId(""); setModal(undefined); setNotice(deleted.retainedPath ? "文件已保留在 " + deleted.retainedPath : "会话与受管文件已删除");
        })}>确认删除会话</button>
      </div>
    </Modal>}

    {modal === "restart" && <Modal title="重新开始本轮" close={() => setModal(undefined)}>
      <form className="gc-form" onSubmit={event => {
        event.preventDefault(); void act({ action: "restart", text: String(new FormData(event.currentTarget).get("reason") ?? "") });
      }}>
        <label><span className="gc-form-label">本轮要避开的方向</span><textarea name="reason" maxLength={3000} /></label>
        {errorMessage}
        <div className="gc-actions gc-dialog-footer">
          <button type="button" onClick={() => setModal(undefined)}>取消</button>
          <button disabled={pending} className="gc-primary">重新生成</button>
        </div>
      </form>
    </Modal>}

    {(modal === "outline" || modal === "final") && session && <Modal title={modal === "outline" ? "整理大纲" : "指定成员成稿"} close={() => setModal(undefined)}>
      <form className="gc-form" onSubmit={event => {
        event.preventDefault(); void act({ action: modal, member: author, artifact: base || undefined, text: String(new FormData(event.currentTarget).get("instructions") ?? "") });
      }}>
        <label><span className="gc-form-label">成稿成员</span><select value={author} onChange={e => setAuthor(e.target.value)}>
          {session.members.map(item => <option key={item.id} value={item.id}>@{item.nickname}</option>)}
        </select></label>
        <label><span className="gc-form-label">基础稿</span><select value={base} onChange={e => setBase(e.target.value)}>
          <option value="">使用当前轮材料</option>{artifacts.filter(item => ["plans", "outline", "final"].includes(item.stage)).map(item => <option value={item.id} key={item.id}>{label(item)}</option>)}
        </select></label>
        <label><span className="gc-form-label">修订要求</span><textarea name="instructions" maxLength={4000} /></label>
        {errorMessage}
        <div className="gc-actions gc-dialog-footer">
          <button type="button" onClick={() => setModal(undefined)}>取消</button>
          <button className="gc-primary" disabled={pending}>发送给指定成员</button>
        </div>
      </form>
    </Modal>}

    {/* 重命名会话弹窗 */}
    {renamingSession && (
      <Modal title="重命名会话" close={() => setRenamingSession(undefined)}>
        <form className="gc-form" onSubmit={handleRenameSession}>
          <label>
            <span className="gc-form-label">会话名称</span>
            <input
              autoFocus
              required
              maxLength={100}
              value={sessionTitleInput}
              onInput={e => setSessionTitleInput(e.currentTarget.value)}
              placeholder="输入新的会话主题或目标"
            />
          </label>
          {errorMessage}
          <div className="gc-actions gc-dialog-footer">
            <button type="button" onClick={() => setRenamingSession(undefined)}>取消</button>
            <button type="submit" className="gc-primary" disabled={pending || !sessionTitleInput.trim()}>
              {pending ? "保存中…" : "保存"}
            </button>
          </div>
        </form>
      </Modal>
    )}

    {/* 删除会话二次确认弹窗 */}
    {deletingSessionItem && (
      <Modal title="删除会话确认" close={() => setDeletingSessionItem(undefined)}>
        <div className="gc-delete-confirm-box">
          <div className="gc-delete-icon">⚠️</div>
          <p className="gc-delete-msg">
            确定要删除会话「<strong>{deletingSessionItem.title}</strong>」吗？
          </p>
          <div className="gc-delete-warning-callout">
            <strong>重要提示：</strong>删除会话将永久清理该会话所有的聊天记录、运行中间产物与文档，此操作无法撤销，请谨慎确认。
          </div>
          {errorMessage}
          <div className="gc-actions gc-dialog-footer">
            <button type="button" onClick={() => setDeletingSessionItem(undefined)}>取消</button>
            <button type="button" className="gc-danger" disabled={pending} onClick={() => void handleDeleteSessionItem()}>
              {pending ? "正在删除…" : "确认删除此会话"}
            </button>
          </div>
        </div>
      </Modal>
    )}

    {/* Hover 群聊卡片纯白磨砂浮层（Fixed脱离文档流，永不触发父容器滚动条滑块） */}
    {popoverGroup && (
      <div
        className="gc-group-popover-fixed"
        role="tooltip"
        style={{
          position: "fixed",
          top: popoverGroup.rect.top,
          left: Math.min(popoverGroup.rect.right + 8, window.innerWidth - 270),
          zIndex: 99999,
          pointerEvents: "none",
        }}
      >
        <div className="gc-popover-header">
          <span>群内模型成员</span>
          <span className="gc-popover-badge">{popoverGroup.group.members.length}</span>
        </div>
        <div className="gc-popover-members">
          {popoverGroup.group.members.map(m => {
            const abbr = getModelAbbr(m.nickname || m.model);
            const isAdm = popoverGroup.group.admin === m.id;
            return (
              <div key={m.id} className="gc-popover-item">
                <span className="gc-popover-avatar">{abbr}</span>
                <div className="gc-popover-info">
                  <div className="gc-popover-name">
                    <span>{m.nickname}</span>
                    {isAdm && <span className="gc-tag-mini-admin">管理员</span>}
                  </div>
                  <small className="gc-popover-tool">{toolLabel(m.tool)} · {modelName(m)}</small>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    )}
  </div>;
}
