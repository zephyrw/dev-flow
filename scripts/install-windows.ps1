# DevFlow 开发者源码安装入口（非普通用户首页入口）。
# 普通用户请使用已发布的一行安装（见 README / docs/guide/安装与升级.md）。
# 本脚本仅从源码树安装/同步开发环境；维护锁与 runtime 的 maintenance-state.json
# 协同，避免更新期间旧启动器误判。FileShare.None 是 Windows 专用句柄互斥，
# 不得假设其它平台有同等语义（POSIX 依赖 maintenance-state.json + 过期恢复）。
[CmdletBinding()]
param(
  [string]$PlannerTool,
  [string]$PlannerModel,
  [string]$PlannerEffort,
  [string]$ExecutorTool,
  [string]$ExecutorModel,
  [string]$ExecutorEffort
)
$ErrorActionPreference = 'Stop'
Write-Host '[开发者源码安装] 从本仓库源码安装/同步 DevFlow（普通用户请使用发布版一行安装）'
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
$maintenanceStatePath = Join-Path $stateRoot 'maintenance-state.json'
$startupPath = Join-Path $stateRoot 'startup-lock.json'
# Windows-only exclusive handle (FileShare.None). Cross-platform identity lives
# in maintenance-state.json (see packages/installer/src/transaction.ts).
$maintenance = [IO.File]::Open($maintenancePath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
$maintenanceTxId = [guid]::NewGuid().ToString('N')
$markerJson = @{
  transaction_id = $maintenanceTxId
  kind = 'install'
  phase = 'requested'
  created_at = (Get-Date).ToUniversalTime().ToString('o')
  updated_at = (Get-Date).ToUniversalTime().ToString('o')
  expires_at = ([DateTimeOffset]::UtcNow.AddMinutes(30)).ToString('o')
  block_new_dispatch = $true
} | ConvertTo-Json -Compress
[IO.File]::WriteAllText($maintenanceStatePath, $markerJson)
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
  $setupArgs = @()
  if ($PlannerTool) { $setupArgs += @('--planner-tool', $PlannerTool) }
  if ($PlannerModel) { $setupArgs += @('--planner-model', $PlannerModel) }
  if ($PlannerEffort) { $setupArgs += @('--planner-effort', $PlannerEffort) }
  if ($ExecutorTool) { $setupArgs += @('--executor-tool', $ExecutorTool) }
  if ($ExecutorModel) { $setupArgs += @('--executor-model', $ExecutorModel) }
  if ($ExecutorEffort) { $setupArgs += @('--executor-effort', $ExecutorEffort) }
  & node (Join-Path $devflowRoot 'scripts\setup.mjs') @setupArgs
  if ($LASTEXITCODE -eq 10) {
    Write-Host '模型设置待完成'
    exit 10
  }
  if ($LASTEXITCODE -ne 0) { throw '安装失败。请根据上方具体错误处理后重试。' }
} finally {
  if ($ownsStartup) { Remove-Item -LiteralPath $startupPath -ErrorAction SilentlyContinue }
  $maintenance.Dispose()
  Remove-Item -LiteralPath $maintenancePath -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $maintenanceStatePath -ErrorAction SilentlyContinue
}
