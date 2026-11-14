#Requires -Version 5.1
<#
.SYNOPSIS
    打包 YuE2 整合包：代码 + 便携 Python 运行时 + 模型权重，放到指定目录，用户拿来即用。
.DESCRIPTION
    专门处理三类会导致「换台机器就跑不起来」的绝对路径问题：
      1. venv 里的 torch 是指向外部缓存的目录链接。打包时展开成包内真实目录。
      2. 开发机的 venv 解释器在 YuE\.venv\Scripts\python.exe，且 pyvenv.cfg 写死了基础
         Python 的绝对路径。整合包改用 embeddable Python（自包含、无 pyvenv.cfg），
         放在 YuE\.venv\python.exe。
      3. activate.bat / direct_url.json 里的旧绝对路径：整个 venv 布局不复制，只取 Lib\site-packages。
    模型权重（YuE\models）完整复制，不压缩。
#>
[CmdletBinding()]
param(
    [string]$Target = "F:\开源语音模型整合包\Yue2",
    [string]$EmbedVersion = "3.11.9",
    [switch]$IncludeTools,
    [switch]$Force,
    [switch]$SkipVerify
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Cache = Join-Path $PSScriptRoot ".bundle-cache"

function Write-Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "    $text" -ForegroundColor Green }
function Write-Warn2($text){ Write-Host "    $text" -ForegroundColor Yellow }

function Get-SizeMB([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return 0 }
    $item = Get-Item -LiteralPath $path
    if ($item.PSIsContainer) {
        return [math]::Round(((Get-ChildItem -LiteralPath $path -Recurse -File -Force -ErrorAction SilentlyContinue |
                               Measure-Object -Property Length -Sum).Sum / 1MB), 1)
    }
    return [math]::Round($item.Length / 1MB, 1)
}

