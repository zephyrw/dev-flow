import { createHmac, randomBytes } from "node:crypto";
import type { Store } from "../../store/src/store.js";
import { AgyAccountRepository } from "../../agy-accounts/src/repository.js";
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

export type ManagedAgyModelIdentity = {
  realmId: string;
  accountId: string;
  authEpoch: number;
  credentialRevision: number;
};

export function managedAgyAccountIdentityId(realmId: string, accountId: string): string {
  return "agy-account:" + JSON.stringify([realmId, accountId]);
}

export function readManagedAgyModelIdentity(store: Store): ManagedAgyModelIdentity | undefined {
  const repository = new AgyAccountRepository(store);
  const realm = repository.getRealm("default-agy-realm");
  // Match AgyAccountService.isManaged, including shutdown while permits drain.
  if (!realm || (!realm.desired_enabled && realm.service_state !== "stopping")) return undefined;
  const account = realm.active_account_id
    ? repository.getAccount(realm.realm_id, realm.active_account_id)
    : undefined;
  if (!account) throw new FlowError("MODEL_LOGIN_REQUIRED", "受管 AGY 尚未选择可识别账号", 422);
  return {
    realmId: realm.realm_id,
    accountId: account.id,
    authEpoch: realm.auth_epoch,
    credentialRevision: account.credential_revision,
  };
}

export function resolveModelIdentityInput(
  store: Store,
  profile: Pick<ToolProfile, "adapterId" | "nativeConfigProfile" | "providerConfigRef" | "modelId">,
): AccessIdentityInput {
  const managed = profile.adapterId === "agy" ? readManagedAgyModelIdentity(store) : undefined;
  if (managed) return {
    nativeConfigScope: `agy-managed:${managed.realmId}`,
    accountId: managedAgyAccountIdentityId(managed.realmId, managed.accountId),
    identityConfidence: "account",
  };
  return identityInputFromProfile(profile);
}

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
  // Managed account identity comes from the same repository that grants permits.
  // Caller-supplied native metadata must not override its selected account.
  const managed = profile.adapterId === "agy" ? readManagedAgyModelIdentity(store) : undefined;
  const identity: AccessIdentityInput = managed
    ? resolveModelIdentityInput(store, profile)
    : suppliedIdentity ?? resolveModelIdentityInput(store, profile);
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
