# DevFlow release bootstrap (Windows PowerShell).
#
# Release builds must replace __DEVFLOW_RELEASE_TAG__ with the immutable tag
# (e.g. v0.2.0) so the script pins manifest + artifacts to that tag and never
# re-resolves latest. A leftover placeholder marks a development copy.
#
# Exit codes follow packages/installer/src/state.ts INSTALL_EXIT_CODES.
# Interactive / `irm | iex` hosts are never closed with `exit`; failures throw
# a terminating error and emit machine-readable DEVFLOW_INSTALL_STATUS.
# Strict automation (`powershell -File install.ps1`) keeps process exit codes.
[CmdletBinding()]
param(
  [string]$Version = "",
  [string]$Source = "",
  [string]$InstallDir = "$env:LOCALAPPDATA\DevFlow",
  [Alias("Tool", "SelectedTool")]
  [string]$Tools = "",
  [switch]$NoOpen,
  [switch]$RequireReady,
  [string]$PlannerTool = "",
  [string]$PlannerModel = "",
  [string]$PlannerEffort = "",
  [string]$ExecutorTool = "",
  [string]$ExecutorModel = "",
  [string]$ExecutorEffort = ""
)

$ErrorActionPreference = "Stop"

$script:DevflowReleaseTag = "__DEVFLOW_RELEASE_TAG__"
# First-release public matrix (plan §5.5). win32-arm64 / 32-bit rejected before download.
$script:DevflowSupportedTargets = @("win32-x64")
$script:ManifestMaxBytes = 65536

function Test-DevflowPlaceholderTag {
  param([string]$Tag)
  return [string]::IsNullOrEmpty($Tag) -or $Tag -eq "__DEVFLOW_RELEASE_TAG__"
}

function Test-DevflowPrereleaseTag {
  param([string]$Tag)
  return $Tag -match '^v[0-9].*-'
}

function Assert-DevflowVersionTag {
  param([string]$Tag)
  if ($Tag -notmatch '^v[0-9][A-Za-z0-9._+-]*$') {
    throw "无效的版本标签：$Tag（应形如 v1.2.3）"
  }
  if ($Tag -match '[/\\]') {
    throw "无效的版本标签：$Tag"
  }
}

function Resolve-DevflowTarget {
  # Reject unknown and 32-bit architectures — never map them to x64 (I-08).
  $osArch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
  switch ($osArch.ToString()) {
    "X64" { $arch = "x64" }
    "Arm64" { $arch = "arm64" }
    "X86" { throw "不支持 32 位架构：$osArch（不会映射为 x64）" }
    default { throw "不支持的架构：$osArch（不会映射为 x64）" }
  }
  $target = "win32-$arch"
  if ($script:DevflowSupportedTargets -notcontains $target) {
    throw "当前平台尚无官方安装包：$target（支持：$($script:DevflowSupportedTargets -join ', ')）"
  }
  return $target
}

function Resolve-DevflowVersionOnce {
  param([string]$Requested)
  if (-not [string]::IsNullOrEmpty($Requested)) {
    Assert-DevflowVersionTag -Tag $Requested
    # explicit -Version may select a prerelease
    return $Requested
  }
  if (-not (Test-DevflowPlaceholderTag -Tag $script:DevflowReleaseTag)) {
    Assert-DevflowVersionTag -Tag $script:DevflowReleaseTag
    return $script:DevflowReleaseTag
  }
  Write-Host "开发版 bootstrap：未嵌入发布标签，解析 latest 一次。"
  # One resolution only (plan §4.3). GitHub latest never points at prerelease.
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/zephyrw/dev-flow/releases/latest"
  $tag = [string]$release.tag_name
  Assert-DevflowVersionTag -Tag $tag
  if (Test-DevflowPrereleaseTag -Tag $tag) {
    throw "latest 解析到预发布标签：$tag；预发布必须显式 -Version"
  }
  return $tag
}

