# Run ON the Windows machine in PowerShell (manual path; the Ops Timeline
# plugin's "Find machines" command does the same over SSH).
# Usage:
#   Expand the zip, then:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\INSTALL.ps1 -DashUrl http://<dashboard-host>:8899
param(
  [Parameter(Mandatory = $true)][string]$DashUrl,
  [string]$HostLabel = $env:COMPUTERNAME
)
$ErrorActionPreference = "Stop"
$root = Join-Path $env:USERPROFILE "hermes-metrics-dash"
New-Item -ItemType Directory -Force -Path $root | Out-Null
Copy-Item -Force "$PSScriptRoot\forwarder.py" $root
Copy-Item -Force "$PSScriptRoot\benchmark.py" $root
Copy-Item -Force "$PSScriptRoot\windows-forwarder.ps1" (Join-Path $root "windows-forwarder.ps1")
Set-Location $root
$lms = Join-Path $env:USERPROFILE ".lmstudio\bin\lms.exe"
if (Test-Path $lms) { $env:LMS_BIN = $lms }

Write-Host "Installing from $root"
& powershell -NoProfile -ExecutionPolicy Bypass -File .\windows-forwarder.ps1 -Install -Start -DashUrl $DashUrl -HostLabel $HostLabel
Start-Sleep -Seconds 2
$log = Join-Path $env:USERPROFILE ".hermes\logs\metricsfwd.log"
$err = Join-Path $env:USERPROFILE ".hermes\logs\metricsfwd.err.log"
if (Test-Path $log) { Write-Host "LOG:"; Get-Content $log -Tail 5 } else { Write-Host "NO_LOG yet" }
if (Test-Path $err) { Write-Host "ERR:"; Get-Content $err -Tail 20 }
$proc = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like "*forwarder.py*" }
if ($proc) { Write-Host "RUNNING pid=$($proc.ProcessId)" } else { Write-Host "NOT_RUNNING" }
Write-Host "Done."
