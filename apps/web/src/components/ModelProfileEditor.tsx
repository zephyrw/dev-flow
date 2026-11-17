import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  TOOL_DISPLAY_ORDER,
  type ModelEntry,
  type SupportedAdapterId,
  type ToolProfile,
} from "../../../../packages/contracts/src/index.js";
import {
  formatToolName,
  formatModelName,
  formatEffortDisplayLabel,
  isHydrogenModelDisplayId,
  isEquivalentModelName,
  buildModelChoices,
  type ModelChoice,
} from "../../../../packages/presentation/src/model-display.js";
import {
  cloneProfile,
  formatApiError,
  getAdapterModels,
  modelCatalogNeedsRefresh,
  refreshAdapterModels,
  isVerifyAbort,
  type AccessState,
  type ApiError,
  verifyModelAccess,
} from "./model-api.js";
import { findProfileModelChoice, normalizeProfileEffort } from "./model-profile-effort.js";

export interface ModelProfileEditorProps {
  profile: ToolProfile;
  onChange: (profile: ToolProfile) => void;
  toolLabel?: string;
  disabled?: boolean;
  autoVerify?: boolean;
  onAccessChange?: (state: AccessState | null) => void;
  reloadToken?: number;
  isFutureConfig?: boolean;
  catalogScope?: string;
}

