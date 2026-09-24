import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { loadConfig } from "../../../packages/contracts/src/config.js";

/** The dev Origin exception is valid only for this manifest's isolated data root. */
export function developmentFrontendOrigin(options: {
  port: number;
  storageInstance?: string;
  developmentFrontendOrigin?: string;
}): string | undefined {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.DEVFLOW_LOCAL_DEV !== "1" ||
    !process.env.DEVFLOW_INSTANCE_ID ||
    !process.env.DEVFLOW_CONFIG ||
    !options.storageInstance ||
    !options.developmentFrontendOrigin
  )
    return;
  try {
    const normalize = (path: string) => {
      const result = realpathSync(resolve(path));
      return process.platform === "win32" ? result.toLowerCase() : result;
    };
    const configPath = resolve(process.env.DEVFLOW_CONFIG);
    const manifestPath = join(dirname(configPath), "instance.json");
    const instance = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (
      instance.instance_type !== "dev" ||
      instance.instance_id !== process.env.DEVFLOW_INSTANCE_ID ||
      normalize(instance.worktree_path) !== normalize(process.cwd()) ||
      normalize(instance.paths.instance_json) !== normalize(manifestPath) ||
      normalize(instance.paths.runtime_config) !== normalize(configPath) ||
      normalize(instance.paths.run_dir) !== normalize(dirname(configPath)) ||
      normalize(instance.paths.state_dir) !==
        normalize(join(dirname(configPath), "state")) ||
      normalize(instance.paths.storage_root) !==
        normalize(options.storageInstance) ||
      normalize(instance.paths.state_dir) !==
        normalize(options.storageInstance) ||
      instance.ports.backend !== options.port
    )
      return;
    const storage = normalize(options.storageInstance);
    const defaultDataRoot = join(instance.worktree_path, ".devflow");
    if (existsSync(defaultDataRoot)) {
      const production = normalize(defaultDataRoot);
      if (storage === production || storage.startsWith(production + sep)) return;
    }
    if (
      storage
        .split(/[\\/]/)
        .some((part) => ["node_modules", ".git"].includes(part))
    )
      return;
    const mainConfig = join(instance.worktree_path, "devflow.yaml");
    if (existsSync(mainConfig)) {
      const mainRoot = loadConfig(mainConfig).storage_root;
      if (existsSync(mainRoot)) {
        const main = normalize(mainRoot);
        if (
          storage === main ||
          storage.startsWith(main + sep) ||
          main.startsWith(storage + sep)
        )
          return;
      }
    }
    const url = new URL(options.developmentFrontendOrigin);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost"].includes(url.hostname) ||
      !url.port ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.origin !== instance.origins.frontend ||
      Number(url.port) !== instance.ports.frontend
    )
      return;
    return url.origin;
  } catch {
    return;
  }
}
