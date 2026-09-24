import type { AgyAccountAuth } from "../../contracts/src/agy-account.js";

function tryExtractJwtClaims(token: string): { email?: string; subject?: string } {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) return {};
    const payloadJson = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    if (!payload || typeof payload !== "object") return {};
    const res: { email?: string; subject?: string } = {};
    if (typeof payload.email === "string" && payload.email.includes("@")) {
      res.email = payload.email.trim();
    }
    if (typeof payload.sub === "string" && payload.sub.length > 0) {
      res.subject = payload.sub.trim();
    }
    return res;
  } catch {
    return {};
  }
}

/** Extract only the old host's explicit expiry/presence fields and identity claims, never raw token contents. */
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

  let email: string | undefined;
  let subject: string | undefined;
  if (typeof parsed.email === "string" && parsed.email.includes("@")) {
    email = parsed.email.trim();
  }
  if (typeof parsed.id_token === "string" && parsed.id_token.length > 0) {
    const claims = tryExtractJwtClaims(parsed.id_token);
    if (claims.email && !email) email = claims.email;
    if (claims.subject && !subject) subject = claims.subject;
  }
  if (!email && typeof parsed.access_token === "string" && parsed.access_token.length > 0) {
    const claims = tryExtractJwtClaims(parsed.access_token);
    if (claims.email) email = claims.email;
    if (claims.subject && !subject) subject = claims.subject;
  }
  if (email) result.email = email;
  if (subject) result.subject = subject;

  if (
    ((typeof parsed.access_token === "string" &&
      parsed.access_token.length > 0) ||
      (typeof parsed.token === "string" &&
        parsed.token.length > 0) ||
      (typeof parsed.id_token === "string" &&
        parsed.id_token.length > 0) ||
      (typeof parsed.token_type === "string" &&
        parsed.token_type.length > 0)) &&
    (access ||
      result.has_refresh_credential === true ||
      typeof parsed.id_token === "string" ||
      typeof parsed.token === "string")
  )
    result.metadata_status = "verified";
  return result;
}

