# Stop every part started by start-system.ps1 (windows titled "CWMR - ...").
# MySQL (UniServerZ) is left running.
#
#   powershell -ExecutionPolicy Bypass -File stop-system.ps1

$windows = Get-Process powershell -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle -like 'CWMR - *' }

foreach ($w in $windows) {
    Write-Host "  stopping $($w.MainWindowTitle)"
    # /T also ends what the window started (php, python, node, go2rtc).
    taskkill /PID $w.Id /T /F | Out-Null
}

# go2rtc can outlive its window when started through Git Bash.
Get-Process go2rtc -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

Write-Host "Stopped $(@($windows).Count) part(s)."
