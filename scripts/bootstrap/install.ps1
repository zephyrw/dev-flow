[CmdletBinding()]
param([string]$Source="",[string]$InstallDir="$env:LOCALAPPDATA\DevFlow",[string]$SelectedTool="codex")
$ErrorActionPreference="Stop"
try {
  if (-not $Source) {
    $arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq [System.Runtime.InteropServices.Architecture]::Arm64) {"arm64"} else {"x64"}
    $release=Invoke-RestMethod -Uri "https://api.github.com/repos/zephyrw/dev-flow/releases/latest"
    $name="devflow-$($release.tag_name)-win32-$arch.tar.gz"
    $asset=$release.assets | Where-Object { $_.name -eq $name }
    $sum=$release.assets | Where-Object { $_.name -eq "$name.sha256" }
    if (-not $asset -or -not $sum) { throw "没有经过发布验证的当前平台安装包：$name" }
    $staging=Join-Path ([IO.Path]::GetTempPath()) ("devflow-install-"+[guid]::NewGuid())
    New-Item -ItemType Directory -Path $staging | Out-Null
    $archive=Join-Path $staging $name
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $archive
    $expected=(Invoke-WebRequest -Uri $sum.browser_download_url).Content.Trim().Split(" ")[0]
    if ($expected -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLower() -ne $expected) { throw "发布包 SHA-256 校验失败" }
    $entries=& tar -tzf $archive
    if ($LASTEXITCODE -ne 0 -or ($entries | Where-Object { $_ -match '(^/|(^|/)\.\.(/|$)|:|\\)' })) { throw "发布包目录不安全" }
    & tar -xzf $archive -C $staging
    if ($LASTEXITCODE -ne 0) { throw "解压失败" }
    $Source=Join-Path $staging "devflow"
  }
  $Source=(Resolve-Path -LiteralPath $Source).Path
  $node=Join-Path $Source "runtime\node.exe"
  if (-not (Test-Path -LiteralPath $node)) {$node=(Get-Command node -ErrorAction Stop).Source}
  $entry=Join-Path $Source "dist\packages\installer\src\main.js"
  if (-not (Test-Path -LiteralPath $entry)) { throw "源码需要先执行 pnpm install --frozen-lockfile、pnpm build 和 pnpm build:host" }
  & $node $entry --source $Source --install-dir $InstallDir --tools $SelectedTool
  exit $LASTEXITCODE
} catch {
  Write-Error $_ -ErrorAction Continue
  exit 20
}
