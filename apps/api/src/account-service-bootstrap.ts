import type { Store } from "../../../packages/store/src/store.js";
import { AgyAccountRepository } from "../../../packages/agy-accounts/src/repository.js";
import { DevFlowAuthHost } from "../../../packages/agy-accounts/src/auth-host.js";
import { AgyAccountProbe } from "../../../packages/adapters/agy/src/account-probe.js";
import { AgyAccountService } from "../../../packages/agy-accounts/src/service.js";
import type { ProcessHostPort } from "../../../packages/agy-accounts/src/ports.js";
import type { AgyAccountSettings } from "../../../packages/contracts/src/agy-account.js";
import type { ProcessManager } from "../../../packages/process/src/manager.js";
import { AgyAccountProcessHost } from "../../../packages/process/src/agy-account-processes.js";
export function bootstrapAccountService(
  store: Store,
  options: {
    authHostExecutable?: string;
    agyCliPath?: string;
    hostExecutable: string;
    processManager?: ProcessManager;
    processHost?: ProcessHostPort;
    settings?: Partial<AgyAccountSettings>;
  },
): AgyAccountService {
  const repository = new AgyAccountRepository(store);
  const authHost = new DevFlowAuthHost(options.authHostExecutable);
  const probe = new AgyAccountProbe(options.agyCliPath);
  const processHost =
    options.processHost ??
    new AgyAccountProcessHost({
      store,
      hostExecutable: options.hostExecutable,
      agyExecutable: options.agyCliPath ?? "agy",
      processManager: options.processManager,
    });
  const service = new AgyAccountService(
    repository,
    authHost,
    probe,
    processHost,
  );
  service.initializeSettings("default-agy-realm", options.settings ?? {});
  return service;
}
