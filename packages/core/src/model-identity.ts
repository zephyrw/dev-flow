import { createHmac, randomBytes } from "node:crypto";
import type { Store } from "../../store/src/store.js";
import {
  FlowError,
  NativeResolvedConfigSchema,
  type IdentityConfidence,
  type NativeResolvedConfig,
  type ToolProfile,
} from "../../contracts/src/index.js";
import {
  identityInputFromProfile,
  nativeProfileSupported,
} from "../../adapters/sdk/src/native-identity.js";
import {
  ADAPTER_BINARY_NAMES,
  resolveAdapterExecutable,
} from "../../adapters/sdk/src/registry.js";

export type AccessIdentityInput = {
  nativeConfigScope: string;
  accountId?: string;
  credentialSecret?: string;
  providerEndpoint?: string;
  accountFingerprint?: string;
  providerEndpointFingerprint?: string;
  identityConfidence?: IdentityConfidence;
  displayLabel?: string;
};

export function resolveModelExecutable(
  profile: Pick<ToolProfile, "adapterId" | "executableRef">,
): string {
  const custom = profile.executableRef?.trim() || undefined;
  return (
    resolveAdapterExecutable(profile.adapterId, custom) ??
    custom ??
    ADAPTER_BINARY_NAMES[profile.adapterId]
  );
}

export function modelIdentityKey(store: Store): Buffer {
  const prior = store.get<{ key: string }>("model_instance_hmac", "global");
  if (prior?.key) return Buffer.from(prior.key, "base64url");
  const key = randomBytes(32);
  store.put("model_instance_hmac", "global", "global", {
    key: key.toString("base64url"),
  });
  return key;
}

export function fingerprintModelIdentity(
  store: Store,
  input: AccessIdentityInput,
) {
  const key = modelIdentityKey(store);
  const digest = (value: string) =>
    createHmac("sha256", key).update(value).digest("hex");
  const nativeConfigScope = input.nativeConfigScope.trim() || "default";
  const providerEndpointFingerprint =
    input.providerEndpointFingerprint ??
    (input.providerEndpoint ? digest(input.providerEndpoint) : "default");
  if (
    input.identityConfidence === "account" &&
    !input.accountId &&
    !input.accountFingerprint
  ) {
    throw new FlowError("INVALID_REQUEST", "缺少账号身份", 422);
  }
  const identityConfidence: IdentityConfidence = input.accountId
    ? "account"
    : input.credentialSecret
      ? "credential"
      : (input.identityConfidence ?? "profile-scope");
  const accountFingerprint = input.accountId
    ? digest(input.accountId)
    : input.credentialSecret
      ? digest(input.credentialSecret)
      : (input.accountFingerprint ?? digest(`scope:${nativeConfigScope}`));
  return {
    nativeConfigScope,
    accountFingerprint,
    providerEndpointFingerprint,
    identityConfidence,
  };
}

export function resolveModelIdentity(
  store: Store,
  profile: Pick<
    ToolProfile,
    | "adapterId"
    | "executableRef"
    | "modelId"
    | "nativeConfigProfile"
    | "providerConfigRef"
  >,
  suppliedIdentity?: AccessIdentityInput,
): NativeResolvedConfig {
  const identity = suppliedIdentity ?? identityInputFromProfile(profile);
  const fingerprint = fingerprintModelIdentity(store, identity);
  return NativeResolvedConfigSchema.parse({
    adapterId: profile.adapterId,
    executablePath: resolveModelExecutable(profile),
    nativeConfigProfile: profile.nativeConfigProfile,
    ...fingerprint,
    providerEndpoint: identity.providerEndpoint,
    accountId: identity.accountId,
    displayLabel: identity.displayLabel,
    profileSelectionSupported: nativeProfileSupported(profile.adapterId),
  });
}
