import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
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
import {
  AgyAccountService,
  DefaultClockPort,
} from "../../../packages/agy-accounts/src/service.js";
import type { ProcessHostPort } from "../../../packages/agy-accounts/src/ports.js";
import type { AgyAccountSettings } from "../../../packages/contracts/src/agy-account.js";
import { ProcessManager } from "../../../packages/process/src/manager.js";
import { AgyAccountProcessHost } from "../../../packages/process/src/agy-account-processes.js";
import { AgyAccountJobRunner } from "../../../packages/process/src/agy-account-job-runner.js";
import {
  AgyLoginLauncher,
  type VerifiedLoginCommand,
} from "../../../packages/agy-accounts/src/login.js";

export async function bootstrapAccountService(
  store: Store,
  options: {
    agyCliPath?: string;
    processManager?: ProcessManager;
    processHost?: ProcessHostPort;
    settings?: Partial<AgyAccountSettings>;
  },
): Promise<AgyAccountService> {
  const repository = new AgyAccountRepository(store);
  const authHost = new DevFlowAuthHost();

  let adapter: VerifiedUsageAdapter | undefined;
  let loginLauncher: AgyLoginLauncher | undefined;
  let cliPath = options.agyCliPath ?? process.env.AGY_CLI_PATH;
  if (!cliPath && process.platform === "win32" && process.env.LOCALAPPDATA) {
    const defaultWinPath = join(
      process.env.LOCALAPPDATA,
      "agy",
      "bin",
      "agy.exe",
    );
    if (existsSync(defaultWinPath)) {
      cliPath = defaultWinPath;
    }
  }

  const auxiliaryProcesses = new ProcessManager((spec, event) => {
    store.put("process_record", spec.id, spec.workflow_id ?? "system", {
      id: spec.id,
      executable: spec.executable,
      cwd: spec.cwd,
      ...event,
      updated_at: new Date().toISOString(),
    });
  });
  const runner = new AgyAccountJobRunner(cliPath ?? "agy", auxiliaryProcesses);

  if (cliPath && existsSync(cliPath)) {
    try {
      const bytes = readFileSync(cliPath);
      const fingerprint = createHash("sha256").update(bytes).digest("hex");
      let cliVersion = "unknown";
      try {
        const versionProcess = auxiliaryProcesses.start({
          id: "agy_version_" + randomUUID(),
          executable: cliPath,
          args: ["--version"],
          cwd: process.cwd(),
          env: {},
          timeout_ms: 3000,
        });
        const chunks: Buffer[] = [];
        let size = 0;
        versionProcess.on("stdout", (chunk: Buffer) => {
          size += chunk.length;
          if (size <= 65536) chunks.push(chunk);
          else void versionProcess.stop().catch(() => {});
        });
        const result = await versionProcess.completion;
        if (result.code !== 0 || result.termination_reason || size > 65536)
          throw new Error("version_probe_failed");
        const match = /(\d+\.\d+\.\d+)/.exec(
          Buffer.concat(chunks).toString("utf8"),
        );
        if (match && match[1]) cliVersion = match[1];
      } catch (error) {
        if ((error as { code?: string }).code === "PROCESS_STOP_UNCONFIRMED")
          throw error;
      }

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
    } catch (error) {
      if ((error as { code?: string }).code === "PROCESS_STOP_UNCONFIRMED")
        throw error;
    }
  }

  const probe = new AgyAccountProbe(
    cliPath ?? options.agyCliPath,
    adapter,
    runner,
  );
  const processHost =
    options.processHost ??
    new AgyAccountProcessHost({
      store,
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
  const close = service.close.bind(service);
  service.close = async () => {
    await close();
    await runner.close();
    await authHost.close();
  };
  service.initializeSettings("default-agy-realm", options.settings ?? {});
  const capabilitySnapshot = evaluateCapabilitySnapshot(
    adapter
      ? { version: adapter.cli_version, sha256: adapter.executable_fingerprint }
      : null,
    {
      platform: process.platform,
      version: "unverified",
      dpapi_available: false,
      cred_manager_available: false,
      named_mutex_available: false,
    },
  );
  service.setCapabilitySnapshot(capabilitySnapshot);
  return service;
}
