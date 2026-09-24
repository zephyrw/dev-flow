/**
 * Shared release helpers for DFP-03 (build identity, runtime list, manifests).
 * Pure functions + filesystem checks; consumed by build/verify/assemble/smoke
 * and by unit tests. No Host/build:host/build:auth-host paths.
 */
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, relative, sep, posix } from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";

/** Runtime backend identity. Never mixed with application version. */
export const RUNTIME_BACKEND = "node-v1";
/** Config schema this build reads/writes (migration target). */
export const CONFIG_SCHEMA_RANGE = { min: 2, max: 2 };
/** HTTP service / health protocol for the Node backend (stream F echoes this). */
export const SERVICE_PROTOCOL_VERSION = "1.0.0";
/** Managed runner handshake version (packages/process runner-entry). */
export const RUNNER_PROTOCOL_VERSION = "1.0.0";
/** Credential worker protocol id — NOT the application version. */
export const CREDENTIAL_WORKER_PROTOCOL = "3.0.0-node";

/** Candidate release platforms (generation-side matrix). Unknown ids are rejected. */
export const RELEASE_PLATFORMS = Object.freeze([
  "win32-x64",
  "darwin-x64",
  "darwin-arm64",
  "linux-x64",
]);

export const RUNTIME_FILES_SCHEMA_VERSION = 1;
export const MANIFEST_SCHEMA_VERSION = 1;
export const BUILD_INFO_SCHEMA_VERSION = 1;

/**
 * Install-script tag binding placeholders (shared interface #11 / stream D).
 * Scripts keep `DEVFLOW_RELEASE_TAG="@TAG@"` form; build-release substitutes
 * the immutable release tag/version. Formal assets must not retain any of
 * these unreplaced tokens.
 */
export const RELEASE_TAG_PLACEHOLDER = "@TAG@";
export const RELEASE_VERSION_PLACEHOLDER = "@VERSION@";
export const RELEASE_PLACEHOLDER_TOKENS = [
  "@TAG@",
  "@VERSION@",
  "@DEVFLOW_TAG@",
  "@DEVFLOW_VERSION@",
];

/**
 * Negative list: formal packages must never contain legacy Host artifacts.
 * Historical migration fixtures live in tests and are out of package scope.
 */
export const NEGATIVE_PACKAGE_PATTERNS = [
  { re: /^dist\/host(\/|$)/i, reason: "legacy Go Host output dist/host" },
  { re: /^dist\/auth-host(\/|$)/i, reason: "legacy auth Host output dist/auth-host" },
  { re: /^host(\/|$)/i, reason: "legacy host/ tree" },
  { re: /(^|\/)auth-host\.exe$/i, reason: "legacy auth-host.exe" },
  { re: /(^|\/)devflow-host\.exe$/i, reason: "legacy devflow-host.exe" },
  { re: /(^|\/)build-host\.mjs$/i, reason: "legacy build-host.mjs" },
  { re: /(^|\/)build-auth-host\.mjs$/i, reason: "legacy build-auth-host.mjs" },
];

/** Native binary layouts accepted for koffi (optional-dep package or build output). */
export function koffiNativeCandidates(platformId) {
  const [os, arch] = splitPlatformId(platformId);
  const underscore = `${os}_${arch}`;
  const scoped = `@koromix/koffi-${os}-${arch}`;
  return [
    `node_modules/${scoped}/${underscore}/koffi.node`,
    `node_modules/koffi/build/koffi/${underscore}/koffi.node`,
  ];
}

export function betterSqlite3NativePath(platformId) {
  return `node_modules/better-sqlite3/prebuilds/${platformId}.node`;
}

export function splitPlatformId(platformId) {
  const parts = String(platformId).split("-");
  if (parts.length < 2) return [parts[0] ?? "", ""];
  return [parts.slice(0, -1).join("-"), parts[parts.length - 1]];
}

export function currentPlatformId() {
  return `${process.platform}-${process.arch}`;
}

/**
 * Reject unknown / 32-bit platform ids. Never map unknown arch to x64.
 */
export function assertKnownPlatform(platformId) {
  if (!RELEASE_PLATFORMS.includes(platformId)) {
    throw new Error(
      `Unsupported platform id: ${platformId} (allowed: ${RELEASE_PLATFORMS.join(", ")}); refusing to guess an arch mapping`,
    );
  }
  return platformId;
}

