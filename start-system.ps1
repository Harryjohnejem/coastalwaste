# Start the Coastal Waste Monitoring system.
# Each part that is not already running opens in its own minimized window, so
# its log stays readable. Safe to run again: running parts are left alone.
#
#   powershell -ExecutionPolicy Bypass -File start-system.ps1
#
# MySQL (UniServerZ) must be running first.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$api = Join-Path $root 'api'
$web = Join-Path $root 'web'
$detector = Join-Path $root 'detector'
$gateway = Join-Path $root 'gateway'
$bash = 'C:\Program Files\Git\bin\bash.exe'

function Test-Port([int]$Port) {
    return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Test-Command([string]$Pattern) {
    return [bool](Get-CimInstance Win32_Process -Filter "Name='php.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*$Pattern*" })
}

function Start-Part([string]$Title, [string]$Dir, [string]$Command) {
    Write-Host "  starting $Title"
    $script = "`$Host.UI.RawUI.WindowTitle = 'CWMR - $Title'; Set-Location '$Dir'; $Command"
    Start-Process powershell -WindowStyle Minimized -ArgumentList @('-NoExit', '-NoProfile', '-Command', $script) | Out-Null
}

Write-Host 'Coastal Waste Monitoring - starting'

if (-not (Test-Port 3306)) {
    Write-Warning 'MySQL is not running on port 3306. Start UniServerZ first, then run this again.'
    exit 1
}

# 1. Video gateway (go2rtc) - reads the camera logins from gateway\.env
if (Test-Port 1990) { Write-Host '  go2rtc already running' }
elseif (Test-Path $bash) { Start-Part 'Video gateway (go2rtc)' $gateway "& '$bash' ./start.sh" }
else { Write-Warning 'Git Bash not found; start gateway\start.sh by hand.' }

# 2. API for the web dashboard
if (Test-Port 8000) { Write-Host '  API :8000 already running' }
else { Start-Part 'API 8000 (web)' $api 'php artisan serve --host=127.0.0.1 --port=8000' }

# 3. API for the detector (keeps camera frames off the web API)
if (Test-Port 8001) { Write-Host '  API :8001 already running' }
else { Start-Part 'API 8001 (detector)' $api 'php artisan serve --host=127.0.0.1 --port=8001 --no-reload' }

# 4. Queue worker (Roboflow training steps)
if (Test-Command 'queue:') { Write-Host '  queue worker already running' }
else { Start-Part 'Queue worker' $api 'php artisan queue:work --tries=1 --timeout=0' }

# 5. Scheduler (daily database backup, weekly image backup)
if (Test-Command 'schedule:work') { Write-Host '  scheduler already running' }
else { Start-Part 'Scheduler (backups)' $api 'php artisan schedule:work' }

# 6. Detector (YOLO on the live cameras) - wait for go2rtc and the API first
Start-Sleep -Seconds 3
if (Test-Port 8092) { Write-Host '  detector already running' }
else { Start-Part 'Detector' $detector 'python app.py' }

# 7. Web dashboard
if (Test-Port 5173) { Write-Host '  web :5173 already running' }
else { Start-Part 'Web dashboard' $web 'npm run dev' }

Write-Host ''
Write-Host 'Done. Open http://127.0.0.1:5173 in the browser.'
Write-Host 'Windows titled "CWMR - ..." hold each part''s log. stop-system.ps1 closes them.'
