import React, { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";

export interface ReferenceItem {
  ref_id: string;
  repo_id: string;
  relative_path: string;
  kind: "file" | "directory";
  label?: string;
}

export interface RequirementComposerProps {
  placeholder?: string;
  onSubmit: (text: string, refs: ReferenceItem[]) => Promise<any> | void;
  disabled?: boolean;
  initialText?: string;
  submitLabel?: string;
  fetchReferences?: (query: string) => Promise<ReferenceItem[]>;
  extraActions?: React.ReactNode;
}

export function RequirementComposer({
  placeholder = "输入需求或反馈... 输入 @ 引用工作区文件或目录",
  onSubmit,
  disabled = false,
  initialText = "",
  submitLabel = "提交",
  fetchReferences,
  extraActions,
}: RequirementComposerProps) {
  const [text, setText] = useState(initialText);
  const [refs, setRefs] = useState<ReferenceItem[]>([]);
  const [isComposing, setIsComposing] = useState(false);
  const [showPopup, setShowPopup] = useState(false);
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<ReferenceItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [popupPosition, setPopupPosition] = useState<React.CSSProperties>({});
  useEffect(() => {
    if (!showPopup) return;
    const position = () => {
      const rect = textareaRef.current?.getBoundingClientRect();
      if (!rect) return;
      const above = rect.top >= 180,
        height = Math.min(
          220,
          above ? rect.top - 8 : window.innerHeight - rect.bottom - 8,
        );
      setPopupPosition({
        position: "fixed",
        left: Math.max(8, rect.left),
        width: Math.min(rect.width, window.innerWidth - 16),
        maxHeight: Math.max(60, height),
        ...(above
          ? { bottom: window.innerHeight - rect.top + 4 }
          : { top: rect.bottom + 4 }),
      });
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [showPopup]);

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setText(val);

    const cursorPos = e.target.selectionStart;
    const textBeforeCursor = val.slice(0, cursorPos);
    const lastAtIndex = textBeforeCursor.lastIndexOf("@");

    if (lastAtIndex !== -1 && lastAtIndex === cursorPos - 1) {
      setShowPopup(true);
      setQuery("");
      setSelectedIndex(0);
    } else if (lastAtIndex !== -1 && showPopup) {
      const currentQuery = textBeforeCursor.slice(lastAtIndex + 1);
      if (currentQuery.includes(" ") || currentQuery.includes("\n")) {
        setShowPopup(false);
      } else {
        setQuery(currentQuery);
      }
    } else {
      setShowPopup(false);
    }
  };

  useEffect(() => {
    if (!showPopup || !fetchReferences) return;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);

    debounceTimerRef.current = setTimeout(async () => {
      try {
        const results = await fetchReferences(query);
        setCandidates(results.slice(0, 50));
        setSelectedIndex(0);
      } catch (err) {
        console.error("加载文件引用候选失败", err);
      }
    }, 200);

    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [query, showPopup, fetchReferences]);

  const selectCandidate = useCallback(
    (item: ReferenceItem) => {
      if (!textareaRef.current) return;
      const cursorPos = textareaRef.current.selectionStart;
      const textBeforeCursor = text.slice(0, cursorPos);
      const lastAtIndex = textBeforeCursor.lastIndexOf("@");
      const textAfterCursor = text.slice(cursorPos);

      const newText =
        text.slice(0, lastAtIndex) +
        `@${item.relative_path} ` +
        textAfterCursor;
      setText(newText);
      setShowPopup(false);

      if (
        !refs.some(
          (r) =>
            r.relative_path === item.relative_path &&
            r.repo_id === item.repo_id,
        )
      ) {
        setRefs((prev) => [...prev, item]);
      }

      setTimeout(() => {
        if (textareaRef.current) {
          const nextPos = lastAtIndex + item.relative_path.length + 2;
          textareaRef.current.setSelectionRange(nextPos, nextPos);
          textareaRef.current.focus();
        }
      }, 10);
    },
    [text, refs],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposing || e.nativeEvent.isComposing) return;

    if (showPopup && candidates.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % candidates.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex(
          (prev) => (prev - 1 + candidates.length) % candidates.length,
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (candidates[selectedIndex]) {
          selectCandidate(candidates[selectedIndex]);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setShowPopup(false);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleFinalSubmit();
    }
  };

  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleFinalSubmit = async () => {
    if (disabled || submitting || !text.trim()) return;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      await onSubmit(text.trim(), refs);
      setText("");
      setRefs([]);
      setShowPopup(false);
    } catch (err: any) {
      setErrorMessage(err.message || String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const removeRef = (idx: number) => {
    setRefs((prev) => prev.filter((_, i) => i !== idx));
  };

  return (
    <div
      className="requirement-composer"
      style={{ position: "relative", width: "100%" }}
    >
      {refs.length > 0 && (
        <div
          className="composer-tags"
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "6px",
            marginBottom: "6px",
          }}
        >
          {refs.map((r, i) => (
            <span
              key={`${r.repo_id}:${r.relative_path}`}
              className="ref-tag"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                fontSize: "12px",
                padding: "2px 8px",
                background: "var(--color-bg-subtle, #f1f3f5)",
                borderRadius: "4px",
                border: "1px solid var(--color-border, #d0d7de)",
              }}
            >
              <span>{r.kind === "directory" ? "📁" : "📄"}</span>
              <span
                style={{
                  maxWidth: "200px",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {r.relative_path}
              </span>
              <button
                type="button"
                onClick={() => removeRef(i)}
                style={{
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  fontSize: "12px",
                  color: "#6c757d",
                }}
                aria-label="移除引用"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div style={{ position: "relative" }}>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleTextChange}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          placeholder={placeholder}
          disabled={disabled}
          rows={3}
          style={{
            width: "100%",
            boxSizing: "border-box",
            resize: "vertical",
            padding: "8px 10px",
            fontSize: "13px",
            lineHeight: "1.5",
            borderRadius: "6px",
            border: "1px solid var(--color-border, #d0d7de)",
            background: "var(--color-canvas, #ffffff)",
            color: "inherit",
          }}
        />

        {showPopup &&
          candidates.length > 0 &&
          createPortal(
            <div
              className="reference-popup"
              style={{
                ...popupPosition,
                overflowY: "auto",
                background: "var(--color-canvas-overlay, #ffffff)",
                border: "1px solid var(--color-border, #d0d7de)",
                borderRadius: "6px",
                boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
                zIndex: 10000,
                marginBottom: "4px",
              }}
            >
              <div
                style={{
                  padding: "4px 8px",
                  fontSize: "11px",
                  color: "#6c757d",
                  borderBottom: "1px solid #f1f3f5",
                }}
              >
                按 ↑↓ 选择，Enter 确认，Esc 取消
              </div>
              {candidates.map((c, i) => (
                <div
                  key={`${c.repo_id}:${c.relative_path}`}
                  onClick={() => selectCandidate(c)}
                  style={{
                    padding: "6px 10px",
                    fontSize: "12px",
                    cursor: "pointer",
                    background:
                      i === selectedIndex
                        ? "var(--color-accent-muted, #e7f5ff)"
                        : "transparent",
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                >
                  <span>{c.kind === "directory" ? "📁" : "📄"}</span>
                  <span
                    style={{
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {c.relative_path}
                  </span>
                </div>
              ))}
            </div>,
            document.body,
          )}
      </div>

      <div className="composer-actions">
        {extraActions}
        <button
          type="button"
          onClick={handleFinalSubmit}
          disabled={disabled || submitting || !text.trim()}
          className="btn btn-primary btn-sm"
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
