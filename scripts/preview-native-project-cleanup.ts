import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ProjectCleanupCandidate {
  id: string;
  name: string;
  configFile: string;
  folderUri?: string;
  folderPath?: string;
  isDevFlowGenerated: boolean;
  category: "devflow_container" | "debug_candidate" | "user_project";
  reason: string;
  safeToClean: boolean;
}

export interface CleanupPreviewReport {
  scannedAt: string;
  totalProjects: number;
  devflowProjects: number;
  debugCandidates: number;
  userProjects: number;
  candidates: ProjectCleanupCandidate[];
  instructions: string;
}

/**
 * 扫描用户家目录下 %USERPROFILE%/.gemini/config/projects/*.json
 * 生成只读清理预览报告，绝不自动删除任何文件或项目
 */
export function generateNativeProjectCleanupPreview(profileRoot?: string): CleanupPreviewReport {
  const root = profileRoot ?? homedir();
  const projectsDir = join(root, ".gemini", "config", "projects");
  const candidates: ProjectCleanupCandidate[] = [];

  if (!existsSync(projectsDir)) {
    return {
      scannedAt: new Date().toISOString(),
      totalProjects: 0,
      devflowProjects: 0,
      debugCandidates: 0,
      userProjects: 0,
      candidates: [],
      instructions: "未找到 AGY 项目配置目录",
    };
  }

  const files = readdirSync(projectsDir).filter((f) => f.endsWith(".json"));

  for (const file of files) {
    const fullPath = join(projectsDir, file);
    try {
      const raw = readFileSync(fullPath, "utf8");
      const data = JSON.parse(raw);
      const id = data.id || file.replace(/\.json$/, "");
      const name = String(data.name ?? "");
      const resources = data.projectResources?.resources ?? [];
      const folderUri = resources[0]?.folderUri;
      let folderPath: string | undefined;
      if (folderUri) {
        try {
          folderPath = fileURLToPath(folderUri);
        } catch {
          folderPath = folderUri;
        }
      }

      const isDevFlowNamed = name.startsWith("DevFlow ");
      const isContainerDir = folderPath ? folderPath.includes(".devflow/containers") || folderPath.includes(".devflow\\containers") : false;
      const isDebugDir = folderPath ? folderPath.includes("scratch/runtime-fix") || folderPath.includes("scratch\\runtime-fix") : false;

      let category: ProjectCleanupCandidate["category"] = "user_project";
      let isDevFlowGenerated = false;
      let reason = "用户自有项目，严禁清理";
      let safeToClean = false;

      if (isDevFlowNamed || isContainerDir) {
        category = "devflow_container";
        isDevFlowGenerated = true;
        reason = "由旧版本 DevFlow 自动写入交接目录生成，无用户活跃会话引用时可单独清理配置";
        safeToClean = true;
      } else if (name.startsWith("live-edit-") || name === "container" || isDebugDir) {
        category = "debug_candidate";
        isDevFlowGenerated = true;
        reason = "调试目录注册残留候选，需用户人工核对后决定是否清理";
        safeToClean = false;
      }

      candidates.push({
        id,
        name,
        configFile: fullPath,
        folderUri,
        folderPath,
        isDevFlowGenerated,
        category,
        reason,
        safeToClean,
      });
    } catch {
      // 忽略损坏的单个配置文件
    }
  }

  const devflowProjects = candidates.filter((c) => c.category === "devflow_container").length;
  const debugCandidates = candidates.filter((c) => c.category === "debug_candidate").length;
  const userProjects = candidates.filter((c) => c.category === "user_project").length;

  return {
    scannedAt: new Date().toISOString(),
    totalProjects: candidates.length,
    devflowProjects,
    debugCandidates,
    userProjects,
    candidates,
    instructions:
      "本报告为只读预览。依据 NV-D12 规定，清理属于独立用户操作，不随系统升级自动删除。仅在确认原生客户端无活动写者、无未保存会话时手动清理候选配置。",
  };
}

if (process.argv[1]?.endsWith("preview-native-project-cleanup.ts") || process.argv[1]?.endsWith("preview-native-project-cleanup.js")) {
  const report = generateNativeProjectCleanupPreview();
  console.log(JSON.stringify(report, null, 2));
}
