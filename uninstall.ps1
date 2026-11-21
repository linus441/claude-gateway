# Claude 网关 · 彻底卸载
# 做什么：停进程 → 删自启/桌面图标/注册表/计划任务 → 删程序目录 → 清 Claude 的 3p 配置 → 清临时文件
# 特点：先扫出清单再动手；认得出「部署包安装」和「手工复制的旧安装」两种路径；
#       有内容的配置会先备份到桌面，没有内容的直接删。
#
# 用法：
#   uninstall.ps1                 交互确认（双击「一键卸载.cmd」就是这个）
#   uninstall.ps1 -DryRun         只列清单，一个字节都不删
#   uninstall.ps1 -Force          不确认，直接删
#   uninstall.ps1 -NoBackup       不备份配置，全删
#   uninstall.ps1 -Deep           连 Claude 的 userData（Claude-3p 整个目录）也删
#   uninstall.ps1 -RemoveClaude   连 Claude Desktop 一起卸载（需要管理员）
#   uninstall.ps1 -RemovePackage  连这个部署包本体一起删

param(
    [switch]$DryRun,
    [switch]$Force,
    [switch]$NoBackup,
    [switch]$Deep,
    [switch]$RemoveClaude,
    [switch]$RemovePackage
)

$ErrorActionPreference = 'Continue'
$PORT = 15722
$script:DryRun = [bool]$DryRun
$script:Removed = New-Object System.Collections.Generic.List[string]
$script:Skipped = New-Object System.Collections.Generic.List[string]
$script:Failed = New-Object System.Collections.Generic.List[string]

function Head($m) { Write-Host "`n$m" -ForegroundColor Cyan }
function Done($m) { Write-Host "   OK   $m" -ForegroundColor Green; $script:Removed.Add($m) }
function Skip($m) { Write-Host "   --   $m" -ForegroundColor DarkGray; $script:Skipped.Add($m) }
function Bad($m) { Write-Host "   X    $m" -ForegroundColor Red; $script:Failed.Add($m) }
function Warn($m) { Write-Host "   !    $m" -ForegroundColor Yellow }

function Get-SizeText($p) {
    try {
        if (Test-Path -LiteralPath $p -PathType Leaf) {
            $n = (Get-Item -LiteralPath $p).Length
        } else {
            $n = (Get-ChildItem -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue |
                  Measure-Object -Property Length -Sum).Sum
        }
        if (-not $n) { return '0 KB' }
        if ($n -ge 1GB) { return ('{0:N1} GB' -f ($n / 1GB)) }
        if ($n -ge 1MB) { return ('{0:N1} MB' -f ($n / 1MB)) }
        return ('{0:N0} KB' -f ($n / 1KB))
    } catch { return '?' }
}

# ---------- 删除原语 ----------
function Kill-File($p) {
    if (-not (Test-Path -LiteralPath $p)) { return }
    if ($script:DryRun) { Done ("[预览] 删文件 " + $p); return }
    try {
        Remove-Item -LiteralPath $p -Force -ErrorAction Stop
        Done ("删文件 " + $p)
    } catch {
        Bad ("删不掉 " + $p + " — " + $_.Exception.Message)
    }
}