function Test-DevflowManifest {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$ExpectedTarget,
    [Parameter(Mandatory = $true)][string]$ExpectedTag
  )
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "manifest 不存在"
  }
  $size = (Get-Item -LiteralPath $Path).Length
  if ($size -le 0 -or $size -gt $script:ManifestMaxBytes) {
    throw "manifest 大小不合法：$size（上限 $($script:ManifestMaxBytes)）"
  }
  $raw = Get-Content -LiteralPath $Path -Raw
  if ($raw -match '__DEVFLOW_[A-Z_]+__') {
    throw "manifest 含未替换占位符"
  }
  try {
    $manifest = $raw | ConvertFrom-Json
  } catch {
    throw "manifest 不是合法 JSON：$($_.Exception.Message)"
  }
  if ($null -eq $manifest -or $manifest -isnot [System.Management.Automation.PSObject]) {
    throw "manifest 不是单个 JSON 对象"
  }
  if ([string]$manifest.tag -ne $ExpectedTag) {
    throw "manifest 标签与请求版本不一致（期望 $ExpectedTag）"
  }
  $components = $manifest.components
  if ($null -eq $components) {
    throw "manifest 缺少 components"
  }
  $component = $components.$ExpectedTarget
  if ($null -eq $component) {
    throw "manifest 不含目标平台组件：$ExpectedTarget"
  }
  $expectedOs, $expectedArch = $ExpectedTarget -split '-', 2
  if ([string]$component.platform -ne $expectedOs) {
    throw "manifest 平台字段与 $ExpectedTarget 不符"
  }
  if ([string]$component.arch -ne $expectedArch) {
    throw "manifest 架构字段与 $ExpectedTarget 不符"
  }
  $sha = [string]$component.sha256
  if ($sha -notmatch '^[a-fA-F0-9]{64}$') {
    throw "manifest 摘要字段畸形"
  }
  if ([string]$component.name -notmatch [regex]::Escape("devflow-$ExpectedTag-$ExpectedTarget")) {
    throw "manifest 资产名与标签/平台不符"
  }
  return @{ sha256 = $sha.ToLowerInvariant(); name = [string]$component.name }
}

function Test-DevflowArchiveEntries {
  # I-07: reject absolute paths, .., drive/colon, backslash, links, special types — before extract.
  param([Parameter(Mandatory = $true)][string]$Archive)
  $entries = & tar -tzf $Archive
  if ($LASTEXITCODE -ne 0) {
    throw "无法列出归档条目"
  }
  $unsafe = $entries | Where-Object { $_ -match '(^/|(^|/)\.\.(/|$)|\\|:)' }
  if ($unsafe) {
    throw "归档含不安全路径（绝对路径/上级目录/反斜杠/冒号）"
  }
  $verbose = & tar -tvzf $Archive
  if ($LASTEXITCODE -ne 0) {
    throw "无法检查归档条目类型"
  }
  foreach ($line in $verbose) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $type = $line.Substring(0, 1)
    # only regular files (-) and directories (d); reject l/h and specials
    if ($type -ne "-" -and $type -ne "d") {
      throw "归档含符号链接/硬链接/特殊条目，已拒绝：$line"
    }
  }
}

function Expand-DevflowArchiveSafely {
  param(
    [Parameter(Mandatory = $true)][string]$Archive,
    [Parameter(Mandatory = $true)][string]$Destination
  )
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  & tar -xzf $Archive -C $Destination
  if ($LASTEXITCODE -ne 0) {
    throw "解压失败（可能磁盘不足或归档损坏）"
  }
}

function Resolve-DevflowNode {
  param(
    [Parameter(Mandatory = $true)][string]$SourceDir,
    [Parameter(Mandatory = $true)][bool]$SourceMode
  )
  $bundled = Join-Path $SourceDir "runtime\node.exe"
  if (Test-Path -LiteralPath $bundled) {
    return $bundled
  }
  if ($SourceMode) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $cmd) {
      throw "开发 -Source 模式需要 Node 运行时"
    }
    return $cmd.Source
  }
  throw "安装包不完整：缺少内置 Node 运行时（不会回退到系统 Node）"
}

function Get-DevflowSetupUrl {
  param(
    [string]$InstallerOutput,
    [string]$InstallRoot
  )
  foreach ($line in ($InstallerOutput -split "`r?`n")) {
    if ($line -like "首次设置页面：*") {
      return $line.Substring("首次设置页面：".Length).Trim()
    }
  }
  $configPath = Join-Path $InstallRoot "devflow.yaml"
  if (Test-Path -LiteralPath $configPath) {
    $raw = Get-Content -LiteralPath $configPath -Raw
    if ($raw -match '"human_origin"\s*:\s*"([^"]+)"') {
      return $Matches[1]
    }
  }
  return "http://localhost:4810"
}

