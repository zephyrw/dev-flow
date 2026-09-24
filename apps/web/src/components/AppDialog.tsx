import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./app-dialog.css";

export interface AppDialogProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  width?: number | string;
  isDirty?: boolean;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}

// 模块级模态计数器，确保多弹窗并存时滚动锁安全恢复
let openModalsCount = 0;
let initialBodyOverflow = "";

function lockBodyScroll() {
  if (openModalsCount === 0) {
    initialBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  openModalsCount++;
}

function unlockBodyScroll() {
  openModalsCount = Math.max(0, openModalsCount - 1);
  if (openModalsCount === 0) {
    document.body.style.overflow = initialBodyOverflow;
  }
}

export function AppDialog({
  isOpen,
  onClose,
  title,
  subtitle,
  width = 720,
  isDirty = false,
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
  const focusTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (isOpen) {
      previousActiveElement.current = document.activeElement as HTMLElement | null;
      setShowDiscardConfirm(false);
      lockBodyScroll();

      // 打开时自动聚焦关闭按钮或首个交互元素
      focusTimeoutRef.current = setTimeout(() => {
        if (closeButtonRef.current) {
          closeButtonRef.current.focus();
        } else if (dialogRef.current) {
          const focusable = dialogRef.current.querySelector<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
          );
          focusable?.focus();
        }
      }, 50);
    } else {
      unlockBodyScroll();
      if (previousActiveElement.current) {
        try {
          previousActiveElement.current.focus();
        } catch {
          // 元素可能已脱离 DOM
        }
        previousActiveElement.current = null;
      }
    }

    return () => {
      if (focusTimeoutRef.current) {
        clearTimeout(focusTimeoutRef.current);
      }
      unlockBodyScroll();
      // F09: 组件卸载时也要确保焦点恢复
      if (previousActiveElement.current) {
        try {
          previousActiveElement.current.focus();
        } catch {
          // 元素已脱离 DOM
        }
        previousActiveElement.current = null;
      }
    };
  }, [isOpen]);

  const handleRequestClose = () => {
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
        const focusableElements = dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusableElements.length === 0) {
          e.preventDefault();
          return;
        }

        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];
        if (!firstElement || !lastElement) return;

        if (e.shiftKey) {
          if (document.activeElement === firstElement || !dialogRef.current.contains(document.activeElement)) {
            e.preventDefault();
            lastElement.focus();
          }
        } else {
          if (document.activeElement === lastElement || !dialogRef.current.contains(document.activeElement)) {
            e.preventDefault();
            firstElement.focus();
          }
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, isDirty, showDiscardConfirm]);

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
      >
        <div className="app-dialog-header">
          <div>
            <h2 id={titleId} className="app-dialog-title">
              {title}
            </h2>
            {subtitle && <p className="app-dialog-subtitle">{subtitle}</p>}
          </div>
          <button
            type="button"
            className="app-dialog-close-btn"
            onClick={handleRequestClose}
            aria-label="关闭对话框"
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
