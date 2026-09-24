import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { execFileSync, spawnSync } from "node:child_process";

const repoRoot = resolve(__dirname, "../..");
const shPath = join(repoRoot, "scripts", "bootstrap", "install.sh");
const ps1Path = join(repoRoot, "scripts", "bootstrap", "install.ps1");
const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
const bashExe = existsSync(gitBash) ? gitBash : "bash";

function toPosix(p: string): string {
  return p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1");
}

function runBash(
  script: string,
  opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): { status: number; stdout: string; stderr: string } {
  // Git Bash on Windows reports MINGW from uname; install.sh targets macOS/Linux.
  // Tests prepend a portable uname shim unless the caller overrides PATH inside the script.
  const r = spawnSync(bashExe, ["-c", script], {
    encoding: "utf8",
    cwd: opts.cwd ?? repoRoot,
    env: { ...process.env, ...opts.env },
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

/** PATH prefix inside bash that forces a given `uname -s` / `uname -m`. */
function unamePathPrefix(machine: string, osName = "Linux"): string {
  const bin = join(work, `unamebin-${osName}-${machine}`);
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, "uname");
  writeFileSync(
    shim,
    `#!/bin/sh\ncase "$1" in\n  -s) echo ${osName};;\n  -m) echo ${machine};;\n  *) echo ${osName};;\nesac\n`,
    { mode: 0o755 },
  );
  return toPosix(bin);
}

/** Wrap script body so `uname` is the shim (Git Bash would otherwise report MINGW). */
function withUname(machine: string, body: string, osName = "Linux"): string {
  const prefix = unamePathPrefix(machine, osName);
  return `export PATH="${prefix}:$PATH"\n${body}`;
}

function sourceSh(expr: string): { status: number; stdout: string; stderr: string } {
  const script = withUname(
    "x86_64",
    `DEVFLOW_INSTALL_TEST_LIB=1 . "${toPosix(shPath)}"\n${expr}`,
  );
  return runBash(script);
}

interface TarEntry {
  name: string;
  type?: string;
  content?: Buffer | string;
  linkname?: string;
}

function tarHeader(entry: TarEntry, size: number): Buffer {
  const buf = Buffer.alloc(512);
  buf.write(entry.name, 0, "utf8");
  buf.write("0000644\0", 100, "ascii");
  buf.write("0000000\0", 108, "ascii");
  buf.write("0000000\0", 116, "ascii");
  buf.write(size.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  buf.write("00000000000\0", 136, "ascii");
  buf.write("        ", 148, "ascii");
  buf.write(entry.type ?? "0", 156, "ascii");
  if (entry.linkname) buf.write(entry.linkname, 157, "utf8");
  buf.write("ustar\0", 257, "ascii");
  buf.write("00", 263, "ascii");
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i]!;
  buf.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return buf;
}

function makeTar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const content =
      e.content == null
        ? Buffer.alloc(0)
        : Buffer.isBuffer(e.content)
          ? e.content
          : Buffer.from(e.content);
    const type = e.type ?? "0";
    const useSize = type === "0" ? content.length : 0;
    parts.push(tarHeader(e, useSize));
    if (type === "0" && useSize > 0) {
      parts.push(content);
      const pad = (512 - (useSize % 512)) % 512;
      if (pad) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function makeTarGz(entries: TarEntry[]): Buffer {
  return gzipSync(makeTar(entries));
}

let work: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "bootstrap-unit-"));
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("DFP-04 bootstrap 参数契约（install.sh）", () => {
  it("未知参数报错并返回 30，不进入下载", () => {
    const r = runBash(`"${toPosix(shPath)}" --definitely-unknown`);
    expect(r.status).toBe(30);
    expect(r.stderr).toContain("未知参数");
  });

  it("--version 缺值报错 30", () => {
    const r = runBash(`"${toPosix(shPath)}" --version`);
    expect(r.status).toBe(30);
    expect(r.stderr).toMatch(/缺少参数值/);
  });

  it("默认不强制 --tools codex；显式 --tool 仍透传", () => {
    const dir = join(work, "argv-fixture");
    mkdirSync(join(dir, "dist/packages/installer/src"), { recursive: true });
    const argsFile = join(work, "sh-args-default.json");
    writeFileSync(
      join(dir, "dist/packages/installer/src/main.js"),
      `require('fs').writeFileSync(process.env.MOCK_ARGS_FILE, JSON.stringify(process.argv.slice(2)));\n`,
    );
    const r = runBash(
      withUname(
        "x86_64",
        `"${toPosix(shPath)}" --source "${toPosix(dir)}" --install-dir "${toPosix(join(work, "安装 目录/App"))}" --no-open`,
      ),
      {
        env: {
          MOCK_ARGS_FILE: argsFile,
          DEVFLOW_INSTALL_TEST_LIB: "",
        },
      },
    );
    expect(r.status).toBe(0);
    const args = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
    expect(args).toContain("--source");
    expect(args).toContain("--install-dir");
    const toolsIdx = args.indexOf("--tools");
    expect(toolsIdx).toBe(-1);
    expect(args.join(" ")).not.toMatch(/codex/);

    const argsFile2 = join(work, "sh-args-tools.json");
    const r2 = runBash(
      withUname(
        "x86_64",
        `"${toPosix(shPath)}" --source "${toPosix(dir)}" --install-dir "${toPosix(join(work, "install"))}" --no-open --tool codex,agy`,
      ),
      { env: { MOCK_ARGS_FILE: argsFile2 } },
    );
    expect(r2.status).toBe(0);
    const args2 = JSON.parse(readFileSync(argsFile2, "utf8")) as string[];
    expect(args2).toContain("--tools");
    expect(args2[args2.indexOf("--tools") + 1]).toBe("codex,agy");
  });

  it("--install-dir 支持空格与中文，--no-open 不尝试打开浏览器", () => {
    const dir = join(work, "argv-fixture");
    const argsFile = join(work, "sh-args-dir.json");
    const marker = join(work, "opened-marker");
    const openShim = join(work, "bin");
    mkdirSync(openShim, { recursive: true });
    writeFileSync(
      join(openShim, "xdg-open"),
      `#!/bin/sh\necho "$@" > "${toPosix(marker)}"\nexit 1\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(openShim, "open"), `#!/bin/sh\nexit 1\n`, {
      mode: 0o755,
    });
    const installDir = join(work, "我的 DevFlow 目录/App Name");
    const r = runBash(
      withUname(
        "x86_64",
        `export PATH="${toPosix(openShim)}:$PATH"\n"${toPosix(shPath)}" --source "${toPosix(dir)}" --install-dir "${toPosix(installDir)}" --no-open`,
      ),
      {
        env: {
          MOCK_ARGS_FILE: argsFile,
        },
      },
    );
    expect(r.status).toBe(0);
    const args = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
    expect(args[args.indexOf("--install-dir") + 1]).toContain("我的 DevFlow 目录");
    expect(existsSync(marker)).toBe(false);
    expect(r.stdout).toContain("请访问下方地址完成设置");
  });

  it("--source 离线不发起网络（拦截 curl）", () => {
    const dir = join(work, "argv-fixture");
    const bin = join(work, "offline-bin");
    const netMarker = join(work, "network-marker");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "curl"),
      `#!/bin/sh\necho curl >> "${toPosix(netMarker)}"\nexit 1\n`,
      { mode: 0o755 },
    );
    const r = runBash(
      withUname(
        "x86_64",
        `export PATH="${toPosix(bin)}:$PATH"\n"${toPosix(shPath)}" --source "${toPosix(dir)}" --install-dir "${toPosix(join(work, "offline-inst"))}" --no-open`,
      ),
      {
        env: {
          MOCK_ARGS_FILE: join(work, "sh-args-offline.json"),
        },
      },
    );
    expect(r.status).toBe(0);
    expect(existsSync(netMarker)).toBe(false);
  });
});

