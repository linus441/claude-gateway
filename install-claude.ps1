# Claude Desktop 独立安装器
# 作用：只安装 Claude Desktop + 写 3p 配置 + 建桌面图标，不安装/改动网关和 Magpie。
# 可以在安装网关之前或之后运行。

$ErrorActionPreference = 'Stop'

# ---------- 0. 管理员权限 ----------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host ''
    Write-Host '  需要管理员权限（安装 Claude Desktop 用），正在申请…' -ForegroundColor Yellow
    try {
        Start-Process powershell -Verb RunAs -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    } catch {
        Write-Host '  提权被拒绝，安装中止。' -ForegroundColor Red
        Read-Host '按回车关闭'
    }
    exit
}

$Root = $PSScriptRoot
$Payload = Join-Path $Root 'payload'
$ClaudePayload = Join-Path $Payload 'claude'
$Msix = Join-Path $ClaudePayload 'Claude-win-x64.msix'
$MsixDownloadUrls = @(
    'https://github.com/linus441/claude-gateway/releases/download/v0.3.1/Claude-win-x64.msix',
    'https://claude.ai/api/desktop/win32/x64/msix/latest/redirect'
)
$MsixSha256 = '4625EAA902E05C81D35D247423AE24A2A1C30E60CAE9B355C07264998A89E453'
# 本机/共享目录里已经有完整包时直接拿来用，不走网络
$MsixLocalSources = @(
    $env:CLAUDE_MSIX_PATH,
    (Join-Path $Root 'Claude网关部署包\payload\claude\Claude-win-x64.msix'),
    (Join-Path (Split-Path $Root -Parent) 'Claude网关部署包\payload\claude\Claude-win-x64.msix'),
    'Z:\Claude网关部署包\payload\claude\Claude-win-x64.msix'
) | Where-Object { $_ }

function Ensure-ClaudeMsix {
    if (Test-Path -LiteralPath $Msix -PathType Leaf) { return $true }
    foreach ($src in $MsixLocalSources) {
        if (Test-Path -LiteralPath $src -PathType Leaf) {
            try {
                New-Item -ItemType Directory -Force -Path $ClaudePayload | Out-Null
                Write-Host ('     使用本地 MSIX：' + $src) -ForegroundColor DarkGray
                Copy-Item $src $Msix -Force
                if ((Get-FileHash -LiteralPath $Msix -Algorithm SHA256).Hash -eq $MsixSha256) { return $true }
                Remove-Item $Msix -Force -ErrorAction SilentlyContinue
            } catch {}
        }
    }
    try {
        New-Item -ItemType Directory -Force -Path $ClaudePayload | Out-Null
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        foreach ($url in $MsixDownloadUrls) {
            try {
                Write-Host ('     正在下载 Claude MSIX（285 MB，支持断点续传）：' + $url) -ForegroundColor DarkGray
                $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
                if (Test-Path $curl) {
                    & $curl -L --fail --retry 3 --retry-delay 2 -C - -o $Msix $url
                    if ($LASTEXITCODE -ne 0) { throw ('curl 退出码 ' + $LASTEXITCODE) }
                } else {
                    Invoke-WebRequest -Uri $url -OutFile $Msix -UseBasicParsing -ErrorAction Stop
                }
                if ((Test-Path -LiteralPath $Msix -PathType Leaf) -and (Get-Item -LiteralPath $Msix).Length -ge 1MB) {
                    $hash = (Get-FileHash -LiteralPath $Msix -Algorithm SHA256).Hash
                    if ($hash -eq $MsixSha256) { return $true }
                    Remove-Item -LiteralPath $Msix -Force -ErrorAction SilentlyContinue
                }
            } catch {
                Remove-Item -LiteralPath $Msix -Force -ErrorAction SilentlyContinue
            }
        }
        throw '所有官方下载地址均不可用'
    } catch {
        Remove-Item -LiteralPath $Msix -Force -ErrorAction SilentlyContinue
        Warn ('下载 Claude MSIX 失败：' + $_.Exception.Message)
        return $false
    }
}

