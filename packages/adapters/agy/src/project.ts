import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { atomicWrite } from "../../../core/src/util.js";
import { requireCondition } from "../../../contracts/src/index.js";
import { workerNames } from "../../../mcp/src/tools.js";
/** AGY 1.2 project-local grants; never changes shared user permissions. */
export function writeAgyProject(
  profileRoot: string,
  projectId: string,
  directory: string,
) {
  requireCondition(
    /^[0-9a-f-]{36}$/.test(projectId),
    "PROJECT_ID_INVALID",
    "agy 项目标识必须是 UUID",
  );
  const path = join(
    profileRoot,
    ".gemini",
    "config",
    "projects",
    projectId + ".json",
  );
  const folderUri = pathToFileURL(directory).href;
  if (existsSync(path)) {
    const existing = JSON.parse(readFileSync(path, "utf8"));
    requireCondition(
      existing.id === projectId &&
        existing.projectResources?.resources?.length === 1 &&
        existing.projectResources.resources[0].folderUri === folderUri,
      "PROJECT_BINDING_MISMATCH",
      "agy 项目已绑定其他目录",
    );
  }
  const record = {
    id: projectId,
    name: "DevFlow " + projectId,
    projectResources: { resources: [{ folderUri }] },
    permissionGrants: {
      permissionGrants: {
        allow: workerNames.map((name) => `mcp(devflow_worker/${name})`),
        deny: [],
        ask: [],
      },
      v2Migrated: true,
    },
  };
  atomicWrite(path, JSON.stringify(record, null, 2));
  return { project_id: projectId, path };
}
