import { ExecutionPanel, formatPathSummary } from "./execution-panel.js";
import { TaskInteraction } from "./interactions.js";
import {
  RuntimeFailureNotice,
  runtimeFailureForTask,
} from "./components/RuntimeFailureNotice.js";
import { DeliveryStrip, EnvironmentSummary } from "./workbench.js";
import guideText from "../../../docs/guide/使用指南.md?raw";
import { TaskTree, TestResults } from "./panels.js";
import { useNativeProgress } from "./native-progress.js";
import { CreateWorkflowModal } from "./components/CreateWorkflowModal.js";
import { ToolModelDialog } from "./components/ToolModelDialog.js";
import {
  SettingsDialog,
  type SettingsTabId,
} from "./components/SettingsDialog.js";
import { CurrentRuntime } from "./components/CurrentRuntime.js";
import { WorkflowAttentionBanner } from "./components/WorkflowAttentionBanner.js";
import { WorkflowOverview } from "./components/WorkflowOverview.js";
import { WorkflowArchiveAction } from "./components/WorkflowArchiveAction.js";
import { formatWorkflowState } from "../../../packages/presentation/src/workflow-status.js";
import { useEventCatchup } from "./use-event-catchup.js";
import { RequirementComposer } from "./components/RequirementComposer.js";
import { SourceChangeDialog } from "./components/SourceChangeDialog.js";
import {
  PlanReviewDialog,
  type PlanReviewTarget,
} from "./components/PlanReviewDialog.js";
import { PlanApprovalDialog } from "./components/PlanApprovalDialog.js";
import { type ApprovalTarget } from "./components/plan-approval-api.js";
import { AgyAccountsDialog } from "./components/AgyAccountsDialog.js";
import { AgyAccountsPage } from "./components/AgyAccountsPage.js";
import {
  SubagentWorkCard,
  readWorkCardPreference,
} from "./components/SubagentWorkCard.js";
import { ConversationBreadcrumb } from "./components/ConversationBreadcrumb.js";
import {
  ConversationRequestGuard,
  useConversationView,
} from "./use-conversation-view.js";
import {
  unknownSubagentCapabilities,
  type ConversationAttempt,
  type ConversationNode,
  type SubagentCapabilities,
} from "../../../packages/contracts/src/conversation.js";
import type { LogEntry } from "./logs.js";
import React, { useEffect, useRef, useState } from "react";

import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import mermaid from "mermaid";
import "./style.css";
import "./components/model-settings.css";
import {
  readableLogs,
  userFacingLogs,
  mergeEvents,
  workflowProgress,
} from "./logs.js";
import {
  getExecutionSpec,
  resumeContinueLabel,
} from "./components/model-api.js";
const labels: Record<string, string> = {
  RESEARCHING: "调研中",
  PLANNING: "规划中",
  INTEGRATING: "整合代码中",
  CLEANUP_PENDING: "等待清理工作树",
  COMPLETED: "已完成",
  PLAN_PENDING: "等待计划批准",
  QUEUED: "排队中",
  EXECUTING: "实施中",
  VERIFYING: "交接审查",
  HUMAN_PENDING: "等待你的验收",
  REVIEW_QUEUED: "等待代码审查",
  REVIEWING: "代码审查中",
  REPAIR_PLAN_PENDING: "等待修复计划批准",
  REPAIR_RESEARCH_REQUIRED: "需要补充调研",
  COMMITTING: "提交中",
  COMMITTED: "已提交",
  COMMIT_PARTIAL: "提交需要恢复",
  STOPPING: "正在暂停",
  STOPPED: "已暂停",
  BLOCKED: "需要处理",
  RECOVERY_REQUIRED: "需要恢复检查",
  WAITING_AUTHORIZATION: "等待操作授权",
  WAITING_INPUT: "等待你的指导",
};
async function api(path: string, body?: unknown, signal?: AbortSignal) {
  const r = await fetch("/api" + path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const result = await r.json();
  if (!r.ok) throw Error(result.error?.message ?? "请求失败");
  return result;
}
const PAUSE_CONTROL_POLL_MS = 1000;
const PAUSE_CONTROL_POLL_LIMIT = 12;

function pauseControlNotice(control: {
  status?: string;
  message?: string;
} | null | undefined): string {
  if (control?.status === "complete") return "主会话及子 Agent 已暂停";
  if (control?.status === "partial") {
    return control.message ?? "部分会话已暂停，仍有状态待确认";
  }
  return control?.message ?? "暂停已受理，尚未全部确认";
}

async function pollConversationControl(
  workflowId: string,
  controlId: string,
  initial: { status?: string; message?: string },
) {
  let current = initial;
  for (let attempt = 0; attempt < PAUSE_CONTROL_POLL_LIMIT; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, PAUSE_CONTROL_POLL_MS));
    try {
      current = await api(
        `/workflows/${workflowId}/conversation-controls/${controlId}`,
      );
    } catch {
      break;
    }
    if (current?.status === "complete" || current?.status === "partial") {
      break;
    }
  }
  return current;
}
const mermaidSvgCache = new Map<string, string>();

let mermaidInitialized = false;
function ensureMermaidInitialized() {
  if (!mermaidInitialized) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "neutral",
      fontFamily: "Microsoft YaHei, sans-serif",
    });
    mermaidInitialized = true;
  }
}

function downloadSvgAsPng(
  svgElement: SVGSVGElement,
  filename: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const clone = svgElement.cloneNode(true) as SVGSVGElement;
      if (!clone.getAttribute("xmlns")) {
        clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      }
      const bBox = svgElement.getBoundingClientRect();
      const width = Math.ceil(
        bBox.width || parseFloat(clone.getAttribute("width") || "800"),
      );
      const height = Math.ceil(
        bBox.height || parseFloat(clone.getAttribute("height") || "500"),
      );
      clone.setAttribute("width", String(width));
      clone.setAttribute("height", String(height));

      const svgString = new XMLSerializer().serializeToString(clone);
      const svgBlob = new Blob([svgString], {
        type: "image/svg+xml;charset=utf-8",
      });
      const url = URL.createObjectURL(svgBlob);

      const img = new Image();
      img.onload = () => {
        const scale = 2; // 2x Retina 高清输出
        const canvas = document.createElement("canvas");
        canvas.width = width * scale;
        canvas.height = height * scale;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.scale(scale, scale);
          ctx.drawImage(img, 0, 0, width, height);
          canvas.toBlob((blob) => {
            if (blob) {
              const a = document.createElement("a");
              a.download = filename;
              a.href = URL.createObjectURL(blob);
              a.click();
              URL.revokeObjectURL(a.href);
              resolve(true);
            } else {
              resolve(false);
            }
          }, "image/png");
        } else {
          resolve(false);
        }
        URL.revokeObjectURL(url);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(false);
      };
      img.src = url;
    } catch {
      resolve(false);
    }
  });
}

const Diagram = React.memo(function Diagram({ source }: { source: string }) {
  const [svg, setSvg] = useState<string>(
    () => mermaidSvgCache.get(source) ?? "",
  );
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!fullscreen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [fullscreen]);

  useEffect(() => {
    let alive = true;
    if (mermaidSvgCache.has(source)) {
      setSvg(mermaidSvgCache.get(source)!);
      setError("");
      return;
    }
    ensureMermaidInitialized();
    setError("");
    const id = "diagram" + crypto.randomUUID().replaceAll("-", "");
    mermaid
      .render(id, source)
      .then(({ svg: renderedSvg }) => {
        mermaidSvgCache.set(source, renderedSvg);
        if (alive) {
          setSvg(renderedSvg);
          setError("");
        }
      })
      .catch(() => {
        if (alive) setError("图表语法有误，请在批准前修正。");
      });
    return () => {
      alive = false;
    };
  }, [source]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 容错处理
    }
  };

  const handleDownload = async () => {
    if (!containerRef.current) return;
    const svgEl = containerRef.current.querySelector("svg");
    if (!svgEl) return;
    setDownloading(true);
    await downloadSvgAsPng(svgEl, `mermaid-diagram-${Date.now()}.png`);
    setDownloading(false);
  };

  if (error) return <p className="error">{error}</p>;

  if (svg) {
    return (
      <>
        <div className="diagram-wrapper" ref={containerRef}>
          <div className="diagram-toolbar" aria-label="图表操作">
            <button
              className="diagram-action-btn"
              onClick={handleCopy}
              title="复制 Mermaid 原始代码"
            >
              <span className="btn-icon">{copied ? "✓" : "📋"}</span>
              <span className="btn-label">{copied ? "已复制" : "复制"}</span>
            </button>
            <button
              className="diagram-action-btn"
              onClick={handleDownload}
              disabled={downloading}
              title="下载 PNG 图片"
            >
              <span className="btn-icon">{downloading ? "⏳" : "📥"}</span>
              <span className="btn-label">
                {downloading ? "生成中…" : "下载"}
              </span>
            </button>
            <button
              className="diagram-action-btn"
              onClick={() => setFullscreen(true)}
              title="在浏览器全屏浏览"
            >
              <span className="btn-icon">⛶</span>
              <span className="btn-label">全屏</span>
            </button>
          </div>
          <div className="diagram" dangerouslySetInnerHTML={{ __html: svg }} />
        </div>

        {fullscreen && (
          <div
            className="diagram-lightbox-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Mermaid 图表全屏浏览"
            onClick={() => setFullscreen(false)}
          >
            <div
              className="diagram-lightbox-content"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="diagram-lightbox-header">
                <span className="lightbox-title">Mermaid 图表全屏浏览</span>
                <div className="lightbox-actions">
                  <button
                    className="diagram-action-btn"
                    onClick={handleCopy}
                    title="复制 Mermaid 原始代码"
                  >
                    <span>{copied ? "✓ 已复制" : "📋 复制代码"}</span>
                  </button>
                  <button
                    className="diagram-action-btn"
                    onClick={handleDownload}
                    disabled={downloading}
                    title="下载 PNG 图片"
                  >
                    <span>{downloading ? "⏳ 生成中…" : "📥 下载 PNG"}</span>
                  </button>
                  <button
                    className="diagram-action-btn close-btn"
                    onClick={() => setFullscreen(false)}
                    title="关闭全屏 (ESC)"
                  >
                    ✕ 退出全屏
                  </button>
                </div>
              </div>
              <div
                className="diagram-lightbox-body"
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            </div>
          </div>
        )}
      </>
    );
  }
  return <div className="diagram" style={{ minHeight: "40px" }} />;
});

