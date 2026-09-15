<#
  phone-bridge / start-phone-access.ps1

  One click to make the DSH Web GUI usable from a phone on the same Wi-Fi:

    1. make sure a dsh web instance is running and capture its startup token
    2. start phone-gateway (0.0.0.0:3081 -> 127.0.0.1:3080) which rewrites the
       Host/Origin headers DSH's browser-trust fence expects
    3. print + render a QR code for the phone entry, which always hands out the
       current token, so the phone never has to know it

  ASCII only on purpose: Windows PowerShell 5.1 decodes a BOM-less .ps1 as ANSI,
  which corrupts non-ASCII text and breaks parsing. Console output stays ASCII
  too, because that same console mangles non-ASCII.

  Files it owns (all under $DSH_HOME):
    dsh-web-out.log      dsh web stdout (token source)
    dsh-web-err.log      dsh web stderr
    phone-gateway.log    gateway log
    dsh-web-token.txt    latest captured token
    phone-key.txt        pairing key (?k=...) for the phone entry
    phone-qr.png         QR image for the phone entry
#>
param(
  [int]$WebPort = 3080,
  [int]$GatewayPort = 3081,
  [switch]$NoRestart,
  [switch]$NoBrowser,
  [switch]$NoQr
)

$ErrorActionPreference = 'Continue'

# --- portable path resolution (no machine-specific literals) ---------------
# DSH home: explicit env var, else ~/.dsh
if ($env:DSH_HOME) { $dshHome = $env:DSH_HOME } else { $dshHome = Join-Path $env:USERPROFILE '.dsh' }

# node: explicit env var, else whatever is on PATH
if ($env:NODE_EXE) { $nodeExe = $env:NODE_EXE } else {
  $nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($nodeCmd) { $nodeExe = $nodeCmd.Source } else { $nodeExe = $null }
}
if (-not $nodeExe) { throw 'node.exe not found on PATH; set NODE_EXE to its full path' }

# dsh CLI entry: explicit env var, else `dsh` on PATH, else search the npx cache
if ($env:DSH_BIN) { $dshBin = $env:DSH_BIN } else {
  $dshBin = $null
  $dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
  if ($dshCmd) { $dshBin = $dshCmd.Source }
  if (-not $dshBin) {
    foreach ($cacheRoot in @((Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'), (Join-Path $env:APPDATA 'npm-cache\_npx'))) {
      if (-not (Test-Path $cacheRoot)) { continue }
      $hit = Get-ChildItem -Path $cacheRoot -Recurse -Depth 4 -Filter 'bin.js' -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -like '*@deepseek-ai\dsh\lib\bin.js' } |
        Select-Object -First 1
      if ($hit) { $dshBin = $hit.FullName; break }
    }
  }
}

# bridge directory: explicit env var, else next to this script, else <dshHome>\tools
if ($env:DSH_BRIDGE_DIR) { $bridgeDir = $env:DSH_BRIDGE_DIR }
elseif (Test-Path (Join-Path $PSScriptRoot 'phone-gateway.mjs')) { $bridgeDir = $PSScriptRoot }
else { $bridgeDir = Join-Path $dshHome 'tools' }
$gatewayJs = Join-Path $bridgeDir 'phone-gateway.mjs'

$webLog = Join-Path $dshHome 'dsh-web-out.log'
$webErrLog = Join-Path $dshHome 'dsh-web-err.log'
$gwLog = Join-Path $dshHome 'phone-gateway.log'
$gwErrLog = Join-Path $dshHome 'phone-gateway-err.log'
$tokenFile = Join-Path $dshHome 'dsh-web-token.txt'
$keyFile = Join-Path $dshHome 'phone-key.txt'
$qrPng = Join-Path $dshHome 'phone-qr.png'

function Say([string]$m) { Write-Host ('[phone] ' + $m) }

function Test-Port([int]$p) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $client.Connect('127.0.0.1', $p)
    $client.Close()
    return $true
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

# Who is really listening on a port. "The port answers TCP" proves nothing about
# WHAT is listening -- an unrelated system service can hold it. Always resolve the
# owning PID and its command line before concluding "my service is already running".
function Get-PortOwnerPid([int]$p) {
  try {
    $conn = Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction Stop | Select-Object -First 1
    if ($conn -and $conn.OwningProcess) { return [int]$conn.OwningProcess }
  } catch { }
  return 0
}

function Get-ProcessCommandLine([int]$processId) {
  if ($processId -le 0) { return '' }
  try {
    $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $processId) -ErrorAction Stop
    if ($p) { return [string]$p.CommandLine }
  } catch { }
  return ''
}

