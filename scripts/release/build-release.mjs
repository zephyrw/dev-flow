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
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertKnownPlatform,
  buildBuildInfo,
  generateSbom,
  injectReleaseBindings,
  resolveNativeDependencyVersions,
  sbomComponentsFromLockfile,
  validateBuildInfo,
  validateNoLegacyArtifacts,
  validateRuntimeFiles,
  MANIFEST_SCHEMA_VERSION,
} from "./release-lib.mjs";

export function requiredAccountReleaseInputs(platform = process.platform) {
  return [
    "dist/apps/api/src/accounts-main.js",
    "dist/packages/service/src/open.js",
    "dist/packages/agy-accounts/src/service.js",
    "dist/packages/agy-accounts/src/credential-worker.js",
    "dist/packages/agy-accounts/src/credential-store.js",
    "dist/packages/process/src/runner-entry.js",
    "dist/packages/process/src/native/index.js",
    "dist/packages/process/src/native/windows.js",
    "dist/packages/process/src/native/posix.js",
    ...(platform === "win32"
      ? ["dist/packages/agy-accounts/src/credential-windows.js"]
      : []),
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
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const version = pkg.version;
  const platform = process.platform + "-" + process.arch;
  assertKnownPlatform(platform);
  const tag = "v" + version;

  const gitRevision = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();

  const root = mkdtempSync(join(tmpdir(), "devflow-release-"));
  const payload = join(root, "devflow");
  mkdirSync(payload, { recursive: true });

  // 1. Copy application files, skills and compliance notices (no Go Host artifacts)
  const copyList = [
    "dist/apps",
    "dist/web",
    "dist/packages",
    "packages/skills",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "compatibility.json",
    "LICENSE",
    "THIRD_PARTY_NOTICES",
  ];
  for (const file of copyList) {
    if (!existsSync(file)) throw new Error("Missing release input: " + file);
    cpSync(file, join(payload, file), { recursive: true });
  }

  // Copy runtime-files.json to package root as the authoritative manifest copy
  const runtimeFilesSource = existsSync("scripts/release/runtime-files.json")
    ? "scripts/release/runtime-files.json"
    : "runtime-files.json";
  if (existsSync(runtimeFilesSource)) {
    cpSync(runtimeFilesSource, join(payload, "runtime-files.json"));
  }

  // 2. Install flat production dependencies
  if (process.platform === "win32") {
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
  } else {
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
  }

  // 3. Native self-check: verify koffi and SQLite load from the packaged payload
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "const k=await import(process.argv[1]);if(!k.default.load)throw Error('koffi missing');const s=await import(process.argv[2]);const db=new s.default(':memory:');db.close();",
      pathToFileURL(join(payload, "node_modules/koffi/index.js")).href,
      pathToFileURL(join(payload, "node_modules/better-sqlite3/lib/index.js")).href,
    ],
    { cwd: payload, stdio: "inherit", windowsHide: true },
  );

  // 4. Bundle target Node runtime
  mkdirSync(join(payload, "runtime"), { recursive: true });
  cpSync(
    process.execPath,
    join(
      payload,
      "runtime",
      process.platform === "win32" ? "node.exe" : "node",
    ),
  );

  // 5. Build identity (build-info.json)
  const lockfileText = readFileSync("pnpm-lock.yaml", "utf8");
  const nativeDependencies = resolveNativeDependencyVersions(lockfileText);
  const buildInfo = buildBuildInfo({
    applicationVersion: version,
    buildRevision: gitRevision,
    buildTag: tag,
    builtAt: new Date().toISOString(),
    platformId: platform,
    nodeVersion: process.version,
    nativeDependencies,
  });
  validateBuildInfo(buildInfo, {
    packageVersion: version,
    platformId: platform,
    gitRevision,
  });
  writeFileSync(join(payload, "build-info.json"), JSON.stringify(buildInfo, null, 2));

  // 6. SBOM generated from lockfile resolved versions
  const sbomComponents = sbomComponentsFromLockfile(lockfileText);
  const sbom = generateSbom({ version, components: sbomComponents });
  writeFileSync(join(payload, "sbom.json"), JSON.stringify(sbom, null, 2));

  // 7. Verify no forbidden legacy Host artifacts and all runtime files exist
  validateNoLegacyArtifacts(payload);
  validateRuntimeFiles(payload, platform);

  // 8. Package tar.gz
  const output = resolve("dist/release");
  mkdirSync(output, { recursive: true });
  const asset = "devflow-" + tag + "-" + platform + ".tar.gz";
  const path = join(output, asset);
  execFileSync("tar", ["-czf", path, "-C", root, "devflow"], {
    windowsHide: true,
  });
  const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
  writeFileSync(path + ".sha256", digest + "  " + asset + "\n");

  // 9. Generate bound bootstrap scripts (install.sh & install.ps1) with immutable tag
  const bootstrapDir = resolve("scripts/bootstrap");
  if (existsSync(join(bootstrapDir, "install.sh"))) {
    const rawSh = readFileSync(join(bootstrapDir, "install.sh"), "utf8");
    const boundSh = injectReleaseBindings(rawSh, { tag, version });
    writeFileSync(join(output, "install.sh"), boundSh.content);
  }
  if (existsSync(join(bootstrapDir, "install.ps1"))) {
    const rawPs1 = readFileSync(join(bootstrapDir, "install.ps1"), "utf8");
    const boundPs1 = injectReleaseBindings(rawPs1, { tag, version });
    writeFileSync(join(output, "install.ps1"), boundPs1.content);
  }

  // 10. Platform manifest
  const manifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    tag,
    version,
    git_revision: gitRevision,
    built_at: buildInfo.built_at,
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
) {
  generateReleaseBundle();
}