function extractTextFromChildren(children: any): string {
  if (!children) return "";
  if (typeof children === "string") return children;
  if (Array.isArray(children))
    return children.map(extractTextFromChildren).join("");
  if (children.props?.children)
    return extractTextFromChildren(children.props.children);
  return "";
}

function slugifyHeading(text: string): string {
  const clean = text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "");
  return encodeURIComponent(clean) || "section";
}

const headingRenderer = (level: number) => {
  return ({ children, ...props }: any) => {
    const text = extractTextFromChildren(children).replace(/[*_`[\]]/g, "");
    const id = slugifyHeading(text);
    const Tag = `h${level}` as any;
    return (
      <Tag id={id} {...props}>
        {children}
      </Tag>
    );
  };
};

const markdownComponents = {
  h1: headingRenderer(1),
  h2: headingRenderer(2),
  h3: headingRenderer(3),
  h4: headingRenderer(4),
  code: ({ className, children, ...props }: any) =>
    className === "language-mermaid" ? (
      <Diagram source={String(children)} />
    ) : (
      <code className={className} {...props}>
        {children}
      </code>
    ),
  a: ({ children, ...props }: any) => (
    <a {...props} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
};

const Document = React.memo(function Document({ text }: { text: string }) {
  return (
    <div className="document">
      <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {text}
      </Markdown>
    </div>
  );
});

interface TocItem {
  id: string;
  text: string;
  level: number;
}

function extractToc(markdown: string): TocItem[] {
  if (!markdown) return [];
  const lines = markdown.split("\n");
  const items: TocItem[] = [];
  const seen = new Map<string, number>();

  for (const line of lines) {
    const match = line.match(/^(#{1,4})\s+(.+)$/);
    if (match && match[1] && match[2]) {
      const level = match[1].length;
      const rawText = match[2].trim().replace(/[*_`[\]]/g, "");
      let slug = slugifyHeading(rawText);
      const count = seen.get(slug) ?? 0;
      seen.set(slug, count + 1);
      if (count > 0) {
        slug = `${slug}-${count}`;
      }
      items.push({ id: slug, text: rawText, level });
    }
  }
  return items;
}

interface ParsedDiffLine {
  type: "hunk" | "add" | "del" | "context" | "meta";
  oldNum?: number | string;
  newNum?: number | string;
  prefix: string;
  content: string;
}

function parseDiff(diffText: string): {
  lines: ParsedDiffLine[];
  additions: number;
  deletions: number;
} {
  if (!diffText) return { lines: [], additions: 0, deletions: 0 };
  const rawLines = diffText.split("\n");
  const lines: ParsedDiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let additions = 0;
  let deletions = 0;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]!;
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
    if (hunkMatch) {
      oldLine = parseInt(hunkMatch[1]!, 10);
      newLine = parseInt(hunkMatch[2]!, 10);
      lines.push({
        type: "hunk",
        prefix: "",
        content: line,
      });
      continue;
    }

    if (
      line.startsWith("---") ||
      line.startsWith("+++") ||
      line.startsWith("diff --git") ||
      line.startsWith("index ")
    ) {
      lines.push({
        type: "meta",
        prefix: "",
        content: line,
      });
      continue;
    }

    if (line.startsWith("+")) {
      additions++;
      lines.push({
        type: "add",
        oldNum: "",
        newNum: newLine++,
        prefix: "+",
        content: line.slice(1),
      });
    } else if (line.startsWith("-")) {
      deletions++;
      lines.push({
        type: "del",
        oldNum: oldLine++,
        newNum: "",
        prefix: "-",
        content: line.slice(1),
      });
    } else {
      lines.push({
        type: "context",
        oldNum: oldLine > 0 ? oldLine++ : "",
        newNum: newLine > 0 ? newLine++ : "",
        prefix: " ",
        content: line.startsWith(" ") ? line.slice(1) : line,
      });
    }
  }

  return { lines, additions, deletions };
}

interface CodeDiffFileItem {
  repo_id: string;
  path: string;
  status: string;
  branch: string;
  baseline: string;
  frozen: boolean;
}

interface CodeDiffPanelProps {
  diff: any[];
  selected: string;
  pending: boolean;
  refreshDiff: () => Promise<void>;
  attempt: (fn: () => Promise<unknown>) => Promise<void>;
  setFileDiff: (fileDiff: any) => void;
  setNotice?: (notice: string) => void;
}

