import type { Run, ToolProfile } from "../../contracts/src/index.js";
import type { Store } from "../../store/src/store.js";
import { objectHash } from "./util.js";

export function nativeAdapter(run: Run): string | undefined {
  return run.frozen_invocation?.adapterId ?? run.profile?.adapterId ?? run.adapter;
}

/** Model and effort belong to an invocation, not to the native conversation. */
export function nativeSessionScope(run: Run): string | undefined {
  const frozen = run.frozen_invocation ?? run.model_binding?.frozen_invocation;
  const profile = run.profile;
  if (!frozen && !profile) return undefined;
  return objectHash({
    adapter: nativeAdapter(run),
    executable: frozen?.executable ?? profile?.executableRef ?? nativeAdapter(run),
    config: frozen?.nativeConfigProfile ?? profile?.nativeConfigProfile ?? "",
    provider: frozen?.providerScope ?? profile?.providerConfigRef ?? nativeAdapter(run),
    account: frozen?.accountScope ?? profile?.nativeConfigProfile ?? "default",
    options: profile?.options ?? {},
  });
}

export function sameNativeSessionScope(source: Run, target: Run): boolean {
  const scope = nativeSessionScope(source);
  return source.workflow_id === target.workflow_id && !!scope && scope === nativeSessionScope(target);
}

export function nativeRootForRun(store: Store, run: Run): string | undefined {
  const root = (run as Run & { root_session_id?: string }).root_session_id;
  for (const value of [root, run.conversation_id]) {
    if (!value) continue;
    const node = store.get<{ adapter_id: string; native_session_id?: string; id: string; root_id: string }>("conversation_node", value);
    if (node) {
      if (node.id === node.root_id && node.adapter_id === nativeAdapter(run) && node.native_session_id) return node.native_session_id;
      continue;
    }
    if (!value.startsWith("cnv-") && !value.startsWith("leg-")) return value;
  }
  return undefined;
}

export function profileSessionScopeMatches(profile: ToolProfile | undefined, run: Run): boolean {
  if (!profile) return false;
  return nativeSessionScope({ ...run, profile, frozen_invocation: undefined, model_binding: undefined, adapter: profile.adapterId }) ===
    nativeSessionScope({ ...run, frozen_invocation: undefined, model_binding: undefined });
}
