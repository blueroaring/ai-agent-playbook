# install-scheduled-task.ps1 -- install / remove / run the periodic publish task.
#
# ASCIi ONLY ON PURPOSE: Windows PowerShell 5.1 decodes a BOM-less .ps1 as ANSI,
# which corrupts non-ASCII text and breaks parsing.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\install-scheduled-task.ps1
#   powershell ... -IntervalDays 2
#   powershell ... -RunNow
#   powershell ... -Remove
#
# Verification matters more than installation here: a registered task with
# LastTaskResult = 0 proves nothing (a script that never ran also exits 0).
# Always confirm by looking for NEW LINES in .local\publish.log afterwards.

param(
    [string]$TaskName = 'AI-Agent-Playbook-Publish',
    [int]$IntervalDays = 3,
    [string]$At = '10:00',
    [switch]$RunNow,
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$ToolsDir = $PSScriptRoot
$RepoRoot = Split-Path -Parent $ToolsDir
$PublishScript = Join-Path $ToolsDir 'publish.ps1'
$LogFile = Join-Path $RepoRoot '.local\publish.log'

if ($Remove) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $existing) { Write-Host ("task not found: " + $TaskName); exit 0 }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host ("removed scheduled task: " + $TaskName)
    exit 0
}

if (-not (Test-Path -LiteralPath $PublishScript)) { throw ("publish.ps1 not found at " + $PublishScript) }
if ($IntervalDays -lt 1 -or $IntervalDays -gt 365) { throw 'IntervalDays must be 1..365' }

$powerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $powerShellExe)) { $powerShellExe = 'powershell.exe' }

$action = New-ScheduledTaskAction -Execute $powerShellExe `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -File "' + $PublishScript + '"') `
    -WorkingDirectory $RepoRoot

$trigger = New-ScheduledTaskTrigger -Daily -DaysInterval $IntervalDays -At $At

# StartWhenAvailable: if the machine was off at the scheduled moment, run on next boot.
# That is the whole point of "every few days" -- it must not silently skip.
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -MultipleInstances IgnoreNew

# Run as the current user, interactive logon: no stored password, and the task can
# read the user's credential file. It only runs while the user is logged on, which
# is acceptable for a desktop publishing job (StartWhenAvailable covers catch-up).
$principal = New-ScheduledTaskPrincipal -UserId ($env:USERDOMAIN + '\' + $env:USERNAME) `
    -LogonType Interactive -RunLevel Limited

Write-Host ("registering task: " + $TaskName)
Write-Host ("  action : " + $powerShellExe)
Write-Host ("  script : " + $PublishScript)
Write-Host ("  trigger: daily, every " + $IntervalDays + " day(s), at " + $At)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null

$task = Get-ScheduledTask -TaskName $TaskName
Write-Host ("registered. state = " + $task.State)

if ($RunNow) {
    Write-Host 'running the task once to verify it actually executes...'
    $before = $null
    if (Test-Path -LiteralPath $LogFile) { $before = (Get-Item -LiteralPath $LogFile).Length }

    Start-ScheduledTask -TaskName $TaskName
    # Wait for it to settle, then look for evidence in the log.
    $deadline = (Get-Date).AddMinutes(5)
    $grew = $false
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 3
        if (Test-Path -LiteralPath $LogFile) {
            $now = (Get-Item -LiteralPath $LogFile).Length
            if ($before -eq $null -or $now -gt $before) { $grew = $true; break }
        }
    }

    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Host ("  LastRunTime   : " + $info.LastRunTime)
    Write-Host ("  LastTaskResult: " + $info.LastTaskResult)

    if ($grew) {
        Write-Host '  EVIDENCE: publish.log grew -> the script really executed. OK.'
        Write-Host ''
        Write-Host '  tail of publish.log:'
        Get-Content -LiteralPath $LogFile -Tail 12 | ForEach-Object { Write-Host ('    ' + $_) }
    } else {
        Write-Host '  NO EVIDENCE: publish.log did not grow.'
        Write-Host '  LastTaskResult = 0 does NOT mean the script ran -- a silent no-op also exits 0.'
        Write-Host '  Check: the script path, the execution policy, and any security software'
        Write-Host '  that silently kills scripted processes. See lessons/02 section 5.'
        exit 1
    }
}

Write-Host ''
Write-Host 'Next steps:'
Write-Host ('  Get-ScheduledTaskInfo -TaskName ' + $TaskName)
Write-Host ('  Get-Content "' + $LogFile + '" -Tail 20')
