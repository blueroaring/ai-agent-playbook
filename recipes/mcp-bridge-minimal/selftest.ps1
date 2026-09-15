# selftest.ps1 -- self test for the minimal MCP bridge template.
#
# Usage:   powershell -NoProfile -ExecutionPolicy Bypass -File selftest.ps1
# Output:  _selftest.out.txt / _selftest.err.txt
#
# NOTE: This file is deliberately PURE ASCII.
#   Windows PowerShell 5.1 decodes .ps1 files WITHOUT a BOM using the system ANSI
#   code page (GBK/936 on Chinese Windows), NOT UTF-8. A UTF-8-without-BOM script
#   containing non-ASCII text gets mis-decoded at PARSE time and breaks in ways
#   that look like random syntax errors -- which is exactly what happened when
#   this file was first written with Chinese messages.
#   See lessons/02-windows-powershell51.md section 1. Keep .ps1 ASCII, or save
#   it as UTF-8 WITH BOM.
#
# It also demonstrates two encoding traps on purpose:
#   (a) $OutputEncoding controls the bytes PowerShell writes to a NATIVE program
#       through a pipe. Its default is not UTF-8, so non-ASCII input becomes
#       mojibake. We set it explicitly below. (lessons/02 section 7)
#   (b) Set-Content -Encoding utf8 writes a BOM on PowerShell 5.1, which breaks
#       downstream JSON parsers. We use the .NET API with an explicit no-BOM
#       encoder instead. (lessons/02 section 2)

$ErrorActionPreference = 'Stop'
$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$server = Join-Path $here 'server.mjs'
$input_ = Join-Path $here 'selftest.jsonl'
$outFile = Join-Path $here '_selftest.out.txt'
$errFile = Join-Path $here '_selftest.err.txt'

if (-not (Test-Path $server)) { throw "server.mjs not found at $server" }
if (-not (Test-Path $input_)) { throw "selftest.jsonl not found at $input_" }

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom

# Trap (c): with $ErrorActionPreference = 'Stop', ANY write to stderr by a native
# program becomes a TERMINATING error (NativeCommandError). Our server legitimately
# logs to stderr, so we relax the preference just for this call.
# See lessons/02-windows-powershell51.md section 8.
$savedEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$stdout = Get-Content -Encoding UTF8 $input_ | & node $server 2> $errFile
$exit = $LASTEXITCODE
$ErrorActionPreference = $savedEap

$text = ($stdout -join "`n") + "`n"
[System.IO.File]::WriteAllText($outFile, $text, $utf8NoBom)

# Assertions must check PROTOCOL SEMANTICS, not just "no error was printed".
# See lessons/01-verification-discipline.md
$responses = @($stdout | Where-Object { $_ -match '^\s*\{' } | ForEach-Object { $_ | ConvertFrom-Json })
$byId = @{}
foreach ($r in $responses) { $byId[[string]$r.id] = $r }

$script:fail = @()
function Check {
    param([string]$Name, [bool]$Cond)
    if ($Cond) { Write-Output ("  [PASS] " + $Name) }
    else { Write-Output ("  [FAIL] " + $Name); $script:fail += $Name }
}

$echoText = $null
if ($byId['3']) { $echoText = $byId['3'].result.content[0].text }

Check 'exit code is 0'                          ($exit -eq 0)
Check 'id=1 initialize returns serverInfo'      ($byId['1'].result.serverInfo.name -eq 'minimal')
Check 'id=2 tools/list returns 3 tools'         ($byId['2'].result.tools.Count -eq 3)
Check 'id=3 echo round-trips non-ASCII input'   ($echoText -eq ("echo: " + [char]0x4F60 + [char]0x597D))
Check 'id=4 no confirm -> rejected (isError)'   ($byId['4'].result.isError -eq $true)
Check 'id=5 with confirm -> success'            ($byId['5'].result.isError -ne $true)
Check 'id=6 unknown tool -> JSON-RPC error'     ($byId['6'].error.code -eq -32602)
Check 'id=7 bad arg type -> isError'            ($byId['7'].result.isError -eq $true)
$errRaw = Get-Content -Raw $errFile
Check 'stderr carries no JSON (no pollution)'   (-not ($errRaw -match '"jsonrpc"'))
Check 'stdout carries 7 JSON-RPC responses'     ($responses.Count -eq 7)

Write-Output ''
Write-Output ("stdout -> " + $outFile)
Write-Output ("stderr -> " + $errFile)
if ($script:fail.Count -gt 0) {
    Write-Output ("FAILED: " + ($script:fail -join ' | '))
    exit 1
}
Write-Output 'ALL CHECKS PASSED'
exit 0
