import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  conversationCommandSuggestions,
  parseConversationInput,
  type AsideCommand,
} from "../../../../packages/core/src/conversation-input.js";
import {
  addWorkspaceReference,
  insertWorkspaceReference,
  nextReferencePopupState,
  ReferenceCandidatePopup,
  startWorkspaceReferenceDraft,
  type ReferenceItem,
} from "./RequirementComposer.js";
import {
  COMPOSER_TEXTAREA_ROWS,
  conversationHandoverHint,
  composerTextareaHeight,
  resolveComposerSendPayload,
  shouldSubmitComposerKey,
  applyConversationCommandSuggestion,
  removeConversationAsideCommand,
  useConversationDraft,
  type ConversationDraft,
  type ConversationDraftAttachment,
} from "../use-conversation-draft.js";
import {
  ConversationAttachments,
  conversationDropFiles,
  conversationPasteImageFiles,
  conversationPasteText,
  clearSubmittedConversationAttachments,
  isConversationFileDrag,
  useConversationAttachmentQueue,
} from "./ConversationAttachments.js";
import {
  ConversationStatusBar,
  useWorkflowComposerRuntime,
} from "./ConversationStatusBar.js";
import "./conversation-composer.css";

export interface ConversationComposerSlots {
  attachmentsSlot?: React.ReactNode;
  statusSlot?: React.ReactNode;
  modelSlot?: React.ReactNode;
}

export interface ConversationComposerSubmit {
  mode: "formal" | "aside";
  sendText: string;
  draftText: string;
  refs: ReferenceItem[];
  requestId: string;
  attachments: ConversationDraftAttachment[];
}

export function ConversationComposer({
  workflowId,
  draft,
  setText,
  setRefs,
  pending,
  readonly,
  readonlyReason,
  showRoundFeedback,
  fetchReferences,
  onSubmit,
  onOpenHistory,
  hasAsideHistory,
  attachmentsSlot,
  statusSlot,
  modelSlot,
  formalBlockedReason,
}: {
  workflowId: string;
  draft: ConversationDraft;
  setText: (text: string) => void;
  setRefs: (refs: ReferenceItem[]) => void;
  pending: boolean;
  readonly: boolean;
  readonlyReason: string;
  showRoundFeedback: boolean;
  fetchReferences: (query: string) => Promise<ReferenceItem[]>;
  onSubmit: (payload: ConversationComposerSubmit) => Promise<void>;
  onOpenHistory?: () => void;
  hasAsideHistory?: boolean;
  attachmentsSlot?: React.ReactNode;
  statusSlot?: React.ReactNode;
  modelSlot?: React.ReactNode;
  formalBlockedReason?: string;
}) {
  if (readonly) {
    return (
      <EndedComposer
        reason={readonlyReason}
        showRoundFeedback={showRoundFeedback}
      />
    );
  }
  return (
    <ActiveComposer
      workflowId={workflowId}
      draft={draft}
      setText={setText}
      setRefs={setRefs}
      pending={pending}
      fetchReferences={fetchReferences}
      onSubmit={onSubmit}
      onOpenHistory={onOpenHistory}
      hasAsideHistory={hasAsideHistory}
      attachmentsSlot={attachmentsSlot}
      statusSlot={statusSlot}
      modelSlot={modelSlot}
      formalBlockedReason={formalBlockedReason}
    />
  );
}

function EndedComposer({
  reason,
  showRoundFeedback,
}: {
  reason: string;
  showRoundFeedback: boolean;
}) {
  return (
    <div className="conversation-composer conversation-composer-readonly">
      <p className="conversation-composer-ended">{reason}</p>
      {showRoundFeedback && (
        <button
          type="button"
          className="conversation-composer-round-feedback"
          onClick={() =>
            window.dispatchEvent(new Event("devflow-open-round-feedback"))
          }
        >
          新一轮反馈
        </button>
      )}
    </div>
  );
}

