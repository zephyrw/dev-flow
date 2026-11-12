import type { WindowKind } from "../../../contracts/src/agy-account.js";
import {
  isRetryableModelTransportFailure,
  isTemporaryModelCapacityFailure,
} from "../../../contracts/src/runtime-failure.js";

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
const INDIVIDUAL_QUOTA_PATTERN =
  /^Individual quota reached\.(?: Please upgrade your subscription to increase your limits\.)?(?: Resets in (?:\d+[dhms])+\.?)?$/i;

export function unwrapAgyQuotaError(value: unknown): string | undefined {
  if (typeof value !== "string") {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const err = (value as Record<string, unknown>).error;
      if (typeof err === "string") return unwrapAgyQuotaError(err);
    }
    return undefined;
  }
  const trimmed = value.trim();
  // Check the entire error before unwrapping or selecting a quota line. Shared
  // consumers must not lose a conflicting diagnostic elsewhere in this error.
  if (hasConflictingAgyFailureDiagnostic(trimmed)) return undefined;
  if (INDIVIDUAL_QUOTA_PATTERN.test(trimmed)) {
    return trimmed;
  }
  const prefixMatch = /^(?:(?:FlowError:\s*)?(?:CLI\s*返回错误|AGY_ERROR|\[agy\]|Error)[：:]\s*)(.*)$/is.exec(trimmed);
  const target = prefixMatch ? prefixMatch[1]!.trim() : trimmed;
  if (INDIVIDUAL_QUOTA_PATTERN.test(target)) {
    return target;
  }
  if (target.startsWith("{") && target.endsWith("}")) {
    try {
      const parsed = JSON.parse(target);
      if (parsed && typeof parsed === "object" && typeof parsed.error === "string") {
        const inner = parsed.error.trim();
        if (INDIVIDUAL_QUOTA_PATTERN.test(inner)) return inner;
      }
    } catch {
      // ignore malformed JSON
    }
  }
  // Try line by line if text contains multiple lines
  if (trimmed.includes("\n")) {
    for (const line of trimmed.split(/[\r\n]+/)) {
      const lineTrimmed = line.trim();
      if (!lineTrimmed) continue;
      const unwrapped = unwrapAgyQuotaError(lineTrimmed);
      if (unwrapped) return unwrapped;
    }
  }
  return undefined;
}

export function isAgyIndividualQuotaError(value: unknown): value is string {
  return unwrapAgyQuotaError(value) !== undefined;
}
export function hasConflictingAgyFailureDiagnostic(text: string) {
  return isRetryableModelTransportFailure(text) || isTemporaryModelCapacityFailure(text) || /tls|bad record mac|econn|etimedout|enotfound|network|connection|fetch failed|permission.?denied|unauthorized|unauthenticated|invalid_grant|timeout|timed out/i.test(text);
}

/** Current CLI stderr can report an unfinished turn despite exit 0 / SUCCESS. */
export function hasAgyPrintTimeout(stderr: string): boolean {
  return /^\s*\[agy\]\s+print timeout after [^\r\n]+ with turn in progress; returning partial output\s*$/im.test(stderr);
}

/** A resumed footer alone is historical. Confirm it only with this process's
 * quota exit and unfinished current turn, with no conflicting host failure. */
export function confirmAgyQuotaFailure(fact: AgyFailureFact, completion: {
  exitCode: number | null;
  currentTurn: boolean;
  stderr?: string;
  stdout?: string;
  diagnostic?: string;
  terminationReason?: string;
}): AgyFailureFact {
  const stdoutDiag = completion.stdout ?? "";
  const stderrDiag = completion.stderr ?? "";
  const extraDiag = completion.diagnostic ?? "";
  // Exit 0 and process stderr always require official quota verification.
  // Only a bound current-turn result with quota exit 3 can confirm itself.
  if (
    !fact.requires_quota_verification ||
    !fact.can_switch_account ||
    fact.source_event_type === "stderr" ||
    completion.exitCode !== 3 ||
    !completion.currentTurn ||
    completion.terminationReason ||
    hasConflictingAgyFailureDiagnostic(stderrDiag) ||
    hasConflictingAgyFailureDiagnostic(stdoutDiag) ||
    hasConflictingAgyFailureDiagnostic(extraDiag) ||
    hasAgyPrintTimeout(stderrDiag) ||
    hasAgyPrintTimeout(stdoutDiag)
  ) {
    return fact;
  }
  const { requires_quota_verification: _, ...confirmed } = fact;
  return { ...confirmed, reason: "current_turn_quota_exit", raw_message: "current_turn_quota_exit" };
}

/** Extract a constrained quota failure candidate from current process stderr.
 * Retains requires_quota_verification so official probeUsage verification is still required. */
export function extractAgyStderrQuotaCandidate(input: {
  realmId: string;
  accountId: string;
  authEpoch: number;
  runId?: string;
  conversationId?: string;
  stderr: string;
  /** The caller read this stderr from the managed process for runId. */
  currentProcess: boolean;
  eventOffset?: number;
}): AgyFailureFact | undefined {
  if (!input.currentProcess || !input.runId || !Number.isSafeInteger(input.authEpoch) || input.authEpoch <= 0) {
    return undefined;
  }
  const rawStderr = input.stderr ?? "";
  if (hasConflictingAgyFailureDiagnostic(rawStderr) || hasAgyPrintTimeout(rawStderr)) {
    return undefined;
  }
  const unwrapped = unwrapAgyQuotaError(rawStderr);
  if (!unwrapped) return undefined;

  return {
    realm_id: input.realmId,
    account_id: input.accountId,
    auth_epoch: input.authEpoch,
    run_id: input.runId,
    conversation_id: input.conversationId,
    category: "quota_exhausted",
    reason: "stderr_quota_requires_verification",
    window: "unknown",
    can_switch_account: true,
    requires_quota_verification: true,
    requires_reauth: false,
    observed_at: new Date().toISOString(),
    raw_message: "stderr_quota_requires_verification",
    source_event_type: "stderr",
    source_offset: input.eventOffset,
  };
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
  const rawCandidateError = typeof event?.error === "string" ? event.error : (typeof result?.error === "string" ? result.error : undefined);
  const unwrappedCandidateError = unwrapAgyQuotaError(rawCandidateError);
  const quotaTextCandidate = boundCurrentEvent && type === "result" &&
    result?.status === "ERROR" && !!unwrappedCandidateError &&
    !(Array.isArray(result.denied_actions) && result.denied_actions.length) &&
    (result.error === event?.error || unwrappedCandidateError === unwrapAgyQuotaError(result?.error));
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
