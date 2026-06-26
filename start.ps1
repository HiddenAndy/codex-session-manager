$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $ProjectDir

$Host.UI.RawUI.WindowTitle = "Codex Session Manager"

$Port = if ($env:PORT) { $env:PORT } else { "4317" }
$Url = "http://127.0.0.1:$Port/"
$LogDir = Join-Path $ProjectDir "logs"
$LogFile = Join-Path $LogDir ("session-manager-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))

function Pause-And-Exit {
  param([int]$Code)
  Write-Host "Press Enter to exit."
  [void][Console]::ReadLine()
  exit $Code
}

function Open-ManagerUrl {
  param([string]$TargetUrl)
  try {
    Start-Process $TargetUrl | Out-Null
  } catch {
    Write-Host "Could not open the browser automatically. Open this URL manually: $TargetUrl"
  }
}

function Get-ListeningProcess {
  param([string]$TargetPort)
  try {
    return Get-NetTCPConnection -LocalPort ([int]$TargetPort) -State Listen -ErrorAction Stop |
      Select-Object -First 1
  } catch {
    return $null
  }
}

function Invoke-NpmCommand {
  param(
    [string[]]$Arguments,
    [string]$OutputLog = ""
  )

  $PreviousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    if ($OutputLog) {
      & npm @Arguments 2>&1 | Tee-Object -FilePath $OutputLog -Append | ForEach-Object {
        Write-Host $_
      }
    } else {
      & npm @Arguments 2>&1 | ForEach-Object {
        Write-Host $_
      }
    }
    if ($null -ne $LASTEXITCODE) {
      return $LASTEXITCODE
    }
    return 0
  } finally {
    $ErrorActionPreference = $PreviousErrorActionPreference
  }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js 20 or newer is required."
  Write-Host "Install it, then run this again: https://nodejs.org/"
  Pause-And-Exit 1
}

$NodeMajor = [int](& node -p "Number(process.versions.node.split('.')[0])")
if ($NodeMajor -lt 20) {
  Write-Host ("Current Node.js version: {0}" -f (& node -v))
  Write-Host "Node.js 20 or newer is required."
  Pause-And-Exit 1
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Host "Could not find the npm command. Check your Node.js installation."
  Pause-And-Exit 1
}

$NeedsInstall = -not (Test-Path -LiteralPath "node_modules" -PathType Container)
if (-not $NeedsInstall) {
  $NodeModules = Get-Item -LiteralPath "node_modules"
  $PackageJson = Get-Item -LiteralPath "package.json"
  $PackageLock = Get-Item -LiteralPath "package-lock.json" -ErrorAction SilentlyContinue
  $NeedsInstall = $PackageJson.LastWriteTime -gt $NodeModules.LastWriteTime
  if (-not $NeedsInstall -and $PackageLock) {
    $NeedsInstall = $PackageLock.LastWriteTime -gt $NodeModules.LastWriteTime
  }
}

if ($NeedsInstall) {
  Write-Host "Checking dependencies..."
  $InstallExitCode = Invoke-NpmCommand -Arguments @("install")
  if ($InstallExitCode -ne 0) {
    Write-Host "npm install failed."
    Pause-And-Exit $InstallExitCode
  }
}

$Connection = Get-ListeningProcess $Port
if ($Connection) {
  $RunningPid = $Connection.OwningProcess
  $RunningProcess = Get-Process -Id $RunningPid -ErrorAction SilentlyContinue
  Write-Host "Server is already running: $Url"
  if ($RunningProcess) {
    Write-Host ("Running process: {0} (PID {1})" -f $RunningProcess.ProcessName, $RunningPid)
  } else {
    Write-Host ("Running PID: {0}" -f $RunningPid)
  }
  Open-ManagerUrl $Url
  exit 0
}

Write-Host "Starting server: $Url"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Write-Host "Log file: $LogFile"

$BrowserJob = Start-Job -ScriptBlock {
  param([string]$TargetUrl)
  for ($i = 0; $i -lt 80; $i += 1) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $TargetUrl -TimeoutSec 2 | Out-Null
      Start-Process $TargetUrl | Out-Null
      return
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }
} -ArgumentList $Url

$env:CODEX_SESSION_MANAGER_AUTO_SHUTDOWN = "1"
$env:PORT = $Port

try {
  $ExitCode = Invoke-NpmCommand -Arguments @("start") -OutputLog $LogFile
} finally {
  if ($BrowserJob.State -eq "Running") {
    Stop-Job $BrowserJob -ErrorAction SilentlyContinue
  }
  Remove-Job $BrowserJob -Force -ErrorAction SilentlyContinue
}

Write-Host "Server stopped."
Write-Host "Log file: $LogFile"

if ($ExitCode -ne 0) {
  Write-Host "Server exited with an error. Check the log above."
  Pause-And-Exit $ExitCode
}

exit $ExitCode