function ActiveComposer({
  workflowId,
  draft,
  setText,
  setRefs,
  pending,
  fetchReferences,
  onSubmit,
  onOpenHistory,
  hasAsideHistory,
  attachmentsSlot,
  statusSlot,
  modelSlot,
  formalBlockedReason,
}: {
  workflowId: string;
  draft: ConversationDraft;
  setText: (text: string) => void;
  setRefs: (refs: ReferenceItem[]) => void;
  pending: boolean;
  fetchReferences: (query: string) => Promise<ReferenceItem[]>;
  onSubmit: (payload: ConversationComposerSubmit) => Promise<void>;
  onOpenHistory?: () => void;
  hasAsideHistory?: boolean;
  attachmentsSlot?: React.ReactNode;
  statusSlot?: React.ReactNode;
  modelSlot?: React.ReactNode;
  formalBlockedReason?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const submittingRef = useRef(false);
  const [composing, setComposing] = useState(false);
  const [referenceOpenTick, setReferenceOpenTick] = useState(0);
  const { setAttachments } = useConversationDraft(workflowId);
  const runtime = useWorkflowComposerRuntime(workflowId);
  const attachments = useConversationAttachmentQueue(
    workflowId,
    setAttachments,
    runtime.fileInput,
  );
  const parsed = parseConversationInput(draft.text);
  const resolved = resolveComposerSendPayload({
    text: draft.text,
    attachments: draft.attachments,
  });
  const payload =
    formalBlockedReason && resolved.mode === "formal"
      ? { ...resolved, canSend: false, reason: formalBlockedReason }
      : resolved;
  const suggestions =
    parsed.mode === "aside" ? [] : conversationCommandSuggestions(draft.text);
  const hint = conversationHandoverHint({
    mode: parsed.mode,
    readonly: false,
    receivedFormal: draft.receivedFormal,
  });

  const submit = useCallback(async () => {
    if (submittingRef.current || pending || !payload.canSend) return;
    submittingRef.current = true;
    const submittedIds = draft.attachments.map((item) => item.id);
    try {
      await onSubmit({
        mode: payload.mode,
        sendText: payload.sendText,
        draftText: payload.draftText,
        refs: draft.refs,
        requestId: draft.requestId,
        attachments: draft.attachments,
      });
      clearSubmittedConversationAttachments(workflowId, submittedIds);
    } finally {
      submittingRef.current = false;
    }
  }, [draft, onSubmit, payload, pending, workflowId]);

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = conversationPasteImageFiles(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    attachments.addFiles(files);
    const pasted = conversationPasteText(event.clipboardData);
    if (pasted) {
      insertTextAtCursor(textareaRef.current, draft.text, pasted, setText);
    }
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!isConversationFileDrag(event.dataTransfer)) return;
    event.preventDefault();
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    const files = conversationDropFiles(event.dataTransfer);
    if (!files.length) return;
    event.preventDefault();
    attachments.addFiles(files);
  };

  return (
    <div
      className="conversation-composer"
      id={`conversation-composer-${workflowId}`}
      data-conversation-composer=""
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div
        className="conversation-composer-attachments"
        data-slot="attachments"
      >
        <ConversationAttachments
          workflowId={workflowId}
          items={attachments.items}
          limitReason={attachments.limitReason}
          onRetry={attachments.retry}
          onRemove={attachments.remove}
          inputRef={attachments.inputRef}
          onFileInput={attachments.handleFileInput}
        />
        {attachmentsSlot}
      </div>
      <ReferenceTags refs={draft.refs} onChange={setRefs} />
      {parsed.mode === "aside" && (
        <AsideChip onRemove={() => setText(removeConversationAsideCommand(draft.text))} />
      )}
      {hasAsideHistory && onOpenHistory && parsed.mode === "aside" && (
        <button
          type="button"
          className="conversation-composer-history"
          disabled={pending}
          onClick={onOpenHistory}
        >
          历史提问
        </button>
      )}
      <SlashSuggestions
        commands={suggestions}
        onPick={(command) =>
          setText(applyConversationCommandSuggestion(draft.text, command))
        }
      />
      <ComposerInput
        textareaRef={textareaRef}
        text={draft.text}
        refs={draft.refs}
        composing={composing}
        setComposing={setComposing}
        setText={setText}
        setRefs={setRefs}
        fetchReferences={fetchReferences}
        referenceOpenTick={referenceOpenTick}
        onSubmit={submit}
        onPaste={handlePaste}
      />
      <ComposerFooter
        pending={pending}
        canSend={payload.canSend}
        sendReason={payload.reason}
        statusSlot={statusSlot}
        modelSlot={modelSlot}
        textareaRef={textareaRef}
        text={draft.text}
        setText={setText}
        workflowId={workflowId}
        runtime={runtime}
        onUploadLocal={attachments.pickLocalFiles}
        onCiteWorkspace={() => setReferenceOpenTick((value) => value + 1)}
        onSubmit={submit}
      />
      {payload.reason &&
        !payload.canSend &&
        payload.reason !== "请输入内容或添加附件" && (
          <p className="conversation-composer-reason">{payload.reason}</p>
        )}
      {hint && hint !== "发送后调整当前任务" && (
        <p className="conversation-composer-hint">{hint}</p>
      )}
    </div>
  );
}

