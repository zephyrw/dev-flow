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
import {
  cloneProfile,
  formatApiError,
  getAdapterModels,
  refreshAdapterModels,
  isVerifyAbort,
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
}

export function ModelProfileEditor({
  profile,
  onChange,
  toolLabel = "工具",
  disabled = false,
  autoVerify = true,
  onAccessChange,
  reloadToken = 0,
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
  const generation = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const verifyGen = useRef(0);
  const verifyAbort = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const comboboxRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const verifyTimer = useRef<number | null>(null);
  // portal 浮层的锚点坐标（fixed 定位，脱离 overflow 裁剪祖先）
  const [listPos, setListPos] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  const adapter = profile.adapterId;
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
      // 目录缺失 / 旧解析器产物 / 全 manual 候补（旧服务残留）都触发一次真实发现
      const allManual =
        result.entries.length > 0 &&
        result.entries.every((entry) => entry.source === "manual");
      const needsRefresh =
        !disabled &&
        (result.discoveryStatus === "missing" ||
          result.status === "missing" ||
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
    loadCatalog(adapter);
    return () => abortRef.current?.abort();
  }, [adapter, reloadToken]);

  const runVerify = (candidate: ToolProfile, force = false) => {
    if (disabled || !autoVerify || !candidate.modelId) {
      onAccessChange?.(null);
      return;
    }
    verifyAbort.current?.abort();
    const controller = new AbortController();
    verifyAbort.current = controller;
    verifyGen.current += 1;
    const token = verifyGen.current;

    onAccessChange?.({ status: "checking", message: "正在验证" });
    verifyModelAccess(candidate, controller.signal, force)
      .then((state) => {
        if (token !== verifyGen.current) return;
        onAccessChange?.(state);
      })
      .catch((error) => {
        if (controller.signal.aborted || token !== verifyGen.current) return;
        if (isVerifyAbort(error)) return;
        const api = error as ApiError;
        onAccessChange?.({
          status: api.code || "failed",
          message: formatApiError(error),
        });
      });
  };

  // 访问探测去抖（约 1.5s）：真实模型探测可达 20–60s，不能每次键入/切换都打
  useEffect(() => {
    if (verifyTimer.current) window.clearTimeout(verifyTimer.current);
    verifyTimer.current = window.setTimeout(() => {
      runVerify(profile, false);
    }, 1500);
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
    onAccessChange?.(null);
    onChange(blankKeepId(profile.id, next));
  };

  const selectChoice = (choice: ModelChoice) => {
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
    setOpenList(false);
    setQuery("");
    update({
      modelSelection: "explicit",
      modelId: trimmed,
      selectionKind: "custom-model-id",
      reasoning: { mode: "not-applicable" },
    });
  };

  // 当模型列表加载完成且未选中模型（或残留了跨工具的旧模型）时，自动选中排在首位的模型（优先本地配置或最新模型）
  useEffect(() => {
    if (disabled || choices.length === 0) return;
    const isResidual =
      Boolean(profile.modelId) &&
      !currentChoice &&
      profile.selectionKind !== "custom-model-id" &&
      ((adapter !== "agy" && /^gemini-/i.test(profile.modelId!)) ||
        (adapter !== "codex" && adapter !== "opencode" && /^gpt-6-astra$/i.test(profile.modelId!)));
    if (!profile.modelId || isResidual) {
      selectChoice(choices[0]!);
    }
  }, [choices, profile.modelId, currentChoice, profile.selectionKind, adapter, disabled]);

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

  // 关闭态展示友好名（若友好名与原始 ID 不等价则附带原始 ID；等价时只展示友好名，避免重复）
  const currentModelLabel = (() => {
    if (!profile.modelId) return "";
    const label = currentChoice?.label ?? formatModelName(adapter, profile.modelId);
    if (label && !isEquivalentModelName(label, profile.modelId)) {
      return `${label} · ${profile.modelId}`;
    }
    return label || profile.modelId;
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
            className="ms-icon-button"
            title="刷新模型目录"
            disabled={disabled || loading || refreshing}
            onClick={() => loadCatalog(adapter, true)}
          >
            {refreshing ? "…" : "↻"}
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
            disabled={disabled}
            value={openList ? query : currentModelLabel}
            placeholder={
              loading
                ? "正在读取模型列表…"
                : refreshing
                  ? `正在发现${toolLabel === "工具" ? "" : toolLabel}可用模型…`
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
              {visibleChoices.map((choice, idx) => {
                const isSelected =
                  currentChoice === choice;
                const isFocused = activeIndex === idx;
                const idTokens = [
                  choice.nativeId,
                  ...Object.values(choice.variantByEffort),
                ];
                const idText = [...new Set(idTokens)].join(" ");
                const showIdText =
                  Boolean(idText) && !isEquivalentModelName(choice.label, idText);
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
                      selectChoice(choice);
                    }}
                  >
                    <span className="ms-option-label">{choice.label}</span>
                    {showIdText && <span className="ms-option-id">{idText}</span>}
                    {isSelected && <span className="ms-option-check">✓</span>}
                  </li>
                );
              })}

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

              {!loading && visibleChoices.length === 0 && !query.trim() && (
                <li className="ms-empty">没有匹配的模型</li>
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
