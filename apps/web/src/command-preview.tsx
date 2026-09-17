import React, { useId, useState } from "react";

/** Keep even a very long single-line script to one visual line until requested. */
export function CommandPreview({
  command,
  cwd,
}: {
  command: string;
  cwd?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  return (
    <div className="command-preview">
      <div className="command-preview-row">
        <code className="command-first-line">
          {command.split(/\r?\n/, 1)[0]}
        </code>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "收起命令" : "展开命令"}
        </button>
      </div>
      {expanded && (
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
