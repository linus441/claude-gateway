# Claude 网关 · 一键部署（网关 + Magpie；Claude Desktop 单独安装）
# 做什么：复制网关与 Magpie → 生成密钥与空配置 → 建自启和桌面图标 → 启动
# 特点：不带任何原有配置。模型表为空，上游只留内置的 Magpie，其余由你装完后自己加。

$ErrorActionPreference = 'Stop'

# ---------- 0. 管理员权限 ----------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host ''
    Write-Host '  需要管理员权限（安装网关/桌面图标/自启用），正在申请…' -ForegroundColor Yellow
    try {
        Start-Process powershell -Verb RunAs -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    } catch {
        Write-Host '  提权被拒绝，安装中止。' -ForegroundColor Red
        Read-Host '按回车关闭'
    }
    exit
}

$Root    = $PSScriptRoot
$Payload = Join-Path $Root 'payload'
$Version = 'unknown'
$VersionDate = ''
try {
    $vi = Get-Content (Join-Path $Payload 'gateway\version.json') -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json
    if ($vi.version) { $Version = [string]$vi.version }
    if ($vi.date) { $VersionDate = [string]$vi.date }
} catch {}
$Dest    = Join-Path $env:LOCALAPPDATA 'ClaudeGateway'
$GwDir   = Join-Path $Dest 'gateway'
$MpDir   = Join-Path $Dest 'magpie'
$Port    = 15722

function Step($n, $t) { Write-Host "`n[$n] $t" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "     OK   $m" -ForegroundColor Green }
function Warn($m) { Write-Host "     !    $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "     X    $m" -ForegroundColor Red }

function New-ClaudeShortcut($pkg) {
    $desk = [Environment]::GetFolderPath('Desktop')
    $lnk = Join-Path $desk 'Claude.lnk'
    $aumid = $pkg.PackageFamilyName + '!Claude'
    $exe = Join-Path $pkg.InstallLocation 'app\Claude.exe'
    try {
        $ws = New-Object -ComObject WScript.Shell
        $s = $ws.CreateShortcut($lnk)
        $s.TargetPath = "$env:windir\explorer.exe"
        $s.Arguments = 'shell:AppsFolder\' + $aumid
        $s.WorkingDirectory = $desk
        $s.Description = 'Claude Desktop'
        if (Test-Path $exe) { $s.IconLocation = "$exe,0" }
        $s.Save()
        return $true
    } catch {
        try {
            $shell = New-Object -ComObject Shell.Application
            $apps = $shell.Namespace('shell:AppsFolder')
            $item = $apps.Items() | Where-Object { $_.Name -match 'Claude' } | Select-Object -First 1
            if ($item) {
                $shell.Namespace($desk).CopyHere($item, 0x14)
                return $true
            }
        } catch {}
        Warn '创建 Claude 桌面图标失败；请从开始菜单打开 Claude'
        return $false
    }
}

function New-MagpieShortcut($exe, $workdir) {
    $desk = [Environment]::GetFolderPath('Desktop')
    $lnk = Join-Path $desk 'Magpie.lnk'
    try {
        $ws = New-Object -ComObject WScript.Shell
        $s = $ws.CreateShortcut($lnk)
        $s.TargetPath = $exe
        $s.WorkingDirectory = $workdir
        $s.IconLocation = "$exe,0"
        $s.Save()
        return $true
    } catch {
        # 如果系统策略禁止创建 .lnk，就在桌面放一个同卷硬链接，仍有原图标
        try {
            $target = Join-Path $desk 'Magpie.exe'
            if (-not (Test-Path -LiteralPath $target)) {
                New-Item -ItemType HardLink -Path $target -Target $exe -ErrorAction Stop | Out-Null
            }
            return $true
        } catch {
            try {
                $cmd = Join-Path $desk 'Magpie.cmd'
                Set-Content -Path $cmd -Value ('@echo off' + "`r`n" + 'start "" "' + $exe + '"') -Encoding ASCII
                return $true
            } catch {
                Warn '创建 Magpie 桌面图标失败'
                return $false
            }
        }
    }
}

# 仓库里不带 node.exe（83 MB），首次安装时从官方源取一份
function Ensure-NodeExe {
    $nodeExe = Join-Path $Payload 'gateway\node.exe'
    if ((Test-Path $nodeExe -PathType Leaf) -and ((Get-Item $nodeExe).Length -gt 30MB)) { return $true }
    $ver = 'v22.22.2'
    $urls = @(
        ('https://nodejs.org/dist/' + $ver + '/node-' + $ver + '-win-x64.zip'),
        ('https://npmmirror.com/mirrors/node/' + $ver + '/node-' + $ver + '-win-x64.zip')
    )
    $zip = Join-Path $env:TEMP ('node-' + [guid]::NewGuid().ToString('N') + '.zip')
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
    foreach ($u in $urls) {
        try {
            Write-Host ('     正在下载 Node 运行时：' + $u) -ForegroundColor DarkGray
            Invoke-WebRequest -Uri $u -OutFile $zip -UseBasicParsing -TimeoutSec 300 -ErrorAction Stop
            $z = [IO.Compression.ZipFile]::OpenRead($zip)
            $entry = $z.Entries | Where-Object { $_.FullName -like '*/node.exe' } | Select-Object -First 1
            if ($entry) {
                New-Item -ItemType Directory -Force -Path (Split-Path $nodeExe) | Out-Null
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $nodeExe, $true)
            }
            $z.Dispose()
            if ((Test-Path $nodeExe -PathType Leaf) -and ((Get-Item $nodeExe).Length -gt 30MB)) { return $true }
        } catch {
        } finally {
            if (Test-Path $zip) { Remove-Item $zip -Force -ErrorAction SilentlyContinue }
        }
    }
    return $false
}

