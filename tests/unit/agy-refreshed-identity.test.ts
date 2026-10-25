import { expect, it } from "vitest";
import { extractSafeAuthMetadata } from "../../packages/agy-accounts/src/auth-metadata.js";

it.each([false, true])("reads the official refreshed credential email, keyring wrapper=%s", wrapped => {
  const text = JSON.stringify({ auth_method: "oauth", id_token_email: " a@example.com ",
    token: { access_token: "opaque-access", refresh_token: "opaque-refresh", expiry: "2026-10-23T11:05:21.173Z" } });
  const input = Buffer.from(wrapped ? "go-keyring-base64:" + Buffer.from(text).toString("base64") : text);
  expect(extractSafeAuthMetadata(input)).toEqual({ email: "a@example.com", has_refresh_credential: true,
    access_expires_at: "2026-10-23T11:05:21.173Z", refresh_expiry_source: "not_provided", metadata_status: "unverified" });
});

it("keeps explicit identity evidence instead of replacing it with the cached email", () => {
  const token = ["header", Buffer.from(JSON.stringify({ email: "real@example.com", sub: "subject" })).toString("base64url"), "signature"].join(".");
  expect(extractSafeAuthMetadata(Buffer.from(JSON.stringify({ id_token: token, id_token_email: "other@example.com" }))))
    .toMatchObject({ email: "real@example.com", subject: "subject", metadata_status: "unverified" });
});