export function ModelProfileEditor({
  profile,
  onChange,
  toolLabel = "工具",
  disabled = false,
  autoVerify = true,
  onAccessChange,
  reloadToken = 0,
  isFutureConfig = false,
  catalogScope,
}: ModelProfileEditorProps) {
  const [query, setQuery] = useState("");
  const [openList, setOpenList] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [entriesData, setEntriesData] = useState<{
    adapter: string;
    scope?: string;
    items: ModelEntry[];
    cliVersion?: string;
    accountContextKey?: string;
  }>({ adapter: "", items: [] });
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [catalogState, setCatalogState] = useState<{
    adapter: string;
    scope?: string;
    reloadToken: number;
    status: "loading" | "ready" | "failed";
    complete?: boolean;
    accountContextKey?: string;
  }>({ adapter: "", reloadToken, status: "loading" });
  const [access, setAccess] = useState<AccessState | null>(null);
  const generation = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const verifyGen = useRef(0);
  const verifyAbort = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const comboboxRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const verifyTimer = useRef<number | null>(null);


  const [listPos, setListPos] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  const adapter = profile.adapterId;
  const activeScope = adapter === "codebuddy-code" ? catalogScope : undefined;
  const toolVisible = TOOL_DISPLAY_ORDER.some((item) => item.adapterId === adapter);

  const matchingCatalog =
    entriesData.adapter === adapter &&
    entriesData.scope === activeScope &&
    (adapter !== "agy" ||
      (catalogState.adapter === adapter &&
        catalogState.status === "ready" &&
        catalogState.accountContextKey === entriesData.accountContextKey))
      ? entriesData
      : undefined;
  const entries = matchingCatalog?.items ?? [];
  const catalogReady =
    catalogState.adapter === adapter &&
    catalogState.scope === activeScope &&
    catalogState.reloadToken === reloadToken &&
    catalogState.status === "ready" &&
    (adapter !== "agy" || catalogState.accountContextKey === entriesData.accountContextKey);
  const catalogComplete = catalogReady && catalogState.complete === true;

  const choices = useMemo(() => buildModelChoices(entries), [entries]);

  // 当前选中的 ModelChoice
  const currentChoice = useMemo(
    () => findProfileModelChoice(profile, choices),
    [choices, profile],
  );

  const effectiveProfile = useMemo(
    () => catalogComplete ? normalizeProfileEffort(profile, currentChoice) : profile,
    [catalogComplete, profile, currentChoice],
  );

  // 过滤后的模型列表（匹配显示名、choiceId、nativeId 与全部变体 ID）
  const visibleChoices = useMemo(() => {
    if (!query.trim()) return choices;
    const lower = query.toLowerCase().trim();
    return choices.filter(
      (c) =>
        c.label.toLowerCase().includes(lower) ||
        c.choiceId.toLowerCase().includes(lower) ||
        c.nativeId.toLowerCase().includes(lower) ||
        Object.values(c.variantByEffort).some((v) => v.toLowerCase().includes(lower)),
    );
  }, [choices, query]);

  const invalidateCatalogForAgy = (scope = activeScope) => {
    abortRef.current?.abort();
    abortRef.current = null;
    generation.current += 1;
    setOpenList(false);
    setEntriesData({ adapter: "agy", scope, items: [] });
    setCatalogState({ adapter: "agy", scope, reloadToken, status: "loading" });
    if (verifyTimer.current) window.clearTimeout(verifyTimer.current);
    verifyGen.current += 1;
    verifyAbort.current?.abort();
    setAccess(null);
    onAccessChange?.(null);
  };

  const loadCatalog = (nextAdapter: string, doRefresh = false) => {
    const scope = nextAdapter === "codebuddy-code" ? catalogScope : undefined;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    generation.current += 1;
    const token = generation.current;
    const isCurrent = () => token === generation.current && !controller.signal.aborted;
    if (nextAdapter === "agy") {
      setOpenList(false);
      setEntriesData({ adapter: nextAdapter, scope, items: [] });
    }
    setCatalogState({ adapter: nextAdapter, scope, reloadToken, status: "loading" });
    if (verifyTimer.current) window.clearTimeout(verifyTimer.current);
    verifyGen.current += 1;
    verifyAbort.current?.abort();
    setAccess(null);
    onAccessChange?.(null);
    setLoading(true);
    setLoadError(null);

    const run = async () => {
      let result = await getAdapterModels(nextAdapter, controller.signal, scope);
      if (!isCurrent()) return;
      const initialAccountContext = result.accountContextKey;
      // 过期目录、缺失目录和全 manual 候补都触发一次真实发现。
      const needsRefresh = !disabled && modelCatalogNeedsRefresh(result);
      if (result.entries.length > 0 && (nextAdapter !== "agy" || !needsRefresh)) {
        // 非 AGY 或已就绪条目先展示预览；AGY 待刷新期间不透出旧账号能力
        setEntriesData({
          adapter: nextAdapter,
          scope,
          items: result.entries,
          cliVersion: result.cliVersion,
          accountContextKey: result.accountContextKey,
        });
        setLoading(false);
      }
      if (doRefresh || needsRefresh) {
        setRefreshing(true);
        await refreshAdapterModels(nextAdapter, controller.signal, scope);
        if (!isCurrent()) return;
        result = await getAdapterModels(nextAdapter, controller.signal, scope);
        if (!isCurrent()) return;
        if (
          nextAdapter === "agy" &&
          initialAccountContext &&
          result.accountContextKey &&
          result.accountContextKey !== initialAccountContext
        ) {
          // 刷新前后账号上下文不一致时，重新取用最新上下文对应目录，防止混入旧上下文
          result = await getAdapterModels(nextAdapter, controller.signal, scope);
          if (!isCurrent()) return;
        }
      }
      if (result.status !== "fresh" || result.discoveryStatus === "missing") {
        throw new Error(result.catalog?.errorMessage || "模型目录尚未完整加载，已保留当前配置，请刷新后重试。");
      }
      return result;
    };

    run()
      .then((result) => {
        if (!isCurrent() || !result) return;
        setEntriesData({
          adapter: nextAdapter,
          scope,
          items: result.entries,
          cliVersion: result.cliVersion,
          accountContextKey: result.accountContextKey,
        });
        setCatalogState({
          adapter: nextAdapter,
          scope,
          reloadToken,
          status: "ready",
          // 截断目录仍允许验证自定义模型，但不能据此清除已有强度。
          complete: result.discoveryStatus !== "partial",
          accountContextKey: result.accountContextKey,
        });
      })
      .catch((error) => {
        if (!isCurrent()) return;
        setEntriesData((prev) =>
          nextAdapter !== "agy" && prev.adapter === nextAdapter && prev.scope === scope && prev.items.length > 0
            ? prev
            : { adapter: nextAdapter, scope, items: [] },
        );
        setLoadError(formatApiError(error));
        setCatalogState({ adapter: nextAdapter, scope, reloadToken, status: "failed" });
      })
      .finally(() => {
        if (isCurrent()) {
          setLoading(false);
          setRefreshing(false);
        }
      });
  };

  useEffect(() => {
    if (!toolVisible) return;
    loadCatalog(adapter);
    return () => abortRef.current?.abort();
  }, [adapter, reloadToken, activeScope]);

  // 页面获得焦点时重核最新账号与模型目录
  useEffect(() => {
    if (!toolVisible || typeof window === "undefined") return;
    const onFocus = () => {
      if (adapter === "agy") invalidateCatalogForAgy();
      loadCatalog(adapter);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [adapter, toolVisible, reloadToken, activeScope]);

  // 订阅 AGY 账号变更通知，收到通知或 WS 连接恢复时立即失效旧目录并重核当前账号模型列表
  useEffect(() => {
    if (!toolVisible || adapter !== "agy" || typeof WebSocket === "undefined") return;
    if (typeof location === "undefined" || !location.host) return;
    let disposed = false;
    let socket: WebSocket | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnecting = false;
    const scheduleReload = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        if (!disposed) loadCatalog("agy");
      }, 80);
    };
    const connect = () => {
      if (disposed) return;
      try {
        const protocol = location.protocol === "https:" ? "wss:" : "ws:";
        socket = new WebSocket(`${protocol}//${location.host}/api/agy-accounts/notifications`);
        socket.onopen = () => {
          if (disposed) return;
          if (reconnecting) {
            reconnecting = false;
            invalidateCatalogForAgy();
            loadCatalog("agy");
          }
        };
        socket.onmessage = () => {
          if (disposed) return;
          invalidateCatalogForAgy();
          scheduleReload();
        };
        socket.onclose = () => {
          if (disposed) return;
          clearTimeout(debounceTimer);
          debounceTimer = undefined;
          invalidateCatalogForAgy();
          reconnecting = true;
          retryTimer = setTimeout(connect, 5000);
        };
      } catch {
        // 测试或无 WS 宿主环境静默忽略
      }
    };
    connect();
    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      clearTimeout(debounceTimer);
      socket?.close();
    };
  }, [adapter, toolVisible, reloadToken, activeScope]);

  const runVerify = (candidate: ToolProfile) => {
    verifyGen.current += 1;
    verifyAbort.current?.abort();
    if (disabled || !autoVerify || !candidate.modelId || !toolVisible || !catalogReady) {
      setAccess(null);
      onAccessChange?.(null);
      return;
    }
    const controller = new AbortController();
    verifyAbort.current = controller;
    const token = verifyGen.current;

    const checkingState: AccessState = { status: "checking", message: "正在验证" };
    setAccess(checkingState);
    onAccessChange?.(checkingState);
    const effectiveCandidate = catalogComplete
      ? normalizeProfileEffort(candidate, currentChoice)
      : candidate;

    verifyModelAccess(effectiveCandidate, controller.signal, false, catalogScope)
      .then((state) => {
        if (controller.signal.aborted || token !== verifyGen.current) return;
        setAccess(state);
        onAccessChange?.(state);
      })
      .catch((error) => {
        if (controller.signal.aborted || token !== verifyGen.current) return;
        if (isVerifyAbort(error)) return;
        const api = error as ApiError;
        const failState: AccessState = {
          status: api.code || "failed",
          message: formatApiError(error),
        };
        setAccess(failState);
        onAccessChange?.(failState);
      });
  };

  // 访问探测去抖（约 200ms）
  useEffect(() => {
    if (verifyTimer.current) window.clearTimeout(verifyTimer.current);
    verifyGen.current += 1;
    verifyAbort.current?.abort();
    setAccess(null);
    onAccessChange?.(null);
    if (catalogReady && effectiveProfile === profile) {
      verifyTimer.current = window.setTimeout(() => {
        runVerify(profile);
      }, 200);
    }
    return () => {
      if (verifyTimer.current) window.clearTimeout(verifyTimer.current);
      verifyGen.current += 1;
      verifyAbort.current?.abort();
    };
  }, [
    profile.adapterId,
    profile.modelId,
    profile.reasoning?.mode,
    profile.reasoning && "value" in profile.reasoning ? profile.reasoning.value : undefined,
    profile.nativeConfigProfile,
    profile.executableRef,
    disabled,
    autoVerify,
    catalogReady,
    catalogComplete,
    currentChoice,
  ]);

  // portal 浮层锚点：跟随输入框矩形，下方空间不足时上翻
  const updateListPos = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - 12;
    const spaceAbove = rect.top - 12;
    const openUp = spaceBelow < 180 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(140, Math.min(240, openUp ? spaceAbove : spaceBelow));
    setListPos(
      openUp
        ? { left: rect.left, bottom: window.innerHeight - rect.top + 4, width: rect.width, maxHeight }
        : { left: rect.left, top: rect.bottom + 4, width: rect.width, maxHeight },
    );
  }, []);

  useLayoutEffect(() => {
    if (!openList) {
      setListPos(null);
      return;
    }
    updateListPos();
    const handler = () => updateListPos();
    window.addEventListener("resize", handler);
    // capture：对话框 body 内部滚动也要跟随
    window.addEventListener("scroll", handler, true);
    return () => {
      window.removeEventListener("resize", handler);
      window.removeEventListener("scroll", handler, true);
    };
  }, [openList, updateListPos]);

  // 点击外部关闭下拉列表（浮层 portal 到 body，需同时检查 listRef）
  useEffect(() => {
    function handleDocumentClick(e: MouseEvent) {
      const target = e.target as Node;
      const inCombo = comboboxRef.current?.contains(target) ?? false;
      const inList = listRef.current?.contains(target) ?? false;
      if (!inCombo && !inList) {
        setOpenList(false);
      }
    }
    if (openList) {
      document.addEventListener("mousedown", handleDocumentClick);
      return () => document.removeEventListener("mousedown", handleDocumentClick);
    }
  }, [openList]);

  const update = (patch: Partial<ToolProfile>) => {
    onChange(cloneProfile({ ...profile, ...patch, revision: profile.revision }));
  };

  const changeTool = (next: SupportedAdapterId) => {
    if (next === adapter) return;
    setQuery("");
    setOpenList(false);
    setAccess(null);
    onAccessChange?.(null);
    onChange(blankKeepId(profile.id, next));
  };

  const selectChoice = (choice: ModelChoice, closeList = true) => {
    if (disabled || !catalogReady) return;
    // 只有在模型明确支持思考强度且包含有效档位时才保留或设置显式思考强度
    const isSupported = choice.effortStatus === "supported" && choice.effortValues.length > 0;
    const switchingToHydrogen =
      choice.choiceId === "gemini-4-hydrogen" &&
      currentChoice?.choiceId !== "gemini-4-hydrogen";
    let nextEffort = switchingToHydrogen
      ? choice.defaultEffort
      : profile.reasoning && "value" in profile.reasoning
        ? profile.reasoning.value
        : undefined;

    if (!isSupported || (nextEffort && !choice.effortValues.includes(nextEffort))) {
      nextEffort = isSupported ? choice.defaultEffort : undefined;
    } else if (!nextEffort && isSupported && choice.defaultEffort) {
      nextEffort = choice.defaultEffort;
    }

    let targetModelId = choice.nativeId;
    if (nextEffort && choice.variantByEffort[nextEffort]) {
      targetModelId = choice.variantByEffort[nextEffort]!;
    }

    const reasoning =
      isSupported && nextEffort
        ? { mode: "explicit" as const, value: nextEffort }
        : choice.effortStatus === "unsupported"
          ? { mode: "not-applicable" as const }
          : { mode: "native-default" as const };

    if (closeList) {
      setOpenList(false);
      setQuery("");
    }
    update({
      modelSelection: "explicit",
      modelId: targetModelId,
      selectionKind: choice.selectionKind,
      reasoning,
    });
  };

  const selectCustomModel = (customId: string) => {
    if (disabled || !catalogReady) return;
    const trimmed = customId.trim();
    if (!trimmed) return;
    if (adapter === "agy" && isHydrogenModelDisplayId(trimmed)) return;
    setOpenList(false);
    setQuery("");
    update({
      modelSelection: "explicit",
      modelId: trimmed,
      selectionKind: "fixed",
      reasoning: { mode: "not-applicable" },
    });
  };

  // 当模型列表加载完成且未选中模型（或残留了跨工具的旧模型）时，自动选中排在首位的模型（优先本地配置或最新模型）
  useEffect(() => {
    if (disabled || !catalogReady) return;
    const isResidual =
      adapter !== "codebuddy-code" &&
      catalogComplete &&
      Boolean(profile.modelId) &&
      !currentChoice &&
      profile.modelSelection !== "explicit" &&
      ((adapter !== "agy" && /^gemini-/i.test(profile.modelId!)) ||
        (adapter !== "codex" && adapter !== "opencode" && /^gpt-6-astra$/i.test(profile.modelId!)));
    if (choices.length > 0 && (!profile.modelId || isResidual)) {
      selectChoice(choices[0]!, false);
      return;
    }
    // 保留在当前账号目录不存在的 AGY 历史选择，避免切号后静默降档或覆盖原档位。
    if (effectiveProfile !== profile && !(adapter === "agy" && profile.modelId && !currentChoice)) {
      update({ reasoning: effectiveProfile.reasoning });
    }
  }, [choices, currentChoice, profile, effectiveProfile, adapter, disabled, catalogReady, catalogComplete]);

  const changeEffort = (effortValue: string) => {
    if (!effortValue || effortValue === "default") {
      // 原生默认或清空
      const targetModelId =
        (currentChoice && currentChoice.variantByEffort["high"]) ||
        currentChoice?.nativeId ||
        profile.modelId;
      update({
        modelId: targetModelId,
        reasoning: effortValue === "default" ? { mode: "native-default" } : undefined,
      });
      return;
    }

    let targetModelId = profile.modelId;
    if (currentChoice && currentChoice.variantByEffort[effortValue]) {
      targetModelId = currentChoice.variantByEffort[effortValue];
    }

    update({
      modelId: targetModelId,
      reasoning: { mode: "explicit", value: effortValue },
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const canOpenList = adapter !== "agy" || catalogState.status !== "failed";
    if (!openList) {
      if ((e.key === "ArrowDown" || e.key === "Enter") && canOpenList) {
        e.preventDefault();
        setOpenList(true);
      }
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((prev) =>
        prev < visibleChoices.length - 1 ? prev + 1 : 0,
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((prev) =>
        prev > 0 ? prev - 1 : visibleChoices.length - 1,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!catalogReady) return;
      if (activeIndex >= 0 && activeIndex < visibleChoices.length) {
        selectChoice(visibleChoices[activeIndex]!);
      } else if (query.trim() && !(adapter === "agy" && isHydrogenModelDisplayId(query.trim()))) {
        selectCustomModel(query.trim());
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpenList(false);
    }
  };

  // 目录加载前后均展示友好名；未知模型由格式化函数保留原始 ID。
  const activeChoice =
    currentChoice ??
    choices.find((c) => c.choiceId === profile.modelId || c.nativeId === profile.modelId);

  const currentModelLabel = (() => {
    if (!profile.modelId) return "";
    const base = activeChoice?.label || formatModelName(adapter, profile.modelId);
    if (activeChoice?.availability === "candidate") {
      return `${base} [候补]`;
    }
    return base;
  })();

  const availableEfforts =
    currentChoice?.effortStatus === "supported" ? (currentChoice.effortValues ?? []) : [];
  const currentEffort =
    profile.reasoning?.mode === "explicit"
      ? profile.reasoning.value
      : profile.reasoning?.mode === "native-default"
        ? "default"
        : "";

  return (
    <div className="ms-editor">
      {/* 工具选择 */}
      <div className="ms-field">
        <label htmlFor={`ms-tool-${profile.id}`}>{toolLabel} <span className="required-marker" aria-hidden="true">*</span></label>
        <select
          id={`ms-tool-${profile.id}`}
          aria-label={toolLabel}
          disabled={disabled}
          value={adapter}
          onChange={(e) => changeTool(e.target.value as SupportedAdapterId)}
        >
          {!toolVisible && <option value={adapter} disabled>历史工具（暂未开放）</option>}
          {TOOL_DISPLAY_ORDER.map((item) => (
            <option key={item.adapterId} value={item.adapterId}>
              {formatToolName(item.adapterId)}
            </option>
          ))}
        </select>
        {adapter === "codebuddy-code" && matchingCatalog?.cliVersion && (
          <p className="ms-muted" role="note">
            版本 {matchingCatalog.cliVersion} · 当前 CLI 登录账号 · {activeScope ? "项目模型目录" : "用户模型目录"}
          </p>
        )}
      </div>

      {/* 模型选择（可搜索 combobox） */}
      <div className="ms-field" ref={comboboxRef}>
        <div className="ms-field-header">
          <label htmlFor={`ms-model-${profile.id}`}>模型 <span className="required-marker" aria-hidden="true">*</span></label>
          <button
            type="button"
            className={`ms-icon-button ${refreshing ? "is-refreshing" : ""}`}
            title="刷新模型目录"
            disabled={disabled || !toolVisible || loading || refreshing}
            onClick={() => loadCatalog(adapter, true)}
          >
            ↻
          </button>
        </div>

        <div className="ms-combobox-container">
          <input
            ref={inputRef}
            id={`ms-model-${profile.id}`}
            name={`ms-model-search-${profile.id}`}
            type="text"
            role="combobox"
            aria-label={`${toolLabel}模型搜索`}
            aria-expanded={openList}
            aria-autocomplete="list"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            disabled={disabled || !toolVisible}
            value={openList ? query : currentModelLabel}
            placeholder={
              (loading || refreshing) && choices.length === 0
                ? refreshing
                  ? `正在发现${toolLabel === "工具" ? "" : toolLabel}可用模型…`
                  : "正在读取模型列表…"
                : openList
                  ? "输入搜索或直接输入自定义模型 ID"
                  : "点击展开或输入自定义模型"
            }
            onFocus={() => {
              if (adapter === "agy" && catalogState.status === "failed") return;
              setOpenList(true);
              setQuery("");
              setActiveIndex(-1);
            }}
            onClick={() => {
              if (adapter === "agy" && catalogState.status === "failed") return;
              if (!openList) {
                setOpenList(true);
                setQuery("");
                setActiveIndex(-1);
              }
            }}
            onChange={(e) => {
              setQuery(e.target.value);
              if (adapter !== "agy" || catalogState.status !== "failed") {
                setOpenList(true);
                setActiveIndex(0);
              }
            }}
            onKeyDown={handleKeyDown}
          />

          {openList && !disabled && listPos && createPortal(
            <ul
              className="ms-model-list"
              role="listbox"
              ref={listRef}
              aria-label="模型选项列表"
              style={{
                position: "fixed",
                left: listPos.left,
                top: listPos.top,
                bottom: listPos.bottom,
                width: listPos.width,
                maxHeight: listPos.maxHeight,
              }}
            >
              {(loading || refreshing) && visibleChoices.length === 0 && (
                <li className="ms-loading" role="status" aria-live="polite">
                  <span className="ms-spinner" /> 正在获取可用模型列表…
                </li>
              )}

              {visibleChoices.map((choice, idx) => {
                const isSelected =
                  currentChoice === choice;
                const isFocused = activeIndex === idx;
                const idText = choice.choiceId || choice.nativeId;
                const showIdText =
                  Boolean(idText) && !isEquivalentModelName(choice.label, idText);
                const isCandidate = choice.availability === "candidate";
                return (
                  <li
                    key={choice.entryIds.join("|")}
                    role="option"
                    aria-selected={isSelected}
                    className={`ms-model-option ${
                      isSelected ? "is-selected" : ""
                    } ${isFocused ? "is-focused" : ""}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      if (!catalogReady) return;
                      selectChoice(choice);
                    }}
                  >
                    <span className="ms-option-label">{choice.label}</span>
                    {isCandidate && (
                      <span
                        className="ms-candidate-tag"
                        title="候补模型"
                        style={{
                          fontSize: "11px",
                          padding: "1px 5px",
                          borderRadius: "3px",
                          background: "#fef3c7",
                          color: "#92400e",
                          border: "1px solid #fde68a",
                          marginLeft: "6px",
                        }}
                      >
                        候补
                      </span>
                    )}
                    {showIdText && <span className="ms-option-id">{idText}</span>}
                    {isSelected && <span className="ms-option-check">✓</span>}
                  </li>
                );
              })}

              {refreshing && visibleChoices.length > 0 && !query.trim() && (
                <li className="ms-loading-hint">
                  <span className="ms-spinner" /> 正在检查更新…
                </li>
              )}

              {query.trim() &&
                !(adapter === "agy" && isHydrogenModelDisplayId(query.trim())) &&
                !choices.some(
                  (c) => c.nativeId.toLowerCase() === query.trim().toLowerCase(),
                ) && (
                  <li
                    role="option"
                    aria-selected={profile.modelId === query.trim()}
                    className="ms-model-option ms-custom-option"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      if (!catalogReady) return;
                      selectCustomModel(query.trim());
                    }}
                  >
                    <span className="ms-option-label">
                      使用自定义模型: {query.trim()}
                    </span>
                    <span className="ms-option-id">自定义</span>
                  </li>
                )}

              {!loading && !refreshing && visibleChoices.length === 0 && !query.trim() && (
                <li className="ms-empty">{choices.length === 0 ? "当前账号暂无可用模型" : "没有匹配的模型"}</li>
              )}
            </ul>,
            document.body,
          )}
        </div>


        {loadError && (
          <p className="ms-error" role="alert">
            {loadError}
            <button
              type="button"
              className="ms-link-retry"
              onClick={() => loadCatalog(adapter, true)}
            >
              重试
            </button>
          </p>
        )}
      </div>

      {/* 思考强度选择（按需显示） */}
      {availableEfforts.length > 0 && (
        <div className="ms-field">
          <label htmlFor={`ms-effort-${profile.id}`}>思考强度</label>
          {availableEfforts.length === 1 ? (
            <div className="ms-fixed-value">{formatEffortDisplayLabel(availableEfforts[0]!, profile.modelId)}</div>
          ) : (
            <select
              id={`ms-effort-${profile.id}`}
              aria-label={`${toolLabel}思考强度`}
              disabled={disabled}
              value={currentEffort}
              onChange={(e) => changeEffort(e.target.value)}
            >
              <option value="default">默认</option>
              {availableEfforts.map((effort) => (
                <option key={effort} value={effort}>
                  {formatEffortDisplayLabel(effort, profile.modelId)}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      {catalogComplete && !disabled && profile.modelId && !currentChoice && adapter === "agy" && isHydrogenModelDisplayId(profile.modelId) ? (
        <>
          <p className="ms-error" role="alert">
            当前账号不支持模型 {formatModelName(adapter, profile.modelId)}，请切换到支持的账号或重新选择模型。
          </p>
          {profile.reasoning?.mode === "explicit" && profile.reasoning.value && (
            <p className="ms-muted" role="note" data-testid="preserved-reasoning-summary">
              已保留当前配置思考强度：{formatEffortDisplayLabel(profile.reasoning.value, profile.modelId)}
            </p>
          )}
        </>
      ) : catalogComplete && !disabled && profile.reasoning?.mode === "explicit" &&
        (!currentChoice ||
          currentChoice.effortStatus !== "supported" ||
          !currentChoice.effortValues.includes(profile.reasoning.value)) ? (
        <p className="ms-muted" role="note">
          当前配置中的思考强度（{formatEffortDisplayLabel(profile.reasoning.value, profile.modelId)}）未获此模型明确支持，将使用原生默认行为。
        </p>
      ) : (
        profile.reasoning?.mode === "explicit" &&
        profile.reasoning.value &&
        (availableEfforts.length === 0 || !availableEfforts.includes(profile.reasoning.value)) && (
          <p className="ms-muted" role="note" data-testid="preserved-reasoning-summary">
            已保留当前配置思考强度：{formatEffortDisplayLabel(profile.reasoning.value, profile.modelId)}
          </p>
        )
      )}

      {access && !["verified", "checking", "queued"].includes(access.status) && (
        <p className="ms-error" role="alert">{access.message}</p>
      )}
    </div>
  );
}

function blankKeepId(id: string, adapterId: SupportedAdapterId): ToolProfile {
  return {
    id,
    revision: 1,
    adapterId,
    modelSelection: "explicit",
    selectionKind: "fixed",
    options: {},
  };
}
