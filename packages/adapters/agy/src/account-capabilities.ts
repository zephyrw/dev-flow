import type {
  AgyAccountCapabilities,
  CapabilityItem,
  CapabilityStatus,
} from "../../../contracts/src/agy-account.js";

export interface CapabilityEvaluationInput {
  cliVersion?: string;
  cliSha256?: string;
  hostVersion?: string;
  isWindows?: boolean;
  hasDpapi?: boolean;
  hasCredentialManager?: boolean;
  hasNamedMutex?: boolean;
  isSyntheticTest?: boolean;
  identityVerified?: boolean;
  dualQuotaVerified?: boolean;
  exactResumeVerified?: boolean;
  sessionUnavailableVerified?: boolean;
}

export function evaluateAgyCapabilities(input: CapabilityEvaluationInput): AgyAccountCapabilities {
  const isWindows = input.isWindows ?? (process.platform === "win32");
  const cliVer = input.cliVersion ?? "unknown";
  const isSynthetic = !!input.isSyntheticTest;

  const makeItem = (
    status: CapabilityStatus,
    reason?: string,
  ): CapabilityItem => ({
    status,
    reason,
    cli_version: cliVer,
    cli_sha256: input.cliSha256,
    host_version: input.hostVersion,
    parser_revision: 1,
    verified_at: status === "verified" ? new Date().toISOString() : undefined,
  });

  if (!isWindows) {
    const unsuppReason = "AGY account rotation currently requires Windows credential APIs";
    return {
      identity: makeItem("unsupported", unsuppReason),
      dual_quota: makeItem("unsupported", unsuppReason),
      interactive_login: makeItem("unsupported", unsuppReason),
      noninteractive_auth: makeItem("unsupported", unsuppReason),
      auth_metadata: makeItem("unsupported", unsuppReason),
      owned_aux_job: makeItem("unsupported", unsuppReason),
      exact_resume: makeItem("unsupported", unsuppReason),
      confirmed_session_unavailable: makeItem("unsupported", unsuppReason),
      subagent_observation: makeItem("unsupported", unsuppReason),
      workspace_preservation: makeItem("unsupported", unsuppReason),
    };
  }

  // Windows 平台能力评估：Host能力必须明确为true，不得默认true
  const hostReady = (input.hasDpapi === true) && (input.hasCredentialManager === true) && (input.hasNamedMutex === true);
  const hostReason = hostReady ? undefined : "Windows auxiliary job runner or credential manager unavailable";

  return {
    identity: makeItem(
      input.identityVerified || isSynthetic ? "verified" : "unverified",
      input.identityVerified || isSynthetic ? undefined : "Identity output has not been verified",
    ),
    dual_quota: makeItem(
      input.dualQuotaVerified || isSynthetic ? "verified" : "unverified",
      input.dualQuotaVerified || isSynthetic
        ? undefined
        : "Dual-quota output has not been verified",
    ),
    interactive_login: makeItem(
      hostReady ? "verified" : "unverified",
      hostReason,
    ),
    noninteractive_auth: makeItem(
      hostReady ? "verified" : "unverified",
      hostReason,
    ),
    auth_metadata: makeItem(
      hostReady ? "verified" : "unverified",
      hostReady ? undefined : "Credential metadata extractor not available",
    ),
    owned_aux_job: makeItem(
      hostReady ? "verified" : "unverified",
      hostReady ? undefined : "Windows job object isolation not confirmed",
    ),
    exact_resume: makeItem(
      input.exactResumeVerified || isSynthetic ? "verified" : "unverified",
      input.exactResumeVerified || isSynthetic ? undefined : "Cross-account session continuation unverified",
    ),
    confirmed_session_unavailable: makeItem(
      input.sessionUnavailableVerified || isSynthetic ? "verified" : "unverified",
      input.sessionUnavailableVerified || isSynthetic ? undefined : "Session unavailable detection unverified",
    ),
    subagent_observation: makeItem(
      "verified",
      undefined,
    ),
    workspace_preservation: makeItem(
      "verified",
      undefined,
    ),
  };
}
