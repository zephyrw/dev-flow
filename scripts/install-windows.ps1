[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$devflowRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $devflowRoot
if (!(Get-Command pnpm.cmd -ErrorAction SilentlyContinue)) {
  throw '需要 pnpm 11.7.0。请先执行 corepack enable pnpm，再重新安装。'
}
# Runs under the current user. No account, ACL or login setup.
New-Item -ItemType Directory -Path (Join-Path $devflowRoot '.cache') -Force | Out-Null
if (!(Test-Path -LiteralPath (Join-Path $devflowRoot 'node_modules\yaml'))) {
  & pnpm.cmd install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw '依赖安装失败。' }
}
$env:DEVFLOW_READ_CONFIG = Join-Path $devflowRoot 'devflow.yaml'
try {
  $configured = & node --input-type=module -e "import {existsSync,readFileSync} from 'node:fs';import {parse} from 'yaml'; const f=process.env.DEVFLOW_READ_CONFIG;console.log(existsSync(f) ? (parse(readFileSync(f,'utf8')).storage_root || '.devflow') : '.devflow')"
  if ($LASTEXITCODE -ne 0) { throw '无法读取服务目录。' }
} finally { Remove-Item Env:\DEVFLOW_READ_CONFIG -ErrorAction SilentlyContinue }
$stateRoot = if ([IO.Path]::IsPathRooted($configured)) { [IO.Path]::GetFullPath($configured) } else { [IO.Path]::GetFullPath((Join-Path $devflowRoot $configured)) }
New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
$maintenancePath = Join-Path $stateRoot 'maintenance.lock'
$startupPath = Join-Path $stateRoot 'startup-lock.json'
$maintenance = [IO.File]::Open($maintenancePath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
$ownsStartup = $false
try {
  # Drain an in-flight launch before stopping; hold the same start lock during update.
  for ($attempt = 0; $attempt -lt 75; $attempt++) {
    try {
      $lockStream = [IO.File]::Open($startupPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
      try {
        $lockText = @{ owner = 'installer'; expires = ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 60000) } | ConvertTo-Json -Compress
        $lockBytes = [Text.Encoding]::UTF8.GetBytes($lockText)
        $lockStream.Write($lockBytes, 0, $lockBytes.Length)
      } finally { $lockStream.Dispose() }
      $ownsStartup = $true
      break
    } catch [IO.IOException] {
      if ((Test-Path -LiteralPath $startupPath) -and (([DateTime]::UtcNow - (Get-Item -LiteralPath $startupPath).LastWriteTimeUtc).TotalSeconds -gt 65)) {
        Remove-Item -LiteralPath $startupPath
      }
      Start-Sleep -Seconds 1
    }
  }
  if (!$ownsStartup) { throw '服务正在启动，请稍后重新安装。' }
  & (Join-Path $PSScriptRoot 'stop-devflow.ps1')
  & pnpm.cmd install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw '依赖同步失败，未继续安装。' }
  & node (Join-Path $devflowRoot 'scripts\setup.mjs')
  if ($LASTEXITCODE -ne 0) { throw '安装失败。请根据上方具体错误处理后重试。' }
} finally {
  if ($ownsStartup) { Remove-Item -LiteralPath $startupPath -ErrorAction SilentlyContinue }
  $maintenance.Dispose()
  Remove-Item -LiteralPath $maintenancePath -ErrorAction SilentlyContinue
}
