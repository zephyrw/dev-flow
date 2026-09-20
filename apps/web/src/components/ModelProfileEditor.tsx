import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  EFFORT_LABELS,
  TOOL_DISPLAY_ORDER,
  type ModelEntry,
  type SupportedAdapterId,
  type ToolProfile,
} from "../../../../packages/contracts/src/index.js";
import {
  accessStatusLabel,
  cloneProfile,
  effortCaption,
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

const VISIBLE_MODEL_LIMIT = 80;

function listedEntries(entries: ModelEntry[]): ModelEntry[] {
  return entries.filter(
    (entry) => !entry.hidden && entry.availability !== "unavailable",
  );
}

function matchesQuery(entry: ModelEntry, query: string): boolean {
  if (!query) return true;
  const hay = [entry.label, entry.nativeId, entry.providerId, entry.familyId]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return hay.includes(query.toLowerCase());
}

function effortChoices(entry?: ModelEntry | null): string[] {
  if (!entry) return [];
  if (
    entry.effort.status === "unknown" ||
    entry.effort.status === "unsupported"
  ) {
    return [];
  }
  return entry.effort.values;
}

function nextReasoning(
  previous: ToolProfile["reasoning"],
  entry: ModelEntry | undefined,
): ToolProfile["reasoning"] {
  const values = effortChoices(entry);
  const previousValue =
    previous?.mode === "explicit" ? previous.value : undefined;
  if (previousValue && values.includes(previousValue)) {
    return { mode: "explicit", value: previousValue };
  }
  if (
    entry?.effort.defaultValue &&
    values.includes(entry.effort.defaultValue)
  ) {
    return { mode: "explicit", value: entry.effort.defaultValue };
  }
  if (entry?.effort.fixedValue && values.includes(entry.effort.fixedValue)) {
    return { mode: "explicit", value: entry.effort.fixedValue };
  }
  if (entry?.effort.status === "unsupported") {
    return { mode: "not-applicable" };
  }
  if (entry?.effort.status === "unknown") {
    return undefined;
  }
  return undefined;
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
  const [rawModelId, setRawModelId] = useState(profile.modelId ?? "");
  const [rawExecutable, setRawExecutable] = useState(
    profile.executableRef ?? "",
  );
  const [rawNativeConfig, setRawNativeConfig] = useState(
    profile.nativeConfigProfile ?? "",
  );
  const [openList, setOpenList] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [entries, setEntries] = useState<ModelEntry[]>([]);
  const [catalogStatus, setCatalogStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [access, setAccess] = useState<AccessState | null>(null);
  const [verifying, setVerifying] = useState(false);
  const generation = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const verifyGen = useRef(0);
  const verifyAbort = useRef<AbortController | null>(null);

  const adapter = profile.adapterId;
  const currentEntry = useMemo(
    () =>
      entries.find(
        (entry) =>
          entry.nativeId === profile.modelId ||
          entry.entryId === profile.modelId,
      ),
    [entries, profile.modelId],
  );
  const missingCurrent =
    Boolean(profile.modelId) &&
    profile.modelSelection === "explicit" &&
    !currentEntry;

  const visibleModels = useMemo(() => {
    const filtered = listedEntries(entries).filter((entry) =>
      matchesQuery(entry, query),
    );
    return filtered.slice(0, VISIBLE_MODEL_LIMIT);
  }, [entries, query]);
  const hiddenCount = Math.max(
    0,
    listedEntries(entries).filter((entry) => matchesQuery(entry, query))
      .length - visibleModels.length,
  );
  const effortValues = effortChoices(currentEntry);
  const unknownEffort = currentEntry?.effort.status === "unknown";
  const unsupportedEffort = currentEntry?.effort.status === "unsupported";
  const currentEffort =
    profile.reasoning?.mode === "explicit" ? profile.reasoning.value : "";
  const effortMissing =
    Boolean(currentEffort) &&
    effortValues.length > 0 &&
    !effortValues.includes(currentEffort);

  const emitAccess = (state: AccessState | null) => {
    setAccess(state);
    onAccessChange?.(state);
  };

  const loadCatalog = (nextAdapter: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    generation.current += 1;
    const token = generation.current;
    setLoading(true);
    setLoadError(null);
    getAdapterModels(nextAdapter, controller.signal)
      .then(async (result) => {
        if (result.status === "missing" && !disabled) {
          await refreshAdapterModels(nextAdapter, controller.signal);
          result = await getAdapterModels(nextAdapter, controller.signal);
        }
        if (token !== generation.current) return;
        setEntries(result.entries);
        setCatalogStatus(result.status ?? "");
      })
      .catch((error) => {
        if (controller.signal.aborted || token !== generation.current) return;
        setEntries([]);
        setLoadError(formatApiError(error));
      })
      .finally(() => {
        if (token === generation.current) setLoading(false);
      });
  };

  useEffect(() => {
    loadCatalog(adapter);
    return () => abortRef.current?.abort();
  }, [adapter, reloadToken]);

  const runVerify = (candidate: ToolProfile, force = false) => {
    if (disabled || !autoVerify || !candidate.modelId) {
      emitAccess(null);
      return;
    }
    verifyAbort.current?.abort();
    const controller = new AbortController();
    verifyAbort.current = controller;
    verifyGen.current += 1;
    const token = verifyGen.current;
    setVerifying(true);
    emitAccess({ status: "checking", message: "正在验证访问" });
    verifyModelAccess(candidate, controller.signal, force)
      .then((state) => {
        if (token !== verifyGen.current) return;
        emitAccess(state);
      })
      .catch((error) => {
        if (controller.signal.aborted || token !== verifyGen.current) return;
        if (isVerifyAbort(error)) return;
        const api = error as ApiError;
        emitAccess({
          status: api.code || "failed",
          message: formatApiError(error),
        });
      })
      .finally(() => {
        if (token === verifyGen.current) setVerifying(false);
      });
  };

  useEffect(() => {
    runVerify(profile, false);
    return () => verifyAbort.current?.abort();
  }, [
    profile.adapterId,
    profile.modelId,
    profile.nativeConfigProfile,
    profile.executableRef,
    disabled,
  ]);

  useEffect(
    () => setRawModelId(profile.modelId ?? ""),
    [profile.adapterId, profile.modelId],
  );
  useEffect(
    () => setRawExecutable(profile.executableRef ?? ""),
    [profile.adapterId, profile.executableRef],
  );
  useEffect(
    () => setRawNativeConfig(profile.nativeConfigProfile ?? ""),
    [profile.adapterId, profile.nativeConfigProfile],
  );

  const update = (patch: Partial<ToolProfile>) => {
    onChange(
      cloneProfile({ ...profile, ...patch, revision: profile.revision }),
    );
  };

  const changeTool = (next: SupportedAdapterId) => {
    setQuery("");
    setOpenList(false);
    emitAccess(null);
    onChange({
      ...blankKeepId(profile.id, next),
      executableRef: undefined,
      nativeConfigProfile: undefined,
    });
  };

  const changeModel = (entry: ModelEntry | null, rawId?: string) => {
    const modelId = entry?.nativeId ?? rawId ?? "";
    const reasoning = nextReasoning(profile.reasoning, entry ?? undefined);
    setOpenList(false);
    setQuery("");
    update({
      modelSelection: "explicit",
      modelId: modelId || undefined,
      selectionKind:
        entry?.selectionKind === "native-router" ? "native-router" : "fixed",
      reasoning,
    });
  };

  const changeEffort = (value: string) => {
    if (!value) {
      update({ reasoning: undefined });
      return;
    }
    update({ reasoning: { mode: "explicit", value } });
  };

  const commitRawModel = () => {
    const rawId = rawModelId.trim();
    if (rawId === (profile.modelId ?? "")) return;
    const match =
      entries.find(
        (item) => item.nativeId === rawId || item.entryId === rawId,
      ) ?? null;
    changeModel(match, rawId);
  };

  const commitAdvanced = (
    field: "executableRef" | "nativeConfigProfile",
    raw: string,
  ) => {
    const value = raw.trim() || undefined;
    if (value !== profile[field]) update({ [field]: value });
  };

  const modelDisplay =
    currentEntry?.label && currentEntry.label !== profile.modelId
      ? `${currentEntry.label} · ${profile.modelId}`
      : profile.modelId || "请选择模型";

  return (
    <div className="ms-editor">
      <div className="ms-field">
        <label htmlFor={`ms-tool-${profile.id}`}>{toolLabel}</label>
        <select
          id={`ms-tool-${profile.id}`}
          aria-label={toolLabel}
          disabled={disabled}
          value={adapter}
          onChange={(event) =>
            changeTool(event.target.value as SupportedAdapterId)
          }
        >
          {TOOL_DISPLAY_ORDER.map((item) => (
            <option key={item.adapterId} value={item.adapterId}>
              {item.label}（{item.adapterId}）
            </option>
          ))}
        </select>
      </div>

      <div className="ms-field">
        <label htmlFor={`ms-model-${profile.id}`}>模型</label>
        <input
          id={`ms-model-${profile.id}`}
          aria-label={`${toolLabel}模型搜索`}
          disabled={disabled || loading}
          value={openList ? query : modelDisplay}
          placeholder={loading ? "正在加载模型目录…" : "搜索模型"}
          onFocus={() => {
            setOpenList(true);
            setQuery("");
          }}
          onBlur={() => setTimeout(() => setOpenList(false), 120)}
          onChange={(event) => {
            setOpenList(true);
            setQuery(event.target.value);
          }}
        />
        {openList && !disabled && (
          <ul className="ms-model-list" role="listbox" aria-label="模型列表">
            {visibleModels.map((entry) => (
              <li key={entry.entryId}>
                <button
                  type="button"
                  role="option"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => changeModel(entry)}
                >
                  <strong>{entry.label}</strong>
                  <span>{entry.nativeId}</span>
                  {entry.providerId ? <em>{entry.providerId}</em> : null}
                </button>
              </li>
            ))}
            {missingCurrent && (
              <li>
                <button
                  type="button"
                  role="option"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => changeModel(null, profile.modelId)}
                >
                  <strong>{profile.modelId}</strong>
                  <span>当前配置，目录未列出</span>
                </button>
              </li>
            )}
            {!loading && visibleModels.length === 0 && !missingCurrent && (
              <li className="ms-empty">没有匹配的模型</li>
            )}
            {hiddenCount > 0 && (
              <li className="ms-empty">还有 {hiddenCount} 项，请缩小搜索</li>
            )}
          </ul>
        )}
        {missingCurrent && !openList && (
          <p className="ms-hint">当前配置，目录未列出</p>
        )}
      </div>

      <div className="ms-field">
        <label htmlFor={`ms-effort-${profile.id}`}>思考强度</label>
        {unknownEffort ? (
          <p className="ms-hint" role="status">
            该模型未提供可用的思考强度元数据，不能猜测档位
          </p>
        ) : unsupportedEffort ? (
          <p className="ms-hint" role="status">
            该模型不支持独立思考强度
          </p>
        ) : (
          <select
            id={`ms-effort-${profile.id}`}
            aria-label={`${toolLabel}思考强度`}
            disabled={disabled || !currentEntry}
            value={currentEffort}
            onChange={(event) => changeEffort(event.target.value)}
          >
            <option value="">请选择</option>
            {effortMissing && currentEffort && (
              <option value={currentEffort}>
                {effortCaption(currentEffort)}（当前配置，目录未列出）
              </option>
            )}
            {effortValues.map((value) => (
              <option key={value} value={value}>
                {effortOptionLabel(value)}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="ms-access" role="status">
        <span>访问状态：{accessStatusLabel(access)}</span>
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

      {loadError && (
        <p className="ms-error" role="alert">
          {loadError}
          <button
            type="button"
            className="ms-link"
            onClick={() => loadCatalog(adapter)}
          >
            重试
          </button>
        </p>
      )}
      {catalogStatus === "stale" && (
        <p className="ms-hint">目录可能已过期，可在工具状态中刷新</p>
      )}

      <details
        className="ms-advanced"
        open={advanced}
        onToggle={(event) =>
          setAdvanced((event.target as HTMLDetailsElement).open)
        }
      >
        <summary>高级选项</summary>
        <div className="ms-field">
          <label htmlFor={`ms-cli-${profile.id}`}>实际 CLI</label>
          <input
            id={`ms-cli-${profile.id}`}
            aria-label={`${toolLabel}实际 CLI`}
            disabled={disabled}
            value={rawExecutable}
            onChange={(event) => setRawExecutable(event.target.value)}
            onBlur={() => commitAdvanced("executableRef", rawExecutable)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitAdvanced("executableRef", rawExecutable);
              }
            }}
            placeholder="仅在明确指定路径时填写"
          />
        </div>
        <div className="ms-field">
          <label htmlFor={`ms-native-${profile.id}`}>原生命名配置</label>
          <input
            id={`ms-native-${profile.id}`}
            aria-label={`${toolLabel}原生命名配置`}
            disabled={disabled}
            value={rawNativeConfig}
            onChange={(event) => setRawNativeConfig(event.target.value)}
            onBlur={() =>
              commitAdvanced("nativeConfigProfile", rawNativeConfig)
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitAdvanced("nativeConfigProfile", rawNativeConfig);
              }
            }}
            placeholder="已有配置名，不是凭据"
          />
        </div>
        <div className="ms-field">
          <label htmlFor={`ms-raw-${profile.id}`}>原始模型 ID</label>
          <input
            id={`ms-raw-${profile.id}`}
            aria-label={`${toolLabel}原始模型 ID`}
            disabled={disabled}
            value={rawModelId}
            onChange={(event) => setRawModelId(event.target.value)}
            onBlur={commitRawModel}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitRawModel();
              }
            }}
          />
        </div>
      </details>
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

function effortOptionLabel(value: string): string {
  const known = EFFORT_LABELS[value as keyof typeof EFFORT_LABELS];
  return known ? `${known} · ${value}` : value;
}