describe("DFP-04 架构/平台拒绝（I-08）", () => {
  function withFakeUname(machine: string, osName = "Linux"): ReturnType<typeof runBash> {
    return runBash(
      withUname(
        machine,
        `"${toPosix(shPath)}" --version v0.0.0 --no-open`,
        osName,
      ),
    );
  }

  it("32 位 i686 不映射 x64，下载前拒绝", () => {
    const r = withFakeUname("i686");
    expect(r.status).toBe(40);
    expect(r.stderr).toContain("32 位");
  });

  it("未知架构不映射 x64", () => {
    const r = withFakeUname("mips64");
    expect(r.status).toBe(40);
    expect(r.stderr).toContain("不支持的架构");
  });

  it("linux-arm64 不在首发矩阵，下载前拒绝", () => {
    const r = withFakeUname("aarch64", "Linux");
    expect(r.status).toBe(40);
    expect(r.stderr).toMatch(/尚无官方安装包|linux-arm64/);
  });
});

describe("DFP-04 manifest 严格校验", () => {
  function writeManifest(name: string, raw: string | Buffer): string {
    const p = join(work, name);
    writeFileSync(p, raw);
    return p;
  }

  it("接受格式/平台/标签正确的 manifest 并输出摘要", () => {
    const sha = "a".repeat(64);
    const body = JSON.stringify({
      tag: "v1.2.3",
      version: "1.2.3",
      platforms: ["linux-x64"],
      components: {
        "linux-x64": {
          name: "devflow-v1.2.3-linux-x64.tar.gz",
          version: "1.2.3",
          platform: "linux",
          arch: "x64",
          sha256: sha,
          size_bytes: 10,
          url: "https://example.invalid/x",
        },
      },
    });
    const p = writeManifest("manifest-ok.json", body);
    const r = sourceSh(
      `validate_manifest_file "${toPosix(p)}" "linux-x64" "v1.2.3"`,
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(sha);
  });

  it("拒绝超大 manifest", () => {
    const p = writeManifest("manifest-big.json", "x".repeat(70000));
    const r = sourceSh(
      `validate_manifest_file "${toPosix(p)}" "linux-x64" "v1.2.3"`,
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("大小不合法");
  });

  it("拒绝畸形 manifest", () => {
    const p = writeManifest("manifest-bad.json", "{not-json");
    const r = sourceSh(
      `validate_manifest_file "${toPosix(p)}" "linux-x64" "v1.2.3"`,
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/JSON|对象/);
  });

  it("拒绝平台不符", () => {
    const body = JSON.stringify({
      tag: "v1.2.3",
      components: {
        "win32-x64": {
          name: "devflow-v1.2.3-win32-x64.tar.gz",
          platform: "win32",
          arch: "x64",
          sha256: "b".repeat(64),
        },
      },
    });
    const p = writeManifest("manifest-plat.json", body);
    const r = sourceSh(
      `validate_manifest_file "${toPosix(p)}" "linux-x64" "v1.2.3"`,
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/目标平台|平台字段/);
  });

  it("拒绝标签不一致", () => {
    const body = JSON.stringify({
      tag: "v9.9.9",
      components: {
        "linux-x64": {
          name: "devflow-v9.9.9-linux-x64.tar.gz",
          platform: "linux",
          arch: "x64",
          sha256: "c".repeat(64),
        },
      },
    });
    const p = writeManifest("manifest-tag.json", body);
    const r = sourceSh(
      `validate_manifest_file "${toPosix(p)}" "linux-x64" "v1.2.3"`,
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("标签");
  });
});

describe("DFP-04 归档路径逃逸拒绝（I-07）", () => {
  function writeArchive(name: string, entries: TarEntry[]): string {
    const p = join(work, name);
    writeFileSync(p, makeTarGz(entries));
    return p;
  }

  function validate(p: string) {
    const names = join(work, "entries.txt");
    const verbose = join(work, "verbose.txt");
    return sourceSh(
      `validate_archive_entries "${toPosix(p)}" "${toPosix(names)}" "${toPosix(verbose)}"`,
    );
  }

  it("接受普通文件与目录", () => {
    const p = writeArchive("ok.tar.gz", [
      { name: "devflow/", type: "5" },
      { name: "devflow/package.json", content: "{}" },
    ]);
    const r = validate(p);
    expect(r.status).toBe(0);
  });

  it("拒绝绝对路径", () => {
    const p = writeArchive("abs.tar.gz", [
      { name: "/etc/passwd", content: "x" },
    ]);
    const r = validate(p);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("不安全路径");
  });

  it("拒绝上级路径 ..", () => {
    const p = writeArchive("dotdot.tar.gz", [
      { name: "devflow/../../escape.txt", content: "x" },
    ]);
    const r = validate(p);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("不安全路径");
  });

  it("拒绝符号链接条目", () => {
    const p = writeArchive("symlink.tar.gz", [
      { name: "devflow/link", type: "2", linkname: "/etc/passwd" },
      { name: "devflow/file", content: "x" },
    ]);
    const r = validate(p);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("符号链接");
  });

  it("拒绝硬链接条目", () => {
    const p = writeArchive("hardlink.tar.gz", [
      { name: "devflow/file", content: "x" },
      { name: "devflow/hard", type: "1", linkname: "devflow/file" },
    ]);
    const r = validate(p);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("符号链接");
  });
});

describe("DFP-04 退出码语义（默认非 require-ready / require-ready）", () => {
  function mockInstaller(dir: string, exitCode: number): string {
    mkdirSync(join(dir, "dist/packages/installer/src"), { recursive: true });
    writeFileSync(
      join(dir, "dist/packages/installer/src/main.js"),
      `process.stdout.write('首次设置页面：http://127.0.0.1:4810\\n');\nprocess.exit(${exitCode});\n`,
    );
    return dir;
  }

  it("默认安装：安装器 10（模型未配置）不作为失败", () => {
    const dir = mockInstaller(join(work, "mock10"), 10);
    const r = runBash(
      withUname(
        "x86_64",
        `"${toPosix(shPath)}" --source "${toPosix(dir)}" --install-dir "${toPosix(join(work, "inst10"))}" --no-open`,
      ),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("模型设置待完成");
  });

  it("--require-ready：安装器 10 保持非成功", () => {
    const dir = mockInstaller(join(work, "mock10b"), 10);
    const r = runBash(
      withUname(
        "x86_64",
        `"${toPosix(shPath)}" --source "${toPosix(dir)}" --install-dir "${toPosix(join(work, "inst10b"))}" --no-open --require-ready`,
      ),
    );
    expect(r.status).toBe(10);
    expect(r.stderr).toContain("严格就绪检查");
  });

  it("安装器其它失败码原样传递", () => {
    const dir = mockInstaller(join(work, "mock50"), 50);
    const r = runBash(
      withUname(
        "x86_64",
        `"${toPosix(shPath)}" --source "${toPosix(dir)}" --install-dir "${toPosix(join(work, "inst50"))}" --no-open`,
      ),
    );
    expect(r.status).toBe(50);
  });
});
