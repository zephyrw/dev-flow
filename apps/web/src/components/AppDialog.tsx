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
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}

export function AppDialog({
  isOpen,
  onClose,
  title,
  titleExtra,
  subtitle,
  width = 720,
  isDirty = false,
  children,
  footer,
  className = "",
}: AppDialogProps) {
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const previousActiveElement = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      previousActiveElement.current = document.activeElement as HTMLElement | null;
      setShowDiscardConfirm(false);
      // 锁定背景滚动
      document.body.style.overflow = "hidden";
      // 打开时自动聚焦关闭按钮或标题
      setTimeout(() => {
        closeButtonRef.current?.focus();
      }, 50);
    } else {
      document.body.style.overflow = "";
      if (previousActiveElement.current) {
        previousActiveElement.current.focus();
        previousActiveElement.current = null;
      }
    }
    return () => {
      document.body.style.overflow = "";
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
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-dialog-title"
      >
        <div className="app-dialog-header">
          <div className="app-dialog-title-wrap">
            <div className="app-dialog-title-row">
              <h2 id="app-dialog-title" className="app-dialog-title">
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
            ref={closeButtonRef}
          >
            ×
          </button>
        </div>

        <div className="app-dialog-body">
          {showDiscardConfirm ? (
            <div className="app-dialog-confirm-discard">
              <p className="app-dialog-confirm-text">
                有未保存的修改，确定要放弃并退出吗？
              </p>
              <div className="app-dialog-confirm-actions">
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
          ) : (
            children
          )}
        </div>

        {footer && !showDiscardConfirm && (
          <div className="app-dialog-footer">{footer}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}
