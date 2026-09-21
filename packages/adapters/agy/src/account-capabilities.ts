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
}

export const KNOWN_OFFICIAL_CLI_VERSIONS = ["1.2.7"];

export function evaluateAgyCapabilities(input: CapabilityEvaluationInput): AgyAccountCapabilities {
  const isWindows = input.isWindows ?? (process.platform === "win32");
  const cliVer = input.cliVersion ?? "unknown";
  const isKnownCli = KNOWN_OFFICIAL_CLI_VERSIONS.includes(cliVer);
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
      isKnownCli || isSynthetic ? "verified" : "unverified",
      isKnownCli || isSynthetic ? undefined : `CLI version ${cliVer} identity parser not officially certified`,
    ),
    dual_quota: makeItem(
      isSynthetic
        ? "verified"
        : isKnownCli && input.cliSha256
          ? "verified"
          : "unverified",
      isSynthetic || (isKnownCli && input.cliSha256)
        ? undefined
        : `CLI version ${cliVer} dual-quota parser missing pools or official fingerprint unverified`,
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
      isKnownCli || isSynthetic ? "verified" : "unverified",
      isKnownCli || isSynthetic ? undefined : "Cross-account session continuation unverified for this CLI",
    ),
    confirmed_session_unavailable: makeItem(
      isKnownCli || isSynthetic ? "verified" : "unverified",
      isKnownCli || isSynthetic ? undefined : "Session unavailable detection unverified for this CLI",
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