function insertTextAtCursor(
  textarea: HTMLTextAreaElement | null,
  current: string,
  inserted: string,
  setText: (text: string) => void,
): void {
  if (!textarea) {
    setText(current + inserted);
    return;
  }
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const next = current.slice(0, start) + inserted + current.slice(end);
  setText(next);
  requestAnimationFrame(() => {
    const pos = start + inserted.length;
    textarea.setSelectionRange(pos, pos);
  });
}

function ReferenceTags({
  refs,
  onChange,
}: {
  refs: ReferenceItem[];
  onChange: (refs: ReferenceItem[]) => void;
}) {
  if (!refs.length) return null;
  return (
    <div className="conversation-composer-tags">
      {refs.map((ref, index) => (
        <span
          key={`${ref.repo_id}:${ref.relative_path}`}
          className="conversation-composer-ref"
        >
          <span>{ref.kind === "directory" ? "📁" : "📄"}</span>
          <span>{ref.relative_path}</span>
          <button
            type="button"
            aria-label="移除引用"
            onClick={() => onChange(refs.filter((_, i) => i !== index))}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

function AsideChip({ onRemove }: { onRemove: () => void }) {
  return (
    <span className="conversation-composer-chip">
      临时提问
      <button type="button" aria-label="移除临时提问" onClick={onRemove}>
        ×
      </button>
    </span>
  );
}

function SlashSuggestions({
  commands,
  onPick,
}: {
  commands: AsideCommand[];
  onPick: (command: AsideCommand) => void;
}) {
  if (!commands.length) return null;
  return (
    <div className="conversation-composer-suggestions" role="listbox" aria-label="命令建议">
      {commands.map((command) => (
        <button
          key={command}
          type="button"
          role="option"
          onClick={() => onPick(command)}
        >
          /{command}
        </button>
      ))}
    </div>
  );
}

function setComposerIme(
  composingRef: React.MutableRefObject<boolean>,
  skipEnterRef: React.MutableRefObject<boolean>,
  setComposing: (value: boolean) => void,
  next: boolean,
) {
  composingRef.current = next;
  skipEnterRef.current = !next;
  setComposing(next);
}

function bindComposerIme(
  el: HTMLTextAreaElement,
  composingRef: React.MutableRefObject<boolean>,
  skipEnterRef: React.MutableRefObject<boolean>,
  setComposing: (value: boolean) => void,
) {
  const start = () =>
    setComposerIme(composingRef, skipEnterRef, setComposing, true);
  const end = () =>
    setComposerIme(composingRef, skipEnterRef, setComposing, false);
  el.addEventListener("compositionstart", start);
  el.addEventListener("compositionend", end);
  return () => {
    el.removeEventListener("compositionstart", start);
    el.removeEventListener("compositionend", end);
  };
}

function ComposerInput({
  textareaRef,
  text,
  refs,
  composing,
  setComposing,
  setText,
  setRefs,
  fetchReferences,
  referenceOpenTick,
  onSubmit,
  onPaste,
}: {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  text: string;
  refs: ReferenceItem[];
  composing: boolean;
  setComposing: (value: boolean) => void;
  setText: (text: string) => void;
  setRefs: (refs: ReferenceItem[]) => void;
  fetchReferences: (query: string) => Promise<ReferenceItem[]>;
  referenceOpenTick: number;
  onSubmit: () => Promise<void>;
  onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
}) {
  const search = useComposerReferences(
    textareaRef,
    text,
    refs,
    setText,
    setRefs,
    fetchReferences,
    referenceOpenTick,
  );
  const composingRef = useRef(false);
  const skipEnterRef = useRef(false);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const line = Number.parseFloat(getComputedStyle(el).lineHeight) || 19.5;
    const min = line * COMPOSER_TEXTAREA_ROWS + 16;
    el.style.height = `${composerTextareaHeight(el.scrollHeight, min)}px`;
  }, [text, textareaRef]);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return undefined;
    return bindComposerIme(el, composingRef, skipEnterRef, setComposing);
  }, [textareaRef, setComposing]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const skipEnterAfterComposition = skipEnterRef.current;
    if (event.key === "Enter") skipEnterRef.current = false;
    const nativeComposing = event.nativeEvent.isComposing;
    const ime = composingRef.current || composing || nativeComposing;
    if (ime) {
      if (event.key === "Enter" && !nativeComposing) event.preventDefault();
      return;
    }
    if (search.handlePopupKey(event)) return;
    if (
      shouldSubmitComposerKey({
        key: event.key,
        shiftKey: event.shiftKey,
        composing: ime,
        keyCode: event.nativeEvent.keyCode,
        skipEnterAfterComposition,
      })
    ) {
      event.preventDefault();
      void onSubmit();
    }
  };

  const markImeStart = () =>
    setComposerIme(composingRef, skipEnterRef, setComposing, true);
  const markImeEnd = () =>
    setComposerIme(composingRef, skipEnterRef, setComposing, false);

  return (
    <div style={{ position: "relative" }}>
      <textarea
        ref={textareaRef}
        className="conversation-composer-input"
        rows={COMPOSER_TEXTAREA_ROWS}
        value={text}
        placeholder="输入指导，或输入 /btw、/side 临时提问。输入 @ 引用文件或目录"
        onChange={(event) => search.handleTextChange(event)}
        onKeyDown={handleKeyDown}
        onCompositionStart={markImeStart}
        onCompositionEnd={markImeEnd}
        onPaste={onPaste}
      />
      {search.showPopup && (
        <ReferenceCandidatePopup
          candidates={search.candidates}
          selectedIndex={search.selectedIndex}
          position={search.popupPosition}
          onSelect={search.selectCandidate}
        />
      )}
    </div>
  );
}

function ComposerFooter({
  pending,
  canSend,
  sendReason,
  statusSlot,
  modelSlot,
  textareaRef,
  text,
  setText,
  workflowId,
  runtime,
  onUploadLocal,
  onCiteWorkspace,
  onSubmit,
}: {
  pending: boolean;
  canSend: boolean;
  sendReason?: string;
  statusSlot?: React.ReactNode;
  modelSlot?: React.ReactNode;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  text: string;
  setText: (text: string) => void;
  workflowId: string;
  runtime: ReturnType<typeof useWorkflowComposerRuntime>;
  onUploadLocal: () => void;
  onCiteWorkspace: () => void;
  onSubmit: () => Promise<void>;
}) {
  return (
    <div className="conversation-composer-footer">
      <PlusMenu
        textareaRef={textareaRef}
        text={text}
        setText={setText}
        onUploadLocal={onUploadLocal}
        onCiteWorkspace={onCiteWorkspace}
      />
      <div className="conversation-composer-status-slot" data-slot="status">
        {statusSlot}
        <ConversationStatusBar workflowId={workflowId} model={runtime} />
        {modelSlot}
      </div>
      <button
        type="button"
        className="conversation-composer-send"
        aria-label="发送"
        title={canSend ? "发送" : sendReason}
        disabled={pending || !canSend}
        onClick={() => void onSubmit()}
      >
        ↑
      </button>
    </div>
  );
}

function PlusMenu({
  textareaRef,
  text,
  setText,
  onUploadLocal,
  onCiteWorkspace,
}: {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  text: string;
  setText: (text: string) => void;
  onUploadLocal: () => void;
  onCiteWorkspace: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const citeWorkspace = () => {
    const el = textareaRef.current;
    const cursor = el?.selectionStart ?? text.length;
    const next = startWorkspaceReferenceDraft(text, cursor);
    setText(next.text);
    onCiteWorkspace();
    setOpen(false);
    requestAnimationFrame(() => {
      if (!textareaRef.current) return;
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(next.cursor, next.cursor);
    });
  };

  return (
    <div className="conversation-composer-plus-wrap" ref={wrapRef}>
      <button
        type="button"
        className="conversation-composer-plus"
        aria-label="添加附件或引用"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        +
      </button>
      {open && (
        <div className="conversation-composer-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onUploadLocal();
              setOpen(false);
            }}
          >
            上传本地文件
          </button>
          <button type="button" role="menuitem" onClick={citeWorkspace}>
            引用工作区文件或目录
          </button>
        </div>
      )}
    </div>
  );
}

