<#
  show-phone-qr.ps1 -- desktop-shortcut target: show the phone entry QR code.

  What it does, in order:
    1. if the phone channel is not ready (no dsh web / no gateway / no token),
       it runs start-phone-access.ps1 -NoQr first, so the QR is never useless
    2. recompute the LAN address (it changes when you switch Wi-Fi)
    3. render the QR image and open it with the default viewer

  It deliberately does NOT ask DSH to restart unless the channel is unusable.

  ASCII only: Windows PowerShell 5.1 decodes a BOM-less .ps1 as ANSI, which
  corrupts non-ASCII text and breaks parsing. Console output stays ASCII too.

  Files: phone-qr.png (latest), phone-qr-new.png (staging, avoids viewer locks),
         phone-qr.log
#>
param(
  [switch]$NoOpen,
  [int]$WebPort = 3080,
  [int]$GatewayPort = 3081
)

$ErrorActionPreference = 'Continue'

# --- portable path resolution (no machine-specific literals) ---------------
if ($env:DSH_HOME) { $dshHome = $env:DSH_HOME } else { $dshHome = Join-Path $env:USERPROFILE '.dsh' }

if ($env:NODE_EXE) { $nodeExe = $env:NODE_EXE } else {
  $nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($nodeCmd) { $nodeExe = $nodeCmd.Source } else { $nodeExe = $null }
}
if (-not $nodeExe) { throw 'node.exe not found on PATH; set NODE_EXE to its full path' }

# gateway dir: explicit env var, else next to this script, else <dshHome>\tools
if ($env:DSH_BRIDGE_DIR) { $bridgeDir = $env:DSH_BRIDGE_DIR }
elseif (Test-Path (Join-Path $PSScriptRoot 'phone-gateway.mjs')) { $bridgeDir = $PSScriptRoot }
else { $bridgeDir = Join-Path $dshHome 'tools' }
$gatewayJs = Join-Path $bridgeDir 'phone-gateway.mjs'
$launcher = Join-Path $dshHome 'start-phone-access.ps1'

$keyFile = Join-Path $dshHome 'phone-key.txt'
$tokenFile = Join-Path $dshHome 'dsh-web-token.txt'
$qrFinal = Join-Path $dshHome 'phone-qr.png'
$qrStage = Join-Path $dshHome 'phone-qr-new.png'
$qrLog = Join-Path $dshHome 'phone-qr.log'
$gwLog = Join-Path $dshHome 'phone-gateway.log'
$gwErrLog = Join-Path $dshHome 'phone-gateway-err.log'

function Say([string]$m) {
  $line = '[qr] ' + $m
  Write-Host $line
  Add-Content -LiteralPath $qrLog -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $m)
}

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

function Stop-WithMessage([string]$message) {
  Write-Host ''
  Write-Host ('[qr] ' + $message) -ForegroundColor Yellow
  Write-Host '[qr] press Enter to close this window...'
  [void](Read-Host)
  exit 1
}

Write-Host ''
Write-Host '=== DSH phone QR ===' -ForegroundColor Cyan

# ---- 1. make sure the channel is usable -------------------------------------
$channelReady = (Test-Port $WebPort) -and (Test-Port $GatewayPort) -and (Test-Path $tokenFile)
if (-not $channelReady) {
  Say 'phone channel is not ready yet - preparing it (this may take a moment)'
  if (-not (Test-Path $launcher)) {
    Stop-WithMessage ('missing launcher: ' + $launcher)
  }
  & $launcher -NoQr -NoBrowser
} else {
  Say 'phone channel already running - reusing it'
}

if (-not (Test-Path $keyFile)) {
  Stop-WithMessage ('pairing key missing: ' + $keyFile + ' (run the DSH phone launcher once)')
}
$key = (Get-Content $keyFile -Raw).Trim()

# ---- 2. address --------------------------------------------------------------
$lanIp = Get-LanIp
if (-not $lanIp) {
  Stop-WithMessage 'no LAN IPv4 address found - connect this PC to Wi-Fi first'
}
$url = "http://${lanIp}:${GatewayPort}/phone?k=${key}"
Say ('phone entry: ' + $url)

# ---- 3. render the QR --------------------------------------------------------
$snippet = "const qr=require('qrcode');qr.toFile(process.argv[1],process.argv[2],{width:560,margin:2})" +
  ".then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})"

Remove-Item $qrStage -ErrorAction SilentlyContinue
Push-Location $bridgeDir
try {
  $output = & $nodeExe -e $snippet $qrStage $url 2>&1
} finally {
  Pop-Location
}

if (-not (Test-Path $qrStage)) {
  Stop-WithMessage ('QR generation failed: ' + ($output -join ' | '))
}
Say ('QR rendered: ' + (Get-Item $qrStage).Length + ' bytes')

# prefer the stable name; if a viewer holds it open, show the staging copy
$toShow = $qrStage
try {
  Copy-Item $qrStage $qrFinal -Force -ErrorAction Stop
  $toShow = $qrFinal
} catch {
  Say 'phone-qr.png is locked by an open viewer - showing the staging copy instead'
}

if (-not $NoOpen) {
  Start-Process $toShow
  Say ('opened: ' + $toShow)
}

Write-Host ''
Write-Host 'Scan this with the phone (same Wi-Fi), then Add to home screen.' -ForegroundColor Green
Write-Host ('  ' + $url)
Write-Host ''
Say ('dsh web: ' + (Test-Port $WebPort) + ' | gateway: ' + (Test-Port $GatewayPort) + ' | key file: ' + (Test-Path $keyFile))
