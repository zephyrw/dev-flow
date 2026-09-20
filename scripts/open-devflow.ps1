param([switch]$Accounts)
﻿$ErrorActionPreference = 'Stop'
$devflowRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
try {
  $entry = Join-Path $devflowRoot 'dist\packages\service\src\open.js'
  if (!(Test-Path -LiteralPath $entry)) { throw '请先双击项目目录中的“安装或更新 DevFlow.cmd”。' }
  Set-Location -LiteralPath $devflowRoot
  if ($Accounts) { & node $entry --accounts } else { & node $entry }
  if ($LASTEXITCODE -ne 0) { throw '后台服务未启动。请查看 .devflow\controller.stderr.log；若旧服务占用端口，请先关闭旧服务。' }
} catch {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show($_.Exception.Message, 'DevFlow') | Out-Null
  exit 1
}
