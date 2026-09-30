export interface ComponentManifestItem {
  name: string;
  version: string;
  platform: string;
  arch: string;
  sha256: string;
  url: string;
  size_bytes: number;
  tag: string;
  git_revision: string;
  git_sha?: string;
}
export interface ReleaseManifest {
  tag: string;
  version: string;
  published_at: string;
  git_revision: string;
  git_sha?: string;
  platforms?: string[];
  components: Record<string, ComponentManifestItem>;
}
export const RELEASE_REPOSITORY = "zephyrw/dev-flow";
// Assets and checksums are generated from the actual release files. No fictitious prepublished asset.
export function validateReleaseManifest(
  input: ReleaseManifest,
): ReleaseManifest {
  if (
    !/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(input.tag) ||
    input.tag !== `v${input.version}` ||
    !/^[a-f0-9]{40}$/.test(input.git_revision) ||
    (input.git_sha !== undefined && input.git_sha !== input.git_revision) ||
    !Object.keys(input.components).length
  )
    throw new Error("发布清单无效");
  for (const [key, c] of Object.entries(input.components))
    if (
      !/^[a-f0-9]{64}$/.test(c.sha256) ||
      c.size_bytes <= 0 ||
      key !== `${c.platform}-${c.arch}` ||
      !["win32-x64", "linux-x64", "darwin-x64", "darwin-arm64"].includes(key) ||
      c.version !== input.version || c.tag !== input.tag ||
      c.git_revision !== input.git_revision ||
      (c.git_sha !== undefined && c.git_sha !== input.git_revision) ||
      (input.platforms !== undefined && !input.platforms.includes(key)) ||
      c.name !== `devflow-${input.tag}-${key}.tar.gz` ||
      c.url !== (
        "https://github.com/" +
          RELEASE_REPOSITORY +
          "/releases/download/" +
          input.tag +
          "/" + c.name
      )
    )
      throw new Error("发布资产无效");
  return input;
}

/** Strict platform/arch acceptance — never map unknown or 32-bit to x64. */
export function isSupportedPlatformPair(
  platform: string,
  arch: string,
): boolean {
  return (
    (platform === "win32" && arch === "x64") ||
    (platform === "darwin" && (arch === "x64" || arch === "arm64")) ||
    (platform === "linux" && arch === "x64")
  );
}

export function assertPlatformAsset(
  item: ComponentManifestItem,
  platform = process.platform,
  arch = process.arch,
): void {
  if (!isSupportedPlatformPair(item.platform, item.arch)) {
    throw new Error(
      `不支持的平台或架构：${item.platform}-${item.arch}（不会自动映射为 x64）`,
    );
  }
  if (item.platform !== platform || item.arch !== arch) {
    throw new Error(
      `发布资产平台不匹配：需要 ${platform}-${arch}，清单为 ${item.platform}-${item.arch}`,
    );
  }
}
