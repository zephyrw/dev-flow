import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/store/src/store.js";
const pending = vi.hoisted(() => ({
  resolve: undefined as undefined | ((value: unknown) => void),
  close: vi.fn(),
}));
vi.mock("../../packages/agy-accounts/src/auth-host.js", () => ({
  DevFlowAuthHost: class {
    capabilities() {
      return new Promise((resolve) => {
        pending.resolve = resolve;
      });
    }
    close = pending.close;
  },
}));
vi.mock("../../packages/adapters/agy/src/executable-resolver.js", () => ({
  resolveAgyExecutable: () => ({ resolvedPath: undefined }),
}));
import { bootstrapAccountService } from "../../apps/api/src/account-service-bootstrap.js";
afterEach(() => vi.restoreAllMocks());
describe.skipIf(process.platform !== "darwin")(
  "macOS account host startup",
  () => {
    it("returns without waiting for Keychain authorization, then publishes the actual capability result", async () => {
      const root = mkdtempSync(join(realpathSync(tmpdir()), "mac-bootstrap-"));
      const store = new Store(join(root, "devflow.sqlite"));
      const service = await bootstrapAccountService(store, {});
      try {
        expect(service.getCapabilitySnapshot().supported).toBe(false);
        pending.resolve!({
          supported: true,
          platform: "darwin",
          encrypted_storage_available: true,
          credential_store_available: true,
          domain_lock_available: true,
        });
        await vi.waitFor(() =>
          expect(
            service.getCapabilitySnapshot().encrypted_storage_available,
          ).toBe(true),
        );
        expect(service.getCapabilitySnapshot().supported).toBe(false); // No installed CLI was attested.
      } finally {
        await service.close();
        store.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  },
);