function Invoke-Robo {
    param([string]$From, [string]$To, [string[]]$Xd = @(), [string[]]$Xf = @())
    $a = @($From, $To, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/R:1", "/W:1")
    if ($Xd) { $a += "/XD"; $a += $Xd }
    if ($Xf) { $a += "/XF"; $a += $Xf }
    & robocopy @a | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy 失败 (exit=$LASTEXITCODE): $From -> $To" }
}

# ---------------------------------------------------------------- 安全校验
$targetFull = [System.IO.Path]::GetFullPath($Target)
if ($targetFull -eq [System.IO.Path]::GetFullPath($Root)) { throw "目标目录不能是源仓库本身" }
if ($targetFull -match '^[A-Za-z]:\\$') { throw "目标目录不能是盘符根目录" }
$parent = Split-Path -Parent $targetFull
if (-not (Test-Path -LiteralPath $parent)) { throw "目标父目录不存在：$parent" }

Write-Host ""
Write-Host "YuE2 整合包打包" -ForegroundColor White
Write-Host "  源:   $Root"
Write-Host "  目标: $targetFull"
Write-Host ""

Write-Step "预检"
$required = @(
    (Join-Path $Root "app\server.py"),
    (Join-Path $Root "YuE\src\yue2\pipeline.py"),
    (Join-Path $Root "YuE\.venv\Lib\site-packages"),
    (Join-Path $Root "YuE\models\YuE2-3B\model.safetensors"),
    (Join-Path $Root "YuE\models\YuE2-Vae\model.safetensors"),
    (Join-Path $Root "start.bat"),
    (Join-Path $Root "stop.bat"),
    (Join-Path $Root "version.json")
)
foreach ($r in $required) {
    if (-not (Test-Path -LiteralPath $r)) { throw "缺少必要文件：$r" }
}
Write-Ok "源文件齐全"

# ---------------------------------------------------------------- 版本与更新源
Write-Step "写版本与更新配置"
$verPath = Join-Path $Root "version.json"
$verVersion = "0.1.0"
if (Test-Path -LiteralPath $verPath) {
    try { $verObj = Get-Content -LiteralPath $verPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $verObj = $null }
    if ($verObj -and $verObj.version) { $verVersion = [string]$verObj.version }
}
$commit = ""
try { $commit = (git -C $Root rev-parse --short HEAD 2>$null) } catch { }
if ($commit) { $commit = $commit.Trim() }
$builtAt = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssK")
$verJson = @"
{"version":"$verVersion","commit":"$commit","built_at":"$builtAt"}
"@
[System.IO.File]::WriteAllText($verPath, $verJson, (New-Object System.Text.UTF8Encoding($false)))
$updPath = Join-Path $Root "update.json"
if (-not (Test-Path -LiteralPath $updPath)) {
    $updJson = @"
{"update_url":"https://gitee.com/<owner>/<repo>/raw/main/releases/latest.json","channel":"stable","auto_check":false}
"@
    [System.IO.File]::WriteAllText($updPath, $updJson, (New-Object System.Text.UTF8Encoding($false)))
    Write-Ok "已生成默认 update.json（请改成真实 Gitee 仓库地址）"
}
Write-Ok ("版本 {0}  commit {1}" -f $verVersion, $(if ($commit) { $commit } else { "none" }))

$drive = $targetFull.Substring(0, 1)
$freeGB = [math]::Round((Get-PSDrive -Name $drive).Free / 1GB, 1)
Write-Ok ("目标盘 {0}: 剩余 {1} GB" -f $drive, $freeGB)
if ($freeGB -lt 16) { throw "目标盘剩余空间不足 16 GB（预计需要约 13 GB）" }

if (Test-Path -LiteralPath $targetFull) {
    if (-not $Force) { throw "目标目录已存在。确认要清空请加 -Force：$targetFull" }
    Write-Warn2 "清空已存在的目标目录"
    [System.IO.Directory]::Delete($targetFull, $true)
}
New-Item -ItemType Directory -Force -Path $targetFull | Out-Null

# ---------------------------------------------------------------- 1. 代码
Write-Step "复制代码"
$xd = @(".git", ".github", ".venv", "models", "docs", "assets", "build", "tests",
        "runs", "_trash", "test-run", "design", ".workbuddy-ai", "evidence",
        "__pycache__", "node_modules", ".bundle-cache", "wheels")
$xf = @("*.zip", "*.log", "*.db", "*.db-shm", "*.db-wal", "*.pdf",
        ".DS_Store", "Thumbs.db", "YuE2-UI-Demo.html")
Invoke-Robo -From $Root -To $targetFull -Xd $xd -Xf $xf
if (-not $IncludeTools) {
    if (Test-Path -LiteralPath (Join-Path $targetFull "tools")) {
        [System.IO.Directory]::Delete((Join-Path $targetFull "tools"), $true)
    }
}
if (Test-Path -LiteralPath (Join-Path $targetFull "demo\fonts")) {
    [System.IO.Directory]::Delete((Join-Path $targetFull "demo\fonts"), $true)
}
if (-not (Test-Path -LiteralPath (Join-Path $targetFull "demo\showcase"))) {
    New-Item -ItemType Directory -Force -Path (Join-Path $targetFull "demo\showcase") | Out-Null
    Invoke-Robo -From (Join-Path $Root "demo\showcase") -To (Join-Path $targetFull "demo\showcase")
}
if (Test-Path -LiteralPath (Join-Path $targetFull "README.md")) {
    [System.IO.File]::Delete((Join-Path $targetFull "README.md"))
}
Write-Ok ("代码 {0} MB" -f (Get-SizeMB $targetFull))

# ---------------------------------------------------------------- 2. 权重
Write-Step "复制模型权重"
Invoke-Robo -From (Join-Path $Root "YuE\models") -To (Join-Path $targetFull "YuE\models")
foreach ($m in @("YuE2-3B", "YuE2-Vae")) {
    $p = Join-Path $targetFull "YuE\models\$m\model.safetensors"
    if (-not (Test-Path -LiteralPath $p)) { throw "权重没有复制完整：$p" }
}
Write-Ok ("权重 {0} MB" -f (Get-SizeMB (Join-Path $targetFull "YuE\models")))

# ---------------------------------------------------------------- 3. 运行时
Write-Step "部署便携 Python 运行时"
$venvDst = Join-Path $targetFull "YuE\.venv"
New-Item -ItemType Directory -Force -Path (Join-Path $venvDst "Lib") | Out-Null

# 3a. site-packages（robocopy 会跟随目录链接，把 torch 变成真实文件）
$spSrc = Join-Path $Root "YuE\.venv\Lib\site-packages"
$spDst = Join-Path $venvDst "Lib\site-packages"
Invoke-Robo -From $spSrc -To $spDst -Xd @("__pycache__")

# 3b. 校验：不能留下任何目录链接（否则换机器就断）
$links = Get-ChildItem -LiteralPath $spDst -Recurse -Force -ErrorAction SilentlyContinue |
         Where-Object { $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint }
if ($links) {
    foreach ($l in $links) { Write-Warn2 ("残留链接：{0} -> {1}" -f $l.FullName, $l.Target) }
    throw "site-packages 里仍有目录链接，打包不可用"
}
Write-Ok ("site-packages {0} MB（目录链接已全部展开）" -f (Get-SizeMB $spDst))

# 3c. embeddable Python
$zip = Join-Path $Cache "python-$EmbedVersion-embed-amd64.zip"
if (-not (Test-Path -LiteralPath $zip)) {
    New-Item -ItemType Directory -Force -Path $Cache | Out-Null
    $url = "https://www.python.org/ftp/python/$EmbedVersion/python-$EmbedVersion-embed-amd64.zip"
    Write-Ok "下载 embeddable Python $EmbedVersion"
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 300
}
$tmp = Join-Path $env:TEMP ("yue2-embed-" + [guid]::NewGuid().ToString("N"))
Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
Invoke-Robo -From $tmp -To $venvDst -Xd @("__pycache__")
[System.IO.Directory]::Delete($tmp, $true)

# 3d. 让 embeddable 启用 site（否则 site-packages 不生效）
$pth = Join-Path $venvDst "python311._pth"
$pthText = [System.IO.File]::ReadAllText($pth)
if ($pthText -match '#\s*import site') {
    $pthText = $pthText -replace '#(\s*import site)', '$1'
    [System.IO.File]::WriteAllText($pth, $pthText, [System.Text.Encoding]::ASCII)
}
if (-not (Test-Path -LiteralPath (Join-Path $venvDst "python.exe"))) {
    throw "embeddable Python 没有就位：$venvDst\python.exe"
}
Write-Ok ("运行时 {0} MB" -f (Get-SizeMB $venvDst))

# ---------------------------------------------------------------- 4. 说明 + 清单
Write-Step "写使用说明与清单"
$guide = @"
# YuE2 本地音乐工作台 · 整合包

开箱即用：代码、Python 运行时、模型权重都已在本目录内，不需要联网安装任何东西。

## 先确认硬件

- Windows 10 / 11 64 位
- NVIDIA 显卡，BF16 需算力 8.0 以上（RTX 30 系起）
- 官方建议 24GB 显存；8GB 卡能跑短歌，显存不够会自动降级到 CPU（单首约 8.5 分钟）
- 剩余磁盘 20GB 以上

## 启动 / 停止

双击 start.bat（默认端口 9090），浏览器会自动打开 http://127.0.0.1:9090
换端口：start.bat 9091，停止用 stop.bat 9091
--no-pause 供自动化使用。

## 第一次用

1. 打开页面后点右上角「加载模型」，选显卡或 CPU（第一次约 1 分钟）
2. 创作页点「载入范例」→「生成歌曲」
3. 卡住了看界面里的「界面巡览」和「使用指南」

## 目录说明

| 路径 | 是什么 |
|---|---|
| app/ | 网页工作台（FastAPI + 原生 JS） |
| YuE/ | 官方引擎、权重、技能脚本 |
| YuE/.venv/ | 自带的 Python 运行时和依赖（不要删） |
| YuE/models/ | 模型权重（约 7.8GB） |
| demo/showcase/ | 内置示例曲，启动后自动导入曲库 |
| runs/ | 运行数据：任务产物、日志、SQLite 索引 |
| 使用说明.md | 本文件 |

## 常见问题

- 端口起不来：Windows 的 Hyper-V / WSL / Docker 会保留一段端口，start.bat 会提示。
  查保留段：netsh int ipv4 show excludedportrange protocol=tcp，换个端口即可。
- 显存不足：界面会自动降级到 CPU，能跑但慢很多。
- 模型缺失：界面「系统」页的 doctor 会明确报告缺什么。
- 本整合包不需要 activate，也不要设 VIRTUAL_ENV。

## 许可

- 代码：Apache 2.0（见 YuE/LICENSE）
- 模型权重：CC BY-NC 4.0 + 附加条款（见 YuE/MODEL_LICENSE），非商业用途，不要二次分发权重
- 第三方依赖的许可见 YuE/THIRD_PARTY_NOTICES.md 与 YuE/licenses/
"@
[System.IO.File]::WriteAllText((Join-Path $targetFull "使用说明.md"), $guide, (New-Object System.Text.UTF8Encoding($false)))

$manifest = @(
    "YuE2 整合包清单",
    "生成时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')",
    "源仓库:   $Root",
    "版本:     $($verVersion)  ($($commit))",
    "目标:     $targetFull",
    "",
    ("代码:     {0,9:N1} MB" -f (Get-SizeMB (Join-Path $targetFull "app"))),
    ("运行时:   {0,9:N1} MB" -f (Get-SizeMB $venvDst)),
    ("权重:     {0,9:N1} MB" -f (Get-SizeMB (Join-Path $targetFull "YuE\models"))),
    ("合计:     {0,9:N1} MB" -f (Get-SizeMB $targetFull)),
    "",
    "Python: $EmbedVersion (embeddable, 自包含)",
    "解释器: YuE\.venv\python.exe"
) -join "`r`n"
[System.IO.File]::WriteAllText((Join-Path $targetFull "bundle-manifest.txt"), $manifest, (New-Object System.Text.UTF8Encoding($false)))
Write-Ok "使用说明.md / bundle-manifest.txt"

# 清理脚本（整合包自带，给用户测试后收拾用）
$cleanSrc = Join-Path $PSScriptRoot "clean-bundle.bat"
if (Test-Path -LiteralPath $cleanSrc) {
    Copy-Item -LiteralPath $cleanSrc -Destination (Join-Path $targetFull "clean.bat") -Force
    Write-Ok "clean.bat"
}

# ---------------------------------------------------------------- 5. 验证
if (-not $SkipVerify) {
    Write-Step "验证打包结果"
    $py = Join-Path $venvDst "python.exe"
    Push-Location $targetFull
    try {
        $probe = & $py -c "import sys, torch, fastapi, uvicorn, numpy, soundfile, onnxruntime, yue2; print('PYOK', sys.version.split()[0], torch.__version__)" 2>&1
        if ($LASTEXITCODE -ne 0) { throw "导入自检失败：$probe" }
        Write-Ok ($probe | Select-Object -Last 1)

        $doctor = & $py -m yue2.cli doctor 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Warn2 "doctor 返回非 0（不阻断打包）：$($doctor | Select-Object -Last 3)"
        } else {
            Write-Ok "doctor 通过"
        }
    } finally { Pop-Location }

    Write-Ok "网页服务自检（端口 9099）"
    $port = "9099"
    $null = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "start.bat", $port, "--no-pause" `
                              -WorkingDirectory $targetFull -WindowStyle Hidden -PassThru
    $healthy = $false
    $h = $null
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Seconds 1
        try {
            $h = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 3
            if ($h.status -eq "ok") { $healthy = $true; break }
        } catch { }
    }
    if (-not $healthy) { throw "整合包启动后 /api/health 没有就绪" }
    Write-Ok ("health: jobs={0} status={1}" -f $h.jobs, $h.status)
    & cmd.exe /c "stop.bat $port --no-pause" | Out-Null
    Start-Sleep -Seconds 2
}

Write-Host ""
Write-Host ("打包完成：{0}  ({1:N1} MB)" -f $targetFull, (Get-SizeMB $targetFull)) -ForegroundColor Green
Write-Host ""
