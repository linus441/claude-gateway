# Claude 网关托盘程序
# 作用：以无窗口方式守护网关，右下角托盘图标提供右键菜单
#   点面板窗口的叉 = 只是关掉面板，程序仍在托盘运行
#   托盘菜单「退出」= 真正关闭（写 .tray-off 标记并结束网关）
# 启动方式：tray-launch.vbs（wscript 隐藏窗口）→ 本脚本
# 注意：本文件必须是 UTF-8 带 BOM，否则 PowerShell 5.1 会把中文读成乱码

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ROOT = $PSScriptRoot
if (-not $ROOT) { $ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path }
$NODE = Join-Path $ROOT 'node.exe'
$GWJS = Join-Path $ROOT 'gateway.js'
$TLOG = Join-Path $ROOT 'tray.log'
$FLAG = Join-Path $ROOT '.tray-off'
$PORT = 15722

function Log-Tray([string]$m) {
  try {
    if ((Test-Path -LiteralPath $TLOG) -and ((Get-Item -LiteralPath $TLOG).Length -gt 1048576)) {
      Move-Item -LiteralPath $TLOG -Destination ($TLOG + '.1') -Force
    }
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m" | Add-Content -LiteralPath $TLOG -Encoding UTF8
  } catch { }
}

# 用户点过「退出」就不要自己回来（计划任务每 2 分钟会调一次本脚本）
if (Test-Path -LiteralPath $FLAG) { Log-Tray 'flag .tray-off 存在，托盘不启动'; exit 0 }

# 单实例
$created = $false
$script:MTX = [System.Threading.Mutex]::new($true, 'Local\ClaudeGatewayTray', [ref]$created)
if (-not $created) { exit 0 }

function Test-Port([int]$p) {
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $c.BeginConnect('127.0.0.1', $p, $null, $null)
    if ($iar.AsyncWaitHandle.WaitOne(400) -and $c.Connected) { return $true }
    return $false
  } catch { return $false } finally { $c.Close() }
}

function Get-GwPid {
  try {
    $c = Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction Stop | Select-Object -First 1
    if ($c -ne $null) { return [int]$c.OwningProcess }
  } catch { }
  return 0
}

$script:GwProc = $null

function Start-Gateway {
  if (Test-Port $PORT) { return $true }
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $NODE
    $psi.Arguments = '"' + $GWJS + '" --quiet'
    $psi.WorkingDirectory = $ROOT
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $script:GwProc = [System.Diagnostics.Process]::Start($psi)
    Log-Tray ('启动网关 pid=' + $script:GwProc.Id)
  } catch {
    Log-Tray ('启动网关失败: ' + $_.Exception.Message)
    return $false
  }
  for ($i = 0; $i -lt 24; $i++) {
    Start-Sleep -Milliseconds 250
    if (Test-Port $PORT) { return $true }
  }
  return (Test-Port $PORT)
}

function Stop-Gateway {
  $gwPid = Get-GwPid
  if ($gwPid -gt 0) {
    try {
      Stop-Process -Id $gwPid -Force -Confirm:$false -ErrorAction Stop
      Log-Tray ('结束网关 pid=' + $gwPid)
    } catch { Log-Tray ('结束网关失败: ' + $_.Exception.Message) }
  }
  if ($script:GwProc -ne $null) {
    try { if (-not $script:GwProc.HasExited) { $script:GwProc.Kill() } } catch { }
    $script:GwProc = $null
  }
  Start-Sleep -Milliseconds 600
}

function Invoke-Act([string]$act, [int]$timeout = 30) {
  try {
    $uri = 'http://127.0.0.1:' + $PORT + '/admin/api/action'
    $body = '{"do":"' + $act + '"}'
    $r = Invoke-RestMethod -Uri $uri -Method Post -Body $body -ContentType 'application/json' -TimeoutSec $timeout
    if ($r -ne $null -and $r.ok -eq $false) { return ('失败：' + $r.error) }
    return ''
  } catch {
    return ('失败：' + $_.Exception.Message)
  }
}

# ---------- 图标 ----------

$script:Keep = @()