function Complete-DevflowBootstrap {
  param(
    [Parameter(Mandatory = $true)][int]$ExitCode,
    [string]$ErrorMessage = ""
  )
  $status = [ordered]@{
    ok        = ($ExitCode -eq 0)
    exit_code = $ExitCode
    error     = $ErrorMessage
  }
  $json = $status | ConvertTo-Json -Compress
  # Machine-readable status for strict automation (I-16).
  Write-Host "DEVFLOW_INSTALL_STATUS: $json"
  $asFile = -not [string]::IsNullOrEmpty($PSCommandPath)
  if ($asFile) {
    # powershell -File: preserve precise process exit code
    exit $ExitCode
  }
  if ($ExitCode -ne 0) {
    throw "DevFlow 安装未完成（exit $ExitCode）：$ErrorMessage"
  }
}

function Show-DevflowInstallResult {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][bool]$SourceModeOffline,
    [bool]$SetupPending = $false
  )
  if ($NoOpen) {
    Write-Host "DevFlow 已安装。请访问下方地址完成设置，或运行 ``devflow`` 打开。"
    Write-Host $Url
  } else {
    $opened = $false
    try {
      Start-Process -FilePath $Url -ErrorAction Stop | Out-Null
      $opened = $true
    } catch {
      $opened = $false
    }
    if ($opened) {
      Write-Host "DevFlow 已安装，并已打开设置页面。选择你要使用的编程助手和模型，即可开始。"
    } else {
      Write-Host "DevFlow 已安装。浏览器未能自动打开，请访问下方地址，或运行 ``devflow`` 再次打开。"
      Write-Host $Url
    }
  }
  if ($SetupPending) {
    Write-Host "模型设置待完成（不影响本次软件安装）。"
  }
}

function Resolve-DevflowFailureCode {
  param([string]$Message)
  if ($Message -match '不支持的架构|不支持 32 位|尚无官方安装包|不支持的操作系统') { return 40 }
  if ($Message -match '无效的版本标签') { return 30 }
  if ($Message -match '缺少参数值|未知参数|不能为空') { return 30 }
  if ($Message -match '严格就绪检查') { return 10 }
  return 20
}

