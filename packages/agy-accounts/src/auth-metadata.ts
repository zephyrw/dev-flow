import type { AgyAccountAuth } from "../../contracts/src/agy-account.js";

/** Extract only the old host's explicit expiry/presence fields, never token contents. */
export function extractSafeAuthMetadata(
  secret: Buffer,
): Partial<AgyAccountAuth> {
  const result: Partial<AgyAccountAuth> = {
    has_refresh_credential: null,
    metadata_status: "unrecognized",
    refresh_expiry_source: "not_provided",
  };
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(secret.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      return result;
    parsed = value as Record<string, unknown>;
  } catch {
    return result;
  }
  const date = (value: unknown): string | undefined => {
    if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value))
      value = Number(value);
    if (typeof value !== "string" && typeof value !== "number")
      return undefined;
    if (typeof value === "number" && (!Number.isFinite(value) || value <= 0))
      return undefined;
    if (
      typeof value === "string" &&
      !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)
    )
      return undefined;
    const ms =
      typeof value === "number"
        ? value > 1e11
          ? value
          : value * 1000
        : Date.parse(value);
    return Number.isFinite(ms) && !Number.isNaN(new Date(ms).getTime())
      ? new Date(ms).toISOString()
      : undefined;
  };
  if (typeof parsed.refresh_token === "string")
    result.has_refresh_credential = parsed.refresh_token.length > 0;
  const access =
    (typeof parsed.expiry === "string" ? date(parsed.expiry) : undefined) ??
    date(parsed.expires_at);
  const refresh = date(parsed.refresh_expires_at);
  if (access) result.access_expires_at = access;
  if (refresh) {
    result.refresh_expires_at = refresh;
    result.refresh_expiry_source = "provider_reported";
  }
  if (
    ((typeof parsed.access_token === "string" &&
      parsed.access_token.length > 0) ||
      (typeof parsed.token_type === "string" &&
        parsed.token_type.length > 0)) &&
    (access || result.has_refresh_credential === true)
  )
    result.metadata_status = "verified";
  return result;
}
