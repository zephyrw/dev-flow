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