export function toPosixPath(p) {
  return String(p).split(sep).join(posix.sep).replaceAll("\\", "/");
}

export function loadRuntimeFiles(root = process.cwd()) {
  const file = join(root, "scripts", "release", "runtime-files.json");
  const alt = join(root, "runtime-files.json");
  const path = existsSync(file) ? file : alt;
  if (!existsSync(path))
    throw new Error("runtime-files.json not found under scripts/release or package root");
  const doc = JSON.parse(readFileSync(path, "utf8"));
  if (doc.schema_version !== RUNTIME_FILES_SCHEMA_VERSION)
    throw new Error(
      `runtime-files.json schema_version ${doc.schema_version} != ${RUNTIME_FILES_SCHEMA_VERSION}`,
    );
  if (!Array.isArray(doc.entries) || doc.entries.length === 0)
    throw new Error("runtime-files.json entries must be a non-empty array");
  for (const entry of doc.entries) validateRuntimeFileEntry(entry);
  return doc;
}

export function validateRuntimeFileEntry(entry) {
  if (!entry || typeof entry !== "object")
    throw new Error("runtime-files entry must be an object");
  if (typeof entry.path !== "string" || !entry.path)
    throw new Error("runtime-files entry.path must be a non-empty string");
  if (entry.path.includes("\\") || entry.path.startsWith("/") || entry.path.includes(".."))
    throw new Error(`runtime-files entry.path must be relative posix: ${entry.path}`);
  const categories = ["app", "runtime", "native", "compliance", "skills"];
  if (!categories.includes(entry.category))
    throw new Error(
      `runtime-files entry.category ${entry.category} invalid (allowed: ${categories.join(", ")})`,
    );
  const r = entry.required;
  const okRequired =
    typeof r === "boolean" ||
    (r &&
      typeof r === "object" &&
      (typeof r.os === "string" || Array.isArray(r.os)) &&
      (r.arch === undefined ||
        typeof r.arch === "string" ||
        Array.isArray(r.arch)));
  if (!okRequired)
    throw new Error(
      `runtime-files entry.required must be boolean or {os, arch?} for ${entry.path}`,
    );
  if (entry.any_of !== undefined) {
    if (!Array.isArray(entry.any_of) || entry.any_of.some((p) => typeof p !== "string" || !p))
      throw new Error(`runtime-files entry.any_of must be a string array for ${entry.path}`);
  }
  return true;
}

export function platformMatches(required, platformId) {
  if (required === true) return true;
  if (required === false) return false;
  const [os, arch] = splitPlatformId(platformId);
  const osList = Array.isArray(required.os) ? required.os : [required.os];
  if (!osList.includes(os)) return false;
  if (required.arch !== undefined) {
    const archList = Array.isArray(required.arch) ? required.arch : [required.arch];
    if (!archList.includes(arch)) return false;
  }
  return true;
}

export function requiredRuntimeFiles(runtimeFiles, platformId) {
  return runtimeFiles.entries.filter((e) => platformMatches(e.required, platformId));
}

export function entryExists(root, entry) {
  const candidates = entry.any_of?.length ? entry.any_of : [entry.path];
  return candidates.some((p) => existsSync(join(root, p)));
}

/**
 * Complete runtime + compliance checklist. Missing entry fails.
 * Native category is never satisfied by package.json alone: the entry path
 * (or any_of) must point at a real binary / module artifact.
 */
export function validateRuntimeFiles(root, platformId, runtimeFiles = loadRuntimeFiles(root)) {
  const required = requiredRuntimeFiles(runtimeFiles, platformId);
  const missing = [];
  for (const entry of required) {
    if (!entryExists(root, entry)) {
      missing.push(entry.any_of?.length ? entry.any_of.join(" | ") : entry.path);
      continue;
    }
    if (entry.category === "native") {
      const hit = (entry.any_of?.length ? entry.any_of : [entry.path]).find((p) =>
        existsSync(join(root, p)),
      );
      if (hit && /package\.json$/i.test(hit) && !entry.any_of?.length) {
        missing.push(`${entry.path} (native entry must not be package.json only)`);
      }
      if (hit && !/package\.json$/i.test(hit)) {
        try {
          if (statSync(join(root, hit)).size <= 0)
            missing.push(`${hit} (native artifact is empty)`);
        } catch {
          missing.push(hit);
        }
      }
    }
  }
  if (missing.length)
    throw new Error(
      `Missing runtime file(s) for ${platformId}:\n  - ` + missing.join("\n  - "),
    );
  return { checked: required.length, platformId };
}

