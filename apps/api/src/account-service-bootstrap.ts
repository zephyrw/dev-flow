import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { Store } from "../../../packages/store/src/store.js";
import { AgyAccountRepository } from "../../../packages/agy-accounts/src/repository.js";
import { DevFlowAuthHost } from "../../../packages/agy-accounts/src/auth-host.js";
import {
  AgyAccountProbe,
  type VerifiedUsageAdapter,
} from "../../../packages/adapters/agy/src/account-probe.js";
import {
  lookupCertifiedAdapter,
  evaluateCapabilitySnapshot,
} from "../../../packages/adapters/agy/src/account-capability-registry.js";
import { parseAgyUsageOutput } from "../../../packages/adapters/agy/src/quota-parser.js";
import { AgyAccountService, DefaultClockPort } from "../../../packages/agy-accounts/src/service.js";
import type { ProcessHostPort } from "../../../packages/agy-accounts/src/ports.js";
import type { AgyAccountSettings } from "../../../packages/contracts/src/agy-account.js";
import type { ProcessManager } from "../../../packages/process/src/manager.js";
import { AgyAccountProcessHost } from "../../../packages/process/src/agy-account-processes.js";
import { AgyAccountJobRunner } from "../../../packages/process/src/agy-account-job-runner.js";
import {
  AgyLoginLauncher,
  type VerifiedLoginCommand,
} from "../../../packages/agy-accounts/src/login.js";

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

  let adapter: VerifiedUsageAdapter | undefined;
  let loginLauncher: AgyLoginLauncher | undefined;
  let cliPath = options.agyCliPath ?? process.env.AGY_CLI_PATH;
  if (!cliPath && process.platform === "win32" && process.env.LOCALAPPDATA) {
    const defaultWinPath = join(process.env.LOCALAPPDATA, "agy", "bin", "agy.exe");
    if (existsSync(defaultWinPath)) {
      cliPath = defaultWinPath;
    }
  }

  const runner = new AgyAccountJobRunner(options.hostExecutable, cliPath ?? "agy");

  if (cliPath && existsSync(cliPath)) {
    try {
      const bytes = readFileSync(cliPath);
      const fingerprint = createHash("sha256").update(bytes).digest("hex");
      let cliVersion = "unknown";
      try {
        const versionOut = execFileSync(cliPath, ["--version"], {
          timeout: 3000,
          windowsHide: true,
          encoding: "utf8",
        });
        const match = /(\d+\.\d+\.\d+)/.exec(versionOut);
        if (match && match[1]) cliVersion = match[1];
      } catch {}

      // 直接装配实际支持的身份与全局双额度解析实现，真实校验和报错 (Q01)
      adapter = {
        executable_fingerprint: fingerprint,
        cli_version: cliVersion,
        parse: (text: string) => parseAgyUsageOutput(text, { cliVersion }),
      };

      const command: VerifiedLoginCommand = {
        executable: cliPath,
        args: ["login"],
        executable_fingerprint: fingerprint,
      };
      loginLauncher = new AgyLoginLauncher(runner, command);
    } catch {}
  }

  const probe = new AgyAccountProbe(cliPath ?? options.agyCliPath, adapter, runner);
  const processHost =
    options.processHost ??
    new AgyAccountProcessHost({
      store,
      hostExecutable: options.hostExecutable,
      agyExecutable: cliPath ?? options.agyCliPath ?? "agy",
      processManager: options.processManager,
    });
  const service = new AgyAccountService(
    repository,
    authHost,
    probe,
    processHost,
    new DefaultClockPort(),
    undefined,
    loginLauncher,
  );
  service.initializeSettings("default-agy-realm", options.settings ?? {});
  const capabilitySnapshot = evaluateCapabilitySnapshot(
    adapter
      ? { version: adapter.cli_version, sha256: adapter.executable_fingerprint }
      : null,
    {
      platform: process.platform,
      version: "2.0.0",
      dpapi_available: process.platform === "win32",
      cred_manager_available: process.platform === "win32",
      named_mutex_available: process.platform === "win32",
    },
  );
  service.setCapabilitySnapshot(capabilitySnapshot);
  return service;
}