function Round-Path([int]$x, [int]$y, [int]$w, [int]$h, [int]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc(($x + $w - $d), $y, $d, $d, 270, 90)
  $p.AddArc(($x + $w - $d), ($y + $h - $d), $d, $d, 0, 90)
  $p.AddArc($x, ($y + $h - $d), $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function New-TrayIcon([string]$hex) {
  $col = [System.Drawing.ColorTranslator]::FromHtml($hex)
  $bmp = New-Object System.Drawing.Bitmap 64, 64
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear([System.Drawing.Color]::Transparent)
  $path = Round-Path 2 2 60 60 16
  $brush = New-Object System.Drawing.SolidBrush($col)
  $g.FillPath($brush, $path)
  $font = New-Object System.Drawing.Font('Segoe UI', 40, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
  $wbr = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
  $rect = New-Object System.Drawing.RectangleF -ArgumentList 0, 0, 64, 62
  $g.DrawString('G', $font, $wbr, $rect, $fmt)
  $g.Dispose()
  $script:Keep += $bmp
  return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}

$icoOk = New-TrayIcon '#2563eb'
$icoOff = New-TrayIcon '#dc2626'

# ---------- 托盘 ----------

$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = $icoOk
$ni.Text = 'Claude 网关 · 正在启动'
$ni.Visible = $true

function Tip([string]$title, [string]$msg) {
  try {
    $ni.BalloonTipTitle = $title
    $ni.BalloonTipText = $msg
    $ni.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::None
    $ni.ShowBalloonTip(3500)
  } catch { }
}

function Open-Panel {
  try {
    Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-File', (Join-Path $ROOT 'open-panel.ps1')
    )
  } catch { Log-Tray ('打开面板失败: ' + $_.Exception.Message) }
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.ShowImageMargin = $false
$boldFont = New-Object System.Drawing.Font('Microsoft YaHei UI', 9, [System.Drawing.FontStyle]::Bold)

$miOpen = New-Object System.Windows.Forms.ToolStripMenuItem
$miOpen.Text = '打开控制面板'
$miOpen.Font = $boldFont

$miStat = New-Object System.Windows.Forms.ToolStripMenuItem
$miStat.Text = '状态：检查中…'
$miStat.Enabled = $false

$miRestart = New-Object System.Windows.Forms.ToolStripMenuItem
$miRestart.Text = '重启网关'

$miMagpie = New-Object System.Windows.Forms.ToolStripMenuItem
$miMagpie.Text = '重启/打开 Magpie'

$miRestore = New-Object System.Windows.Forms.ToolStripMenuItem
$miRestore.Text = '恢复原装 Claude 设置'

$miClaude = New-Object System.Windows.Forms.ToolStripMenuItem
$miClaude.Text = '重启/打开 Claude Desktop'

$miLog = New-Object System.Windows.Forms.ToolStripMenuItem
$miLog.Text = '打开网关日志'

$miCfg = New-Object System.Windows.Forms.ToolStripMenuItem
$miCfg.Text = '打开配置目录'

$miQuit = New-Object System.Windows.Forms.ToolStripMenuItem
$miQuit.Text = '退出'

$null = $menu.Items.Add($miOpen)
$null = $menu.Items.Add($miStat)
$null = $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$null = $menu.Items.Add($miRestart)
$null = $menu.Items.Add($miMagpie)
$null = $menu.Items.Add($miRestore)
$null = $menu.Items.Add($miClaude)
$null = $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$null = $menu.Items.Add($miLog)
$null = $menu.Items.Add($miCfg)
$null = $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$null = $menu.Items.Add($miQuit)

$ni.ContextMenuStrip = $menu
$ni.add_MouseDoubleClick({ Open-Panel })

$menu.add_Opening({
  if (Test-Port $PORT) {
    $miStat.Text = '状态：网关运行中 · 端口 15722'
    $miRestart.Enabled = $true
    $miMagpie.Enabled = $true
    $miRestore.Enabled = $true
    $miClaude.Enabled = $true
    $miCfg.Enabled = $true
  } else {
    $miStat.Text = '状态：网关已停止（点「重启网关」）'
    $miRestart.Enabled = $true
    $miMagpie.Enabled = $false
    $miRestore.Enabled = $false
    $miClaude.Enabled = $true
    $miCfg.Enabled = $true
  }
})

$miOpen.add_Click({ Open-Panel })

$miRestart.add_Click({
  Log-Tray '菜单：重启网关'
  Stop-Gateway
  if (Start-Gateway) {
    Log-Tray '菜单：重启网关成功'
    Tip 'Claude 网关' '网关已重启。'
  } else {
    Log-Tray '菜单：重启网关失败'
    Tip 'Claude 网关' '网关没能起来，请打开日志查看原因。'
  }
})

$miMagpie.add_Click({
  Log-Tray '菜单：重启/打开 Magpie'
  $err = Invoke-Act 'restart-magpie'
  if ($err -ne '') { Tip 'Magpie' $err; Log-Tray ('重启/打开 Magpie ' + $err) } else { Tip 'Magpie' '已发送重启/打开指令，约 2 秒后可用。' }
})

$miRestore.add_Click({
  Log-Tray '菜单：恢复原装 Claude 设置'
  $err = Invoke-Act 'restore-original'
  if ($err -ne '') { Tip '配置' $err; Log-Tray ('恢复原装配置 ' + $err) } else { Tip '配置' '已恢复原装 Claude 设置，重启 Claude 后生效。' }
})

$miClaude.add_Click({
  Log-Tray '菜单：重启/打开 Claude'
  $err = Invoke-Act 'restart-claude' 45
  if ($err -ne '') { Tip 'Claude' $err; Log-Tray ('重启/打开 Claude ' + $err) } else { Tip 'Claude' 'Claude 已重新打开。' }
})

$miLog.add_Click({
  $f = Join-Path $ROOT 'gateway.log'
  if (Test-Path -LiteralPath $f) { Start-Process notepad.exe $f } else { Tip '日志' '还没有日志文件。' }
})

$miCfg.add_Click({
  $err = Invoke-Act 'open-config'
  if ($err -ne '') { Start-Process explorer.exe $ROOT }
})

function Invoke-Quit {
  Log-Tray '执行退出：关闭网关并结束托盘'
  $script:Timer.Stop()
  New-Item -ItemType File -Path $FLAG -Force | Out-Null
  Stop-Gateway
  # 兜底：反复确认端口已释放，确保不留下任何 node 进程
  for ($i = 0; $i -lt 10; $i++) {
    if (-not (Test-Port $PORT)) { break }
    $p = Get-GwPid
    if ($p -gt 0) { Stop-Process -Id $p -Force -Confirm:$false -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 250
  }
  $ni.Visible = $false
  $ni.Dispose()
  Log-Tray ('已退出，网关端口仍在运行=' + (Test-Port $PORT))
  [System.Windows.Forms.Application]::Exit()
}

$miQuit.add_Click({ Invoke-Quit })

# ---------- 看护 ----------

$script:TickCount = 0
$script:ModelCount = 0

function Refresh-Tip([bool]$ok) {
  if ($ok) {
    $ni.Icon = $icoOk
    $t = 'Claude 网关 · 运行中'
    if ($script:ModelCount -gt 0) { $t = $t + ' · ' + $script:ModelCount + ' 个模型' }
    if ($t.Length -le 63) { $ni.Text = $t }
  } else {
    $ni.Icon = $icoOff
    $ni.Text = 'Claude 网关 · 已停止'
  }
}

function Update-Models {
  try {
    $r = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $PORT + '/admin/api/models') -TimeoutSec 4
    if ($r -ne $null -and $r.models -ne $null) { $script:ModelCount = $r.models.Count }
  } catch { }
}

Start-Gateway
Update-Models
Refresh-Tip (Test-Port $PORT)
Log-Tray ('托盘已启动，网关端口 ' + $PORT + ' ' + (Test-Port $PORT))

$script:Timer = New-Object System.Windows.Forms.Timer
$script:Timer.Interval = 5000
$script:Timer.add_Tick({
  $script:TickCount = $script:TickCount + 1
  $ok = Test-Port $PORT
  if (-not $ok) {
    Log-Tray '发现网关掉线，自动拉起'
    $ok = Start-Gateway
    if ($ok) { Update-Models }
  } elseif (($script:TickCount % 6) -eq 0) {
    Update-Models
  }
  Refresh-Tip $ok
})
$script:Timer.Start()

# 自测开关：启动时带 --quit-test，3 秒后自动走一遍和菜单「退出」完全相同的流程
if ($args -contains '--quit-test') {
  Log-Tray '自测：3 秒后自动执行退出'
  $script:QTimer = New-Object System.Windows.Forms.Timer
  $script:QTimer.Interval = 3000
  $script:QTimer.add_Tick({ $script:QTimer.Stop(); Invoke-Quit })
  $script:QTimer.Start()
}

[System.Windows.Forms.Application]::Run()

$script:Timer.Stop()
try { $ni.Visible = $false; $ni.Dispose() } catch { }
Log-Tray '消息循环结束'
