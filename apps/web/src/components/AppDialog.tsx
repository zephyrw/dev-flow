import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./app-dialog.css";

export interface AppDialogProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  titleExtra?: React.ReactNode;
  subtitle?: string;
  width?: number | string;
  isDirty?: boolean;
  busy?: boolean;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}

// 模块级模态计数器，确保多弹窗并存时滚动锁安全恢复
const openModals: HTMLElement[] = [];
let initialBodyOverflow = "";
const inertValues = new Map<HTMLElement, boolean>();

function updateModalBackground() {
  for (const [element, inert] of inertValues) element.inert = inert;
  inertValues.clear();
  const top = openModals.at(-1);
  if (top) {
    for (const child of Array.from(document.body.children)) {
      if (child instanceof HTMLElement && !child.contains(top)) {
        inertValues.set(child, child.inert);
        child.inert = true;
      }
    }
  }
}

export function AppDialog({
  isOpen,
  onClose,
  title,
  titleExtra,
  subtitle,
  width = 720,
  isDirty = false,
  busy = false,
  children,
  footer,
  className = "",
}: AppDialogProps) {
  const generatedId = React.useId();
  const titleId = `app-dialog-title-${generatedId.replace(/:/g, "")}`;
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const previousActiveElement = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (isOpen && dialog) {
      previousActiveElement.current =
        document.activeElement as HTMLElement | null;
      setShowDiscardConfirm(false);
      if (!openModals.length) {
        initialBodyOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
      }
      openModals.push(dialog);
      updateModalBackground();
      closeButtonRef.current?.focus();
      const containFocus = (event: FocusEvent) => {
        if (
          openModals.at(-1) === dialog &&
          !dialog.contains(event.target as Node)
        )
          dialog.focus();
      };
      document.addEventListener("focusin", containFocus);
      return () => {
        document.removeEventListener("focusin", containFocus);
        const wasTop = openModals.at(-1) === dialog;
        const index = openModals.indexOf(dialog);
        if (index >= 0) openModals.splice(index, 1);
        updateModalBackground();
        if (!openModals.length)
          document.body.style.overflow = initialBodyOverflow;
        if (wasTop) {
          const previous = previousActiveElement.current;
          const top = openModals.at(-1);
          if (previous?.isConnected && (!top || top.contains(previous)))
            previous.focus();
          else top?.focus();
        }
        previousActiveElement.current = null;
      };
    }
  }, [isOpen]);

  const handleRequestClose = () => {
    if (busy) return;
    if (isDirty && !showDiscardConfirm) {
      setShowDiscardConfirm(true);
      return;
    }
    setShowDiscardConfirm(false);
    onClose();
  };

  // F09: 键盘事件监听：Escape 关闭 + Tab / Shift+Tab 焦点陷阱
  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || openModals.at(-1) !== dialogRef.current) return;
      if (e.key === "Escape") {
        e.preventDefault();
        if (showDiscardConfirm) {
          setShowDiscardConfirm(false);
        } else {
          handleRequestClose();
        }
        return;
      }

      if (e.key === "Tab" && dialogRef.current) {
        const scope = showDiscardConfirm
          ? (dialogRef.current.querySelector(".app-dialog-discard-content") ??
            dialogRef.current)
          : dialogRef.current;
        const focusableElements = Array.from(
          scope.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        ).filter(
          (element) =>
            element.tabIndex >= 0 &&
            !element.closest('[hidden], [inert], [aria-hidden="true"]'),
        );
        if (focusableElements.length === 0) {
          e.preventDefault();
          return;
        }

        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];
        if (!firstElement || !lastElement) return;

        if (e.shiftKey) {
          if (
            document.activeElement === firstElement ||
            !scope.contains(document.activeElement)
          ) {
            e.preventDefault();
            lastElement.focus();
          }
        } else {
          if (
            document.activeElement === lastElement ||
            !scope.contains(document.activeElement)
          ) {
            e.preventDefault();
            firstElement.focus();
          }
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, isDirty, showDiscardConfirm, busy, onClose]);

  if (!isOpen) return null;

  const styleWidth = typeof width === "number" ? `${width}px` : width;

  return createPortal(
    <div
      className="app-dialog-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          handleRequestClose();
        }
      }}
      role="presentation"
    >
      <div
        className={`app-dialog-container ${className}`}
        style={{ width: styleWidth }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        tabIndex={-1}
      >
        <div className="app-dialog-header">
          <div className="app-dialog-title-wrap">
            <div className="app-dialog-title-row">
              <h2 id={titleId} className="app-dialog-title">
                {title}
              </h2>
              {titleExtra}
            </div>
            {subtitle && (
              <p className="app-dialog-subtitle">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            className="app-dialog-close-btn"
            onClick={handleRequestClose}
            aria-label="关闭对话框"
            disabled={busy}
            ref={closeButtonRef}
          >
            &times;
          </button>
        </div>

        <div className="app-dialog-body">{children}</div>

        {footer && <div className="app-dialog-footer">{footer}</div>}

        {showDiscardConfirm && (
          <div className="app-dialog-discard-confirm">
            <div className="app-dialog-discard-content">
              <p>内容尚未保存，确定要放弃修改吗？</p>
              <div className="app-dialog-discard-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowDiscardConfirm(false)}
                >
                  继续编辑
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => {
                    setShowDiscardConfirm(false);
                    onClose();
                  }}
                >
                  放弃修改
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
