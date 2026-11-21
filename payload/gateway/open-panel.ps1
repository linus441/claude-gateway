# Open the control panel: make sure the tray app (and gateway) is up,
# then open an Edge app window. Called hidden. Does not stay in memory.

$ErrorActionPreference = 'SilentlyContinue'
$gw = $PSScriptRoot
if (-not $gw) { $gw = Split-Path -Parent $MyInvocation.MyCommand.Path }
$port = 15722
$url = "http://127.0.0.1:$port/admin"

function Test-Port([int]$p) {
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $c.BeginConnect('127.0.0.1', $p, $null, $null)
    if ($iar.AsyncWaitHandle.WaitOne(600) -and $c.Connected) { return $true }
    return $false
  } catch { return $false } finally { $c.Close() }
}

# user explicitly asked for the panel -> clear the "quit" flag
Remove-Item -LiteralPath "$gw\.tray-off" -Force -ErrorAction SilentlyContinue

if (-not (Test-Port $port)) {
  # start the tray app through its windowless .vbs launcher (ShellExecute, no console)
  if (Test-Path "$gw\tray-launch.vbs") {
    Start-Process -FilePath "$gw\tray-launch.vbs"
  }
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 400
    if (Test-Port $port) { break }
  }
}

$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
if (Test-Path $edge) {
  Start-Process -FilePath $edge -ArgumentList "--app=$url", "--window-size=920,760"
} else {
  Start-Process $url
}