function CodeDiffPanel({
  diff,
  selected,
  pending,
  refreshDiff,
  attempt,
  setFileDiff,
  setNotice,
}: CodeDiffPanelProps) {
  const allFiles = React.useMemo(() => {
    const list: CodeDiffFileItem[] = [];
    for (const d of diff ?? []) {
      for (const f of d.files ?? []) {
        list.push({
          repo_id: d.repo_id,
          path: f.path,
          status: f.status,
          branch: d.branch,
          baseline: d.baseline,
          frozen: !!d.frozen,
        });
      }
    }
    return list;
  }, [diff]);

  const [selectedFile, setSelectedFile] = useState<CodeDiffFileItem | null>(
    null,
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<"tree" | "flat">("tree");
  const [collapsedFolders, setCollapsedFolders] = useState<
    Record<string, boolean>
  >({});
  const [inlineDiff, setInlineDiff] = useState<{
    path: string;
    branch?: string;
    baseline?: string;
    diff: string;
    loading: boolean;
    truncated?: boolean;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  const diffCache = useRef<Record<string, any>>({});

  useEffect(() => {
    if (!allFiles.length) {
      setSelectedFile(null);
      setInlineDiff(null);
      return;
    }
    setSelectedFile((current) => {
      if (
        current &&
        allFiles.some(
          (f) => f.repo_id === current.repo_id && f.path === current.path,
        )
      ) {
        return current;
      }
      return allFiles[0] ?? null;
    });
  }, [allFiles]);

  useEffect(() => {
    if (!selectedFile) {
      setInlineDiff(null);
      return;
    }
    const cacheKey = `${selectedFile.repo_id}:${selectedFile.path}`;
    if (diffCache.current[cacheKey]) {
      setInlineDiff(diffCache.current[cacheKey]);
      return;
    }

    let active = true;
    setInlineDiff({
      path: selectedFile.path,
      branch: selectedFile.branch,
      baseline: selectedFile.baseline,
      diff: "",
      loading: true,
    });

    api(
      `/workflows/${selected}/diff?repo_id=${encodeURIComponent(selectedFile.repo_id)}&path=${encodeURIComponent(selectedFile.path)}`,
    )
      .then((result) => {
        if (!active) return;
        diffCache.current[cacheKey] = result;
        setInlineDiff(result);
      })
      .catch((err) => {
        if (!active) return;
        setInlineDiff({
          path: selectedFile.path,
          branch: selectedFile.branch,
          baseline: selectedFile.baseline,
          diff: `读取差异失败: ${err.message ?? String(err)}`,
          loading: false,
        });
      });

    return () => {
      active = false;
    };
  }, [selectedFile, selected]);

  const openModalDiff = (file: CodeDiffFileItem) => {
    void attempt(async () => {
      const loading = {
        path: file.path,
        branch: file.branch,
        baseline: file.baseline,
        loading: true,
      };
      setFileDiff(loading);
      try {
        const cacheKey = `${file.repo_id}:${file.path}`;
        const result =
          diffCache.current[cacheKey] ??
          (await api(
            `/workflows/${selected}/diff?repo_id=${encodeURIComponent(file.repo_id)}&path=${encodeURIComponent(file.path)}`,
          ));
        diffCache.current[cacheKey] = result;
        setFileDiff((current: any) => (current === loading ? result : current));
      } catch (error) {
        setFileDiff((current: any) => (current === loading ? null : current));
        throw error;
      }
    });
  };

  const filteredFiles = React.useMemo(() => {
    if (!searchQuery.trim()) return allFiles;
    const q = searchQuery.toLowerCase().trim();
    return allFiles.filter((f) => f.path.toLowerCase().includes(q));
  }, [allFiles, searchQuery]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if (!filteredFiles.length) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const currentIndex = selectedFile
          ? filteredFiles.findIndex(
              (f) =>
                f.repo_id === selectedFile.repo_id &&
                f.path === selectedFile.path,
            )
          : -1;
        let nextIndex = 0;
        if (e.key === "ArrowDown") {
          nextIndex =
            currentIndex < filteredFiles.length - 1 ? currentIndex + 1 : 0;
        } else {
          nextIndex =
            currentIndex > 0 ? currentIndex - 1 : filteredFiles.length - 1;
        }
        setSelectedFile(filteredFiles[nextIndex] ?? null);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [filteredFiles, selectedFile]);

  const stats = React.useMemo(() => {
    let added = 0;
    let modified = 0;
    let deleted = 0;
    for (const f of allFiles) {
      if (f.status === "A") added++;
      else if (f.status === "D") deleted++;
      else modified++;
    }
    return { total: allFiles.length, added, modified, deleted };
  }, [allFiles]);

  const treeGroups = React.useMemo(() => {
    const map: Record<string, CodeDiffFileItem[]> = {};
    for (const file of filteredFiles) {
      const parts = file.path.split("/");
      const folder =
        parts.length > 1
          ? parts.slice(0, Math.min(2, parts.length - 1)).join("/")
          : "root";
      if (!map[folder]) map[folder] = [];
      map[folder].push(file);
    }
    return map;
  }, [filteredFiles]);

  const parsedDiff = React.useMemo(() => {
    return parseDiff(inlineDiff?.diff ?? "");
  }, [inlineDiff?.diff]);

  const copyPath = () => {
    if (!selectedFile) return;
    navigator.clipboard?.writeText(selectedFile.path);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    if (setNotice) setNotice(`已复制路径: ${selectedFile.path}`);
  };

  const statusMap: Record<
    string,
    { label: string; textClass: string; bgClass: string; title: string }
  > = {
    A: {
      label: "A",
      textClass: "status-tag-add",
      bgClass: "status-pill-add",
      title: "新增文件",
    },
    M: {
      label: "M",
      textClass: "status-tag-mod",
      bgClass: "status-pill-mod",
      title: "修改文件",
    },
    D: {
      label: "D",
      textClass: "status-tag-del",
      bgClass: "status-pill-del",
      title: "删除文件",
    },
    T: {
      label: "T",
      textClass: "status-tag-type",
      bgClass: "status-pill-type",
      title: "类型变化",
    },
  };

  const parseBranch = (branch?: string) => {
    if (!branch) return { display: "工作区", full: "", isWorktree: false };
    const match = branch.match(/^devflow\/[^/]+\/(.+)$/);
    if (match) {
      return {
        display: match[1],
        full: branch,
        isWorktree: true,
      };
    }
    return {
      display: branch,
      full: branch,
      isWorktree: false,
    };
  };

  const firstRepo = diff[0];
  const branchInfo = parseBranch(firstRepo?.branch);
  const isWorktree = firstRepo?.owned ?? branchInfo.isWorktree;

  return (
    <div className="diff-workbench-container">
      {/* 顶部元信息与统计概览条 */}
      <div className="diff-header-bar">
        <div className="diff-meta-info">
          <div
            className="diff-branch-badge"
            title={
              branchInfo.isWorktree
                ? `当前分支: ${branchInfo.display} (隔离分支: ${branchInfo.full})`
                : `当前分支: ${branchInfo.display}`
            }
          >
            <span className="diff-branch-icon">⎇</span>
            <span className="diff-branch-name">{branchInfo.display}</span>
            {firstRepo?.frozen ? (
              <span className="badge VERIFYING">测试版本</span>
            ) : isWorktree ? (
              <span
                className="badge VERIFYING"
                title="运行在独立 Worktree 隔离工作区"
              >
                Worktree 副本
              </span>
            ) : (
              <span className="badge COMMITTED" title="运行在本地主仓库工作区">
                主工作区
              </span>
            )}
          </div>
          <div className="diff-baseline-info">
            对比任务开始前提交 <code>{firstRepo?.baseline?.slice(0, 8)}</code>
          </div>
        </div>

        <div className="diff-header-actions">
          <div className="diff-stats-pill">
            <span className="stat-count">
              共 <strong>{stats.total}</strong> 个文件变更
            </span>
            {stats.added > 0 && (
              <span className="stat-add">+{stats.added} 新增</span>
            )}
            {stats.modified > 0 && (
              <span className="stat-mod">{stats.modified} 修改</span>
            )}
            {stats.deleted > 0 && (
              <span className="stat-del">-{stats.deleted} 删除</span>
            )}
          </div>
          <button
            className="diff-refresh-btn"
            onClick={() => void attempt(refreshDiff)}
            disabled={pending}
          >
            {pending ? "正在读取…" : "刷新文件列表"}
          </button>
        </div>
      </div>

      {allFiles.length === 0 ? (
        <div className="empty" style={{ padding: "48px 0" }}>
          {pending ? "正在读取变更文件…" : "当前无代码变更文件"}
        </div>
      ) : (
        /* SourceTree + GitHub 左右分栏工作区 */
        <div className="diff-layout-split">
          {/* 左侧：文件变更导航面板 */}
          <div className="diff-sidebar">
            <div className="diff-sidebar-toolbar">
              <div className="diff-search-box">
                <input
                  type="text"
                  placeholder="搜索文件名或路径..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="diff-search-input"
                />
                {searchQuery && (
                  <button
                    className="diff-search-clear"
                    onClick={() => setSearchQuery("")}
                    title="清空"
                  >
                    ×
                  </button>
                )}
              </div>

              <div className="diff-view-switcher">
                <div className="diff-switcher-buttons">
                  <button
                    className={`switcher-btn ${viewMode === "tree" ? "active" : ""}`}
                    onClick={() => setViewMode("tree")}
                    title="按目录树展示"
                  >
                    树状
                  </button>
                  <button
                    className={`switcher-btn ${viewMode === "flat" ? "active" : ""}`}
                    onClick={() => setViewMode("flat")}
                    title="平铺全部文件"
                  >
                    列表
                  </button>
                </div>
                <span className="diff-match-count">
                  {filteredFiles.length} / {allFiles.length}
                </span>
              </div>
            </div>

            {/* 文件列表容器：保留 .changed-files 类名供自动化测试选择 */}
            <div className="changed-files diff-files-list">
              {filteredFiles.length === 0 ? (
                <div className="diff-no-matches">未匹配到符合条件的文件</div>
              ) : viewMode === "flat" ? (
                /* 扁平列表 */
                filteredFiles.map((f) => {
                  const isSelected =
                    selectedFile?.repo_id === f.repo_id &&
                    selectedFile?.path === f.path;
                  const parts = f.path.split("/");
                  const fileName = parts.pop();
                  const dirPath = parts.length ? parts.join("/") + "/" : "";
                  const statusInfo = statusMap[f.status] ?? {
                    label: f.status || "M",
                    textClass: "status-tag-mod",
                    bgClass: "status-pill-mod",
                    title: "文件变更",
                  };

                  return (
                    <button
                      type="button"
                      key={f.repo_id + ":" + f.path}
                      className={`diff-file-card diff-file-card-flat ${isSelected ? "active" : ""}`}
                      onClick={() => setSelectedFile(f)}
                      title={`${statusInfo.title} · ${f.path}`}
                    >
                      <span
                        className={`diff-status-badge diff-status-badge-lg ${statusInfo.bgClass}`}
                        aria-label={statusInfo.title}
                      >
                        {statusInfo.label}
                      </span>
                      <div className="diff-file-meta">
                        <span className="diff-file-name" title={f.path}>
                          {fileName}
                        </span>
                        {dirPath && (
                          <span className="diff-file-dir" title={dirPath}>
                            {dirPath}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })
              ) : (
                /* 树状分组 */
                Object.keys(treeGroups).map((folder) => {
                  const isCollapsed = !!collapsedFolders[folder];
                  const items = treeGroups[folder]!;

                  return (
                    <div key={folder} className="diff-tree-group">
                      <div
                        className="diff-folder-header"
                        onClick={() =>
                          setCollapsedFolders((prev) => ({
                            ...prev,
                            [folder]: !prev[folder],
                          }))
                        }
                      >
                        <span
                          className={`folder-arrow ${isCollapsed ? "collapsed" : ""}`}
                        >
                          ▾
                        </span>
                        <span className="folder-icon">📁</span>
                        <span className="folder-name">{folder}/</span>
                        <span className="folder-badge">{items.length}</span>
                      </div>

                      {!isCollapsed && (
                        <div className="diff-folder-children">
                          {items.map((f) => {
                            const isSelected =
                              selectedFile?.repo_id === f.repo_id &&
                              selectedFile?.path === f.path;
                            const fileName = f.path.split("/").pop();
                            const statusInfo = statusMap[f.status] ?? {
                              label: f.status || "M",
                              textClass: "status-tag-mod",
                              bgClass: "status-pill-mod",
                              title: "文件变更",
                            };

                            return (
                              <button
                                type="button"
                                key={f.repo_id + ":" + f.path}
                                className={`diff-file-card tree-child ${isSelected ? "active" : ""}`}
                                onClick={() => setSelectedFile(f)}
                                title={`${statusInfo.title} · ${f.path}`}
                              >
                                <span
                                  className={`diff-status-badge ${statusInfo.bgClass}`}
                                  aria-label={statusInfo.title}
                                >
                                  {statusInfo.label}
                                </span>
                                <div className="diff-file-meta">
                                  <span
                                    className="diff-file-name"
                                    title={f.path}
                                  >
                                    {fileName}
                                  </span>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            <div className="diff-sidebar-footer">
              <span>单击选定 · 支持 ↑ / ↓ 键切换</span>
            </div>
          </div>

          {/* 右侧：主 Diff 代码检视器 (GitHub 风格) */}
          <div className="diff-inspector">
            {selectedFile ? (
              <>
                {/* 检视器头部 */}
                <div className="diff-inspector-head">
                  <div className="diff-file-headline">
                    <span
                      className={`diff-status-tag ${
                        statusMap[selectedFile.status]?.textClass ??
                        "status-tag-mod"
                      }`}
                      title={statusMap[selectedFile.status]?.title}
                    >
                      {statusMap[selectedFile.status]?.label ?? "M"}
                    </span>
                    <span className="diff-full-path">{selectedFile.path}</span>
                  </div>

                  <div className="diff-head-actions">
                    <div className="diff-line-counts">
                      <span className="stat-add">+{parsedDiff.additions}</span>
                      <span className="stat-del">-{parsedDiff.deletions}</span>
                    </div>

                    <button
                      className="diff-head-btn"
                      onClick={copyPath}
                      title="复制完整路径"
                    >
                      {copied ? "已复制" : "复制路径"}
                    </button>

                    <button
                      className="diff-head-btn primary"
                      onClick={() => openModalDiff(selectedFile)}
                      title="全屏大屏查看"
                    >
                      全屏审查 ↗
                    </button>
                  </div>
                </div>

                {/* 代码差异渲染区域：带有 file-diff 类名供测试与样式匹配 */}
                <div className="diff-code-scroll file-diff">
                  {inlineDiff?.loading ? (
                    <div className="diff-loading-state">
                      <div className="diff-spinner" />
                      <span>正在读取文件差异…</span>
                    </div>
                  ) : !inlineDiff?.diff ? (
                    <div className="diff-empty-state">该文件无差异内容</div>
                  ) : (
                    <div className="diff-table-container">
                      <div className="diff-lines-flow">
                        {parsedDiff.lines.map((line, idx) => {
                          if (line.type === "hunk") {
                            return (
                              <span
                                key={idx}
                                className="diff-line-row diff-row-hunk"
                              >
                                <i className="hunk-header-cell">
                                  {line.content}
                                </i>
                              </span>
                            );
                          }
                          if (line.type === "meta") {
                            return (
                              <span
                                key={idx}
                                className="diff-line-row diff-row-meta"
                              >
                                <i className="meta-header-cell">
                                  {line.content}
                                </i>
                              </span>
                            );
                          }

                          const isAdd = line.type === "add";
                          const isDel = line.type === "del";

                          return (
                            <span
                              key={idx}
                              className={`diff-line-row ${
                                isAdd
                                  ? "diff-row-add added"
                                  : isDel
                                    ? "diff-row-del removed"
                                    : "diff-row-context"
                              }`}
                            >
                              <i className="diff-num-col old-col select-none">
                                {line.oldNum || ""}
                              </i>
                              <i className="diff-num-col new-col select-none">
                                {line.newNum || ""}
                              </i>
                              <i className="diff-sign-col select-none">
                                {line.prefix}
                              </i>
                              <code className="diff-content-col">
                                {line.content || " "}
                              </code>
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {inlineDiff?.truncated && (
                    <div className="diff-truncated-banner">
                      文件过大，显示部分差异；完整内容请在本地编辑器查看。
                    </div>
                  )}
                </div>

                <div className="diff-inspector-foot">
                  <span>UTF-8 · LF</span>
                  <span
                    title={
                      selectedFile.branch
                        ? `分支引用: ${selectedFile.branch} · 起始代码版本: ${selectedFile.baseline}`
                        : undefined
                    }
                  >
                    {parseBranch(selectedFile.branch).display} ·{" "}
                    {selectedFile.baseline?.slice(0, 8)}
                  </span>
                </div>
              </>
            ) : (
              <div className="diff-no-selection">
                请在左侧选择要查看差异的文件
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface CentralWorkspaceProps {
  selected: string;
  tab: string;
  setTab: (tab: string) => void;
  w: any;
  detail: any;
  diff: any[];
  pending: boolean;
  projects?: any[];
  refreshDiff: () => Promise<void>;
  refresh: () => Promise<void>;
  setFileDiff: (f: any) => void;
  attempt: (fn: () => Promise<unknown>) => Promise<void>;
  setNotice: (notice: string) => void;
}

const CentralWorkspace = React.memo(
  function CentralWorkspace({
    selected,
    tab,
    setTab,
    w,
    detail,
    diff,
    pending,
    projects = [],
    refreshDiff,
    refresh,
    setFileDiff,
    attempt,
    setNotice,
  }: CentralWorkspaceProps) {
    const [showToc, setShowToc] = useState(true);
    const [planFullscreen, setPlanFullscreen] = useState(false);

    useEffect(() => {
      if (!planFullscreen) return;
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") setPlanFullscreen(false);
      };
      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }, [planFullscreen]);

    const planMarkdown = detail.plan?.plan?.markdown ?? "";
    const tocItems = React.useMemo(
      () => extractToc(planMarkdown),
      [planMarkdown],
    );

    const scrollToHeading = (id: string) => {
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    };

    return (
      <div className="central-workspace">
        <div className="tabs">
          {[
            ["overview", "概览"],
            ["plan", "开发计划"],
            ["tasks", "任务进度"],
            ["tests", "测试结果"],
            ["diff", "代码变更"],
            ["review", "代码复核"],
            ["environment", "本机验证副本"],
          ].map(([key, title]) => (
            <button
              key={key}
              className={tab === key ? "active" : ""}
              onClick={() => {
                setTab(key!);
              }}
            >
              {title}
            </button>
          ))}
        </div>
        <div
          className={`module-body ${tab === "diff" ? "module-body-diff" : ""}`}
          key={selected + tab}
        >
          {tab === "overview" && (
            <WorkflowOverview
              workflow={w}
              overview={detail.overview}
              projectName={projects.find((p) => p.id === w.project_id)?.name}
              onOpenPlan={() => setTab("plan")}
              onOpenTasks={() => setTab("tasks")}
              onOpenTests={() => setTab("tests")}
            />
          )}
          {tab === "plan" && (
            <section
              className={`panel plan-panel ${planFullscreen ? "plan-fullscreen-active" : ""}`}
            >
              <div className="section-title plan-section-title">
                <div className="plan-title-left">
                  <h2>开发计划 · 第 {w.plan_revision} 版</h2>
                  {detail.plan && (
                    <button
                      className={`btn-secondary btn-toc-toggle ${showToc ? "active" : ""}`}
                      onClick={() => setShowToc(!showToc)}
                      title={showToc ? "收起文档大纲" : "展开文档大纲"}
                    >
                      <span className="btn-icon">📑</span>
                      <span>{showToc ? "收起大纲" : "文档大纲"}</span>
                    </button>
                  )}
                </div>
                <div className="plan-title-actions">
                  {detail.plan && (
                    <button
                      className="btn-secondary btn-fullscreen-toggle"
                      onClick={() => setPlanFullscreen(!planFullscreen)}
                      title={
                        planFullscreen
                          ? "退出全屏浏览 (ESC)"
                          : "全屏查看开发计划"
                      }
                    >
                      <span className="btn-icon">
                        {planFullscreen ? "✕" : "⛶"}
                      </span>
                      <span>{planFullscreen ? "退出全屏" : "全屏查看"}</span>
                    </button>
                  )}
                  {detail.executor_plan_check && (
                    <a
                      className="download-link"
                      href={`/api/workflows/${selected}/documents/plan-self-check`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      查看计划自查记录
                    </a>
                  )}
                  {w.plan_revision > 0 && (
                    <a
                      className="download-link"
                      href={`/api/workflows/${selected}/documents/plan?format=markdown&download=1`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      下载 Markdown
                    </a>
                  )}
                </div>
              </div>

              {detail.plan ? (
                <div className={`plan-viewer-body ${showToc ? "has-toc" : ""}`}>
                  {showToc && (
                    <aside className="plan-toc-sidebar" aria-label="文档大纲">
                      <div className="toc-header">
                        <span className="toc-title">目录导航</span>
                        <span className="toc-count">
                          {tocItems.length} 个章节
                        </span>
                      </div>
                      <div className="toc-items-container">
                        {tocItems.length > 0 ? (
                          <ul className="toc-list">
                            {tocItems.map((item, idx) => (
                              <li
                                key={idx}
                                className={`toc-item level-${item.level}`}
                              >
                                <button
                                  className="toc-link-btn"
                                  onClick={() => scrollToHeading(item.id)}
                                  title={item.text}
                                >
                                  <span className="toc-bullet" />
                                  <span className="toc-text">{item.text}</span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <div className="toc-empty">未发现标题章节</div>
                        )}
                      </div>
                    </aside>
                  )}
                  <div className="plan-content-area">
                    <Document text={detail.plan.plan.markdown} />
                    <details className="plan-runtime-details">
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
                  </div>
                </div>
              ) : (
                <div className="empty">
                  计划尚未提交。先由 GPT-6 完成调研和任务拆解。
                </div>
              )}
            </section>
          )}
          {tab === "tasks" && (
            <section className="panel">
              <TaskTree detail={detail} title="任务进度" />
            </section>
          )}
          {tab === "tests" && (
            <section className="panel">
              <TestResults detail={detail} title="测试结果" />
            </section>
          )}
          {tab === "diff" && (
            <section className="panel diff-panel-wrapper">
              <CodeDiffPanel
                diff={diff}
                selected={selected}
                pending={pending}
                refreshDiff={refreshDiff}
                attempt={attempt}
                setFileDiff={setFileDiff}
                setNotice={setNotice}
              />
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
                    <p className="mono">快照：{detail.review.snapshot_id}</p>
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
                <h2>本机验证副本</h2>
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
              <EnvironmentSummary detail={detail} />
              {detail.environment && (
                <>
                  {w.state === "HUMAN_PENDING" && (
                    <div className="actions">
                      <button
                        onClick={() =>
                          void attempt(async () => {
                            await api(
                              `/workflows/${selected}/browser/lock`,
                              {},
                            );
                            setNotice("已保留共享浏览器，完成场景后请释放。");
                          })
                        }
                      >
                        占用人工核验浏览器
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
                        释放人工核验浏览器
                      </button>
                    </div>
                  )}
                </>
              )}
            </section>
          )}
        </div>
      </div>
    );
  },
  (prev, next) => {
    return (
      prev.selected === next.selected &&
      prev.tab === next.tab &&
      prev.w?.state === next.w?.state &&
      prev.w?.plan_revision === next.w?.plan_revision &&
      prev.w?.version === next.w?.version &&
      prev.w?.title === next.w?.title &&
      prev.w?.request === next.w?.request &&
      prev.detail?.runs === next.detail?.runs &&
      prev.detail?.plan === next.detail?.plan &&
      prev.detail?.tasks === next.detail?.tasks &&
      prev.detail?.test_progress === next.detail?.test_progress &&
      prev.detail?.review === next.detail?.review &&
      prev.detail?.environment === next.detail?.environment &&
      prev.diff === next.diff &&
      prev.pending === next.pending
    );
  },
);

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
    [rawDetail, setDetail] = useState<any>(null),
    [tab, setTab] = useState(
      () =>
        sessionStorage.getItem(
          "devflow.tab." +
            (new URLSearchParams(location.search).get("workflow") ?? ""),
        ) || "overview",
    ),
    [modal, setModal] = useState(""),
    [text, setText] = useState(""),
    [pending, setPending] = useState(false),
    [scope, setScope] = useState("within_plan"),
    [diff, setDiff] = useState<any[]>([]);
  const detail = useNativeProgress(rawDetail);
  const [planReview, setPlanReview] = useState<PlanReviewTarget | null>(null);
  const [planApprovalTarget, setPlanApprovalTarget] = useState<any | null>(null);
  const [sourceChange, setSourceChange] = useState<{
    workflowId: string;
    version: number;
  } | null>(null);
  useEffect(() => {
    setPlanReview(null);
    setPlanApprovalTarget(null);
    setSourceChange(null);
  }, [selected]);
  useEffect(() => {
    const url = new URL(location.href);
    if (selected) url.searchParams.set("workflow", selected);
    else {
      url.searchParams.delete("workflow");
      url.searchParams.delete("conversation");
    }
    if (showGuide) url.searchParams.set("view", "guide");
    else url.searchParams.delete("view");
    history.replaceState(null, "", url);
  }, [selected, showGuide]);
  const eventCursor = useRef(0);
  const eventBuffer = useRef<any[]>([]);
  const selection = useRef(selected);
  selection.current = selected;
  const [sidebarPrefs, setSidebarPrefs] = useState<Record<string, boolean>>(
    () => JSON.parse(localStorage.getItem("devflow.sidebar") ?? "{}"),
  );
  const [sidebarWidth, setSidebarWidth] = useState(
    () => Number(localStorage.getItem("devflow.sidebarWidth")) || 380,
  );
  const [seen, setSeen] = useState<Record<string, number>>({});
  const [locate, setLocate] = useState<{ sequence: number; request: number }>();
  const [stopping, setStopping] = useState(false);
  const [workCardExpanded, setWorkCardExpanded] = useState(false);
  const [childEntries, setChildEntries] = useState<LogEntry[]>([]);
  const [childHasMore, setChildHasMore] = useState(false);
  const childGuard = useRef(new ConversationRequestGuard());
  const [updated, setUpdated] = useState(false);
  useEffect(() => {
    let alive = true;
    const check = () =>
      void fetch("/", { cache: "no-store" })
        .then((r) => r.text())
        .then((html) => {
          const current = document
            .querySelector<HTMLScriptElement>('script[type="module"][src]')
            ?.getAttribute("src");
          if (
            alive &&
            current &&
            !html.includes(current) &&
            html.includes('type="module"')
          )
            setUpdated(true);
        })
        .catch(() => {});
    window.addEventListener("focus", check);
    const interval = setInterval(check, 60000);
    return () => {
      alive = false;
      clearInterval(interval);
      window.removeEventListener("focus", check);
    };
  }, []);
  useEffect(() => {
    if (selected) sessionStorage.setItem("devflow.tab." + selected, tab);
  }, [tab, selected]);
  const [connected, setConnected] = useState(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isToolDrawerOpen, setIsToolDrawerOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTabId>("models");
  const [toolDrawerFocus, setToolDrawerFocus] = useState<string | undefined>();
  const [resumeLabel, setResumeLabel] = useState<string | null>(null);
  const [isAgyAccountsDrawerOpen, setIsAgyAccountsDrawerOpen] = useState(false);
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
  const refreshDiff = async () => {
    const result = await api(`/workflows/${selected}/diff`);
    if (selection.current === selected) setDiff(result);
  };
  useEffect(() => {
    if (selected && tab === "diff") void attempt(refreshDiff);
  }, [selected, tab]);
  const detailCache = useRef(new Map<string, any>());
  const savedCursors = useRef(new Map<string, number>());
  const fetchVisibleFlows = () => api("/workflows?visibility=visible");
  const refresh = async () => {
    const key = selected;
    const [p, f, next, tree] = await Promise.all([
      api("/projects"),
      fetchVisibleFlows(),
      key ? api("/workflows/" + key) : Promise.resolve(null),
      key ? loadConversationTree(key) : Promise.resolve(null),
    ]);
    setProjects(p);
    setFlows(f);
    if (next && selection.current === key)
      setDetail((previous: any) => {
        const current = previous?.workflow.id === key ? previous : null;
        if (current?.workflow.version > next.workflow.version) return current;
        const merged = {
          ...next,
          conversation_tree: tree ?? next.conversation_tree,
          events: mergeEvents(
            key,
            current?.events ?? [],
            next.events,
            eventBuffer.current,
          ),
        };
        detailCache.current.set(key, merged);
        return merged;
      });
  };
  useEffect(() => {
    void Promise.all([api("/projects"), fetchVisibleFlows()])
      .then(([p, f]) => {
        setProjects(p);
        setFlows(f);
      })
      .catch((e) => setError(String(e)));
  }, []);
  useEffect(() => {
    if (!selected) return;
    const abort = new AbortController();
    const cached = detailCache.current.get(selected);
    setDetail(cached ?? null);
    void (async () => {
      const summary = await api(
        `/workflows/${selected}?view=summary`,
        undefined,
        abort.signal,
      );
      if (abort.signal.aborted || selection.current !== selected) return;
      setDetail((previous: any) =>
        previous?.workflow.id === selected &&
        !previous.loading &&
        previous.workflow.version === summary.workflow.version
          ? previous
          : summary,
      );
      const next = await api(`/workflows/${selected}`, undefined, abort.signal);
      if (abort.signal.aborted || selection.current !== selected) return;
      const tree = await loadConversationTree(selected, abort.signal);
      if (abort.signal.aborted || selection.current !== selected) return;
      setDetail((previous: any) => {
        const current = previous?.workflow.id === selected ? previous : null;
        if (current?.workflow.version > next.workflow.version) return current;
        const result = {
          ...next,
          conversation_tree: tree ?? next.conversation_tree,
          events: mergeEvents(
            selected,
            current?.events ?? [],
            next.events,
            eventBuffer.current,
          ),
        };
        detailCache.current.set(selected, result);
        if (detailCache.current.size > 10)
          detailCache.current.delete(detailCache.current.keys().next().value!);
        return result;
      });
    })().catch((e) => {
      if (!abort.signal.aborted) setError(String(e));
    });
    return () => abort.abort();
  }, [selected]);
  useEffect(() => {
    let disposed = false,
      socket: WebSocket,
      retry: ReturnType<typeof setTimeout>,
      debounce: ReturnType<typeof setTimeout>;
    const update = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        void Promise.all([api("/projects"), api("/workflows?visibility=visible")])
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
    eventCursor.current = savedCursors.current.get(selected) ?? 0;
    eventBuffer.current = [];
    let ws: WebSocket,
      disposed = false,
      timer: ReturnType<typeof setTimeout>,
      refreshTimer: ReturnType<typeof setTimeout> | undefined,
      streamTimer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      ws = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/events?workflow_id=${selected}&after=${eventCursor.current}&tail=100`,
      );
      (window as any).__eventWs = ws;
      ws.onopen = () => {
        if (!disposed) setConnected(true);
      };
      ws.onmessage = (e) => {
        if (disposed || selection.current !== selected) return;
        const event = JSON.parse(e.data);
        if (event.workflow_id !== selected) return;
        eventCursor.current = Math.max(eventCursor.current, event.event_seq);
        savedCursors.current.set(selected, eventCursor.current);
        eventBuffer.current.push(event);
        if (eventBuffer.current.length > 5000)
          eventBuffer.current.splice(0, eventBuffer.current.length - 5000);
        if (!streamTimer)
          streamTimer = setTimeout(() => {
            streamTimer = undefined;
            if (disposed) return;
            setDetail((previous: any) => {
              if (previous?.workflow.id !== selected) return previous;
              const next = {
                ...previous,
                events: mergeEvents(
                  selected,
                  previous.events,
                  eventBuffer.current,
                ),
              };
              detailCache.current.set(selected, next);
              return next;
            });
          }, 500);
        // Stream output immediately. Only domain changes need an HTTP refresh;
        // a continuous token stream must never postpone displaying the log.
        if (
          !refreshTimer &&
          ![
            "AgentEvent",
            "NativeActivity",
            "RunObserved",
            "AgentDiagnostic",
            "CheckOutput",
            "BuildOutput",
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
        if (disposed) return;
        setConnected(false);
        if (!disposed) timer = setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(refreshTimer);
      clearTimeout(streamTimer);
      ws?.close();
    };
  }, [selected]);
  useEventCatchup(selected, !!detail && !Object.hasOwn(detail, "runtime"), api, (events) => {
    setDetail((previous: any) => {
      if (previous?.workflow.id !== selected) return previous;
      const next = { ...previous, events: mergeEvents(selected, previous.events, events) };
      detailCache.current.set(selected, next);
      return next;
    });
  });
  const approve = async (
    action: "approve" | "accept",
    target?: ApprovalTarget,
    instructionsText?: string,
    instructionsHash?: string,
    requestId?: string,
  ) => {
    const viewed = target ?? (detail?.workflow?.id === selected ? detail.workflow : null);
    if (!viewed)
      throw Error("请先打开计划或验收内容。");

    const trimmed = instructionsText?.trim() ?? "";
    const reqBody: any = {
      schema_version: 2,
      request_id: requestId || crypto.randomUUID(),
      binding: {
        workflow_id: viewed.workflowId ?? viewed.id,
        action,
        version: viewed.workflowVersion ?? viewed.version,
        plan_revision: viewed.planRevision ?? viewed.plan_revision,
        plan_hash: viewed.planHash ?? viewed.plan_hash ?? null,
        snapshot_id: viewed.snapshotId ?? viewed.snapshot_id ?? null,
        environment_revision: viewed.environmentRevision ?? viewed.environment_revision,
        extra: trimmed && instructionsHash
          ? {
              execution_instructions_hash: instructionsHash,
            }
          : {},
      },
    };

    if (trimmed) {
      reqBody.execution_instructions = {
        text: trimmed,
        scope: "approved-plan",
      };
    }

    const targetWorkflowId = viewed.workflowId ?? viewed.id;
    await api(`/workflows/${targetWorkflowId}/${action}`, reqBody);
    await refresh();
    setNotice(
      action === "approve"
        ? "计划已批准，进入执行队列。"
        : "验收已记录，将启动独立复核。",
    );
  };
  const stopSelected = () => {
    setStopping(true);
    void api(`/workflows/${selected}/stop`, {})
      .then(refresh)
      .catch((e) => setError(String(e)))
      .finally(() => setStopping(false));
  };
  const pauseAllConversations = async (
    rootId: string,
    generation: number,
  ) => {
    if (!selected || !rootId) return;
    setStopping(true);
    try {
      const control = await api(`/workflows/${selected}/conversation-controls`, {
        request_id: crypto.randomUUID(),
        action: "pause",
        root_id: rootId,
        expected_generation: generation,
      });
      const controlId = control?.control_id ?? control?.control?.id;
      const settled =
        control?.status === "pending" && controlId
          ? await pollConversationControl(selected, controlId, control)
          : control;
      setNotice(pauseControlNotice(settled));
      await api(`/workflows/${selected}/stop`, {}).catch(() => {});
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setStopping(false);
    }
  };
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setFileDiff(null);
        setModal("");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  const w = detail?.workflow.id === selected ? detail.workflow : undefined;
  useEffect(() => {
    if (!selected || w?.state !== "STOPPED") {
      setResumeLabel(null);
      return;
    }
    const controller = new AbortController();
    getExecutionSpec(selected, controller.signal)
      .then((data) => setResumeLabel(resumeContinueLabel(data.resume_target)))
      .catch(() => setResumeLabel(null));
    return () => controller.abort();
  }, [selected, w?.state, w?.version]);
  const runtimeResolution = w ? runtimeFailureForTask(detail) : undefined;
  // Old controllers may still be finishing an active run while the new UI is served.
  const attention = runtimeResolution
    ? {
        category: "error",
        message: `${runtimeResolution.title}：${runtimeResolution.message}`,
        action: "查看处理方法",
        at: w.updated_at,
      }
    : w && ["STOPPED", "STOPPING"].includes(w.state)
      ? {
          category: "paused" as const,
          message:
            w.state === "STOPPING"
              ? "正在暂停执行"
              : w.blocker?.code === "MODEL_QUOTA" ||
                  detail.attention?.category === "queue"
                ? "已暂停，到点后不会自动继续。"
                : "执行已暂停，等待处理",
          action: "查看执行过程",
          at: w.updated_at,
        }
    : detail?.attention !== undefined
      ? detail.attention
      : !w
        ? null
        : w.state === "BLOCKED"
          ? {
              category: "error",
              message: w.blocker?.message ?? "执行遇到问题",
              at: w.updated_at,
              action: "查看执行过程",
            }
          : ["STOPPED", "STOPPING", "RECOVERY_REQUIRED"].includes(w.state)
            ? {
                category: w.state === "RECOVERY_REQUIRED" ? "error" : "paused",
                message:
                  w.state === "STOPPING"
                    ? "正在暂停执行"
                    : w.state === "RECOVERY_REQUIRED"
                      ? "服务重启后，需要核实中断的执行再继续"
                      : "执行已暂停，等待处理",
                at: w.updated_at,
                action: "查看执行过程",
              }
            : ["PLAN_PENDING", "REPAIR_PLAN_PENDING"].includes(w.state)
              ? {
                  category: "approval",
                  message: "等待你确认开发计划",
                  at: w.updated_at,
                  action: "查看开发计划",
                }
              : w.state === "HUMAN_PENDING"
                ? {
                    category: "acceptance",
                    message: "等待你实际操作验收",
                    at: w.updated_at,
                    action: "查看本机验证副本",
                  }
                : null;
  const progress = w ? workflowProgress(w, detail.events, {
    native: detail.plan?.plan?.task_model === "native-v2",
    humanAccepted: detail.human_accepted,
  }) : undefined;
  const timeline = w
    ? userFacingLogs(readableLogs(detail.events, selected), w.run_id)
    : [];
  const conversationTree = detail?.conversation_tree;
  const conversationView = useConversationView({
    workflowId: selected,
    nodes: (conversationTree?.nodes ?? []) as ConversationNode[],
    attempts: (conversationTree?.attempts ?? []) as ConversationAttempt[],
    activeRootConversationId: conversationTree?.active_root_id,
    entries: timeline,
    search: location.search,
  });
  useEffect(() => {
    if (!selected || !conversationView.rootConversationId) {
      setWorkCardExpanded(false);
      return;
    }
    setWorkCardExpanded(
      readWorkCardPreference(selected, conversationView.rootConversationId) ===
        "expanded",
    );
  }, [selected, conversationView.rootConversationId]);
  useEffect(() => {
    if (
      !selected ||
      !conversationView.isChildView ||
      !conversationView.selectedConversationId
    ) {
      setChildEntries([]);
      setChildHasMore(false);
      return;
    }
    const req = childGuard.current.start(
      selected,
      conversationView.selectedConversationId,
    );
    void api(
      `/workflows/${selected}/conversations/${conversationView.selectedConversationId}/activities?limit=100`,
    )
      .then((page) => {
        if (!req.accept()) return;
        setChildEntries(asConversationLogEntries(page.items));
        setChildHasMore(Boolean(page.has_more));
      })
      .catch(() => {
        if (req.accept()) setChildEntries([]);
      });
  }, [
    selected,
    conversationView.isChildView,
    conversationView.selectedConversationId,
    conversationTree?.cursor,
  ]);
  const phaseStart =
    [...(detail?.events ?? [])]
      .reverse()
      .find((e: any) => e.type === "StateChanged")?.event_seq ?? 0;
  const latest = timeline
    .filter(
      (e) =>
        ![
          "RESEARCHING",
          "REPAIR_RESEARCH_REQUIRED",
          "PLAN_PENDING",
          "REPAIR_PLAN_PENDING",
        ].includes(w?.state) &&
        e.sequence >= phaseStart &&
        e.kind !== "diagnostic" &&
        e.title !== "阶段更新",
    )
    .at(-1);
  const sidebarOpen =
    sidebarPrefs[selected] ??
    [
      "EXECUTING",
      "VERIFYING",
      "WAITING_AUTHORIZATION",
      "WAITING_INPUT",
    ].includes(w?.state);
  useEffect(() => {
    if (["WAITING_AUTHORIZATION", "WAITING_INPUT"].includes(w?.state))
      setSidebarPrefs((previous) => ({ ...previous, [selected]: true }));
  }, [selected, w?.state]);
  const toggleSidebar = (open: boolean) => {
    setSidebarPrefs((previous) => {
      const next = { ...previous, [selected]: open };
      localStorage.setItem("devflow.sidebar", JSON.stringify(next));
      return next;
    });
    if (!open) setLocate(undefined);
  };
  const unreadEntries = timeline.filter(
    (e) => e.kind !== "diagnostic" && e.sequence > (seen[selected] ?? 0),
  );
  const resizeSidebar = (value: number) => {
    const width = Math.max(320, Math.min(520, value));
    setSidebarWidth(width);
    localStorage.setItem("devflow.sidebarWidth", String(width));
  };
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
    <div
      className={"layout " + (selected && !showGuide ? "workbench" : "")}
      style={
        { "--execution-width": `${sidebarWidth}px` } as React.CSSProperties
      }
    >
      <aside>
        <div className="brand">
          <span className="mark">D</span>
          <span className="brand-text">DevFlow</span>
        </div>
        <button
          className={!selected && !showGuide ? "nav active" : "nav"}
          onClick={() => {
            setShowGuide(false);
            setSelected("");
            setDetail(null);
          }}
        >
          <span className="nav-icon">◫</span> 工作流总览
        </button>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            paddingRight: "10px",
          }}
        >
          <div className="nav-heading" style={{ marginBottom: 0 }}>
            项目
          </div>
          <button
            type="button"
            className="btn-create-workflow-compact"
            onClick={() => setIsCreateModalOpen(true)}
            style={{
              background: "var(--color-primary, #0969da)",
              color: "#ffffff",
              border: "none",
              borderRadius: "4px",
              padding: "2px 8px",
              fontSize: "11px",
              cursor: "pointer",
            }}
          >
            + 新建
          </button>
        </div>
        <div className="project-list-nav">
          {projects
            .filter((p) => flows.some((f) => f.project_id === p.id))
            .map((p) => (
              <div key={p.id} className="project-nav">
                <span className="project-name">▱ {p.name}</span>
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
                      setTab(
                        sessionStorage.getItem("devflow.tab." + f.id) ||
                          "overview",
                      );
                      setDiff([]);
                      setFileDiff(null);
                      setLocate(undefined);
                    }}
                  >
                    <i className={"dot " + f.state} />
                    <span className="flow-title-text">{f.title}</span>
                  </button>
                ))}
            </div>
          ))}
        </div>
        <div className="sidebar-bottom">
          <button
            className="nav"
            aria-label="AGY 账号管理"
            onClick={() => setIsAgyAccountsDrawerOpen(true)}
          >
            <span className="nav-icon" aria-hidden="true">
              👥
            </span>{" "}
            AGY 账号
          </button>
          <button
            className={"nav " + (showGuide ? "active" : "")}
            aria-label="使用指南"
            onClick={() => setShowGuide(true)}
          >
            <span className="nav-icon" aria-hidden="true">
              📖
            </span>{" "}
            使用指南
          </button>
          <button
            className={"nav " + (isSettingsOpen ? "active" : "")}
            aria-label="设置"
            onClick={() => {
              setSettingsTab("models");
              setIsSettingsOpen(true);
            }}
          >
            <span className="nav-icon" aria-hidden="true">
              ⚙️
            </span>{" "}
            设置
          </button>
          <div className="connection-status">
            <span className={"dot " + (connected ? "COMMITTED" : "")} />{" "}
            <span className="connection-status-text">
              {selected
                ? connected
                  ? "实时连接已建立"
                  : "正在连接事件流"
                : "本机工作台"}
            </span>
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
            <div className="header-title-wrapper">
              <h1 title={w?.title}>
                {showGuide
                  ? "使用指南"
                  : selected
                    ? (w?.title ??
                      flows.find((f) => f.id === selected)?.title ??
                      "加载中…")
                    : "工作流总览"}
              </h1>
              {w && (
                <span className={"badge " + w.state}>
                  <span className="badge-dot" />
                  {detail.queue?.kind === "preparing"
                    ? w.workspace_mode === "existing_workspace"
                      ? "检查主工作区"
                      : "准备独立工作区"
                    : w.state === "BLOCKED" &&
                        w.blocker?.code === "MODEL_QUOTA" &&
                        detail.attention?.category === "queue"
                      ? "等待模型额度"
                      : w.stage === "auto_repair"
                        ? "准备自动修复"
                        : formatWorkflowState(w.state)}
                </span>
              )}
            </div>
          </div>
          <div className="header-aside">
            {w && !showGuide && (
              <CurrentRuntime
                detail={detail}
                connected={connected}
                onEdit={(role) => {
                  setToolDrawerFocus(role);
                  setIsToolDrawerOpen(true);
                }}
              />
            )}
          </div>
        </header>
        {updated && (
          <div className="update-banner">
            界面已更新 · <button onClick={() => location.reload()}>刷新</button>
            {text && "（反馈尚未保存，请先保存）"}
          </div>
        )}
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
        {selected && !w && !showGuide && (
          <div className="workflow-bar">
            <small>正在读取任务详情…</small>
            {flows.some(
              (f) =>
                f.id === selected &&
                ![
                  "COMMITTED",
                  "COMMITTING",
                  "COMMIT_PARTIAL",
                  "STOPPED",
                ].includes(f.state),
            ) && (
              <button
                className="danger"
                disabled={stopping}
                onClick={stopSelected}
              >
                {stopping ? "正在暂停…" : "暂停"}
              </button>
            )}
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
                        setTab(
                          sessionStorage.getItem("devflow.tab." + f.id) ||
                            "overview",
                        );
                        setDiff([]);
                        setFileDiff(null);
                        setLocate(undefined);
                      }}
                    >
                      <div>
                        <span className="project-label">
                          {projects.find((p) => p.id === f.project_id)?.name}
                        </span>
                        <span className={"badge " + f.state}>
                          {formatWorkflowState(f.state)}
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
            <div
              className={
                "workflow-workbench-layout " +
                (sidebarOpen ? "with-execution" : "")
              }
            >
              <div className="workflow-main-column">
                <div className="workflow-top-deck">
                  {progress && (
                    <div className="compact-progress" aria-label="当前执行进度">
                      <ol className="stage-track" aria-label={progress.title}>
                        {progress.stages.map((name, index) => {
                          const isDone = progress.done[index];
                          const isCurrent =
                            !progress.completed && index === progress.index;
                          return (
                            <li
                              key={name}
                              aria-current={isCurrent ? "step" : undefined}
                              className={
                                isCurrent ? "current" : isDone ? "past" : ""
                              }
                            >
                              <span className="step-circle">
                                {isDone ? "✓" : index + 1}
                              </span>
                              <span className="step-name">{name}</span>
                              {isCurrent && progress.paused ? " · 暂停" : ""}
                            </li>
                          );
                        })}
                      </ol>
                      <div className="compact-summary">
                        <DeliveryStrip detail={detail} />
                        {latest && (
                          <button
                            className="latest-activity"
                            title={
                              latest.command?.split(/\r?\n/, 1)[0] ||
                              latest.text ||
                              latest.title
                            }
                            onClick={() => {
                              toggleSidebar(true);
                              setLocate({
                                sequence: latest.sequence,
                                request: Date.now(),
                              });
                            }}
                          >
                            <span className="activity-pulse-dot" />
                            <span className="activity-text">
                              <b>{latest.title}</b>
                              {latest.text
                                ? ` · ${(latest.command?.split(/\r?\n/, 1)[0] ?? formatPathSummary(latest.text, 65)).replace(/\s+/g, " ")}`
                                : ""}
                            </span>
                            <time>
                              {new Date(latest.created_at).toLocaleTimeString()}
                            </time>
                          </button>
                        )}
                        <div className="compact-summary-actions">
                          <div className="actions">
                            {[
                              "BLOCKED",
                              "STOPPED",
                              "RECOVERY_REQUIRED",
                              "COMMIT_PARTIAL",
                            ].includes(w.state) &&
                              !runtimeResolution &&
                              attention?.category !== "source_change" && (
                                <button
                                  className="btn-secondary"
                                  disabled={pending}
                                  onClick={() =>
                                    void attempt(async () => {
                                      if (
                                        w.state === "BLOCKED" &&
                                        [
                                          "REPAIR_PLAN_INCOMPLETE",
                                          "REVIEW_COMPLETION_EXHAUSTED",
                                          "REVIEW_INCOMPLETE",
                                        ].includes(w.blocker?.code)
                                      ) {
                                        await api(
                                          `/workflows/${selected}/review/retry`,
                                          {},
                                        );
                                        await refresh();
                                        return;
                                      }
                                      await api(
                                        `/workflows/${selected}/browser/reconcile`,
                                        {},
                                      );
                                      await api(
                                        `/workflows/${selected}/environment/stop`,
                                        {},
                                      ).catch(() => {});
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
                                    : [
                                          "REPAIR_PLAN_INCOMPLETE",
                                          "REVIEW_COMPLETION_EXHAUSTED",
                                          "REVIEW_INCOMPLETE",
                                        ].includes(w.blocker?.code)
                                      ? "继续审查"
                                      : w.blocker?.code === "MODEL_QUOTA"
                                        ? "立即重试"
                                        : w.state === "STOPPED" && resumeLabel
                                          ? resumeLabel
                                          : "继续这个任务"}
                                </button>
                              )}
                            {attention?.category === "source_change" && (
                              <button
                                className="primary"
                                disabled={pending}
                                onClick={() =>
                                  setSourceChange({
                                    workflowId: w.id,
                                    version: w.version,
                                  })
                                }
                              >
                                处理代码更新
                              </button>
                            )}
                            {["PLAN_PENDING", "REPAIR_PLAN_PENDING"].includes(
                              w.state,
                            ) && (
                              <>
                                <button
                                  className="primary"
                                  disabled={pending}
                                  onClick={() => setPlanApprovalTarget(w)}
                                >
                                  批准当前计划
                                </button>
                                <button
                                  className="btn-secondary"
                                  disabled={pending}
                                  onClick={() =>
                                    setPlanReview({
                                      workflow_id: w.id,
                                      expected_version: w.version,
                                      plan_revision: w.plan_revision,
                                      plan_hash: w.plan_hash,
                                      mode: "reject",
                                    })
                                  }
                                >
                                  驳回并修正
                                </button>
                              </>
                            )}
                            {w.plan_revision > 0 && (
                              <button
                                className="btn-secondary"
                                disabled={pending}
                                onClick={() =>
                                  setPlanReview({
                                    workflow_id: w.id,
                                    expected_version: w.version,
                                    plan_revision: w.plan_revision,
                                    plan_hash: w.plan_hash,
                                    mode: "question",
                                  })
                                }
                              >
                                计划问答
                              </button>
                            )}
                            {w.state === "HUMAN_PENDING" && (
                              <button
                                className="primary"
                                disabled={pending}
                                onClick={() =>
                                  void attempt(() => approve("accept"))
                                }
                              >
                                验收通过，启动复核
                              </button>
                            )}

                            {[
                              "QUEUED",
                              "EXECUTING",
                              "VERIFYING",
                              "REVIEW_QUEUED",
                              "REVIEWING",
                              "STOPPING",
                            ].includes(w.state) && (
                              <button
                                className="danger"
                                disabled={stopping || w.state === "STOPPING"}
                                onClick={stopSelected}
                              >
                                {stopping || w.state === "STOPPING"
                                  ? "正在暂停…"
                                  : "暂停"}
                              </button>
                            )}
                            <button
                              className="secondary"
                              onClick={() => setIsToolDrawerOpen(true)}
                              aria-label="工具与模型"
                              title="查看或安全修改当前任务的工具与模型配置"
                              style={{
                                padding: "6px 12px",
                                borderRadius: "6px",
                                border:
                                  "1px solid var(--color-border-default, #d0d7de)",
                                background: "var(--color-btn-bg, #f6f8fa)",
                                cursor: "pointer",
                                fontSize: "13px",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "4px",
                              }}
                            >
                              <span>🛠️</span>
                              <span>工具与模型</span>
                            </button>
                            <WorkflowArchiveAction
                              workflowId={w.id}
                              workflowTitle={w.title}
                              onArchived={(archivedId) => {
                                if (selection.current === archivedId) {
                                  setSelected("");
                                }
                                void refresh();
                                setNotice(
                                  "任务已移入归档，可在“设置 -> 归档”中随时查看或恢复。",
                                );
                              }}
                            />
                          </div>
                          {!sidebarOpen && (
                            <button
                              className="execution-toggle"
                              aria-label="执行过程"
                              aria-expanded={false}
                              onClick={() => toggleSidebar(true)}
                            >
                              <span className="toggle-icon">⚡</span>
                              执行过程
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                  <WorkflowAttentionBanner
                    attention={attention}
                    workflowId={w.id}
                    workflowVersion={w.version}
                    onOpenPlan={() => setTab("plan")}
                    onOpenSourceChange={() =>
                      setSourceChange({
                        workflowId: w.id,
                        version: w.version,
                      })
                    }
                    onOpenEnvironment={() => setTab("environment")}
                    onOpenGuidance={() => {
                      toggleSidebar(true);
                      window.dispatchEvent(new Event("devflow-open-guidance"));
                    }}
                  />
                </div>
                <RuntimeFailureNotice
                  key={w.id}
                  detail={detail}
                  send={api}
                  refresh={refresh}
                />
                <div className="workspace-columns">
                  {detail.loading ? (
                    <section className="panel" role="status">
                      正在加载任务明细，状态和操作已可用…
                    </section>
                  ) : (
                    <CentralWorkspace
                      selected={selected}
                      tab={tab}
                      setTab={setTab}
                      w={w}
                      detail={detail}
                      diff={diff}
                      pending={pending}
                      projects={projects}
                      refreshDiff={refreshDiff}
                      refresh={refresh}
                      setFileDiff={setFileDiff}
                      attempt={attempt}
                      setNotice={setNotice}
                    />
                  )}
                </div>
              </div>
              {sidebarOpen && (
                <ExecutionPanel
                  key={selected}
                  interaction={
                    <TaskInteraction
                      key={selected}
                      detail={detail}
                      send={api}
                      refresh={refresh}
                      selectedConversationId={
                        conversationView.selectedConversationId
                      }
                      rootConversationId={conversationView.rootConversationId}
                      expectedGeneration={latestConversationGeneration(
                        conversationTree?.attempts,
                        conversationView.rootConversationId,
                      )}
                    />
                  }
                  footer={
                    conversationView.rootConversationId ? (
                      <SubagentWorkCard
                        workflowId={selected}
                        rootConversationId={conversationView.rootConversationId}
                        expanded={workCardExpanded}
                        nodes={conversationTree?.nodes ?? []}
                        attempts={conversationTree?.attempts ?? []}
                        capabilities={
                          (conversationTree?.capabilities as
                            | SubagentCapabilities
                            | undefined) ?? unknownSubagentCapabilities()
                        }
                        onToggle={() => setWorkCardExpanded(true)}
                        onCollapse={() => setWorkCardExpanded(false)}
                        onSelect={conversationView.selectConversation}
                        onPauseAll={() =>
                          void pauseAllConversations(
                            conversationView.rootConversationId,
                            latestConversationGeneration(
                              conversationTree?.attempts,
                              conversationView.rootConversationId,
                            ),
                          )
                        }
                      />
                    ) : undefined
                  }
                  breadcrumb={
                    <ConversationBreadcrumb
                      items={conversationView.breadcrumb}
                      onSelect={conversationView.selectConversation}
                    />
                  }
                  viewedRuntime={conversationView.viewedRuntimeText}
                  notice={conversationView.notice}
                  workflowId={selected}
                  conversationId={conversationView.selectedConversationId}
                  isChildView={conversationView.isChildView}
                  loadHistory={
                    conversationView.isChildView
                      ? childHasMore
                        ? async () => {
                            const oldest = childEntries[0]?.sequence;
                            if (!oldest || !conversationView.selectedConversationId)
                              return;
                            const page = await api(
                              `/workflows/${selected}/conversations/${conversationView.selectedConversationId}/activities?before_seq=${oldest}&limit=100`,
                            );
                            setChildEntries((previous) => [
                              ...asConversationLogEntries(page.items),
                              ...previous,
                            ]);
                            setChildHasMore(Boolean(page.has_more));
                          }
                        : undefined
                      : detail.history_cursor === null
                        ? undefined
                        : async () => {
                            const oldest =
                              detail.history_cursor ??
                              detail.events?.[0]?.event_seq;
                            if (!oldest) return;
                            await attempt(async () => {
                              const history = await api(
                                `/workflows/${selected}/history?before=${oldest}&limit=100`,
                              );
                              if (selection.current === selected)
                                setDetail((previous: any) => ({
                                  ...previous,
                                  history_cursor: history.next_before,
                                  events: [...history.events, ...previous.events],
                                }));
                            });
                          }
                  }
                  entries={
                    conversationView.isChildView
                      ? childEntries
                      : (conversationView.entries as LogEntry[])
                  }
                  connected={connected}
                  width={sidebarWidth}
                  resize={resizeSidebar}
                  locate={locate}
                  close={() => toggleSidebar(false)}
                  read={(sequence) =>
                    setSeen((previous) =>
                      previous[selected] === sequence
                        ? previous
                        : { ...previous, [selected]: sequence },
                    )
                  }
                />
              )}
            </div>
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
              <RequirementComposer
                initialText={text}
                disabled={pending}
                submitLabel="保存并继续"
                placeholder="问题反馈；输入 @ 引用文件或文件夹"
                fetchReferences={async (query) =>
                  (
                    await api(
                      "/workspaces/references?workflow_id=" +
                        encodeURIComponent(selected) +
                        "&query=" +
                        encodeURIComponent(query),
                    )
                  ).items
                }
                onSubmit={async (text, refs) => {
                  const current = await api("/workflows/" + selected);
                  const endpoint =
                    scope === "within_plan" &&
                    current.workflow.state === "HUMAN_PENDING" &&
                    current.plan?.plan?.task_model === "native-v2"
                      ? "functional-issues"
                      : "feedback";
                  await api("/workflows/" + selected + "/" + endpoint, {
                    request_id: crypto.randomUUID(),
                    text,
                    refs,
                    scope,
                  });
                  setModal("");
                  await refresh();
                  window.dispatchEvent(new Event("devflow-activity"));
                }}
              />
            </>

            {error && <div className="error">{error}</div>}
          </section>
        </div>
      )}
      {sourceChange && (
        <SourceChangeDialog
          key={sourceChange.workflowId}
          {...sourceChange}
          onClose={() => setSourceChange(null)}
          onResolved={(choice) => {
            setSourceChange(null);
            setNotice(
              choice === "continue"
                ? "已确认使用当前代码，将按原计划继续执行。"
                : "规划模型将结合当前代码修正计划，新版仍需你批准。",
            );
            void refresh().catch((e) => setError(String(e)));
          }}
        />
      )}
      {planReview && (
        <PlanReviewDialog
          key={`${planReview.workflow_id}:${planReview.plan_revision}:${planReview.mode}`}
          target={planReview}
          onClose={() => setPlanReview(null)}
          onRejected={() => {
            setPlanReview(null);
            setNotice(
              "计划已驳回，规划模型将按修改意见提交新版，等待你重新批准。",
            );
            void refresh().catch((e) => setError(String(e)));
          }}
        />
      )}
      {planApprovalTarget && (
        <PlanApprovalDialog
          key={`${planApprovalTarget.id}:${planApprovalTarget.plan_revision}`}
          isOpen={!!planApprovalTarget}
          onClose={() => setPlanApprovalTarget(null)}
          workflowId={planApprovalTarget.id}
          workflowVersion={planApprovalTarget.version}
          planRevision={planApprovalTarget.plan_revision}
          planHash={planApprovalTarget.plan_hash}
          snapshotId={planApprovalTarget.snapshot_id}
          environmentRevision={planApprovalTarget.environment_revision}
          planTitle={detail?.plan?.plan?.title}
          planSummary={detail?.plan?.plan?.summary}
          executorProfileDescription={
            detail?.execution_spec?.resolvedRoles?.executor
              ? `${detail.execution_spec.resolvedRoles.executor.profile.adapterId} · ${detail.execution_spec.resolvedRoles.executor.profile.modelId}`
              : undefined
          }
          onApprove={async (target, instructionsText, instructionsHash, requestId) => {
            await approve("approve", target, instructionsText, instructionsHash, requestId);
            setPlanApprovalTarget(null);
          }}
        />
      )}
      <CreateWorkflowModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onCreated={(id) => {
          setSelected(id);
          void refresh();
        }}
        defaultWorkspaceRoot={
          detail?.project?.repositories?.[0]?.path ??
          projects[0]?.repositories?.[0]?.path ??
          ""
        }
        fetchReferences={async (query, workspaceRoot) => {
          try {
            const data = await api(
              `/workspaces/references?workspace_root=${encodeURIComponent(workspaceRoot)}&query=${encodeURIComponent(query)}`,
            );
            return data.items ?? [];
          } catch {
            return [];
          }
        }}
      />
      <ToolModelDialog
        isOpen={isToolDrawerOpen}
        onClose={() => {
          setIsToolDrawerOpen(false);
          setToolDrawerFocus(undefined);
        }}
        workflowId={selected}
        workflowState={detail?.workflow?.state}
        focusRole={toolDrawerFocus}
        onSpecUpdated={() => void refresh()}
      />
      <SettingsDialog
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        initialTab={settingsTab}
        onDefaultsUpdated={() => void refresh()}
        onSelectWorkflow={(workflowId) => {
          setSelected(workflowId);
          setIsSettingsOpen(false);
        }}
        onWorkflowRestored={() => void refresh()}
      />
      <AgyAccountsDialog
        isOpen={isAgyAccountsDrawerOpen}
        onClose={() => setIsAgyAccountsDrawerOpen(false)}
      />
    </div>
  );
}

async function loadConversationTree(workflowId: string, signal?: AbortSignal) {
  try {
    return await api(
      `/workflows/${workflowId}/conversations`,
      undefined,
      signal,
    );
  } catch {
    return null;
  }
}

function latestConversationGeneration(
  attempts: ConversationAttempt[] | undefined,
  rootId?: string,
): number {
  if (!attempts?.length || !rootId) return 0;
  return (
    attempts
      .filter((item) => item.conversation_id === rootId)
      .sort((a, b) => a.generation - b.generation)
      .at(-1)?.generation ?? 0
  );
}

function asConversationLogEntries(items: unknown): LogEntry[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const row = item as Record<string, unknown>;
      return {
        key: String(row.key ?? `${row.conversation_id}:${row.sequence}`),
        sequence: Number(row.sequence ?? 0),
        created_at: String(row.created_at ?? ""),
        title: String(row.title ?? "会话活动"),
        text: String(row.text ?? ""),
        raw: [row],
        kind:
          row.kind === "tool" ||
          row.kind === "message" ||
          row.kind === "event" ||
          row.kind === "diagnostic"
            ? row.kind
            : "event",
        status:
          row.status === "active" ||
          row.status === "done" ||
          row.status === "error" ||
          row.status === "interrupted"
            ? row.status
            : undefined,
        command: typeof row.command === "string" ? row.command : undefined,
      } satisfies LogEntry;
    });
}

const root = createRoot(document.getElementById("root")!);
async function mountApplication() {
  if (window.location.pathname.replace(/\/$/, "") === "/accounts") {
    root.render(<AgyAccountsPage />);
    return;
  }
  try {
    const response = await fetch("/api/health");
    if (!response.ok) throw new Error("无法读取服务模式");
    const health = await response.json();
    root.render(health.mode === "accounts" ? <AgyAccountsPage /> : <App />);
  } catch (error) {
    root.render(<div role="alert">{error instanceof Error ? error.message : "服务暂不可用"}</div>);
  }
}
void mountApplication();