Write-Host ''
Write-Host '================================================' -ForegroundColor White
$verLine = '   Claude 网关 · 一键部署  v' + $Version
if ($VersionDate) { $verLine += '  (' + $VersionDate + ')' }
Write-Host $verLine -ForegroundColor White
Write-Host '================================================' -ForegroundColor White
Write-Host "   安装位置：$Dest" -ForegroundColor DarkGray

# ---------- 1. 检查文件是否齐全 ----------
Step '1/7' '检查安装文件'
$need = @(
    'payload\gateway\gateway.js',
    'payload\gateway\openai-bridge.js',
    'payload\gateway\restore.js',
    'payload\gateway\bootstrap.js',
    'payload\gateway\panel.html',
    'payload\gateway\version.json',
    'payload\gateway\tray.ps1',
    'payload\gateway\models.json',
    'payload\gateway\upstreams.json'
)
$missing = @($need | Where-Object { -not (Test-Path (Join-Path $Root $_)) })
if ($missing.Count -gt 0) {
    foreach ($m in $missing) { Fail "缺少 $m" }
    Read-Host '文件不全，按回车关闭'
    exit 1
}
if (Ensure-NodeExe) { Ok 'Node 运行时已就绪' } else { Warn 'Node 运行时准备失败，安装会不完整' }
Ok '文件齐全'

# ---------- 2. 检查 Claude Desktop ----------
Step '2/7' '检查 Claude Desktop'
$pkg = Get-AppxPackage -Name '*Claude*' -ErrorAction SilentlyContinue |
       Where-Object { $_.PackageFamilyName -like '*pzs8sxrjxfjjc*' } |
       Select-Object -First 1
if ($pkg) {
    Ok ("已安装 " + $pkg.Name + " " + $pkg.Version)
    New-ClaudeShortcut $pkg | Out-Null
} else {
    Warn '未检测到 Claude Desktop。网关会继续安装；请单独运行「安装Claude桌面版-右键以管理员运行.cmd」'
}
# 旧 Squirrel 版会在国内卡地区限制，提醒清理
$old = Join-Path $env:LOCALAPPDATA 'AnthropicClaude\claude.exe'
if (Test-Path $old) {
    Warn "检测到旧版 Squirrel Claude（$old），建议先卸载，避免误启动后卡地区限制"
}

# ---------- 3. 复制程序 ----------
Step '3/7' '复制网关与 Magpie'
New-Item -ItemType Directory -Force -Path $GwDir, $MpDir | Out-Null

# 这两个是「用户数据」，重装时保留，别覆盖
$keep = @('models.json', 'upstreams.json')
$copied = 0
foreach ($f in Get-ChildItem (Join-Path $Payload 'gateway') -File) {
    $t = Join-Path $GwDir $f.Name
    if (($keep -contains $f.Name) -and (Test-Path $t)) { Warn ($f.Name + ' 已存在，保留现有内容'); continue }
    Copy-Item $f.FullName $t -Force
    $copied++
}
$mpFiles = @(Get-ChildItem (Join-Path $Payload 'magpie') -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne '.gitkeep' })
if ($mpFiles.Count -gt 0) {
    foreach ($f in $mpFiles) {
        Copy-Item $f.FullName (Join-Path $MpDir $f.Name) -Force
        $copied++
    }
} else {
    Warn '没有提供 magpie.exe，跳过（可以在面板里接其他上游）'
}
Ok ("复制 $copied 个文件 → " + $Dest)

# ---------- 4. 生成密钥 ----------
Step '4/7' '生成密钥并写入 Claude 的 3p 配置'
$keyFile = Join-Path $GwDir 'gw-key.txt'
if (Test-Path $keyFile) {
    Ok 'gw-key.txt 已存在，沿用（不换了，换了 Claude 那边要重写）'
} else {
    $k = 'sk-gw-' + ([guid]::NewGuid().ToString('N'))
    Set-Content -Path $keyFile -Value $k -Encoding ASCII -NoNewline
    Ok '已生成随机密钥 gw-key.txt'
}

