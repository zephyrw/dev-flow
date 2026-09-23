import { resolve } from "node:path";
import {
  applyMigration,
  dryRunMigration,
} from "../packages/contracts/src/config-migration.js";
import { loadConfig } from "../packages/contracts/src/config.js";
import { acquireControllerLock } from "../packages/process/src/controller-lock.js";
const args = process.argv.slice(2);
const value = (key: string) => {
  const index = args.indexOf(key);
  return index >= 0 ? args[index + 1] : undefined;
};
const path = value("--config"),
  expected = value("--expected-sha256");
if (
  !path ||
  args.includes("--apply") === args.includes("--dry-run") ||
  (args.includes("--apply") && !expected)
) {
  console.error(
    "Use --config <path> --dry-run, or --config <path> --apply --expected-sha256 <hash>",
  );
  process.exitCode = 1;
} else {
  const config = resolve(path);
  let release: (() => Promise<void>) | undefined;
  try {
    if (args.includes("--apply"))
      release = await acquireControllerLock(loadConfig(config).storage_root);
    const result = args.includes("--apply")
      ? applyMigration(config, expected!)
      : dryRunMigration(config);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.success ? 0 : 1;
  } finally {
    await release?.();
  }
}
