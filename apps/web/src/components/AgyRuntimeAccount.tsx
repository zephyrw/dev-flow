import React, { useEffect, useState } from "react";
import type {
  AgyAccountDto,
  AgyQuotaSnapshot,
} from "../../../../packages/contracts/src/agy-account.js";
import { agyApi } from "./agy-api.js";
import { formatQuotaWindow } from "../../../../packages/presentation/src/agy-accounts.js";
interface View {
  realm: { active_account_id?: string | null; service_state?: string };
  accounts: AgyAccountDto[];
  snapshots: AgyQuotaSnapshot[];
}
export function AgyRuntimeAccount({ modelId }: { modelId?: string }) {
  const [view, setView] = useState<View | null>(null);
  useEffect(() => {
    let mounted = true;
    const refresh = () =>
      void agyApi<View>("")
        .then((value) => {
          if (mounted) setView(value);
        })
        .catch(() => {
          if (mounted) setView(null);
        });
    refresh();
    const timer = setInterval(refresh, 15000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);
  const account = view?.accounts.find(
    (a) => a.id === view.realm?.active_account_id,
  );
  const snapshot = view?.snapshots.find(
    (s) =>
      s.account_id === account?.id &&
      !!modelId &&
      s.model_ids.includes(modelId),
  );
  const weekly = formatQuotaWindow(
    snapshot?.windows.find((w) => w.kind === "weekly"),
  );
  const short = formatQuotaWindow(
    snapshot?.windows.find((w) => w.kind === "five_hour"),
  );
  return (
    <a
      href="/accounts"
      title={
        snapshot
          ? `额度池 ${snapshot.pool_id}；上次实测 ${new Date(snapshot.observed_at).toLocaleString()}`
          : "打开账号管理"
      }
    >
      账号管理
      {account
        ? `：${account.identity.email} · 上次实测周 ${weekly.percentageText} / 五小时 ${short.percentageText}`
        : "：未纳入管理"}
    </a>
  );
}
