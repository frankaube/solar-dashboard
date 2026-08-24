# Install Solar Dashboard as a Windows service using WinSW.
# 1. Download WinSW-x64.exe from https://github.com/winsw/winsw/releases
#    and place it in this folder as SolarDashboardService.exe
# 2. Run this script as Administrator.
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$wrapper = Join-Path $here "SolarDashboardService.exe"
if (-not (Test-Path $wrapper)) {
    Write-Error "Place WinSW-x64.exe here as SolarDashboardService.exe first (see comment at top)."
}
& $wrapper install
& $wrapper start
Write-Host "Service installed and started. Dashboard: http://localhost:3001"