function Get-LanIp {
  $found = @()
  $wlan = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.InterfaceAlias -like 'WLAN*' -and $_.IPAddress -notlike '169.254.*' }
  foreach ($a in $wlan) { if ($found -notcontains $a.IPAddress) { $found += $a.IPAddress } }

  $routed = Get-NetIPConfiguration -ErrorAction SilentlyContinue |
    Where-Object { $_.IPv4DefaultGateway -ne $null }
  foreach ($cfg in $routed) {
    $ip = $cfg.IPv4Address.IPAddress
    if ($ip -and $ip -notlike '169.254.*' -and $found -notcontains $ip) { $found += $ip }
  }

  if ($found.Count -gt 0) { return $found[0] }
  return ''
}

function Ensure-Key {
  if (Test-Path $keyFile) {
    $existing = (Get-Content $keyFile -Raw).Trim()
    if ($existing.Length -ge 8) { return $existing }
  }
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $bytes = New-Object byte[] 24
  $rng.GetBytes($bytes)
  $fresh = ([Convert]::ToBase64String($bytes) -replace '[^a-zA-Z0-9]', '')
  if ($fresh.Length -gt 24) { $fresh = $fresh.Substring(0, 24) }
  [System.IO.File]::WriteAllText($keyFile, $fresh)
  Say ('generated a new pairing key: ' + $keyFile)
  return $fresh
}

function Read-TokenFile {
  if (-not (Test-Path $tokenFile)) { return '' }
  return (Get-Content $tokenFile -Raw).Trim()
}

function Save-Token([string]$value) {
  [System.IO.File]::WriteAllText($tokenFile, $value)
}

function Read-TokenFromLog {
  if (-not (Test-Path $webLog)) { return '' }
  $content = Get-Content $webLog -Raw -ErrorAction SilentlyContinue
  if (-not $content) { return '' }
  $match = [regex]::Match($content, 'token=([A-Za-z0-9_\-]+)')
  if ($match.Success) { return $match.Groups[1].Value }
  return ''
}