# 关键一步：Claude 只认 3p 模式，而这个模式的两个文件它自己只在"登录成功之后"才生成。
# 全新机器上它会在登录页被地区限制卡死，永远不会生成 -> 所以这里直接写出来。
$boot = Join-Path $GwDir 'bootstrap.js'
$nodeExe = Join-Path $GwDir 'node.exe'
if ((Test-Path $boot) -and (Test-Path $nodeExe)) {
    try {
        $null = & $nodeExe $boot --quiet
        $claudeCfg = Join-Path $env:LOCALAPPDATA 'Claude-3p\claude_desktop_config.json'
        $libDir = Join-Path $env:LOCALAPPDATA 'Claude-3p\configLibrary'
        if ((Test-Path $claudeCfg) -and (Test-Path $libDir)) {
            Ok '已写入 3p 模式配置（Claude 不会再卡登录页 / 地区限制）'
        } else {
            Warn 'bootstrap.js 跑了，但没看到配置文件，稍后在面板点「自建配置档」'
        }
    } catch {
        Warn ('写入 3p 配置失败：' + $_.Exception.Message)
    }
} else {
    Warn '缺少 bootstrap.js，跳过 3p 配置（稍后在面板点「自建配置档」）'
}

$models = Get-Content (Join-Path $GwDir 'models.json') -Raw | ConvertFrom-Json
$modelCount = @($models).Count
if ($null -eq $models) { $modelCount = 0 }
Ok ("当前模型表：" + $modelCount + " 个（空是正常的，装完自己去加）")

# ---------- 5. 开机自启 ----------
Step '5/7' '设置开机自启'
$startup = [Environment]::GetFolderPath('Startup')
$autoVbs = Join-Path $startup 'Claude Gateway Tray.vbs'
$vbsBody = @"
Set sh = CreateObject("WScript.Shell")
sh.Run "$GwDir\tray-launch.vbs", 0, False
"@
Set-Content -Path $autoVbs -Value $vbsBody -Encoding Default
Ok ('已写入 ' + $autoVbs)

# ---------- 6. 桌面图标 ----------
Step '6/7' '创建桌面图标'
$desk = [Environment]::GetFolderPath('Desktop')
$urlPath = Join-Path $desk 'Claude 网关.url'
$target = (Join-Path $GwDir 'open-panel.vbs') -replace '\\', '/'
$urlBody = @"
[InternetShortcut]
URL=file:///$target
IconFile=$GwDir\gateway.ico
IconIndex=0
"@
Set-Content -Path $urlPath -Value $urlBody -Encoding Unicode
Ok ('已创建 ' + $urlPath)

# Magpie 桌面图标
$mpExe = Join-Path $MpDir 'magpie.exe'
if (Test-Path $mpExe) {
    if (New-MagpieShortcut $mpExe $MpDir) {
        Ok '已创建 Magpie 桌面图标'
    }
} else {
    Warn '找不到 magpie.exe，跳过 Magpie 图标'
}

# Claude 桌面图标（如果已经安装）
if ($pkg) {
    if (New-ClaudeShortcut $pkg) { Ok '已创建 Claude 桌面图标' }
} else {
    Warn 'Claude 尚未安装，安装 Claude 后会自动创建桌面图标'
}

# ---------- 7. 启动 ----------
Step '7/7' '启动网关'
$busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($busy) {
    Warn "端口 $Port 已被占用，可能已经在跑；先试着连一下"
} else {
    Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$GwDir\tray-launch.vbs`""
    $up = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 400
        try {
            $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 2
            if ($r.StatusCode -eq 200) { $up = $true; break }
        } catch {}
    }
    if ($up) { Ok "网关已启动（$Port）" } else { Fail '网关没起来，看 gateway.log' }
}

Write-Host ''
Write-Host '================================================' -ForegroundColor White
Write-Host ('   安装完成  v' + $Version) -ForegroundColor Green
Write-Host '================================================' -ForegroundColor White
Write-Host ''
Write-Host '接下来（第一次必须做）：' -ForegroundColor Yellow
if (-not $pkg) {
    Write-Host '  0. 右键「安装Claude桌面版-右键以管理员运行.cmd」安装 Claude（会写入 3p 配置，避免地区限制）'
    Write-Host '     安装完成后，桌面会出现 Claude 图标；再继续下面的步骤'
}
Write-Host '  1. 启动 Magpie（' + $MpDir + '\magpie.exe），登录你的 WorkBuddy 账号'
Write-Host '  2. 桌面双击「Claude 网关」打开面板 → 上游页 → magpie 那行点「自动填充」'
Write-Host '  3. 勾选要用的模型 → 「加进模型表」→ 模型页点「保存并应用」'
Write-Host '  4. 模型页点「重启/打开 Claude」，下拉框里就有模型了'
Write-Host ''
Write-Host '  想接别家（DeepSeek / Agnes / 任意中转）：上游页「添加」，填 Base URL 和 Key'
Write-Host '  保存后点「自动填充」，模型名和显示名它会自己填好' -ForegroundColor DarkGray
Write-Host ''

# 顺手把面板打开
Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$GwDir\open-panel.vbs`""

Read-Host '按回车关闭这个窗口'
