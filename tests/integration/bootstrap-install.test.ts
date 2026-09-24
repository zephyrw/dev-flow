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
import { join, resolve, win32 } from "node:path";
import { gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(__dirname, "../..");
const ps1Path = join(repoRoot, "scripts", "bootstrap", "install.ps1");
const shPath = join(repoRoot, "scripts", "bootstrap", "install.sh");
const pwshPath = existsSync(
  "C:\\Users\\yckj4798\\AppData\\Local\\Programs\\PowerShell\\7\\pwsh.exe",
)
  ? "C:\\Users\\yckj4798\\AppData\\Local\\Programs\\PowerShell\\7\\pwsh.exe"
  : null;
const windowsPs = existsSync(
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
)
  ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  : "powershell.exe";
// Prefer pwsh (UTF-8); fall back to Windows PowerShell. Script ships with UTF-8 BOM either way.
const powershell = pwshPath ?? windowsPs;

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

function makeTarGz(entries: TarEntry[]): Buffer {
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
  return gzipSync(Buffer.concat(parts));
}

function runPs(
  args: string[],
  opts: { input?: string; env?: NodeJS.ProcessEnv } = {},
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(powershell, args, {
    encoding: "utf8",
    cwd: repoRoot,
    env: { ...process.env, ...opts.env },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function invokePs1File(params: string[]) {
  return runPs([
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    ps1Path,
    ...params,
  ]);
}

function invokePs1DotSource(expr: string): { status: number; stdout: string; stderr: string } {
  // Dot-source loads functions only (InvocationName == '.'); then evaluate expr.
  const command = `$ErrorActionPreference='Stop'; . "${ps1Path.replace(/\\/g, "\\\\")}"; ${expr}`;
  return runPs(["-NoProfile", "-NonInteractive", "-Command", command]);
}

function mockInstallerBundle(dir: string, exitCode: number, body = ""): string {
  mkdirSync(join(dir, "dist/packages/installer/src"), { recursive: true });
  // CJS mock: fixture lives outside the repo package.json ("type": "module") boundary.
  writeFileSync(
    join(dir, "dist/packages/installer/src/main.js"),
    `process.stdout.write('首次设置页面：http://127.0.0.1:4810\\n');\n` +
      `try { require('fs').writeFileSync(process.env.MOCK_ARGS_FILE || require('os').nullDevice, JSON.stringify(process.argv.slice(2))); } catch (e) {}\n` +
      body +
      `process.exit(${exitCode});\n`,
  );
  return dir;
}

let work: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "bootstrap-int-"));
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("DFP-04 install.ps1 参数契约", () => {
  it("未知参数（-File）报错且可识别退出码，不关闭为交互窗口设计的错误路径", () => {
    // -File with an undeclared parameter → PowerShell binding error, non-zero.
    const r = invokePs1File(["-DefinitelyUnknown", "x"]);
    expect(r.status).not.toBe(0);
  });

  it("默认不强制工具；-Tools 显式时透传", () => {
    const dir = mockInstallerBundle(join(work, "ps-argv"), 0);
    const argsFile = join(work, "ps-args-default.json");
    const installDir = join(work, "安装 目录/DevFlow App");
    const r = runPs(
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        ps1Path,
        "-Source",
        dir,
        "-InstallDir",
        installDir,
        "-NoOpen",
      ],
      { env: { MOCK_ARGS_FILE: argsFile } },
    );
    expect(r.status).toBe(0);
    const args = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
    expect(args.join(" ")).not.toMatch(/--tools/);
    expect(args.join(" ")).not.toMatch(/codex/);
    expect(args[args.indexOf("--install-dir") + 1]).toContain("DevFlow App");

    const argsFile2 = join(work, "ps-args-tools.json");
    const r3 = runPs(
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        ps1Path,
        "-Source",
        dir,
        "-InstallDir",
        installDir,
        "-NoOpen",
        "-Tools",
        "codex",
      ],
      { env: { MOCK_ARGS_FILE: argsFile2 } },
    );
    expect(r3.status).toBe(0);
    const args2 = JSON.parse(readFileSync(argsFile2, "utf8")) as string[];
    expect(args2).toContain("--tools");
    expect(args2[args2.indexOf("--tools") + 1]).toBe("codex");
  });

  it("-Source 离线不发起网络依赖安装", () => {
    const dir = mockInstallerBundle(join(work, "ps-offline"), 0);
    // Invoke-WebRequest would fail offline; success without network is the assertion.
    const r = invokePs1File([
      "-Source",
      dir,
      "-InstallDir",
      join(work, "ps-offline-inst"),
      "-NoOpen",
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("DEVFLOW_INSTALL_STATUS");
    expect(r.stdout).toContain('"ok":true');
  });
});

describe("DFP-04 install.ps1 退出码与宿主窗口（I-16）", () => {
  it("默认安装：安装器 10 不作为失败（-File 退出 0）", () => {
    const dir = mockInstallerBundle(join(work, "ps-mock10"), 10);
    const r = invokePs1File([
      "-Source",
      dir,
      "-InstallDir",
      join(work, "ps-inst10"),
      "-NoOpen",
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("模型设置待完成");
  });

  it("-RequireReady：安装器 10 为非成功（-File 退出 10）", () => {
    const dir = mockInstallerBundle(join(work, "ps-mock10r"), 10);
    const r = invokePs1File([
      "-Source",
      dir,
      "-InstallDir",
      join(work, "ps-inst10r"),
      "-NoOpen",
      "-RequireReady",
    ]);
    expect(r.status).toBe(10);
    expect(r.stdout + r.stderr).toContain("DEVFLOW_INSTALL_STATUS");
    expect(r.stdout + r.stderr).toContain('"exit_code":10');
  });

  it("iex 失败不 exit 杀宿主：脚本继续执行", () => {
    // Simulate `irm | iex`: evaluate script text in-session (no PSCommandPath).
    // Defaults make Source empty → missing bundle path must throw, not `exit` the host.
    const content = readFileSync(ps1Path, "utf8");
    const escaped = content.replace(/'/g, "''");
    const simple =
      `$ErrorActionPreference='Continue'; ` +
      `try { Invoke-Expression @'\n${escaped}\n'@ } ` +
      `catch { Write-Host ('CAUGHT:' + $_.Exception.Message) }; ` +
      `Write-Host 'STILL_ALIVE'`;
    const r = runPs(["-NoProfile", "-NonInteractive", "-Command", simple]);
    expect(r.stdout).toContain("STILL_ALIVE");
  });

  it("iex 失败抛出终止错误且不调用 exit 杀宿主（带 -Source 坏目录）", () => {
    // scriptblock invocation keeps host alive (no `exit`); still machine-readable status.
    const command =
      `$ErrorActionPreference='Continue'; ` +
      `try { $sb=[scriptblock]::Create((Get-Content -Raw -LiteralPath '${ps1Path.replace(/\\/g, "\\\\")}')); ` +
      `& $sb -Source 'X:\\does\\not\\exist-devflow' -NoOpen ` +
      `} catch { Write-Host ('CAUGHT:' + $_.Exception.Message) }; ` +
      `Write-Host 'STILL_ALIVE'`;
    const r = runPs(["-NoProfile", "-NonInteractive", "-Command", command]);
    expect(r.stdout).toContain("STILL_ALIVE");
    expect(r.stdout + r.stderr).toMatch(/CAUGHT:|DEVFLOW_INSTALL_STATUS/);
  });
});

describe("DFP-04 install.ps1 manifest 与归档防护", () => {
  function psValidateManifest(raw: string, target = "win32-x64", tag = "v1.2.3") {
    const p = join(work, `mf-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(p, raw);
    const expr =
      `try { ` +
      `$r = Test-DevflowManifest -Path '${p.replace(/\\/g, "\\\\")}' -ExpectedTarget '${target}' -ExpectedTag '${tag}'; ` +
      `Write-Host ('OK:' + $r.sha256) ` +
      `} catch { Write-Host ('ERR:' + $_.Exception.Message); exit 1 }`;
    return invokePs1DotSource(expr);
  }

  it("接受正确 manifest", () => {
    const sha = "d".repeat(64);
    const r = psValidateManifest(
      JSON.stringify({
        tag: "v1.2.3",
        components: {
          "win32-x64": {
            name: "devflow-v1.2.3-win32-x64.tar.gz",
            platform: "win32",
            arch: "x64",
            sha256: sha,
          },
        },
      }),
    );
    expect(r.stdout).toContain("OK:" + sha);
  });

  it("拒绝超大 manifest", () => {
    const r = psValidateManifest("x".repeat(70000));
    expect(r.stdout + r.stderr).toContain("大小不合法");
  });

  it("拒绝畸形 JSON", () => {
    const r = psValidateManifest("{not-json");
    expect(r.stdout + r.stderr).toMatch(/JSON|ERR:/);
  });

  it("拒绝平台不符", () => {
    const r = psValidateManifest(
      JSON.stringify({
        tag: "v1.2.3",
        components: {
          "linux-x64": {
            name: "devflow-v1.2.3-linux-x64.tar.gz",
            platform: "linux",
            arch: "x64",
            sha256: "e".repeat(64),
          },
        },
      }),
    );
    expect(r.stdout + r.stderr).toMatch(/目标平台|不符/);
  });

  it("拒绝归档绝对路径 / 链接条目（I-07）", () => {
    const okArchive = join(work, "ok-entries.tar.gz");
    writeFileSync(
      okArchive,
      makeTarGz([
        { name: "devflow/", type: "5" },
        { name: "devflow/a.txt", content: "x" },
      ]),
    );
    const absArchive = join(work, "abs-entries.tar.gz");
    writeFileSync(absArchive, makeTarGz([{ name: "/etc/passwd", content: "x" }]));
    const linkArchive = join(work, "link-entries.tar.gz");
    writeFileSync(
      linkArchive,
      makeTarGz([{ name: "devflow/l", type: "2", linkname: "/etc/passwd" }]),
    );

    const ok = invokePs1DotSource(
      `try { Test-DevflowArchiveEntries -Archive '${okArchive.replace(/\\/g, "\\\\")}'; Write-Host 'OK' } catch { Write-Host ('ERR:' + $_.Exception.Message); exit 1 }`,
    );
    expect(ok.stdout).toContain("OK");

    const abs = invokePs1DotSource(
      `try { Test-DevflowArchiveEntries -Archive '${absArchive.replace(/\\/g, "\\\\")}'; Write-Host 'OK' } catch { Write-Host ('ERR:' + $_.Exception.Message) }`,
    );
    expect(abs.stdout + abs.stderr).toMatch(/不安全路径|ERR:/);

    const link = invokePs1DotSource(
      `try { Test-DevflowArchiveEntries -Archive '${linkArchive.replace(/\\/g, "\\\\")}'; Write-Host 'OK' } catch { Write-Host ('ERR:' + $_.Exception.Message) }`,
    );
    expect(link.stdout + link.stderr).toMatch(/符号链接|硬链接|特殊条目|ERR:/);
  });
});

describe("DFP-04 正式包禁止回退系统 Node（I-05）", () => {
  it("sh 下载路径缺 runtime/node → 安装包不完整；--source 允许系统 Node", () => {
    const r = invokePs1DotSource(
      `try { Resolve-DevflowNode -SourceDir '${join(work, "no-node").replace(/\\/g, "\\\\")}' -SourceMode $false; Write-Host 'OK' } catch { Write-Host ('ERR:' + $_.Exception.Message) }`,
    );
    expect(r.stdout + r.stderr).toContain("安装包不完整");
  });
});