export function findLegacyArtifacts(root) {
  const hits = [];
  const walk = (dir, rel) => {
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      for (const { re, reason } of NEGATIVE_PACKAGE_PATTERNS) {
        if (re.test(relPath)) hits.push({ path: relPath, reason });
      }
      if (ent.isDirectory()) walk(join(dir, ent.name), relPath);
    }
  };
  walk(root, "");
  return hits;
}

export function validateNoLegacyArtifacts(root) {
  const hits = findLegacyArtifacts(root);
  if (hits.length)
    throw new Error(
      "Legacy Host artifact(s) forbidden in formal package:\n  - " +
        hits.map((h) => `${h.path} (${h.reason})`).join("\n  - "),
    );
  return { clean: true };
}

/**
 * Resolve actual production dependency versions from pnpm-lock.yaml.
 * Never returns range strings (^, ~, *, x).
 */
export function resolveLockfileVersions(lockfileText) {
  const doc = parseYaml(lockfileText);
  const root = doc?.importers?.["."] ?? doc?.importers?.[""] ?? null;
  if (!root) throw new Error("pnpm-lock.yaml importers['.'] not found");
  const out = {};
  for (const group of ["dependencies", "optionalDependencies"]) {
    const deps = root[group];
    if (!deps) continue;
    for (const [name, meta] of Object.entries(deps)) {
      const version = normalizeResolvedVersion(meta?.version ?? meta);
      if (!version) throw new Error(`Lockfile entry ${name} has no resolved version`);
      if (isVersionRange(version))
        throw new Error(`Lockfile entry ${name} looks like a range: ${version}`);
      out[name] = version;
    }
  }
  return out;
}

export function normalizeResolvedVersion(value) {
  if (typeof value !== "string") return null;
  // Strip peer suffixes: 2.0.0(@x@1)(hono@4) -> 2.0.0
  const base = value.split("(")[0].trim();
  return base || null;
}

export function isVersionRange(version) {
  return /[\^~*]| \|\||\sx\b|\.\*|>=|<=|<|>/.test(version) || version === "latest";
}

export function resolveNativeDependencyVersions(lockfileText) {
  const all = resolveLockfileVersions(lockfileText);
  const native = {};
  for (const name of ["koffi", "better-sqlite3"]) {
    if (!all[name])
      throw new Error(`Native dependency ${name} missing from lockfile importers`);
    native[name] = all[name];
  }
  return native;
}

/**
 * CycloneDX SBOM from lockfile-resolved actual versions (not package.json ranges).
 */
export function generateSbom({ version, components }) {
  for (const c of components) {
    if (isVersionRange(c.version))
      throw new Error(`SBOM component ${c.name} has range version: ${c.version}`);
  }
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      component: { type: "application", name: "devflow", version },
    },
    components: components.map((c) => ({
      type: "library",
      name: c.name,
      version: c.version,
    })),
  };
}