function useComposerReferences(
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
  text: string,
  refs: ReferenceItem[],
  setText: (text: string) => void,
  setRefs: (refs: ReferenceItem[]) => void,
  fetchReferences: (query: string) => Promise<ReferenceItem[]>,
  referenceOpenTick: number,
) {
  const [showPopup, setShowPopup] = useState(false);
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<ReferenceItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [popupPosition, setPopupPosition] = useState<React.CSSProperties>({});
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleTextChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextText = event.target.value;
    setText(nextText);
    const next = nextReferencePopupState(
      nextText,
      event.target.selectionStart,
      showPopup,
    );
    setShowPopup(next.open);
    if (next.open) {
      setQuery(next.query);
      if (next.query === "") setSelectedIndex(0);
    }
  };

  useEffect(() => {
    if (!referenceOpenTick) return;
    setShowPopup(true);
    setQuery("");
    setSelectedIndex(0);
  }, [referenceOpenTick]);

  useEffect(() => {
    if (!showPopup) return;
    const position = () => {
      const rect = textareaRef.current?.getBoundingClientRect();
      if (!rect) return;
      const above = rect.top >= 180;
      const height = Math.min(
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
  }, [showPopup, textareaRef]);

  useEffect(() => {
    if (!showPopup) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void fetchReferences(query)
        .then((items) => {
          setCandidates(items.slice(0, 50));
          setSelectedIndex(0);
        })
        .catch(() => {
          setCandidates([]);
        });
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [fetchReferences, query, showPopup]);

  const selectCandidate = useCallback(
    (item: ReferenceItem) => {
      if (!textareaRef.current) return;
      const inserted = insertWorkspaceReference(
        text,
        textareaRef.current.selectionStart,
        item,
      );
      setText(inserted.text);
      setRefs(addWorkspaceReference(refs, item));
      setShowPopup(false);
      requestAnimationFrame(() => {
        if (!textareaRef.current) return;
        textareaRef.current.setSelectionRange(inserted.cursor, inserted.cursor);
        textareaRef.current.focus();
      });
    },
    [refs, setRefs, setText, text, textareaRef],
  );

  const handlePopupKey = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!showPopup || candidates.length === 0) return false;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % candidates.length);
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex(
        (prev) => (prev - 1 + candidates.length) % candidates.length,
      );
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      const item = candidates[selectedIndex];
      if (item) selectCandidate(item);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setShowPopup(false);
      return true;
    }
    return false;
  };

  return {
    showPopup,
    candidates,
    selectedIndex,
    popupPosition,
    handleTextChange,
    handlePopupKey,
    selectCandidate,
  };
}
