import type { AuthHostCapabilities } from "./ports.js";

export function credentialCapabilitiesReady(
  capability: Partial<AuthHostCapabilities>,
): boolean {
  if (capability.platform === "win32")
    return (
      capability.dpapi_available === true &&
      capability.cred_manager_available === true &&
      capability.named_mutex_available === true
    );
  if (capability.platform === "darwin")
    return (
      capability.encrypted_storage_available === true &&
      capability.credential_store_available === true &&
      capability.domain_lock_available === true
    );
  return false;
}
