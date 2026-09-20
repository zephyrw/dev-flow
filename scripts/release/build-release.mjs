import { execFileSync } from "node:child_process";
import {
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
  cpSync,
  mkdtempSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
export function requiredAccountReleaseInputs(platform = process.platform) {
  return [
    "dist/apps/api/src/accounts-main.js",
    "dist/packages/service/src/open.js",
    "dist/packages/agy-accounts/src/service.js",
    ...(platform === "win32" ? ["dist/host/devflow-auth-host.exe"] : []),
  ];
}
export function validateAccountReleaseInputs(
  root = process.cwd(),
  platform = process.platform,
) {
  for (const file of requiredAccountReleaseInputs(platform))
    if (!existsSync(join(root, file)))
      throw new Error("Missing account release input: " + file);
}
export function generateReleaseBundle() {
  validateAccountReleaseInputs();
  const pkg = JSON.parse(readFileSync("package.json", "utf8")),
    version = pkg.version;
  const platform = process.platform + "-" + process.arch,
    tag = "v" + version;
  if (
    !["win32", "darwin", "linux"].includes(process.platform) ||
    !["x64", "arm64"].includes(process.arch)
  )
    throw new Error("Unsupported platform");
  const gitRevision = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  const root = mkdtempSync(join(tmpdir(), "devflow-release-")),
    payload = join(root, "devflow");
  mkdirSync(payload, { recursive: true });
  for (const file of [
    "dist/apps",
    "dist/web",
    "dist/packages",
    "dist/host",
    "packages/skills",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "LICENSE",
    "THIRD_PARTY_NOTICES",
  ]) {
    if (!existsSync(file)) throw new Error("Missing release input: " + file);
    cpSync(file, join(payload, file), { recursive: true });
  }
  // Reuse pnpm's shared cache; flat production modules avoid absolute Windows junctions in archives.
  if (process.platform === "win32")
    execFileSync(
      process.env.ComSpec ?? "cmd.exe",
      [
        "/d",
        "/s",
        "/c",
        "pnpm install --prod --frozen-lockfile --config.node-linker=hoisted",
      ],
      { cwd: payload, stdio: "inherit", windowsHide: true },
    );
  else
    execFileSync(
      "pnpm",
      [
        "install",
        "--prod",
        "--frozen-lockfile",
        "--config.node-linker=hoisted",
      ],
      { cwd: payload, stdio: "inherit" },
    );
  mkdirSync(join(payload, "runtime"), { recursive: true });
  cpSync(
    process.execPath,
    join(
      payload,
      "runtime",
      process.platform === "win32" ? "node.exe" : "node",
    ),
  );
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: { component: { type: "application", name: "devflow", version } },
    components: Object.entries(pkg.dependencies).map(([name, version]) => ({
      type: "library",
      name,
      version,
    })),
  };
  writeFileSync(join(payload, "sbom.json"), JSON.stringify(sbom, null, 2));
  const output = resolve("dist/release");
  mkdirSync(output, { recursive: true });
  const asset = "devflow-" + tag + "-" + platform + ".tar.gz",
    path = join(output, asset);
  execFileSync("tar", ["-czf", path, "-C", root, "devflow"], {
    windowsHide: true,
  });
  const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
  writeFileSync(path + ".sha256", digest + "  " + asset + "\n");
  const manifest = {
    tag,
    version,
    git_revision: gitRevision,
    published_at: new Date().toISOString(),
    platforms: [platform],
    components: {
      [platform]: {
        name: asset,
        version,
        platform: process.platform,
        arch: process.arch,
        sha256: digest,
        size_bytes: statSync(path).size,
        url:
          "https://github.com/zephyrw/dev-flow/releases/download/" +
          tag +
          "/" +
          asset,
      },
    },
  };
  const name = "release-" + platform + ".json";
  writeFileSync(join(output, name), JSON.stringify(manifest, null, 2));
  writeFileSync(
    join(output, name + ".sha256"),
    createHash("sha256")
      .update(readFileSync(join(output, name)))
      .digest("hex") +
      "  " +
      name +
      "\n",
  );
  return { asset: path, manifest: join(output, name) };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  generateReleaseBundle();
