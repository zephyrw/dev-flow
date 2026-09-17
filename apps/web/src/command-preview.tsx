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
            aria-expanded={expanded}
            aria-controls={id}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "收起命令" : "展开命令"}
          </button>
        )}
      </div>
      {canExpand && expanded && (
        <div id={id}>
          <pre className="terminal-pre command-full">{command}</pre>
          {cwd && <p className="notice-subtle">工作目录：{cwd}</p>}
          {command.endsWith("…") && (
            <p className="notice-subtle">
              执行端已截断这条历史命令；以上为收到的全部内容。
            </p>
          )}
        </div>
      )}
    </div>
  );
}
