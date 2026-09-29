import type { WindowKind } from "../../../contracts/src/agy-account.js";

export type AgyFailureCategory =
  | "quota_exhausted"
  | "rate_limit"
  | "auth_invalid"
  | "model_unavailable"
  | "network_error"
  | "business_failure"
  | "other";
export interface AgyFailureFact {
  realm_id: string;
  account_id: string;
  auth_epoch: number;
  run_id?: string;
  conversation_id?: string;
  category: AgyFailureCategory;
  reason: string;
  window?: WindowKind | "unknown";
  reset_at?: string;
  can_switch_account: boolean;
  /** Unconfirmed provider text needs current quota evidence or a bound quota exit. */
  requires_quota_verification?: true;
  requires_reauth: boolean;
  observed_at: string;
  raw_message: string;
  source_event_type?: string;
  source_offset?: number;
}
export interface AgyFailureInput {
  realmId: string;
  accountId: string;
  authEpoch: number;
  runId?: string;
  conversationId?: string;
  errorMessage?: string;
  /** Untrusted textual logs are intentionally never used as switching evidence. */
  stdout?: string;
  stderr?: string;
  observedAt?: string;
  event?: Record<string, unknown>;
  eventOffset?: number;
  currentTurn?: boolean;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
export function isAgyIndividualQuotaError(value: unknown): value is string {
  return typeof value === "string" &&
    /^Individual quota reached\.(?: Please upgrade your subscription to increase your limits\.)?(?: Resets in (?:\d+[dhms])+\.?)?$/i.test(value.trim());
}
export function hasConflictingAgyFailureDiagnostic(text: string) {
  return /tls|bad record mac|econn|etimedout|enotfound|network|connection|fetch failed|permission.?denied|unauthorized|unauthenticated|invalid_grant|timeout|timed out/i.test(text);
}

/** A resumed footer alone is historical. Confirm it only with this process's
 * quota exit and unfinished current turn, with no conflicting host failure. */
export function confirmAgyQuotaFailure(fact: AgyFailureFact, completion: {
  exitCode: number | null; currentTurn: boolean; stderr?: string; terminationReason?: string;
}): AgyFailureFact {
  if (!fact.requires_quota_verification || !fact.can_switch_account ||
      completion.exitCode !== 3 || !completion.currentTurn || completion.terminationReason ||
      hasConflictingAgyFailureDiagnostic(completion.stderr ?? ""))
    return fact;
  const { requires_quota_verification: _, ...confirmed } = fact;
  return { ...confirmed, reason: "current_turn_quota_exit", raw_message: "current_turn_quota_exit" };
}
export function extractAgyFailureFact(input: AgyFailureInput): AgyFailureFact {
  const event = input.event;
  const error = record(event?.error);
  const type = event?.type;
  const boundCurrentEvent =
    input.currentTurn === true &&
    !!input.runId &&
    Number.isSafeInteger(input.authEpoch) &&
    input.authEpoch > 0 &&
    Number.isSafeInteger(input.eventOffset) &&
    input.eventOffset! >= 0;
  const trusted = boundCurrentEvent && (type === "error" || (type === "result" && !!error));
  const result = record(event?.result);
  // AGY 1.2.x reports quota as a result string, not an error object. A resumed
  // footer can be historical even after a fresh TLS failure, so this shape
  // only requests an official quota check; it never proves exhaustion itself.
  const quotaTextCandidate = boundCurrentEvent && type === "result" &&
    result?.status === "ERROR" && typeof event?.error === "string" &&
    result.error === event.error &&
    !(Array.isArray(result.denied_actions) && result.denied_actions.length) &&
    isAgyIndividualQuotaError(event.error);
  const code = trusted
    ? String(error?.code ?? event?.code ?? "").toLowerCase()
    : "";
  const message =
    typeof error?.message === "string"
      ? error.message
      : (input.errorMessage ?? "");
  const lower = (input.errorMessage ?? message).toLowerCase();
  let category: AgyFailureCategory = "other";
  let reason = "unclassified_error";
  let canSwitch = false;
  if (
    /assertionerror|tests? failed|changes_required|review failed|manual_stop/.test(
      lower,
    )
  ) {
    category = "business_failure";
    reason = "business_test_or_review_failure";
  } else if (
    trusted &&
    [
      "invalid_grant",
      "unauthenticated",
      "authentication_required",
      "auth_invalid",
    ].includes(code)
  ) {
    category = "auth_invalid";
    reason = "reauth_required";
    canSwitch = true;
  } else if (
    ["model_not_found", "model_unavailable", "permission_denied"].includes(
      code,
    ) ||
    /model not found|model_not_found|not enabled for this model|permission_denied/.test(
      lower,
    )
  ) {
    category = "model_unavailable";
    reason = "model_permission_denied_or_not_found";
  } else if (
    trusted &&
    [
      "quota_exhausted",
      "weekly_quota_exhausted",
      "five_hour_quota_exhausted",
    ].includes(code)
  ) {
    category = "quota_exhausted";
    reason = "quota_exhausted";
    canSwitch = true;
  } else if (quotaTextCandidate) {
    category = "quota_exhausted";
    reason = "provider_result_quota_requires_verification";
    canSwitch = true;
  } else if (
    /429|rate.limit|resource_exhausted|too many requests/.test(
      code + " " + lower,
    )
  ) {
    category = "rate_limit";
    reason = "rate_limit_temporary";
  } else if (
    /econnrefused|etimedout|enotfound|fetch failed|network error|tls/.test(
      lower,
    )
  ) {
    category = "network_error";
    reason = "network_failure";
  }
  const reportedWindow = error?.window ?? event?.window;
  return {
    realm_id: input.realmId,
    account_id: input.accountId,
    auth_epoch: input.authEpoch,
    run_id: input.runId,
    conversation_id: input.conversationId,
    category,
    reason,
    window:
      category === "quota_exhausted"
        ? quotaTextCandidate ? "unknown"
          : reportedWindow === "weekly" || reportedWindow === "five_hour"
          ? reportedWindow
          : code === "weekly_quota_exhausted"
            ? "weekly"
            : code === "five_hour_quota_exhausted"
              ? "five_hour"
              : "unknown"
        : undefined,
    can_switch_account: canSwitch,
    ...(quotaTextCandidate && canSwitch ? { requires_quota_verification: true as const } : {}),
    requires_reauth: category === "auth_invalid",
    observed_at: input.observedAt ?? new Date().toISOString(),
    // Do not persist arbitrary raw upstream/log content (which can include credentials).
    raw_message: reason,
    source_event_type: trusted || quotaTextCandidate ? String(type) : undefined,
    source_offset: trusted || quotaTextCandidate ? input.eventOffset : undefined,
  };
}
export const classifyAgyFailure = extractAgyFailureFact;