# 删除前的硬保护：不认识的目录一律不删
function Test-DirDeletable($p) {
    try {
        $full = [System.IO.Path]::GetFullPath($p).TrimEnd('\')
    } catch { return $false }
    $leaf = Split-Path -Leaf $full
    $parentLeaf = Split-Path -Leaf (Split-Path -Parent $full)

    $neverLeaf = @('AppData', 'Local', 'Roaming', 'LocalLow', 'Windows', 'WindowsApps',
                   'Users', 'ProgramData', 'Temp', 'Desktop', 'Documents', 'Downloads',
                   'System32', 'Microsoft', 'Packages', 'Program Files', 'Program Files (x86)')
    if ($neverLeaf -contains $leaf) { return $false }
    foreach ($mustNotBe in @($env:LOCALAPPDATA, $env:APPDATA, $env:USERPROFILE, $env:SystemRoot, $env:ProgramData)) {
        if ($mustNotBe -and ($full -eq $mustNotBe.TrimEnd('\'))) { return $false }
    }
    if ($full.Length -lt 12) { return $false }

    # 必须是 Claude 网关目录：路径里带 claude+gateway，或者是 <claude-gateway>\gateway
    if ($full -match '(?i)claude[\s_\-]*gateway') { return $true }
    if ($leaf -eq 'gateway' -and $parentLeaf -match '(?i)claude') { return $true }
    return $false
}

function Kill-Dir($p) {
    if (-not (Test-Path -LiteralPath $p)) { return }
    $size = Get-SizeText $p
    if (-not (Test-DirDeletable $p)) {
        Bad ("拒绝删除 " + $p + "（不像网关目录，为安全起见跳过，请手动确认）")
        return
    }
    if ($script:DryRun) { Done ("[预览] 删目录 " + $p + "  (" + $size + ")"); return }
    $ok = $false
    for ($i = 0; $i -lt 6; $i++) {
        try { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop; $ok = $true; break }
        catch { Start-Sleep -Milliseconds 350 }
    }
    if (-not $ok) {
        & cmd.exe /c rd /s /q "$p" 2>$null | Out-Null
        if (-not (Test-Path -LiteralPath $p)) { $ok = $true }
    }
    if ($ok) { Done ("删目录 " + $p + "  (" + $size + ")") }
    else { Bad ("删不掉目录 " + $p + "（可能被占用，重启后再跑一次）") }
}

function Kill-Proc($procId, $label) {
    if ($script:DryRun) { Done ("[预览] 结束进程 " + $label + " (PID " + $procId + ")"); return $true }
    try { Stop-Process -Id $procId -Force -ErrorAction Stop; return $true }
    catch {
        & taskkill.exe /F /PID $procId 2>$null | Out-Null
        return (-not (Get-Process -Id $procId -ErrorAction SilentlyContinue))
    }
}

function Kill-Files($list, $label) {
    $list = @($list)
    if ($list.Count -eq 0) { return }
    if ($script:DryRun) { Done ("[预览] 删 " + $list.Count + " 个" + $label); return }
    $n = 0
    foreach ($f in $list) {
        try { Remove-Item -LiteralPath $f -Force -ErrorAction Stop; $n++ }
        catch { Bad ("删不掉 " + $f) }
    }
    if ($n -gt 0) { Done ("删 " + $n + " 个" + $label) }
}

# ---------- 1. 找出所有安装痕迹 ----------
function Find-InstallDirs {
    $found = New-Object System.Collections.Generic.List[string]

    # 部署包标准路径
    $std = Join-Path $env:LOCALAPPDATA 'ClaudeGateway'
    if (Test-Path -LiteralPath $std) { $found.Add($std) }

    # 从自启脚本 / 桌面快捷方式 / 进程命令行反查真实目录（兼容手工复制的旧安装）
    $texts = @()
    $startup = [Environment]::GetFolderPath('Startup')
    $desk = [Environment]::GetFolderPath('Desktop')
    foreach ($f in @(
        (Join-Path $startup 'Claude Gateway Tray.vbs'),
        (Join-Path $startup 'ClaudeGateway.vbs'),
        (Join-Path $desk 'Claude 网关.url'),
        (Join-Path $desk 'Claude 网关.lnk')
    )) {
        if (Test-Path -LiteralPath $f -PathType Leaf) {
            $t = Get-Content -LiteralPath $f -Raw -Encoding Default -ErrorAction SilentlyContinue
            if ($t) { $texts += $t }
        }
    }
    foreach ($p in (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
        if ($p.CommandLine) { $texts += [string]$p.CommandLine }
        if ($p.ExecutablePath) { $texts += [string]$p.ExecutablePath }
    }

    $marker = '(?:gateway\.js|gateway\.ico|tray\.ps1|tray-launch\.vbs|open-panel\.ps1|open-panel\.vbs)'
    foreach ($t in $texts) {
        foreach ($m in [regex]::Matches($t, '([A-Za-z]:[\\/][^"''<>\r\n]*?)[\\/]' + $marker)) {
            $d = $m.Groups[1].Value -replace '/', '\'
            $d = $d.Trim()
            if ($d -and (Test-Path -LiteralPath $d -PathType Container)) { $found.Add($d) }
        }
    }

    # 只认目录名对得上的：gateway / ClaudeGateway / claude-gateway
    # 这一步是硬闸门——名字不对的目录（Local、Roaming、Microsoft…）一律不进候选
    $allowLeaf = @('gateway', 'ClaudeGateway', 'claude-gateway')
    $valid = @()
    foreach ($d in $found) {
        if ($d -match '\\payload\\') { continue }          # 部署包里的源文件，不在这里处理
        if ($d -match '\\Windows\\') { continue }
        if ($allowLeaf -notcontains (Split-Path -Leaf $d)) { continue }
        $hit = $false
        foreach ($n in @('gateway.js', 'tray.ps1', 'gateway.ico')) {
            if (Test-Path -LiteralPath (Join-Path $d $n)) { $hit = $true; break }
            if (Test-Path -LiteralPath (Join-Path $d ('gateway\' + $n))) { $hit = $true; break }
        }
        if (-not $hit -and (Test-Path -LiteralPath (Join-Path $d 'magpie'))) { $hit = $true }
        if ($hit) { $valid += $d }
    }

    # 启动脚本指向的是 ...\ClaudeGateway\gateway，要提到父目录，否则同级的 magpie 删不掉
    $valid2 = @()
    foreach ($d in $valid) {
        $parent = Split-Path -Parent $d
        if (((Split-Path -Leaf $d) -eq 'gateway') -and $parent) {
            $pl = Split-Path -Leaf $parent
            if (($pl -eq 'ClaudeGateway') -or (Test-Path -LiteralPath (Join-Path $parent 'magpie'))) {
                $d = $parent
            }
        }
        $valid2 += $d
    }
    return ($valid2 | Select-Object -Unique)
}

# ---------- 2. 找网关相关进程 ----------
function Find-GwProcs($dirs) {
    $out = @()
    # 只认这几种进程，别的（浏览器的 webview、explorer 等）即使命令行里带路径也不碰
    $allowProc = @('node.exe', 'powershell.exe', 'pwsh.exe', 'wscript.exe', 'magpie.exe')
    foreach ($p in (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
        if ($allowProc -notcontains $p.Name) { continue }
        $cl = [string]$p.CommandLine
        $ex = [string]$p.ExecutablePath
        $hit = $false
        foreach ($d in $dirs) {
            if ($cl -and $cl.IndexOf($d, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $hit = $true; break }
            if ($ex -and $ex.IndexOf($d, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $hit = $true; break }
        }
        if (-not $hit -and $p.Name -eq 'magpie.exe' -and $ex) {
            # 只认装在网关目录下那个 magpie（<网关目录>\magpie\magpie.exe），别处的不动
            foreach ($d in $dirs) {
                if ($ex.IndexOf($d + '\magpie\', [StringComparison]::OrdinalIgnoreCase) -ge 0) { $hit = $true; break }
            }
        }
        if ($hit) { $out += $p }
    }
    # 先杀守护（tray），再杀 node，最后 magpie，避免刚杀掉就被拉起来
    $rank = @{ 'powershell.exe' = 0; 'pwsh.exe' = 0; 'wscript.exe' = 0; 'node.exe' = 1; 'magpie.exe' = 2 }
    return ($out | Sort-Object { if ($rank.ContainsKey($_.Name)) { $rank[$_.Name] } else { 3 } })
}

# ---------- 3. Claude 的配置（带备份还原） ----------
function New-BackupDir {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $d = Join-Path ([Environment]::GetFolderPath('Desktop')) ("Claude网关-卸载备份-" + $stamp)
    if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
    return $d
}

function Backup-File($src, $destDir, $rel) {
    if ($script:NoBackup) { return }
    try {
        $t = Join-Path $destDir $rel
        $parent = Split-Path -Parent $t
        if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
        Copy-Item -LiteralPath $src -Destination $t -Force
    } catch {
        Warn ("备份失败 " + $src)
    }
}

Write-Host ''
Write-Host '================================================' -ForegroundColor White
Write-Host '   Claude 网关 · 彻底卸载' -ForegroundColor White
Write-Host '================================================' -ForegroundColor White
if ($script:DryRun) { Write-Host '   预览模式：只列清单，不删任何东西' -ForegroundColor Yellow }

# ---------- 扫描 ----------
Head '[1/6] 扫描安装痕迹'
$dirs = @(Find-InstallDirs)
$procs = @(Find-GwProcs $dirs)

# 端口兜底：权限受限时（命令行读不到）靠 15722 的占用者认出网关，否则目录会删不掉
$listenerPids = @()
try {
    foreach ($c in (Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue)) {
        if ($c.OwningProcess) { $listenerPids += [int]$c.OwningProcess }
    }
} catch {}
foreach ($id in ($listenerPids | Select-Object -Unique)) {
    if (-not ($procs | Where-Object { $_.ProcessId -eq $id })) {
        $g = Get-Process -Id $id -ErrorAction SilentlyContinue
        if ($g -and (($g.ProcessName -eq 'node') -or ($g.ProcessName -eq 'magpie'))) {
            $procs += [pscustomobject]@{
                Name = $g.ProcessName + '.exe'; ProcessId = $g.Id
                ExecutablePath = $null; CommandLine = $null
            }
        }
    }
}
$startupDir = [Environment]::GetFolderPath('Startup')
$deskDir = [Environment]::GetFolderPath('Desktop')
$startupFiles = @(Get-ChildItem -LiteralPath $startupDir -Force -ErrorAction SilentlyContinue |
                  Where-Object { $_.Name -like '*Claude*Gateway*' })
$deskFiles = @(Get-ChildItem -LiteralPath $deskDir -Force -ErrorAction SilentlyContinue |
               Where-Object { $_.Name -in @('Claude 网关.url', 'Claude 网关.lnk') })

$c3p = Join-Path $env:LOCALAPPDATA 'Claude-3p'
$c3pCfg = Join-Path $c3p 'claude_desktop_config.json'
$c3pLib = Join-Path $c3p 'configLibrary'
$roamCfg = Join-Path $env:APPDATA 'Claude\claude_desktop_config.json'

$tmpVbs = @(Get-ChildItem -LiteralPath $env:TEMP -Filter 'wb-launch-*.vbs' -Force -ErrorAction SilentlyContinue)

$runHits = @()
foreach ($k in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Run', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run')) {
    $it = Get-ItemProperty -Path $k -ErrorAction SilentlyContinue
    if ($it) {
        foreach ($pr in $it.PSObject.Properties) {
            if ($pr.Name -like 'PS*') { continue }
            $v = [string]$pr.Value
            # 只认名字里带 Claude 网关的，别的一律不动（曾经误伤过 OneDrive）
            $isOurs = $false
            if ($v -match '(?i)claude[\s_\-]*gateway') { $isOurs = $true }
            foreach ($d in $dirs) {
                if ($v.IndexOf($d + '\', [StringComparison]::OrdinalIgnoreCase) -ge 0) { $isOurs = $true }
            }
            if ($isOurs) { $runHits += [pscustomobject]@{ Path = $k; Name = $pr.Name; Value = $v } }
        }
    }
}

$taskHits = @(Get-ScheduledTask -ErrorAction SilentlyContinue |
              Where-Object { $_.TaskName -like '*Claude*Gateway*' -or $_.TaskName -like '*ClaudeGateway*' })

# Claude Desktop 包
$claudePkg = @(Get-AppxPackage -Name '*Claude*' -ErrorAction SilentlyContinue |
               Where-Object { $_.PackageFamilyName -like '*pzs8sxrjxfjjc*' })

# ---------- 清单 ----------
Head '[2/6] 将要删除的内容'

if ($dirs.Count -eq 0) { Skip '没找到网关程序目录' }
foreach ($d in $dirs) { Write-Host ("   目录  " + $d + "   (" + (Get-SizeText $d) + ")") -ForegroundColor White }

if ($procs.Count -eq 0) { Skip '没找到正在运行的网关进程' }
foreach ($p in $procs) {
    $ex = if ($p.ExecutablePath) { $p.ExecutablePath } else { $p.Name }
    Write-Host ("   进程  " + $p.Name + " (PID " + $p.ProcessId + ")  " + $ex) -ForegroundColor White
}

foreach ($f in $startupFiles) { Write-Host ("   自启  " + $f.FullName) -ForegroundColor White }
foreach ($f in $deskFiles) { Write-Host ("   图标  " + $f.FullName) -ForegroundColor White }
foreach ($r in $runHits) { Write-Host ("   注册表  " + $r.Path + " :: " + $r.Name) -ForegroundColor White }
foreach ($t in $taskHits) { Write-Host ("   计划任务  " + $t.TaskName) -ForegroundColor White }

# 3p 配置：只认我们写的那份
$ourProfiles = @()
if (Test-Path -LiteralPath $c3pLib) {
    foreach ($f in (Get-ChildItem -LiteralPath $c3pLib -Filter '*.json' -Force -ErrorAction SilentlyContinue)) {
        if ($f.Name -eq '_meta.json' -or $f.Name -like '*.bak*') { continue }
        $raw = Get-Content -LiteralPath $f.FullName -Raw -ErrorAction SilentlyContinue
        if (-not $raw) { continue }
        $isOurs = $false
        if ($raw -match [regex]::Escape([string]$PORT)) { $isOurs = $true }
        if ($raw -match '"name"\s*:\s*"Claude 网关"') { $isOurs = $true }
        if ($raw -match 'sk-gw-') { $isOurs = $true }
        if ($isOurs) { $ourProfiles += $f.FullName }
    }
}
$bakFiles = @()
foreach ($p in @($c3p, $c3pLib, (Join-Path $env:APPDATA 'Claude'))) {
    if (Test-Path -LiteralPath $p) {
        $bakFiles += @(Get-ChildItem -LiteralPath $p -Force -Recurse -ErrorAction SilentlyContinue |
                       Where-Object { $_.Name -like '*.bak-bootstrap-*' -or $_.Name -like '*.bak-restore-*' } |
                       Select-Object -ExpandProperty FullName)
    }
}

if (Test-Path -LiteralPath $c3pCfg) { Write-Host ("   Claude 配置  " + $c3pCfg) -ForegroundColor White }
foreach ($f in $ourProfiles) { Write-Host ("   Claude 配置档  " + $f) -ForegroundColor White }
if ($roamCfg -and (Test-Path -LiteralPath $roamCfg)) {
    $raw2 = Get-Content -LiteralPath $roamCfg -Raw -ErrorAction SilentlyContinue
    if ($raw2 -and $raw2 -match [regex]::Escape([string]$PORT)) {
        Write-Host ("   Claude 漫游配置  " + $roamCfg) -ForegroundColor White
    }
}
if ($bakFiles.Count -gt 0) {
    Write-Host ("   配置备份  " + $bakFiles.Count + " 个 .bak-bootstrap / .bak-restore 文件") -ForegroundColor DarkGray
}
if ($tmpVbs.Count -gt 0) { Write-Host ("   临时文件  " + $tmpVbs.Count + " 个 wb-launch-*.vbs") -ForegroundColor White }

if ($Deep -and (Test-Path -LiteralPath $c3p)) {
    Write-Host ("   [Deep] 整个 " + $c3p + "   (" + (Get-SizeText $c3p) + ")") -ForegroundColor Yellow
    Write-Host '          注意：这会连 Claude 的登录态、缓存一起清掉' -ForegroundColor Yellow
}
if ($RemoveClaude) {
    if ($claudePkg.Count -gt 0) {
        foreach ($p in $claudePkg) { Write-Host ("   [Claude] 卸载 " + $p.PackageFullName) -ForegroundColor Yellow }
    } else {
        Write-Host '   [Claude] 没找到已安装的 Claude Desktop 包' -ForegroundColor DarkGray
    }
    foreach ($p in @("$env:LOCALAPPDATA\Packages", "$env:LOCALAPPDATA\AnthropicClaude")) {
        if (Test-Path -LiteralPath $p) {
            $hit = @(Get-ChildItem -LiteralPath $p -Force -ErrorAction SilentlyContinue |
                     Where-Object { $_.Name -like 'Claude_pzs8sxrjxfjjc*' })
            foreach ($h in $hit) { Write-Host ("   [Claude] 残留数据 " + $h.FullName + "   (" + (Get-SizeText $h.FullName) + ")") -ForegroundColor Yellow }
        }
    }
}
if ($RemovePackage) {
    Write-Host ("   [Package] 部署包本体 " + $PSScriptRoot + "   (" + (Get-SizeText $PSScriptRoot) + ")") -ForegroundColor Yellow
}

Write-Host ''
Write-Host '   不受影响：Claude Desktop 本身、你的聊天记录、其他程序的配置' -ForegroundColor DarkGray
if (-not $Deep) { Write-Host '   （要连 Claude 的 userData 一起清，加 -Deep）' -ForegroundColor DarkGray }

if ($script:DryRun) {
    Write-Host ''
    Write-Host '预览结束，什么都没删。去掉 -DryRun 才真删。' -ForegroundColor Yellow
    exit 0
}

if (-not $Force) {
    Write-Host ''
    $ans = Read-Host '   确认卸载？输入 YES 回车（直接回车取消）'
    if ($ans -ne 'YES' -and $ans -ne 'yes' -and $ans -ne 'Yes') {
        Write-Host '已取消，什么都没动。' -ForegroundColor Yellow
        exit 0
    }
    if (-not $RemoveClaude -and $claudePkg.Count -gt 0) {
        $a2 = Read-Host '   连 Claude Desktop 一起卸载吗？(y/N)'
        if ($a2 -match '^[Yy]') { $RemoveClaude = $true; Head '   已选择一并卸载 Claude Desktop' }
    }
}

# ---------- 备份 ----------
Head '[3/6] 备份有内容的配置'
$backupDir = $null
$hasRealData = $false
if (-not $NoBackup -and $dirs.Count -gt 0) {
    $mf = Join-Path $dirs[0] 'models.json'
    $uf = Join-Path $dirs[0] 'upstreams.json'
    try {
        if (Test-Path -LiteralPath $mf) {
            $m = Get-Content -LiteralPath $mf -Raw | ConvertFrom-Json
            if (@($m).Count -gt 0) { $hasRealData = $true }
        }
    } catch {}
    try {
        if (Test-Path -LiteralPath $uf) {
            $u = Get-Content -LiteralPath $uf -Raw | ConvertFrom-Json
            if (@($u.upstreams).Count -gt 1) { $hasRealData = $true }
        }
    } catch { $hasRealData = $true }
}
if ($hasRealData) {
    $backupDir = New-BackupDir
    foreach ($d in $dirs) {
        foreach ($n in @('models.json', 'upstreams.json', 'gw-key.txt')) {
            $src = Join-Path $d $n
            if (Test-Path -LiteralPath $src) { Backup-File $src $backupDir ($d.TrimEnd('\').Split('\')[-1] + '\' + $n) }
        }
        $snap = Join-Path $d 'snapshots'
        if (Test-Path -LiteralPath $snap) {
            $t = Join-Path $backupDir ($d.TrimEnd('\').Split('\')[-1] + '\snapshots')
            New-Item -ItemType Directory -Force -Path $t | Out-Null
            Copy-Item -LiteralPath (Join-Path $snap '*') -Destination $t -Force -Recurse -ErrorAction SilentlyContinue
        }
    }
    Done ('配置已备份到 ' + $backupDir)
} else {
    Skip '模型表和上游都是空的，没有需要备份的东西'
}
if ($c3pCfg -and (Test-Path -LiteralPath $c3pCfg)) {
    if (-not $backupDir) { $backupDir = New-BackupDir }
    Backup-File $c3pCfg $backupDir 'Claude-3p\claude_desktop_config.json'
    Done 'Claude 的 3p 配置已备份'
}

# ---------- 停进程 ----------
Head '[4/6] 结束进程'
if ($procs.Count -eq 0) { Skip '没有需要结束的进程' }
$killed = 0
foreach ($p in $procs) {
    $label = $p.Name + ' PID ' + $p.ProcessId
    if (Kill-Proc $p.ProcessId $label) { Done ('已结束 ' + $label); $killed++ }
    else { Bad ('结束不了 ' + $label) }
}
if ($killed -gt 0) { Start-Sleep -Milliseconds 900 }

# ---------- 删 ----------
Head '[5/6] 删除文件'
foreach ($f in $startupFiles) { Kill-File $f.FullName }
foreach ($f in $deskFiles) { Kill-File $f.FullName }

foreach ($r in $runHits) {
    if ($script:DryRun) { Done ('[预览] 删注册表值 ' + $r.Path + ' :: ' + $r.Name); continue }
    try { Remove-ItemProperty -Path $r.Path -Name $r.Name -Force -ErrorAction Stop; Done ('删注册表值 ' + $r.Name) }
    catch { Bad ('删不掉注册表值 ' + $r.Name + ' — ' + $_.Exception.Message) }
}

foreach ($t in $taskHits) {
    if ($script:DryRun) { Done ('[预览] 删计划任务 ' + $t.TaskName); continue }
    try { Unregister-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -Confirm:$false -ErrorAction Stop; Done ('删计划任务 ' + $t.TaskName) }
    catch { Bad ('删不掉计划任务 ' + $t.TaskName) }
}

foreach ($d in $dirs) { Kill-Dir $d }

# Claude 的 3p 配置
if ($Deep -and (Test-Path -LiteralPath $c3p)) {
    Kill-Dir $c3p
} else {
    # 扁平配置：有 .bak-bootstrap 就还原，没有就删（说明是我们建的）
    if (Test-Path -LiteralPath $c3pCfg) {
        $baks = @(Get-ChildItem -LiteralPath $c3p -Force -File -ErrorAction SilentlyContinue |
                  Where-Object { $_.Name -like 'claude_desktop_config.json.bak-bootstrap-*' } |
                  Sort-Object LastWriteTime -Descending)
        if ($baks.Count -gt 0) {
            if ($script:DryRun) {
                Done ('[预览] 还原 claude_desktop_config.json（来源 ' + $baks[0].Name + '）')
            } else {
                try {
                    Copy-Item -LiteralPath $baks[0].FullName -Destination $c3pCfg -Force
                    Done ('还原成安装前的 claude_desktop_config.json（来源 ' + $baks[0].Name + '）')
                } catch { Bad '还原 claude_desktop_config.json 失败' }
            }
        } else {
            Kill-File $c3pCfg
        }
    }

    # 配置档：只删我们写的那份，别人的（CC Switch 等）不动
    if (Test-Path -LiteralPath $c3pLib) {
        $metaFile = Join-Path $c3pLib '_meta.json'
        $meta = $null
        if (Test-Path -LiteralPath $metaFile) {
            try { $meta = Get-Content -LiteralPath $metaFile -Raw | ConvertFrom-Json } catch {}
        }
        $removedIds = @()
        foreach ($f in $ourProfiles) {
            Kill-File $f
            $removedIds += [System.IO.Path]::GetFileNameWithoutExtension($f)
        }
        if ($meta -and $removedIds.Count -gt 0 -and -not $script:DryRun) {
            $keep = @()
            foreach ($e in @($meta.entries)) {
                if ($e -and ($removedIds -notcontains [string]$e.id)) { $keep += $e }
            }
            if ($keep.Count -eq 0) {
                Kill-File $metaFile
                $left = @(Get-ChildItem -LiteralPath $c3pLib -Force -ErrorAction SilentlyContinue)
                if ($left.Count -eq 0) { Kill-Dir $c3pLib }
            } else {
                $applied = [string]$meta.appliedId
                if ($removedIds -contains $applied) { $applied = [string]$keep[0].id }
                @{ entries = $keep; appliedId = $applied } | ConvertTo-Json -Depth 6 |
                    Set-Content -LiteralPath $metaFile -Encoding UTF8
                Done ('配置档索引已更新，剩下 ' + $keep.Count + ' 个（不是网关的）')
            }
        } elseif ($removedIds.Count -eq 0) {
            Skip '配置档里没有网关创建的条目'
        }
    }

    # 漫游目录那份被改过的配置（要赶在删 .bak 之前，还原要用到它）
    if ($roamCfg -and (Test-Path -LiteralPath $roamCfg)) {
        $raw3 = Get-Content -LiteralPath $roamCfg -Raw -ErrorAction SilentlyContinue
        if ($raw3 -and $raw3 -match [regex]::Escape([string]$PORT)) {
            $rbak = @(Get-ChildItem -LiteralPath (Split-Path -Parent $roamCfg) -Force -File -ErrorAction SilentlyContinue |
                      Where-Object { $_.Name -like 'claude_desktop_config.json.bak-restore-*' } |
                      Sort-Object LastWriteTime -Descending)
            if ($rbak.Count -gt 0) {
                try {
                    Copy-Item -LiteralPath $rbak[0].FullName -Destination $roamCfg -Force
                    Done ('还原漫游目录的 claude_desktop_config.json（来源 ' + $rbak[0].Name + '）')
                } catch { Bad '还原漫游配置失败' }
            } else {
                Kill-File $roamCfg
            }
        }
    }

    # 网关造成的 .bak 文件
    Kill-Files $bakFiles ' 配置备份文件（.bak-bootstrap / .bak-restore）'
}

foreach ($f in $tmpVbs) { Kill-File $f.FullName }

# ---------- Claude Desktop ----------
if ($RemoveClaude) {
    Head '[6/6] 卸载 Claude Desktop'
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        Warn '卸载 Claude Desktop 需要管理员权限'
        Warn '请右键「一键卸载.cmd」→ 以管理员身份运行，再跑一次（网关部分已经删完了）'
    } else {
        Get-Process -Name 'claude' -ErrorAction SilentlyContinue | ForEach-Object { Kill-Proc $_.Id ('claude PID ' + $_.Id) | Out-Null }
        Start-Sleep -Milliseconds 800
        foreach ($p in $claudePkg) {
            try { Remove-AppxPackage -Package $p.PackageFullName -ErrorAction Stop; Done ('已卸载 ' + $p.PackageFullName) }
            catch { Bad ('卸载失败 ' + $p.Name + ' — ' + $_.Exception.Message) }
        }
        foreach ($pn in @("$env:LOCALAPPDATA\Packages", "$env:LOCALAPPDATA\AnthropicClaude")) {
            if (-not (Test-Path -LiteralPath $pn)) { continue }
            if ($pn -like '*AnthropicClaude') { Kill-Dir $pn; continue }
            $hit = @(Get-ChildItem -LiteralPath $pn -Force -ErrorAction SilentlyContinue |
                     Where-Object { $_.Name -like 'Claude_pzs8sxrjxfjjc*' })
            foreach ($h in $hit) { Kill-Dir $h.FullName }
        }
        Kill-File (Join-Path $deskDir 'Claude.lnk')
        Kill-File (Join-Path ([Environment]::GetFolderPath('Programs')) 'Claude.lnk')
    }
}

# ---------- 部署包本体 ----------
if ($RemovePackage) {
    $pkgRoot = $PSScriptRoot
    if (Test-Path -LiteralPath (Join-Path $pkgRoot 'payload')) {
        if ($script:DryRun) {
            Done ('[预览] 删部署包 ' + $pkgRoot)
        } else {
            $bat = Join-Path $env:TEMP ('del-gw-pkg-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.bat')
            $lines = @(
                '@echo off',
                'cd /d "%TEMP%"',
                'timeout /t 2 /nobreak >nul',
                'rd /s /q "' + $pkgRoot + '"',
                'del /f /q "%~f0"'
            )
            Set-Content -LiteralPath $bat -Value $lines -Encoding Default
            Start-Process -FilePath 'cmd.exe' -ArgumentList ('/c "' + $bat + '"') -WindowStyle Hidden
            Done ('部署包会在 2 秒后自行删除：' + $pkgRoot)
        }
    } else {
        Skip '当前目录不是部署包根目录，跳过'
    }
}

# ---------- 验收 ----------
Head '验收'
$leftover = @()
foreach ($d in $dirs) { if (Test-Path -LiteralPath $d) { $leftover += $d } }
foreach ($f in $startupFiles) { if (Test-Path -LiteralPath $f.FullName) { $leftover += $f.FullName } }
foreach ($f in $deskFiles) { if (Test-Path -LiteralPath $f.FullName) { $leftover += $f.FullName } }

$busy = $null
try { $busy = Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue } catch {}
if ($busy) { $leftover += ('端口 ' + $PORT + ' 仍在监听（PID ' + $busy.OwningProcess + '）') }

$stillProc = @()
foreach ($p in (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
    if ($p.Name -eq 'node.exe' -and $p.CommandLine -and $p.CommandLine -match 'gateway\.js') { $stillProc += $p.ProcessId }
}
foreach ($id in $stillProc) { $leftover += ('还在跑的网关进程 PID ' + $id) }

Write-Host ''
Write-Host ('   已删除 / 已处理  ' + $script:Removed.Count + ' 项') -ForegroundColor Green
if ($backupDir) { Write-Host ('   配置备份在      ' + $backupDir) -ForegroundColor Yellow }
if ($script:Failed.Count -gt 0) {
    Write-Host ('   失败            ' + $script:Failed.Count + ' 项') -ForegroundColor Red
    foreach ($f in $script:Failed) { Write-Host ('     - ' + $f) -ForegroundColor Red }
}
if ($leftover.Count -gt 0) {
    Write-Host ''
    Write-Host '   还有残留（多半是被占用，重启后重跑本脚本即可）：' -ForegroundColor Yellow
    foreach ($l in $leftover) { Write-Host ('     - ' + $l) -ForegroundColor Yellow }
} else {
    Write-Host ''
    Write-Host '   干净了：进程、自启、图标、程序目录、Claude 的 3p 配置都没了。' -ForegroundColor Green
}
Write-Host ''
Write-Host '   提醒：Magpie 的 data 目录（登录态、缓存）在 magpie 自己的数据目录里，' -ForegroundColor DarkGray
Write-Host '        默认不删。要清就删 %LOCALAPPDATA%\ClaudeGateway 整个（本脚本已做）。' -ForegroundColor DarkGray
Write-Host ''

if (-not $Force) { Read-Host '按回车关闭' }
