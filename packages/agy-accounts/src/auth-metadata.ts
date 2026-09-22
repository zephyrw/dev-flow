import { createHash } from "node:crypto";

/**
 * Compute a fingerprint of a secret reference for comparison purposes.
 * This is NOT the secret itself - it's a hash that can be compared
 * to verify two references point to the same secret.
 */
export function fingerprintSecretRef(secretRef: string): string {
  return createHash("sha256").update(secretRef).digest("hex").slice(0, 32);
}

/**
 * Extract safe metadata from a credential entry.
 * Only returns fields that are safe to log/transmit - no raw secrets.
 */
export function extractCredentialMetadata(entry: {
  username?: string;
  secret?: Buffer | string;
  comment?: string;
  targetAlias?: string;
  attributes?: Record<string, unknown>;
}): {
  username?: string;
  has_secret: boolean;
  secret_fingerprint?: string;
  comment?: string;
  target_alias?: string;
  attribute_keys: string[];
} {
  const hasSecret = entry.secret != null &&
    (Buffer.isBuffer(entry.secret) ? entry.secret.length > 0 : entry.secret.length > 0);

  return {
    username: entry.username || undefined,
    has_secret: hasSecret,
    secret_fingerprint: hasSecret && entry.secret
      ? fingerprintSecretRef(
          Buffer.isBuffer(entry.secret)
            ? entry.secret.toString("base64")
            : entry.secret
        )
      : undefined,
    comment: entry.comment || undefined,
    target_alias: entry.targetAlias || undefined,
    attribute_keys: entry.attributes ? Object.keys(entry.attributes) : [],
  };
}

/**
 * Validate that a credential target name matches the expected format.
 * Returns true if the target is a valid DevFlow credential target.
 */
export function isValidCredentialTarget(target: string): boolean {
  return /^DevFlow[_A-Za-z0-9.-]{1,200}$/.test(target);
}

/**
 * Compute the credential target name for a given realm and account.
 * Uses the same hash algorithm as the old C# implementation.
 */
export function computeCredentialTarget(realmId: string, accountId: string): string {
  const hash = createHash("sha256")
    .update(`${realmId}:${accountId}`)
    .digest("hex")
    .slice(0, 16);
  return `DevFlow.agy.${hash}`;
}
