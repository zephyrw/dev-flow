import React, { useId, useLayoutEffect, useRef, useState } from "react";

/** Keep even a very long single-line script to one visual line until requested. */
export function CommandPreview({
  command,
  cwd,
}: {
  command: string;
  cwd?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const textRef = useRef<HTMLElement>(null);
  const id = useId();

  const firstLine = command.split(/\r?\n/, 1)[0] ?? "";
  const hasMultipleLines = command.includes("\n") || command.includes("\r");

  useLayoutEffect(() => {
    if (hasMultipleLines) {
      setCanExpand(true);
      return;
    }

    const el = textRef.current;
    if (!el) return;

    const checkOverflow = () => {
      const isOverflow = el.scrollWidth > el.clientWidth;
      // 在真实浏览器中根据 scrollWidth 判断溢出；若在无布局计算环境(如jsdom且clientWidth为0)，退化为字符数预估
      setCanExpand(
        isOverflow || (el.clientWidth === 0 && firstLine.length > 45),
      );
    };

    checkOverflow();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(checkOverflow);
      observer.observe(el);
      return () => observer.disconnect();
    }
  }, [command, firstLine, hasMultipleLines]);

  return (
    <div className="command-preview">
      <div className="command-preview-row">
        <code ref={textRef} className="command-first-line" title={command}>
          {firstLine}
        </code>
        {canExpand && (
          <button
            type="button"
            className="command-expand-btn"
            aria-expanded={expanded}
            aria-controls={id}
            title={expanded ? "收起命令" : "展开命令"}
            aria-label={expanded ? "收起命令" : "展开命令"}
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((prev) => !prev);
            }}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="currentColor"
              aria-hidden="true"
              style={{
                transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
                transition: "transform 0.15s ease",
              }}
            >
              <path d="M4.427 6.427l3.396 3.396a.25.25 0 00.354 0l3.396-3.396A.25.25 0 0011.396 6H4.604a.25.25 0 00-.177.427z" />
            </svg>
          </button>
        )}
      </div>
      {canExpand && expanded && (
        <div id={id}>
          <pre className="terminal-pre command-full">{command}</pre>
          {command.endsWith("…") && (
            <p className="notice-subtle">
              执行端已截断这条历史命令；以上为收到的全部内容。
            </p>
          )}
        </div>
      )}
      {cwd?.trim() && <p className="notice-subtle">工作目录：{cwd}</p>}
    </div>
  );
}