# Ask dsh web whether this token still works: exchange it, then call one
# authenticated API with the resulting cookie.
function Test-DshToken([string]$value) {
  if (-not $value) { return $false }
  try {
    $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
    $null = Invoke-WebRequest -Uri ("http://127.0.0.1:$WebPort/?token=$value") `
      -UseBasicParsing -WebSession $session -TimeoutSec 10 -ErrorAction Stop
    $probe = Invoke-WebRequest -Uri ("http://127.0.0.1:$WebPort/api/session/list") `
      -Method POST -Body '{}' -ContentType 'application/json' `
      -UseBasicParsing -WebSession $session -TimeoutSec 10 -ErrorAction Stop
    return ($probe.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Stop-DshWeb {
  $listeners = Get-NetTCPConnection -State Listen -LocalPort $WebPort -ErrorAction SilentlyContinue
  $targets = @()
  foreach ($entry in $listeners) {
    if ($targets -notcontains $entry.OwningProcess) { $targets += $entry.OwningProcess }
  }
  foreach ($processId in $targets) {
    try {
      Stop-Process -Id $processId -Force -ErrorAction Stop
      Say ('stopped dsh web pid ' + $processId)
    } catch {
      Say ('could not stop pid ' + $processId + ': ' + $_.Exception.Message)
    }
  }

  # stdio MCP children of the hosts we just killed become orphans; clear THOSE ONLY so
  # the new host owns fresh ones.
  #
  # SAFETY: this must never be a name-pattern sweep over every node.exe on the machine.
  # Doing that also kills the harness process itself and its background job runner, and
  # that loss is unrecoverable from inside a session -- see
  # lessons/03-sandbox-stdio-limits.md section 3 in the published playbook.
  # We therefore scope the sweep to children whose ParentProcessId is one of the PIDs we
  # actually stopped (Windows keeps the original PPID even after the parent exits).
  foreach ($parentPid in $targets) {
    $children = @()
    try {
      $children = @(Get-CimInstance Win32_Process -Filter ('ParentProcessId=' + $parentPid) -ErrorAction SilentlyContinue)
    } catch { }
    foreach ($child in $children) {
      $commandLine = $child.CommandLine
      if (-not $commandLine) { continue }
      if ($commandLine -notmatch 'mcp\.mjs|@playwright/mcp|playwright\\mcp') { continue }
      try {
        Stop-Process -Id $child.ProcessId -Force -ErrorAction Stop
        Say ('stopped orphaned bridge process pid ' + $child.ProcessId)
      } catch { }
    }
  }

  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    if (-not (Test-Port $WebPort)) { break }
  }
}

function Start-DshWeb {
  Remove-Item $webLog -ErrorAction SilentlyContinue
  Remove-Item $webErrLog -ErrorAction SilentlyContinue

  # Always launch without the browser handoff: this script opens the local GUI
  # itself at the end, in one place - so a *reused* already-running instance
  # opens it too (that was the bug: the shortcut only produced a QR code).
  $arguments = @($dshBin, '--profile', 'web', '--port', $WebPort, '--no-open')

  Start-Process -FilePath $nodeExe -ArgumentList $arguments `
    -RedirectStandardOutput $webLog -RedirectStandardError $webErrLog `
    -WindowStyle Hidden | Out-Null
  Say ('starting dsh web on port ' + $WebPort + ' (log: ' + $webLog + ')')

  for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Seconds 1
    $captured = Read-TokenFromLog
    if ($captured -and (Test-Port $WebPort)) {
      Save-Token $captured
      Say 'captured dsh web startup token'
      return $captured
    }
  }
  return ''
}

function Start-Gateway {
  if (Test-Port $GatewayPort) {
    $owner = Get-PortOwnerPid $GatewayPort
    if ($owner -eq 0) {
      # Cannot resolve the owner on this system: fall back to the permissive behaviour
      # but say so, rather than silently claiming everything is fine.
      Say ('gateway already listening on port ' + $GatewayPort + ' (owner could not be verified; assuming it is ours)')
      return
    }
    $ownerCmd = Get-ProcessCommandLine $owner
    if ($ownerCmd -and ($ownerCmd -like '*phone-gateway*')) {
      Say ('gateway already listening on port ' + $GatewayPort + ' (pid ' + $owner + ')')
      return
    }
    # The port answers TCP but it is NOT our gateway. Reporting "already running" here
    # would be a false positive -- exactly the trap described in
    # lessons/09-godot-automation.md section 3. Refuse and explain instead.
    Say ('PORT CONFLICT: ' + $GatewayPort + ' is held by pid ' + $owner + ', which is not the gateway')
    if ($ownerCmd) {
      Say ('  command line: ' + $ownerCmd)
    } else {
      Say '  (its command line could not be read; treat this as a conflict anyway)'
    }
    Say ('  free that port, or re-run with -GatewayPort <other port>')
    throw ('gateway port ' + $GatewayPort + ' is occupied by another process (pid ' + $owner + ')')
  }
  Remove-Item $gwLog -ErrorAction SilentlyContinue
  Remove-Item $gwErrLog -ErrorAction SilentlyContinue

  $env:PHONE_GATEWAY_PORT = [string]$GatewayPort
  $env:PHONE_GATEWAY_TARGET_PORT = [string]$WebPort
  $env:PHONE_GATEWAY_TOKEN_FILE = $tokenFile
  $env:PHONE_GATEWAY_KEY_FILE = $keyFile

  Start-Process -FilePath $nodeExe -ArgumentList @($gatewayJs) `
    -WorkingDirectory $bridgeDir `
    -RedirectStandardOutput $gwLog -RedirectStandardError $gwErrLog `
    -WindowStyle Hidden | Out-Null

  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Port $GatewayPort) { break }
  }
  if (Test-Port $GatewayPort) {
    Say ('gateway listening on port ' + $GatewayPort + ' (log: ' + $gwLog + ')')
  } else {
    Say ('gateway FAILED to start - see ' + $gwErrLog)
  }
}

function Show-Qr([string]$url) {
  if ($NoQr) { return }
  $snippet = "const qr=require('qrcode');qr.toFile(process.argv[1],process.argv[2],{width:520,margin:2})" +
    ".then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})"
  Push-Location $bridgeDir
  try {
    $null = & $nodeExe -e $snippet $qrPng $url 2>&1
  } finally {
    Pop-Location
  }
  if (Test-Path $qrPng) {
    Say ('QR image: ' + $qrPng)
    Start-Process $qrPng
  } else {
    Say 'QR generation failed (the printed URL still works)'
  }
}

# ---------------------------------------------------------------- main

Write-Host ''
Write-Host '=== DSH phone access ===' -ForegroundColor Cyan

$key = Ensure-Key
$token = ''

