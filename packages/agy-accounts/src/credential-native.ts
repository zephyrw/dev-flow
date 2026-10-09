import type { VaultCredential, VaultNative } from "./credential-store.js";

export interface CredentialNative extends VaultNative {
  getCurrentUserSid(): string;
  acquireMutex(name: string): (() => void) | null;
  readCredential(target: string): VaultCredential;
  writeCredential(target: string, credential: VaultCredential): void;
  deleteCredential(target: string): boolean;
}

export async function createCredentialNative(): Promise<CredentialNative> {
  if (process.platform === "win32")
    return (await import("./credential-windows.js")).createCredentialWindows();
  if (process.platform === "darwin")
    return (await import("./credential-darwin.js")).createCredentialDarwin();
  throw new Error("unsupported_platform");
}
