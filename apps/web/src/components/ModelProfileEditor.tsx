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
  isEquivalentModelName,
  buildModelChoices,
  type ModelChoice,
} from "../../../../packages/presentation/src/model-display.js";
import { getAgyModelCategory } from "../../../../packages/adapters/agy/src/model-configuration.js";
import {
  cloneProfile,
  formatApiError,
  getAdapterModels,
  refreshAdapterModels,
  isVerifyAbort,
  accessStatusLabel,
  type AccessState,
  type ApiError,
  verifyModelAccess,
} from "./model-api.js";

export interface ModelProfileEditorProps {
  profile: ToolProfile;
  onChange: (profile: ToolProfile) => void;
  toolLabel?: string;
  disabled?: boolean;
  autoVerify?: boolean;
  onAccessChange?: (state: AccessState | null) => void;
  reloadToken?: number;
  isFutureConfig?: boolean;
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
}: ModelProfileEditorProps) {
  const [query, setQuery] = useState("");
  const [openList, setOpenList] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [entriesData, setEntriesData] = useState<{
    adapter: string;
    items: ModelEntry[];
  }>({ adapter: "", items: [] });
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [access, setAccess] = useState<AccessState | null>(null);
  const [verifying, setVerifying] = useState(false);
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

  const [activeAgyCategory, setActiveAgyCategory] = useState<"gemini" | "other" | "unknown" | null>(null);
  const [categoryConflictNotice, setCategoryConflictNotice] = useState<string | null>(null);

  const adapter = profile.adapterId;
  const toolVisible = TOOL_DISPLAY_ORDER.some((item) => item.adapterId === adapter);

  useEffect(() => {
    if (adapter !== "agy") {
      setActiveAgyCategory(null);
      setCategoryConflictNotice(null);
      return;
    }
    let mounted = true;
    fetch("/api/agy-accounts")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (mounted && data?.active_category) {
          setActiveAgyCategory(data.active_category);
        } else if (mounted) {
          setActiveAgyCategory(null);
        }
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [adapter, reloadToken, openList]);
  // 严格校验 entries 所属工具，彻底杜绝切换工具时残留上一工具模型（如 Claude Code 显示 Gemini）
  const entries = entriesData.adapter === adapter ? entriesData.items : [];

  const choices = useMemo(() => buildModelChoices(entries), [entries]);

  // 当前选中的 ModelChoice
  const currentChoice = useMemo(() => {
    if (!profile.modelId) return null;
    return (
      choices.find(
        (c) =>
          c.choiceId === profile.modelId ||
          c.nativeId === profile.modelId ||
          c.entryIds.some((id) => id.endsWith(`/${profile.modelId}`)) ||
          Object.values(c.variantByEffort).includes(profile.modelId!),
      ) ?? null
    );
  }, [choices, profile.modelId]);

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

  const loadCatalog = (nextAdapter: string, doRefresh = false) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    generation.current += 1;
    const token = generation.current;
    setLoading(true);
    setLoadError(null);

    const run = async () => {
      let result = await getAdapterModels(nextAdapter, controller.signal);
      if (token === generation.current && result.entries.length > 0) {
        // 先展示缓存或种子条目，loading 只兜住空目录首载
        setEntriesData({ adapter: nextAdapter, items: result.entries });
        setLoading(false);
      }
      // 过期目录、缺失目录和全 manual 候补都触发一次真实发现。
      const allManual =
        result.entries.length > 0 &&
        result.entries.every((entry) => entry.source === "manual");
      const needsRefresh =
        !disabled &&
        (result.discoveryStatus === "missing" ||
          result.status === "missing" ||
          result.status === "stale" ||
          result.status === "refreshing" ||
          result.status === "failed" ||
          allManual);
      if (doRefresh || needsRefresh) {
        setRefreshing(true);
        try {
          await refreshAdapterModels(nextAdapter, controller.signal);
          const refreshed = await getAdapterModels(nextAdapter, controller.signal);
          if (refreshed.entries.length > 0) {
            result = refreshed;
          }
        } catch (refreshErr) {
          // 若已有可用条目（如内置种子或本地配置），刷新失败不清空已有条目
          if (result.entries.length === 0) {
            throw refreshErr;
          }
          if (token === generation.current && !controller.signal.aborted) {
            setLoadError(formatApiError(refreshErr));
          }
        }
      }
      return result;
    };

    run()
      .then((result) => {
        if (token !== generation.current) return;
        setEntriesData({ adapter: nextAdapter, items: result.entries });
      })
      .catch((error) => {
        if (controller.signal.aborted || token !== generation.current) return;
        setEntriesData((prev) =>
          prev.adapter === nextAdapter && prev.items.length > 0
            ? prev
            : { adapter: nextAdapter, items: [] },
        );
        setLoadError(formatApiError(error));
      })
      .finally(() => {
        if (token === generation.current) {
          setLoading(false);
          setRefreshing(false);
        }
      });
  };

  useEffect(() => {
    if (!toolVisible) return;
    loadCatalog(adapter);
    return () => abortRef.current?.abort();
  }, [adapter, reloadToken]);

  const runVerify = (candidate: ToolProfile, force = false) => {
    if (disabled || !autoVerify || !candidate.modelId || !toolVisible) {
      setAccess(null);
      setVerifying(false);
      onAccessChange?.(null);
      return;
    }
    verifyAbort.current?.abort();
    const controller = new AbortController();
    verifyAbort.current = controller;
    verifyGen.current += 1;
    const token = verifyGen.current;

    setVerifying(true);
    const checkingState: AccessState = { status: "checking", message: "正在验证" };
    setAccess(checkingState);
    onAccessChange?.(checkingState);
    verifyModelAccess(candidate, controller.signal, force)
      .then((state) => {
        if (token !== verifyGen.current) return;
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
      })
      .finally(() => {
        if (token === verifyGen.current) {
          setVerifying(false);
        }
      });
  };

  // 访问探测去抖（约 200ms）
  useEffect(() => {
    if (verifyTimer.current) window.clearTimeout(verifyTimer.current);
    verifyTimer.current = window.setTimeout(() => {
      runVerify(profile, false);
    }, 200);
    return () => {
      if (verifyTimer.current) window.clearTimeout(verifyTimer.current);
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
    setQuery("");
    setOpenList(false);
    setAccess(null);
    onAccessChange?.(null);
    onChange(blankKeepId(profile.id, next));
  };

  const checkCategoryConflict = (modelId?: string | null): boolean => {
    if (isFutureConfig || adapter !== "agy" || !activeAgyCategory || !modelId) return false;
    const cat = getAgyModelCategory(modelId);
    return cat === "unknown" || cat !== activeAgyCategory;
  };

  const categoryConflictMessage = (modelId: string) => {
    if (getAgyModelCategory(modelId) === "unknown") {
      return `无法确认模型 ${modelId} 的类别，当前有 AGY 任务占用，暂不能选择或核验该模型。`;
    }
    const activeDesc = activeAgyCategory === "gemini" ? "Gemini 类" :
      activeAgyCategory === "other" ? "其他模型类（Claude / GPT）" : "未确认类别";
    return `AGY 当前正被 ${activeDesc} 任务占用，无法同时使用该模型。全部同时占用 AGY 的任务只能使用同一类别。`;
  };

  const selectChoice = (choice: ModelChoice) => {
    const targetId = choice.choiceId || choice.nativeId;
    if (checkCategoryConflict(targetId)) {
      setCategoryConflictNotice(categoryConflictMessage(targetId));
      return;
    }
    setCategoryConflictNotice(null);

    // 判断思考强度
    let nextEffort =
      profile.reasoning && "value" in profile.reasoning
        ? profile.reasoning.value
        : undefined;
    if (nextEffort && !choice.effortValues.includes(nextEffort)) {
      nextEffort = choice.defaultEffort;
    } else if (!nextEffort && choice.defaultEffort) {
      nextEffort = choice.defaultEffort;
    }

    let targetModelId = choice.nativeId;
    if (nextEffort && choice.variantByEffort[nextEffort]) {
      targetModelId = choice.variantByEffort[nextEffort]!;
    }

    const reasoning = choice.effortStatus === "unknown" && choice.nativeId === profile.modelId
      ? profile.reasoning?.mode === "explicit" ? profile.reasoning : undefined
      : nextEffort
        ? { mode: "explicit" as const, value: nextEffort }
        : choice.effortStatus === "unsupported"
          ? { mode: "not-applicable" as const }
          : undefined;

    setOpenList(false);
    setQuery("");
    update({
      modelSelection: "explicit",
      modelId: targetModelId,
      selectionKind: choice.selectionKind,
      reasoning,
    });
  };

  const selectCustomModel = (customId: string) => {
    const trimmed = customId.trim();
    if (!trimmed) return;
    if (checkCategoryConflict(trimmed)) {
      setCategoryConflictNotice(categoryConflictMessage(trimmed));
      return;
    }
    setCategoryConflictNotice(null);
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
    if (disabled || choices.length === 0) return;
    const isResidual =
      Boolean(profile.modelId) &&
      !currentChoice &&
      profile.modelSelection !== "explicit" &&
      ((adapter !== "agy" && /^gemini-/i.test(profile.modelId!)) ||
        (adapter !== "codex" && adapter !== "opencode" && /^gpt-6-astra$/i.test(profile.modelId!)));
    if (!profile.modelId || isResidual) {
      selectChoice(choices[0]!);
    }
  }, [choices, profile.modelId, currentChoice, profile.modelSelection, adapter, disabled]);

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
    if (!openList) {
      if (e.key === "ArrowDown" || e.key === "Enter") {
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
      if (activeIndex >= 0 && activeIndex < visibleChoices.length) {
        selectChoice(visibleChoices[activeIndex]!);
      } else if (query.trim()) {
        selectCustomModel(query.trim());
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpenList(false);
    }
  };

  // 关闭态展示友好名（已匹配 Choice 时直接展示选项名称；未匹配且不等价时才附带原始 ID）
  const activeChoice =
    currentChoice ??
    choices.find((c) => c.choiceId === profile.modelId || c.nativeId === profile.modelId);

  const currentModelLabel = (() => {
    if (!profile.modelId) return "";
    let base = "";
    if (activeChoice) {
      base = activeChoice.label;
    } else {
      const label = formatModelName(adapter, profile.modelId);
      if (label && !isEquivalentModelName(label, profile.modelId)) {
        base = `${label} · ${profile.modelId}`;
      } else {
        base = label || profile.modelId;
      }
    }
    if (activeChoice?.availability === "candidate") {
      return `${base} [候补 / 待核验]`;
    }
    return base;
  })();

  const availableEfforts = currentChoice?.effortValues ?? [];
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
        <label htmlFor={`ms-tool-${profile.id}`}>{toolLabel}</label>
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
      </div>

      {/* 模型选择（可搜索 combobox） */}
      <div className="ms-field" ref={comboboxRef}>
        <div className="ms-field-header">
          <label htmlFor={`ms-model-${profile.id}`}>模型</label>
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
              setOpenList(true);
              setQuery("");
              setActiveIndex(-1);
            }}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpenList(true);
              setActiveIndex(0);
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
                const choiceModelId = choice.choiceId || choice.nativeId;
                const choiceCategory = adapter === "agy" ? getAgyModelCategory(choiceModelId) : null;
                const isActualConflict = Boolean(
                  adapter === "agy" &&
                  activeAgyCategory &&
                  choiceCategory &&
                  choiceCategory !== activeAgyCategory,
                );
                const isCategoryConflict = checkCategoryConflict(choiceModelId);
                const isCandidate = choice.availability === "candidate";
                return (
                  <li
                    key={choice.entryIds.join("|")}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={isCategoryConflict}
                    className={`ms-model-option ${
                      isSelected ? "is-selected" : ""
                    } ${isFocused ? "is-focused" : ""} ${isCategoryConflict ? "is-conflict" : ""}`}
                    style={isCategoryConflict ? { opacity: 0.65, cursor: "not-allowed" } : undefined}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      if (isCategoryConflict) {
                        setCategoryConflictNotice(categoryConflictMessage(choiceModelId));
                        return;
                      }
                      setCategoryConflictNotice(null);
                      selectChoice(choice);
                    }}
                  >
                    <span className="ms-option-label">{choice.label}</span>
                    {isCandidate && (
                      <span
                        className="ms-candidate-tag"
                        title="候补模型，待实际核验"
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
                        候补 / 待核验
                      </span>
                    )}
                    {showIdText && <span className="ms-option-id">{idText}</span>}
                    {isCategoryConflict ? (
                      <span className="ms-option-conflict-tag" style={{ color: "#ef4444", fontSize: "11px", marginLeft: "auto" }}>
                        （与当前类别冲突）
                      </span>
                    ) : isFutureConfig && isActualConflict ? (
                      <span className="ms-option-conflict-tag" style={{ color: "#d97706", fontSize: "11px", marginLeft: "auto" }}>
                        （未来配置，派发时校验）
                      </span>
                    ) : null}
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
                !choices.some(
                  (c) => c.nativeId.toLowerCase() === query.trim().toLowerCase(),
                ) && (
                  <li
                    role="option"
                    aria-selected={profile.modelId === query.trim()}
                    className="ms-model-option ms-custom-option"
                    onMouseDown={(e) => {
                      e.preventDefault();
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
                <li className="ms-empty">没有匹配的模型</li>
              )}
            </ul>,
            document.body,
          )}
        </div>

        {adapter === "agy" && activeAgyCategory && (
          <div className="ms-category-active-hint" style={{ fontSize: "12px", color: "#64748b", marginTop: "4px" }}>
            当前 AGY 任务使用 {activeAgyCategory === "gemini" ? "Gemini 类" : activeAgyCategory === "other" ? "其他模型类（Claude / GPT）" : "未确认类别"}
            {isFutureConfig ? "；未来配置在实际生效前仍需检查类别占用" : "，仅允许选择同类模型"}
          </div>
        )}
        {categoryConflictNotice && (
          <div className="ms-category-conflict-alert" role="alert" style={{ fontSize: "12px", color: "#dc2626", background: "#fef2f2", border: "1px solid #fecaca", padding: "6px 10px", borderRadius: "4px", marginTop: "4px" }}>
            {categoryConflictNotice}
          </div>
        )}

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
            <div className="ms-fixed-value">{availableEfforts[0]}</div>
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
                  {effort}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      <div className="ms-access" role="status">
        <span>
          访问状态：
          {accessStatusLabel(access)}
          {activeChoice?.availability === "candidate" && " · 候补目录项"}
        </span>
        {profile.modelId && (
          <button
            type="button"
            className="ms-link"
            disabled={disabled || verifying}
            onClick={() => runVerify(profile, true)}
          >
            {verifying ? "正在验证…" : "重新验证"}
          </button>
        )}
      </div>
      {access?.message && access.status !== "verified" && (
        <p className="ms-muted" role="status">{access.message}</p>
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
