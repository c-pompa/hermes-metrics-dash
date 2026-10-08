# Metrics forwarder (Windows)
# Installs/runs the forwarder so the dashboard gets native CPU/mem/power from
# any Windows machine running LM Studio.
#
# Easiest: the Ops Timeline plugin's "Find machines" button shows a command
# to run on the mini; it copies these files over SSH and runs -Install -Start.
#
# By hand (PowerShell as the LM Studio user, files next to this script):
#   .\windows-forwarder.ps1 -Install -Start -DashUrl http://<dashboard-host>:8899 [-HostLabel <name>]

param(
  [switch]$Install,
  [switch]$Start,
  [switch]$Stop,
  [string]$DashUrl = "",
  [string]$HostLabel = $env:COMPUTERNAME,
  # Flat zip layout puts this script next to forwarder.py; repo layout uses scripts/.
  [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"
if (($Install -or $Start) -and -not $DashUrl) { throw "-DashUrl is required (e.g. http://<dashboard-host>:8899)" }
if (-not $RepoRoot) {
  if (Test-Path (Join-Path $PSScriptRoot "forwarder.py")) {
    $RepoRoot = $PSScriptRoot
  } else {
    $RepoRoot = Split-Path -Parent $PSScriptRoot
  }
}

$pythonCmd = Get-Command python -ErrorAction SilentlyContinue
if (-not $pythonCmd) { $pythonCmd = Get-Command python3 -ErrorAction SilentlyContinue }
if (-not $pythonCmd) { throw "python/python3 not found on PATH" }
$python = $pythonCmd.Source

$forwarder = Join-Path $RepoRoot "forwarder.py"
if (-not (Test-Path $forwarder)) { throw "missing $forwarder (RepoRoot=$RepoRoot)" }

$logDir = Join-Path $env:USERPROFILE ".hermes\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$taskName = "HermesMetricsForwarder"

function Start-ForwarderProcess {
  $env:METRICS_DASH_URL = $DashUrl
  $env:METRICS_HOST_LABEL = $HostLabel
  $outLog = Join-Path $logDir "metricsfwd.log"
  $errLog = Join-Path $logDir "metricsfwd.err.log"
  Start-Process -FilePath $python -ArgumentList "`"$forwarder`"" `
    -WorkingDirectory $RepoRoot -WindowStyle Hidden `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  Write-Host "Started forwarder host=$HostLabel -> $DashUrl"
}

if ($Install) {
  # Env vars via wrapper .cmd — New-ScheduledTaskEnvironmentVariable is not
  # available on all Windows builds.
  $wrapper = Join-Path $logDir "run-metricsfwd.cmd"
  @"
@echo off
set METRICS_DASH_URL=$DashUrl
set METRICS_HOST_LABEL=$HostLabel
"$python" "$forwarder"
"@ | Set-Content -Path $wrapper -Encoding ASCII
  $action = New-ScheduledTaskAction -Execute $wrapper
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  Write-Host "Installed scheduled task $taskName"
}

if ($Stop) {
  # Match only this install's forwarder path — not any python.exe that
  # happens to have "forwarder.py" on its command line.
  Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='python3.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($forwarder) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Write-Host "Stopped forwarder processes"
}

if ($Start -or (-not $Install -and -not $Stop -and -not $Start)) {
  Start-ForwarderProcess
}
