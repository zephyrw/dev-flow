import type { ToolProfile } from "../../../contracts/src/execution-spec.js";
import type { ModelCatalog, ModelEntry } from "../../../contracts/src/model-catalog.js";
import type { NativeResolvedConfig } from "../../../contracts/src/model-access.js";
import {
  FrozenInvocationSchema,
  type FrozenInvocation,
  type RuntimeFlavor,
} from "../../../contracts/src/model-routing.js";
import type {
  ModelSelectionCapability,
  RunContext,
} from "./interface.js";
import { resolveModelSelection } from "./model-selection.js";

/** The same persisted capability is used by access probes and business runs. */
export function selectionCapabilityFromCatalog(
  catalog: ModelCatalog | undefined,
  entry?: ModelEntry,
): ModelSelectionCapability {
  return {
    cliVersion: catalog?.cliVersion,
    opencodeVariantEncoding: catalog?.invocationCapability?.opencodeVariantEncoding,
    ...(entry?.adapterId === "kimi-code"
      ? { kimiProvider: entry.providerId, kimiSupportEfforts: entry.effort.values }
      : {}),
  };
}

export function capabilityForSelection(
  catalogEntry: ModelEntry | undefined,
  capability: ModelSelectionCapability = {},
): ModelSelectionCapability {
  const kimiProvider = capability.kimiProvider ?? catalogEntry?.providerId;
  if (!kimiProvider) return { ...capability };
  return { ...capability, kimiProvider };
}

export function buildFrozenInvocation(
  profile: ToolProfile,
  catalogEntry: ModelEntry | undefined,
  capability: ModelSelectionCapability,
  nativeConfig: NativeResolvedConfig,
  runtimeFlavor: RuntimeFlavor,
): FrozenInvocation {
  const resolvedCapability = capabilityForSelection(catalogEntry, capability);
  const selection = resolveModelSelection(
    profile,
    catalogEntry,
    resolvedCapability,
  );
  const accessModelKey =
    catalogEntry?.accessModelKey?.trim() ||
    catalogEntry?.nativeId?.trim() ||
    selection.modelToken?.trim() ||
    profile.modelId?.trim() ||
    profile.adapterId;
  const nativeConfigProfile =
    profile.nativeConfigProfile ?? nativeConfig.nativeConfigProfile;
  return FrozenInvocationSchema.parse({
    schema_version: 1,
    adapterId: profile.adapterId,
    executable: nativeConfig.executablePath,
    modelToken: selection.modelToken,
    effortArgs: selection.effortArgs,
    effortEnv: selection.effortEnv,
    transport: selection.transport,
    reasoning: selection.reasoning,
    providerScope:
      nativeConfig.providerEndpointFingerprint ?? nativeConfig.nativeConfigScope,
    accountScope: nativeConfig.accountFingerprint,
    identityConfidence: nativeConfig.identityConfidence,
    capabilityRevision:
      catalogEntry?.capabilityRevision ?? selection.fingerprint.effortTransport,
    runtimeFlavor,
    accessModelKey,
    ...(nativeConfigProfile ? { nativeConfigProfile } : {}),
    ...(resolvedCapability.kimiProvider
      ? { kimiProvider: resolvedCapability.kimiProvider }
      : {}),
    ...(resolvedCapability.opencodeVariantEncoding
      ? { opencodeVariantEncoding: resolvedCapability.opencodeVariantEncoding }
      : {}),
    ...(catalogEntry?.entryId
      ? { catalogEntryId: catalogEntry.entryId }
      : {}),
  });
}

export function applyFrozenSelection(
  args: string[],
  env: Record<string, string>,
  frozen: FrozenInvocation,
): void {
  for (const [key, value] of Object.entries(frozen.effortEnv)) {
    env[key] = value;
  }
  if (frozen.modelToken) {
    args.push("--model", frozen.modelToken);
  }
  args.push(...frozen.effortArgs);
}

export function resolveRunSelection(input: RunContext) {
  if (input.frozenInvocation) {
    return {
      modelToken: input.frozenInvocation.modelToken,
      effortArgs: input.frozenInvocation.effortArgs,
      effortEnv: input.frozenInvocation.effortEnv,
    };
  }
  const capability = capabilityForSelection(
    input.catalogEntry,
    input.selectionCapability ?? {},
  );
  return resolveModelSelection(input.toolProfile, input.catalogEntry, capability);
}
