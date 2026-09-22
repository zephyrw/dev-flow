import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  TOOL_DISPLAY_ORDER,
  type ModelEntry,
  type SupportedAdapterId,
  type ToolProfile,
} from "../../../../packages/contracts/src/index.js";
import {
  formatToolName,
  formatModelName,
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
  const [entries, setEntries] = useState<ModelEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const generation = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const verifyGen = useRef(0);
  const verifyAbort = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const comboboxRef = useRef<HTMLDivElement | null>(null);

  const adapter = profile.adapterId;

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

  // 过滤后的模型列表
  const visibleChoices = useMemo(() => {
    if (!query.trim()) return choices;
    const lower = query.toLowerCase().trim();
    return choices.filter(
      (c) =>
        c.label.toLowerCase().includes(lower) ||
        c.choiceId.toLowerCase().includes(lower),
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
      if (doRefresh) {
        setRefreshing(true);
        await refreshAdapterModels(nextAdapter, controller.signal);
      }
      let result = await getAdapterModels(nextAdapter, controller.signal);
      if (
        (result.discoveryStatus === "missing" || result.status === "missing") &&
        !disabled &&
        !doRefresh
      ) {
        await refreshAdapterModels(nextAdapter, controller.signal);
        result = await getAdapterModels(nextAdapter, controller.signal);
      }
      return result;
    };

    run()
      .then((result) => {
        if (token !== generation.current) return;
        setEntries(result.entries);
      })
      .catch((error) => {
        if (controller.signal.aborted || token !== generation.current) return;
        setEntries([]);
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

  useEffect(() => {
    runVerify(profile, false);
    return () => verifyAbort.current?.abort();
  }, [
    profile.adapterId,
    profile.modelId,
    profile.reasoning?.mode,
    profile.reasoning && "value" in profile.reasoning ? profile.reasoning.value : undefined,
    profile.nativeConfigProfile,
    profile.executableRef,
    disabled,
  ]);

  // 点击外部关闭下拉列表
  useEffect(() => {
    function handleDocumentClick(e: MouseEvent) {
      if (
        comboboxRef.current &&
        !comboboxRef.current.contains(e.target as Node)
      ) {
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

    const reasoning = nextEffort
      ? { mode: "explicit" as const, value: nextEffort }
      : profile.reasoning?.mode === "not-applicable"
        ? { mode: "not-applicable" as const }
        : undefined;

    setOpenList(false);
    setQuery("");
    update({
      modelSelection: "explicit",
      modelId: targetModelId,
      selectionKind: "fixed",
      reasoning,
    });
  };

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
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpenList(false);
    }
  };

  const currentModelLabel = currentChoice
    ? currentChoice.label
    : profile.modelId
      ? formatModelName(adapter, profile.modelId)
      : "";

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
            id={`ms-model-${profile.id}`}
            type="text"
            role="combobox"
            aria-expanded={openList}
            aria-autocomplete="list"
            disabled={disabled}
            value={openList ? query : currentModelLabel}
            placeholder={
              loading
                ? "正在读取目录…"
                : currentModelLabel || "点击展开或输入搜索模型"
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

          {openList && !disabled && (
            <ul
              className="ms-model-list"
              role="listbox"
              ref={listRef}
              aria-label="模型选项列表"
            >
              {visibleChoices.map((choice, idx) => {
                const isSelected =
                  currentChoice?.choiceId === choice.choiceId;
                const isFocused = activeIndex === idx;
                return (
                  <li
                    key={choice.choiceId}
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
                    {isSelected && <span className="ms-option-check">✓</span>}
                  </li>
                );
              })}

              {!loading && visibleChoices.length === 0 && (
                <li className="ms-empty">没有匹配的模型</li>
              )}
            </ul>
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
              aria-label="思考强度"
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
