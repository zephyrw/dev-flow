export interface ComponentManifestItem {
  name: string;
  version: string;
  platform: string;
  arch: string;
  sha256: string;
  url: string;
  size_bytes: number;
}
export interface ReleaseManifest {
  tag: string;
  version: string;
  published_at: string;
  components: Record<string, ComponentManifestItem>;
}
export const RELEASE_REPOSITORY = "zephyrw/dev-flow";
// Assets and checksums are generated from the actual release files. No fictitious prepublished asset.
export function validateReleaseManifest(
  input: ReleaseManifest,
): ReleaseManifest {
  if (
    !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(input.tag) ||
    !Object.keys(input.components).length
  )
    throw new Error("发布清单无效");
  for (const c of Object.values(input.components))
    if (
      !/^[a-f0-9]{64}$/.test(c.sha256) ||
      c.size_bytes <= 0 ||
      !c.url.startsWith(
        "https://github.com/" +
          RELEASE_REPOSITORY +
          "/releases/download/" +
          input.tag +
          "/",
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
