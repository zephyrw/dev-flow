import React from "react";

export function PlanMaterialNotice({ error, onRetry }: {
  error: { code: string; message: string };
  onRetry: () => Promise<void>;
}) {
  const [retrying, setRetrying] = React.useState(false);
  const [retryError, setRetryError] = React.useState("");
  return <div className="empty" role="alert">
    <h3>开发计划暂时无法读取</h3>
    <p>{error.message}</p>
    <p>恢复计划原件后重新读取，即可继续查看。</p>
    {retryError && <p>{retryError}</p>}
    <button type="button" className="btn-secondary" disabled={retrying}
      onClick={async () => {
        setRetrying(true);
        setRetryError("");
        try { await onRetry(); }
        catch { setRetryError("重新读取失败，请稍后重试。"); }
        finally { setRetrying(false); }
      }}>{retrying ? "正在重新读取…" : "重新读取计划"}</button>
  </div>;
}