export function sbomComponentsFromLockfile(lockfileText) {
  const resolved = resolveLockfileVersions(lockfileText);
  return Object.entries(resolved)
    .map(([name, version]) => ({ name, version }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Build identity bound into the package (§5.4). Three versions stay distinct:
 * application_version / config schema / runtime backend.
 */
export function buildBuildInfo({
  applicationVersion,
  buildRevision,
  buildTag = null,
  builtAt = new Date().toISOString(),
  platformId,
  nodeVersion,
  nativeDependencies,
}) {
  if (!applicationVersion || isVersionRange(applicationVersion))
    throw new Error(`applicationVersion must be a concrete version: ${applicationVersion}`);
  assertKnownPlatform(platformId);
  if (!buildRevision || typeof buildRevision !== "string")
    throw new Error("buildRevision (git sha) is required");
  if (!nativeDependencies?.koffi || !nativeDependencies?.["better-sqlite3"])
    throw new Error("nativeDependencies must include koffi and better-sqlite3 actual versions");
  for (const [name, ver] of Object.entries(nativeDependencies)) {
    if (isVersionRange(ver))
      throw new Error(`nativeDependencies.${name} looks like a range: ${ver}`);
  }
  return {
    schema_version: BUILD_INFO_SCHEMA_VERSION,
    application_version: applicationVersion,
    build_revision: buildRevision,
    build_tag: buildTag ?? null,
    built_at: builtAt,
    platform: platformId,
    node_version: nodeVersion,
    runtime_backend: RUNTIME_BACKEND,
    native_dependencies: { ...nativeDependencies },
    config_schema_range: { ...CONFIG_SCHEMA_RANGE },
    service_protocol_version: SERVICE_PROTOCOL_VERSION,
    runner_protocol_version: RUNNER_PROTOCOL_VERSION,
    credential_worker_protocol: CREDENTIAL_WORKER_PROTOCOL,
  };
}

export function validateBuildInfo(buildInfo, { packageVersion, platformId, gitRevision } = {}) {
  const required = [
    "application_version",
    "build_revision",
    "built_at",
    "platform",
    "node_version",
    "runtime_backend",
    "native_dependencies",
    "config_schema_range",
    "service_protocol_version",
    "runner_protocol_version",
    "credential_worker_protocol",
  ];
  for (const key of required) {
    if (buildInfo[key] === undefined || buildInfo[key] === null)
      throw new Error(`build-info.json missing ${key}`);
  }
  if (buildInfo.runtime_backend !== RUNTIME_BACKEND)
    throw new Error(`build-info runtime_backend ${buildInfo.runtime_backend} != ${RUNTIME_BACKEND}`);
  if (buildInfo.credential_worker_protocol !== CREDENTIAL_WORKER_PROTOCOL)
    throw new Error(
      `build-info credential_worker_protocol ${buildInfo.credential_worker_protocol} != ${CREDENTIAL_WORKER_PROTOCOL}`,
    );
  if (
    buildInfo.config_schema_range?.min !== CONFIG_SCHEMA_RANGE.min ||
    buildInfo.config_schema_range?.max !== CONFIG_SCHEMA_RANGE.max
  )
    throw new Error("build-info config_schema_range must be {min:2,max:2}");
  if (buildInfo.build_tag !== null && buildInfo.build_tag !== undefined) {
    if (typeof buildInfo.build_tag !== "string" || !/^v\d/.test(buildInfo.build_tag))
      throw new Error(`build-info build_tag must be null or v-prefixed: ${buildInfo.build_tag}`);
  }
  if (packageVersion && buildInfo.application_version !== packageVersion)
    throw new Error(
      `build-info application_version ${buildInfo.application_version} != package.json ${packageVersion}`,
    );
  if (platformId && buildInfo.platform !== platformId)
    throw new Error(`build-info platform ${buildInfo.platform} != ${platformId}`);
  if (gitRevision && buildInfo.build_revision !== gitRevision)
    throw new Error(`build-info build_revision ${buildInfo.build_revision} != ${gitRevision}`);
  if (buildInfo.build_tag) {
    const expected = `v${buildInfo.application_version}`;
    if (buildInfo.build_tag !== expected && !buildInfo.build_tag.startsWith(`v${buildInfo.application_version}`))
      throw new Error(
        `build-info build_tag ${buildInfo.build_tag} inconsistent with application_version ${buildInfo.application_version}`,
      );
  }
  return true;
}

export function injectReleaseBindings(content, { tag, version }) {
  if (!tag || !version) throw new Error("injectReleaseBindings requires tag and version");
  const source = String(content);
  let out = source
    .replaceAll("@DEVFLOW_TAG@", tag)
    .replaceAll("@DEVFLOW_VERSION@", version)
    .replaceAll(RELEASE_TAG_PLACEHOLDER, tag)
    .replaceAll(RELEASE_VERSION_PLACEHOLDER, version);
  const unreplaced = [];
  for (const token of RELEASE_PLACEHOLDER_TOKENS) {
    if (out.includes(token)) unreplaced.push(token);
  }
  return {
    content: out,
    bindingsApplied:
      source.includes(RELEASE_TAG_PLACEHOLDER) ||
      source.includes(RELEASE_VERSION_PLACEHOLDER) ||
      source.includes("@DEVFLOW_TAG@") ||
      source.includes("@DEVFLOW_VERSION@"),
    unreplacedPlaceholders: unreplaced,
  };
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Strict per-platform / assembled manifest validation (structure, digest, platform, size).
 */
export function validateManifest(manifest, { expectedTag, expectedRevision, expectedVersion } = {}) {
  if (!manifest || typeof manifest !== "object")
    throw new Error("manifest must be an object");
  if (manifest.schema_version !== MANIFEST_SCHEMA_VERSION)
    throw new Error(`manifest.schema_version must be ${MANIFEST_SCHEMA_VERSION}`);
  for (const key of ["tag", "version", "git_revision", "built_at", "platforms", "components"]) {
    if (manifest[key] === undefined) throw new Error(`manifest missing ${key}`);
  }
  if (typeof manifest.tag !== "string" || !/^v\d+\.\d+\.\d+/.test(manifest.tag))
    throw new Error(`manifest.tag must look like vMAJOR.MINOR.PATCH: ${manifest.tag}`);
  if (typeof manifest.version !== "string" || isVersionRange(manifest.version))
    throw new Error(`manifest.version must be a concrete version: ${manifest.version}`);
  if (manifest.tag !== `v${manifest.version}`)
    throw new Error(`manifest.tag ${manifest.tag} != v${manifest.version}`);
  if (typeof manifest.git_revision !== "string" || !/^[0-9a-f]{7,40}$/i.test(manifest.git_revision))
    throw new Error(`manifest.git_revision must be a git sha: ${manifest.git_revision}`);
  if (typeof manifest.built_at !== "string" || Number.isNaN(Date.parse(manifest.built_at)))
    throw new Error("manifest.built_at must be an ISO timestamp");
  if (!Array.isArray(manifest.platforms) || manifest.platforms.length === 0)
    throw new Error("manifest.platforms must be a non-empty array");
  if (typeof manifest.components !== "object" || !manifest.components)
    throw new Error("manifest.components must be an object");
  for (const platformId of manifest.platforms) {
    assertKnownPlatform(platformId);
    const component = manifest.components[platformId];
    if (!component) throw new Error(`manifest.components missing ${platformId}`);
    validateManifestComponent(platformId, component, {
      expectedTag: expectedTag ?? manifest.tag,
      expectedVersion: expectedVersion ?? manifest.version,
    });
  }
  const extra = Object.keys(manifest.components).filter(
    (p) => !manifest.platforms.includes(p),
  );
  if (extra.length)
    throw new Error(`manifest.components has platforms not listed: ${extra.join(", ")}`);
  if (expectedTag && manifest.tag !== expectedTag)
    throw new Error(`manifest.tag ${manifest.tag} != expected ${expectedTag}`);
  if (expectedVersion && manifest.version !== expectedVersion)
    throw new Error(`manifest.version ${manifest.version} != expected ${expectedVersion}`);
  if (expectedRevision && manifest.git_revision !== expectedRevision)
    throw new Error(`manifest.git_revision ${manifest.git_revision} != expected ${expectedRevision}`);
  return true;
}

export function validateManifestComponent(platformId, component, { expectedTag, expectedVersion }) {
  for (const key of ["name", "version", "platform", "arch", "sha256", "size_bytes", "url"]) {
    if (component[key] === undefined) throw new Error(`manifest component ${platformId} missing ${key}`);
  }
  if (typeof component.name !== "string" || !component.name.endsWith(".tar.gz"))
    throw new Error(`manifest component ${platformId} name must be a .tar.gz asset`);
  if (component.version !== expectedVersion)
    throw new Error(`manifest component ${platformId} version mismatch`);
  const [os, arch] = splitPlatformId(platformId);
  if (component.platform !== os)
    throw new Error(`manifest component ${platformId} platform ${component.platform} != ${os}`);
  if (component.arch !== arch)
    throw new Error(`manifest component ${platformId} arch ${component.arch} != ${arch}`);
  if (typeof component.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(component.sha256))
    throw new Error(`manifest component ${platformId} sha256 must be 64 hex chars`);
  if (!Number.isInteger(component.size_bytes) || component.size_bytes <= 0)
    throw new Error(`manifest component ${platformId} size_bytes must be a positive integer`);
  if (typeof component.url !== "string" || !component.url.includes(expectedTag))
    throw new Error(`manifest component ${platformId} url must reference tag ${expectedTag}`);
  return true;
}

/**
 * Assemble per-platform manifests into one release manifest.
 * Fails on missing packages, duplicate platforms, or mixed git commits.
 */
export function assembleManifests(
  manifests,
  { expectedPlatforms = RELEASE_PLATFORMS, allowPartial = false } = {},
) {
  if (!Array.isArray(manifests) || manifests.length === 0)
    throw new Error("assembleManifests requires at least one platform manifest");
  const byPlatform = new Map();
  const revisions = new Set();
  const tags = new Set();
  const versions = new Set();
  for (const manifest of manifests) {
    validateManifest(manifest);
    revisions.add(manifest.git_revision);
    tags.add(manifest.tag);
    versions.add(manifest.version);
    for (const platformId of manifest.platforms) {
      if (byPlatform.has(platformId))
        throw new Error(`Duplicate platform in release manifests: ${platformId}`);
      byPlatform.set(platformId, manifest.components[platformId]);
    }
  }
  if (revisions.size > 1)
    throw new Error(
      `Mixed git revisions across platform manifests: ${[...revisions].join(", ")}`,
    );
  if (tags.size > 1) throw new Error(`Mixed tags across platform manifests: ${[...tags].join(", ")}`);
  if (versions.size > 1)
    throw new Error(`Mixed versions across platform manifests: ${[...versions].join(", ")}`);

  const platforms = [...byPlatform.keys()].sort();
  const missing = expectedPlatforms.filter((p) => !byPlatform.has(p));
  if (missing.length && !allowPartial)
    throw new Error(`Missing platform package(s): ${missing.join(", ")}`);

  for (const platformId of platforms) assertKnownPlatform(platformId);

  const components = {};
  for (const platformId of platforms) components[platformId] = byPlatform.get(platformId);
  const sample = manifests[0];
  const assembled = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    tag: sample.tag,
    version: sample.version,
    git_revision: sample.git_revision,
    built_at: sample.built_at,
    platforms,
    components,
    expected_platforms: [...expectedPlatforms],
  };
  validateManifest({ ...assembled, platforms, components });
  // assembled carries all platforms; re-validate each component against its id
  for (const platformId of platforms)
    validateManifestComponent(platformId, components[platformId], {
      expectedTag: sample.tag,
      expectedVersion: sample.version,
    });
  return assembled;
}

/**
 * Content digest for install receipt / U-04 policy (same version + same digest
 * is idempotent; same version + different digest must be rejected).
 */
export function computeReleaseContentDigest(root, paths) {
  const parts = paths.map((p) => {
    const abs = join(root, p);
    if (!existsSync(abs)) throw new Error(`Cannot digest missing file: ${p}`);
    return `${p}:${sha256File(abs)}`;
  });
  return sha256Text(parts.join("\n"));
}

/**
 * Bundled Node must exist for formal packages. Never silently fall back to
 * system Node (§5.2 安装目录层 / clean-system assertion path).
 */
export function resolveBundledNode(root) {
  const name = process.platform === "win32" ? "node.exe" : "node";
  const path = join(root, "runtime", name);
  if (!existsSync(path))
    throw new Error(
      `Bundled Node missing at ${toPosixPath(relative(root, path))}; formal packages must not fall back to system Node`,
    );
  return path;
}

export function readPackageVersion(root = process.cwd()) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (pkg.name !== "devflow") throw new Error(`package.json name must be devflow: ${pkg.name}`);
  return pkg.version;
}

export function readBuildInfo(root) {
  const path = join(root, "build-info.json");
  if (!existsSync(path)) throw new Error("build-info.json missing from package root");
  return JSON.parse(readFileSync(path, "utf8"));
}

export function validateBootstrapAssets(dir) {
  const scripts = ["install.sh", "install.ps1"];
  for (const name of scripts) {
    const p = join(dir, name);
    if (!existsSync(p)) continue;
    const content = readFileSync(p, "utf8");
    for (const token of RELEASE_PLACEHOLDER_TOKENS) {
      if (content.includes(token)) {
        throw new Error(
          `Bootstrap asset ${name} contains unreplaced placeholder token: ${token}`,
        );
      }
    }
  }
}

