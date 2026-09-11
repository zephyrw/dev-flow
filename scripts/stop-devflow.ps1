[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$devflowRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $devflowRoot
$configFile = Join-Path $devflowRoot 'devflow.yaml'
$stateRoot = Join-Path $devflowRoot '.devflow'
if (Test-Path -LiteralPath $configFile) {
  $env:DEVFLOW_READ_CONFIG = $configFile
  try {
    $configured = & node --input-type=module -e "import {readFileSync} from 'node:fs';import {parse} from 'yaml'; console.log(parse(readFileSync(process.env.DEVFLOW_READ_CONFIG,'utf8')).storage_root || '.devflow')"
    if ($LASTEXITCODE -ne 0) { throw '无法读取服务目录。' }
    if ([IO.Path]::IsPathRooted($configured)) { $stateRoot = [IO.Path]::GetFullPath($configured) }
    else { $stateRoot = [IO.Path]::GetFullPath((Join-Path $devflowRoot $configured)) }
  } finally { Remove-Item Env:\DEVFLOW_READ_CONFIG -ErrorAction SilentlyContinue }
}
$recordFile = Join-Path $stateRoot 'controller-process.json'
if (!(Test-Path -LiteralPath $recordFile)) { return }
$record = Get-Content -LiteralPath $recordFile -Raw | ConvertFrom-Json
$expectedEntry = [IO.Path]::GetFullPath((Join-Path $devflowRoot 'dist\apps\api\src\main.js'))
if (![string]::Equals([IO.Path]::GetFullPath($record.entry), $expectedEntry, [StringComparison]::OrdinalIgnoreCase)) {
  throw '进程记录不属于此 DevFlow 安装，未停止任何程序。'
}
$ownedProcess = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
if (!$ownedProcess) { return }
# PowerShell 7 converts ISO JSON dates to DateTime; Windows PowerShell keeps
# strings. Parsing the former through ToString loses fractional seconds/zone.
$recordedStartTicks = if ($record.started -is [DateTimeOffset]) {
  $record.started.UtcTicks
} elseif ($record.started -is [DateTime]) {
  $record.started.ToUniversalTime().Ticks
} else {
  ([DateTimeOffset]::Parse([string]$record.started)).UtcTicks
}
if ($ownedProcess.StartTime.ToUniversalTime().Ticks -ne $recordedStartTicks -or
    ![string]::Equals($ownedProcess.Path, $record.executable, [StringComparison]::OrdinalIgnoreCase)) {
  throw '进程编号已被复用或记录不匹配，未停止任何程序。'
}
# The exact controller's Job handles close; no process-name-wide termination.
Stop-Process -Id $ownedProcess.Id
Wait-Process -Id $ownedProcess.Id -Timeout 15 -ErrorAction SilentlyContinue