function Step($n, $t) { Write-Host "`n[$n] $t" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "     OK   $m" -ForegroundColor Green }
function Warn($m) { Write-Host "     !    $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "     X    $m" -ForegroundColor Red }

Write-Host ''
Write-Host '================================================' -ForegroundColor White
Write-Host '   Claude Desktop 安装' -ForegroundColor White
Write-Host '================================================' -ForegroundColor White

Step '1/4' '检查 Claude Desktop'
$pkg = Get-AppxPackage -Name '*Claude*' -ErrorAction SilentlyContinue |
       Where-Object { $_.PackageFamilyName -like '*pzs8sxrjxfjjc*' } |
       Select-Object -First 1
if ($pkg) {
    Ok ("已安装 " + $pkg.Name + " " + $pkg.Version)
} elseif (Ensure-ClaudeMsix) {
    try {
        Add-AppxPackage -Path $Msix -ErrorAction Stop
        $pkg = Get-AppxPackage -Name '*Claude*' |
               Where-Object { $_.PackageFamilyName -like '*pzs8sxrjxfjjc*' } |
               Select-Object -First 1
        if ($pkg) { Ok ("安装完成 " + $pkg.Version) } else { Fail '安装命令执行了，但没查到 Claude 包' }
    } catch {
        Fail ('安装失败：' + $_.Exception.Message)
        Warn '如果是 0x80073D06 / 已存在 之类，说明其实已经装过了'
    }
} else {
    Fail '找不到 payload\claude\Claude-win-x64.msix'
    Warn '请先安装官方 Claude Desktop，或把 Claude-win-x64.msix 放到 payload\claude'
    Read-Host '按回车关闭'
    exit 1
}
if (-not $pkg) {
    Fail '没有找到可用的 Claude Desktop 包，安装中止'
    Read-Host '按回车关闭'
    exit 1
}

$old = Join-Path $env:LOCALAPPDATA 'AnthropicClaude\claude.exe'
if (Test-Path $old) {
    Warn "检测到旧版 Squirrel Claude（$old）"
    Warn '旧版会卡地区限制；建议手动卸载，只保留商店 MSIX 版'
}

Step '2/4' '写入 Claude 3p 配置'
$gwDir = Join-Path $env:LOCALAPPDATA 'ClaudeGateway\gateway'
$nodeExe = Join-Path $gwDir 'node.exe'
$boot = Join-Path $gwDir 'bootstrap.js'
if (-not (Test-Path $nodeExe)) { $nodeExe = Join-Path $Payload 'gateway\node.exe' }
if (-not (Test-Path $boot)) { $boot = Join-Path $Payload 'gateway\bootstrap.js' }
if ((Test-Path $nodeExe) -and (Test-Path $boot)) {
    try {
        $null = & $nodeExe $boot --quiet
        $cfg = Join-Path $env:LOCALAPPDATA 'Claude-3p\claude_desktop_config.json'
        $lib = Join-Path $env:LOCALAPPDATA 'Claude-3p\configLibrary'
        if ((Test-Path $cfg) -and (Test-Path $lib)) {
            Ok '已写入 3p 配置（Claude 不会再卡登录页 / 地区限制）'
        } else {
            Warn 'bootstrap.js 已运行，但没有看到 3p 配置文件'
        }
    } catch {
        Warn ('写入 3p 配置失败：' + $_.Exception.Message)
    }
} else {
    Warn '找不到 bootstrap.js / node.exe，跳过 3p 配置'
}

Step '3/4' '创建桌面图标'
$desk = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desk 'Claude.lnk'
$aumid = $pkg.PackageFamilyName + '!Claude'
$exe = Join-Path $pkg.InstallLocation 'app\Claude.exe'
$made = $false
try {
    $ws = New-Object -ComObject WScript.Shell
    $s = $ws.CreateShortcut($lnk)
    $s.TargetPath = "$env:windir\explorer.exe"
    $s.Arguments = 'shell:AppsFolder\' + $aumid
    $s.WorkingDirectory = $desk
    $s.Description = 'Claude Desktop'
    if (Test-Path $exe) { $s.IconLocation = "$exe,0" }
    $s.Save()
    $made = $true
} catch {
    try {
        $shell = New-Object -ComObject Shell.Application
        $apps = $shell.Namespace('shell:AppsFolder')
        $item = $apps.Items() | Where-Object { $_.Name -match 'Claude' } | Select-Object -First 1
        if ($item) {
            $shell.Namespace($desk).CopyHere($item, 0x14)
            $made = $true
        }
    } catch {}
}
if ($made) { Ok '已创建 Claude 桌面图标' } else { Warn '创建 Claude 桌面图标失败；请从开始菜单打开 Claude' }

Step '4/4' '打开 Claude'
try {
    Start-Process -FilePath 'explorer.exe' -ArgumentList ('shell:AppsFolder\' + $aumid)
    Ok '正在打开 Claude'
} catch {
    Warn ('打开 Claude 失败：' + $_.Exception.Message)
}

Write-Host ''
Write-Host '安装完成。请确认 Claude 进入的是主页，而不是登录页/地区限制页。' -ForegroundColor Green
Write-Host '如果仍然卡住，请运行网关面板里的「自建配置档」。' -ForegroundColor DarkGray
Read-Host '按回车关闭'
