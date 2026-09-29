[CmdletBinding()]
param(
  [string]$Source="",
  [string]$Version="latest",
  [string]$InstallDir="$env:LOCALAPPDATA\DevFlow",
  [string]$SelectedTool="codex",
  [string]$PlannerTool="",
  [string]$PlannerModel="",
  [string]$PlannerEffort="",
  [string]$ExecutorTool="",
  [string]$ExecutorModel="",
  [string]$ExecutorEffort=""
)
$ErrorActionPreference="Stop"
$releaseManifest=""
try {
  if (-not $Source) {
    $arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq [System.Runtime.InteropServices.Architecture]::Arm64) {"arm64"} else {"x64"}
    $releaseEndpoint = if ($Version -eq "latest") {"latest"} elseif ($Version -match '^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$') {"tags/$Version"} else {throw "Invalid release version"}
    $release=Invoke-RestMethod -Uri "https://api.github.com/repos/zephyrw/dev-flow/releases/$releaseEndpoint"
    if ($release.tag_name -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$' -or ($Version -ne "latest" -and $release.tag_name -cne $Version)) { throw "Requested release tag mismatch" }
    $base="https://github.com/zephyrw/dev-flow/releases/download/$($release.tag_name)"
    $name="devflow-$($release.tag_name)-win32-$arch.tar.gz"
    $asset=$release.assets | Where-Object { $_.name -eq $name }
    $sum=$release.assets | Where-Object { $_.name -eq "$name.sha256" }
    if (-not $asset -or -not $sum) { throw "没有经过发布验证的当前平台安装包：$name" }
    $staging=Join-Path ([IO.Path]::GetTempPath()) ("devflow-install-"+[guid]::NewGuid())
    New-Item -ItemType Directory -Path $staging | Out-Null
    $archive=Join-Path $staging $name
    if ($asset.browser_download_url -ne "$base/$name" -or $sum.browser_download_url -ne "$base/$name.sha256") { throw "Release URL mismatch" }
    $releaseManifest=Join-Path $staging "release-win32-$arch.json"
    Invoke-WebRequest -Uri "$base/release-win32-$arch.json" -OutFile $releaseManifest
    $manifestSum=(Invoke-WebRequest -Uri "$base/release-win32-$arch.json.sha256").Content.Trim().Split(" ")[0]
    if ($manifestSum -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $releaseManifest -Algorithm SHA256).Hash.ToLower() -ne $manifestSum) { throw "Manifest checksum mismatch" }
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $archive
    $expected=(Invoke-WebRequest -Uri $sum.browser_download_url).Content.Trim().Split(" ")[0]
    if ($expected -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLower() -ne $expected) { throw "发布包 SHA-256 校验失败" }
    $entries=& tar -tzf $archive
    if ($LASTEXITCODE -ne 0 -or ($entries | Where-Object { $_ -match '(^/|(^|/)\.\.(/|$)|:|\\)' })) { throw "发布包目录不安全" }
    $entryTypes=& tar -tvzf $archive
    if ($LASTEXITCODE -ne 0 -or ($entryTypes | Where-Object { $_ -notmatch '^[d-]' })) { throw "Archive links and special files are unsupported" }
    & tar -xzf $archive -C $staging
    if ($LASTEXITCODE -ne 0) { throw "解压失败" }
    $Source=Join-Path $staging "devflow"
  }
  $Source=(Resolve-Path -LiteralPath $Source).Path
  $node=Join-Path $Source "runtime\node.exe"
  if (-not (Test-Path -LiteralPath $node)) {$node=(Get-Command node -ErrorAction Stop).Source}
  $entry=Join-Path $Source "dist\packages\installer\src\main.js"
  if (-not (Test-Path -LiteralPath $entry)) { throw "源码需要先执行 pnpm install --frozen-lockfile 和 pnpm build" }
  $nodeArgs = @($entry, '--source', $Source, '--install-dir', $InstallDir, '--tools', $SelectedTool)
  if ($releaseManifest) {
    & $node (Join-Path $Source 'dist/packages/installer/src/release-identity.js') $Source $releaseManifest $archive $release.tag_name "$base/$name"
    if ($LASTEXITCODE -ne 0) { throw "Release identity mismatch" }
    $nodeArgs += @('--release-manifest', $releaseManifest, '--release-archive', $archive, '--release-tag', $release.tag_name, '--release-url', "$base/$name")
  }
  if ($PlannerTool) { $nodeArgs += @('--planner-tool', $PlannerTool) }
  if ($PlannerModel) { $nodeArgs += @('--planner-model', $PlannerModel) }
  if ($PlannerEffort) { $nodeArgs += @('--planner-effort', $PlannerEffort) }
  if ($ExecutorTool) { $nodeArgs += @('--executor-tool', $ExecutorTool) }
  if ($ExecutorModel) { $nodeArgs += @('--executor-model', $ExecutorModel) }
  if ($ExecutorEffort) { $nodeArgs += @('--executor-effort', $ExecutorEffort) }
  & $node @nodeArgs
  exit $LASTEXITCODE
} catch {
  Write-Error $_ -ErrorAction Continue
  exit 20
}
