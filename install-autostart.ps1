# Start the system automatically when this Windows user signs in.
# Run once. To undo:  powershell -ExecutionPolicy Bypass -File install-autostart.ps1 -Remove
#
#   powershell -ExecutionPolicy Bypass -File install-autostart.ps1
#
# MySQL (UniServerZ) must also start on its own: in UniServerZ, turn on its
# "run at startup" option, or start it before signing in.

param([switch]$Remove)

$taskName = 'Coastal Waste Monitoring'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$start = Join-Path $root 'start-system.ps1'

if ($Remove) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removed the '$taskName' start-up task."
    exit 0
}

# Wait one minute after sign-in so MySQL and the network are up.
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File `"$start`"" `
    -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger.Delay = 'PT1M'
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
    -Description 'Starts the Coastal Waste Monitoring system (start-system.ps1) after sign-in.' -Force | Out-Null

Write-Host "Done. '$taskName' will start the system 1 minute after $env:USERNAME signs in."