if (Test-Port $WebPort) {
  $token = Read-TokenFile
  if (Test-DshToken $token) {
    Say 'existing dsh web instance accepted its captured token - reusing it'
  } else {
    if ($NoRestart) {
      Say 'WARNING: dsh web is running but its token is unknown or expired.'
      Say '         Run this script again without -NoRestart to restart dsh web,'
      Say '         otherwise the phone entry cannot authenticate.'
    } else {
      Write-Host ''
      Write-Host 'dsh web is running, but its startup token is unknown or expired.' -ForegroundColor Yellow
      Write-Host 'The phone entry needs that token, so dsh web must restart.' -ForegroundColor Yellow
      Write-Host 'Press Ctrl+C to abort, otherwise restarting in 5 seconds...' -ForegroundColor Yellow
      for ($i = 5; $i -gt 0; $i--) {
        Write-Host ("  restarting in $i ...")
        Start-Sleep -Seconds 1
      }
      Stop-DshWeb
      $token = Start-DshWeb
    }
  }
} else {
  $token = Start-DshWeb
}

if (-not $token) {
  Say 'WARNING: no dsh web token captured - the phone entry will fall back to /'
}

Start-Gateway

$lanIp = Get-LanIp
$phoneUrl = ''
if ($lanIp) { $phoneUrl = "http://${lanIp}:${GatewayPort}/phone?k=${key}" }

Write-Host ''
if ($phoneUrl) {
  Write-Host 'Phone entry (scan the QR, or type this on the phone):' -ForegroundColor Green
  Write-Host ('  ' + $phoneUrl)
} else {
  Write-Host 'No LAN IPv4 address found - connect the PC to Wi-Fi first.' -ForegroundColor Yellow
}
Write-Host ''
Write-Host 'On this PC:'
Write-Host ("  http://127.0.0.1:${WebPort}/")

# The desktop shortcut doubles as the "open DSH on this PC" entry point, so the
# local GUI always comes up - including when we reused a running instance.
if (-not $NoBrowser) {
  $localUrl = "http://127.0.0.1:${WebPort}/"
  if ($token) { $localUrl = "http://127.0.0.1:${WebPort}/?token=${token}" }
  Start-Process $localUrl
  Say 'opened the local DSH GUI in the default browser'
}

Write-Host ''
Write-Host 'Notes:'
Write-Host '  - The phone must be on the same Wi-Fi as this PC.'
Write-Host '  - The /phone entry always hands out the current token, so the phone'
Write-Host '    keeps working across DSH restarts; just reopen the home-screen icon.'
Write-Host '  - Add to home screen once, and it behaves like a fullscreen app.'
Write-Host ''

Show-Qr $phoneUrl

# ---------------------------------------------------------------- self check
# Evidence for later inspection: runs right after the gateway is up.
Write-Host ''
Write-Host '--- self check ---'
$results = @()
$results += ('dsh web listening on ' + $WebPort + ': ' + (Test-Port $WebPort))
$results += ('gateway listening on ' + $GatewayPort + ': ' + (Test-Port $GatewayPort))
$results += ('token captured: ' + [bool]$token)
$results += ('token accepted by dsh web: ' + (Test-DshToken $token))
if ($lanIp) {
  $probeUrl = "http://${lanIp}:${GatewayPort}/phone?k=${key}"
  $probeReq = [System.Net.HttpWebRequest]::Create($probeUrl)
  $probeReq.AllowAutoRedirect = $false
  $probeReq.Timeout = 10000
  $probeResp = $null
  try {
    $probeResp = $probeReq.GetResponse()
  } catch [System.Net.WebException] {
    $probeResp = $_.Exception.Response
  }
  if ($probeResp) {
    $probeCode = [int]$probeResp.StatusCode
    $probeTo = $probeResp.Headers['Location']
    $results += ('phone entry via LAN: HTTP ' + $probeCode + ' -> ' + $probeTo + '  (302 = fresh token handed out)')
    $probeResp.Close()
  } else {
    $results += 'phone entry via LAN: FAILED (no response)'
  }
  try {
    $denied = Invoke-WebRequest -Uri ("http://${lanIp}:${GatewayPort}/") -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 10 -ErrorAction Stop
    $results += ('unpaired access to /: HTTP ' + $denied.StatusCode)
  } catch {
    $resp2 = $_.Exception.Response
    if ($resp2) { $results += ('unpaired access to /: HTTP ' + [int]$resp2.StatusCode + ' (403 expected)') }
    else { $results += ('unpaired access to /: FAILED - ' + $_.Exception.Message) }
  }
} else {
  $results += 'phone entry via LAN: SKIPPED (no LAN IP)'
}
$whaleVersion = 'unknown'
try { $whaleVersion = (Get-Content (Join-Path $dshHome 'profiles\web\node_modules\dsh-whale-widget\package.json') -Raw | ConvertFrom-Json).version } catch { }
$results += ('whale widget version on disk: ' + $whaleVersion)
$results | ForEach-Object { Write-Host ('  ' + $_) }
Write-Host '--- end self check ---'