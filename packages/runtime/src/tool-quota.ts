import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolProfile } from "../../contracts/src/execution-spec.js";
import type { RunObservation } from "../../contracts/src/run-observation.js";
import type { AgyAccountService } from "../../agy-accounts/src/service.js";
import { quotaPoolCoversModel } from "../../agy-accounts/src/quota.js";
import { resolveAdapterExecutable } from "../../adapters/sdk/src/registry.js";
import { nativeLaunch } from "../../adapters/sdk/src/launch.js";
import { readCodexAccountQuota } from "./codex-account-quota.js";

/** Account quota is independent of which workflow role is currently running. */
export async function readToolQuota(profile: ToolProfile, cwd: string, accounts: AgyAccountService): Promise<RunObservation["quota"] | null> {
  if (profile.adapterId === "codex") {
    const path = resolveAdapterExecutable("codex", profile.executableRef);
    if (!path) return null;
    const launch = nativeLaunch(path, "codex");
    const snapshot = await readCodexAccountQuota({
      executable: launch.executable,
      prefixArgs: [...launch.prefix, ...(profile.options.prefixArgs ?? [])],
      cwd,
      home: process.env.CODEX_HOME ?? join(homedir(), ".codex"),
    });
    return snapshot ? { source: "account_api", observed_at: snapshot.observedAt, buckets: snapshot.buckets } : null;
  }
  if (profile.adapterId !== "agy" || !profile.modelId) return null;
  accounts.requestQuotaRefresh();
  const { realm, snapshots } = accounts.getPresentation();
  if (!("active_account_id" in realm) || !realm.active_account_id || realm.pending_operation_id) return null;
  const now = Date.now();
  const pools = snapshots.filter(s => s.account_id === realm.active_account_id &&
    s.auth_epoch === realm.auth_epoch && s.capability_verified &&
    Number.isFinite(Date.parse(s.observed_at)) && Date.parse(s.observed_at) <= now &&
    s.pool_id.toLowerCase() !== "global" && quotaPoolCoversModel(s, profile.modelId!));
  if (!pools.length) return null;
  return {
    source: "account_api",
    observed_at: pools.reduce((oldest, s) => Date.parse(s.observed_at) < Date.parse(oldest) ? s.observed_at : oldest, pools[0]!.observed_at),
    buckets: pools.map(s => ({ id: s.pool_id, model: profile.modelId, windows: s.windows.flatMap(w => {
      if (w.status !== "observed" || typeof w.remaining_fraction !== "number" ||
          !Number.isFinite(w.remaining_fraction) || w.remaining_fraction < 0 || w.remaining_fraction > 1 ||
          !Number.isFinite(Date.parse(w.observed_at)) || Date.parse(w.observed_at) > now ||
          s.windows.filter(other => other.kind === w.kind).length !== 1 ||
          !["weekly", "five_hour"].includes(w.kind) || !w.duration_minutes || w.duration_minutes <= 0) return [];
      const reset = w.reset_at ? Date.parse(w.reset_at) / 1000 : undefined;
      return [{ used_percent: (1 - w.remaining_fraction) * 100, window_minutes: w.duration_minutes,
        resets_at: reset && Number.isFinite(reset) ? reset : undefined }];
    }) })),
  };
}