function Invoke-DevflowBootstrapMain {
  $exitCode = 20
  $errorMessage = ""
  $staging = $null
  $sourceMode = -not [string]::IsNullOrEmpty($Source)
  try {
    if ([string]::IsNullOrWhiteSpace($InstallDir)) {
      throw "-InstallDir 不能为空"
    }
    if ($sourceMode) {
      if (-not (Test-Path -LiteralPath $Source)) {
        throw "源目录不存在：$Source"
      }
      $sourceDir = (Resolve-Path -LiteralPath $Source).Path
    } else {
      $target = Resolve-DevflowTarget
      $tag = Resolve-DevflowVersionOnce -Requested $Version
      $base = "https://github.com/zephyrw/dev-flow/releases/download/$tag"
      $assetName = "devflow-$tag-$target.tar.gz"
      $manifestName = "release-$target.json"
      $staging = Join-Path ([IO.Path]::GetTempPath()) ("devflow-install-" + [guid]::NewGuid())
      New-Item -ItemType Directory -Path $staging | Out-Null

      $manifestPath = Join-Path $staging $manifestName
      Invoke-WebRequest -Uri "$base/$manifestName" -OutFile $manifestPath
      $manifestSumPath = Join-Path $staging "$manifestName.sha256"
      Invoke-WebRequest -Uri "$base/$manifestName.sha256" -OutFile $manifestSumPath
      $expectedManifest = ((Get-Content -LiteralPath $manifestSumPath -Raw).Trim() -split "\s+")[0].ToLowerInvariant()
      $actualManifest = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($expectedManifest -notmatch '^[a-f0-9]{64}$' -or $expectedManifest -ne $actualManifest) {
        throw "manifest SHA-256 校验失败"
      }
      $manifestInfo = Test-DevflowManifest -Path $manifestPath -ExpectedTarget $target -ExpectedTag $tag

      $archive = Join-Path $staging $assetName
      Invoke-WebRequest -Uri "$base/$assetName" -OutFile $archive
      $sidecarPath = Join-Path $staging "$assetName.sha256"
      Invoke-WebRequest -Uri "$base/$assetName.sha256" -OutFile $sidecarPath
      $expected = ((Get-Content -LiteralPath $sidecarPath -Raw).Trim() -split "\s+")[0].ToLowerInvariant()
      $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($expected -notmatch '^[a-f0-9]{64}$' -or $expected -ne $actual -or $manifestInfo.sha256 -ne $actual) {
        throw "发布包 SHA-256 校验失败"
      }
      Test-DevflowArchiveEntries -Archive $archive
      $bundleRoot = Join-Path $staging "bundle"
      Expand-DevflowArchiveSafely -Archive $archive -Destination $bundleRoot
      $sourceDir = Join-Path $bundleRoot "devflow"
      if (-not (Test-Path -LiteralPath $sourceDir)) {
        throw "安装包不完整：缺少 devflow 根目录"
      }
    }

    $node = Resolve-DevflowNode -SourceDir $sourceDir -SourceMode:$sourceMode
    $entry = Join-Path $sourceDir "dist\packages\installer\src\main.js"
    if (-not (Test-Path -LiteralPath $entry)) {
      if ($sourceMode) {
        throw "开发 -Source 需要完整构建产物（缺少 $entry）；请先执行 pnpm install --frozen-lockfile 和 pnpm build。这不是 clone 自动构建入口。"
      }
      throw "安装包不完整：缺少安装器入口"
    }

    $nodeArgs = @($entry, "--source", $sourceDir, "--install-dir", $InstallDir)
    # Default install does not force a client (plan §4.4).
    if (-not [string]::IsNullOrEmpty($Tools)) {
      $nodeArgs += @("--tools", $Tools)
    }
    if ($PlannerTool) { $nodeArgs += @("--planner-tool", $PlannerTool) }
    if ($PlannerModel) { $nodeArgs += @("--planner-model", $PlannerModel) }
    if ($PlannerEffort) { $nodeArgs += @("--planner-effort", $PlannerEffort) }
    if ($ExecutorTool) { $nodeArgs += @("--executor-tool", $ExecutorTool) }
    if ($ExecutorModel) { $nodeArgs += @("--executor-model", $ExecutorModel) }
    if ($ExecutorEffort) { $nodeArgs += @("--executor-effort", $ExecutorEffort) }

    $output = & $node @nodeArgs 2>&1 | ForEach-Object { "$_" }
    $code = $LASTEXITCODE
    foreach ($line in $output) { Write-Host $line }
    $text = ($output -join "`n")

    $setupPending = $false
    # Model/tool setup is onboarding for default installs. Exit 10 keeps its
    # meaning for direct installer callers (plan §4.4 / S07).
    if ($code -eq 10) {
      if ($RequireReady) {
        throw "严格就绪检查未通过：工具/模型设置未完成"
      }
      $setupPending = $true
      $code = 0
    }
    if ($code -ne 0) {
      throw "安装器返回 $code"
    }
    $url = Get-DevflowSetupUrl -InstallerOutput $text -InstallRoot $InstallDir
    Show-DevflowInstallResult -Url $url -SourceModeOffline:$sourceMode -SetupPending $setupPending
    $exitCode = 0
    $errorMessage = ""
  } catch {
    $errorMessage = $_.Exception.Message
    Write-Error $errorMessage -ErrorAction Continue
    if ($errorMessage -match '安装器返回 (\d+)') {
      $exitCode = [int]$Matches[1]
    } else {
      $exitCode = Resolve-DevflowFailureCode -Message $errorMessage
    }
  } finally {
    # Success and failure both drop this run's staging only (I-06).
    if ($staging -and (Test-Path -LiteralPath $staging)) {
      try { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue } catch { }
    }
  }
  Complete-DevflowBootstrap -ExitCode $exitCode -ErrorMessage $errorMessage
}

# Dot-source (tests) loads functions only; -File / iex runs the installer.
if ($MyInvocation.InvocationName -ne '.') {
  Invoke-DevflowBootstrapMain
}
