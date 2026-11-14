#Requires -Version 5.1
<#
.SYNOPSIS
    构建 YuE2 代码更新包（code-only zip）与更新清单，供上传到 Gitee Release。
.DESCRIPTION
    只打包代码：app\、根脚本、version.json、update.json、README.md。
    明确排除 runs\、YuE\、demo\、tools\、docs\、design\、test-run\、.git 等。
    产出：
      <Out>\yue2-code-<version>.zip
      <Out>\latest.json
    上传步骤见脚本末尾输出。
.EXAMPLE
    powershell -File tools\publish-release.ps1 -Changelog "修复歌词对齐；改进更新提示"
#>
[CmdletBinding()]
param(
    [string]$Out = "",
    [string]$Changelog = "",
    [string]$UpdateUrl = "",
    [string]$MinVersion = "0.1.0",
    [string]$Channel = "stable"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
if (-not $Out) { $Out = Join-Path $Root "runs\_release" }
$Out = [System.IO.Path]::GetFullPath($Out)
New-Item -ItemType Directory -Force -Path $Out | Out-Null

$verPath = Join-Path $Root "version.json"
if (-not (Test-Path -LiteralPath $verPath)) { throw "缺少 version.json：$verPath" }
$ver = Get-Content -LiteralPath $verPath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$ver.version
if (-not $version) { throw "version.json 缺少 version 字段" }

# ---------------------------------------------------------------- 暂存代码
$stage = Join-Path $env:TEMP ("yue2-release-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $stage | Out-Null
$copyItems = @("app", "version.json", "update.json", "start.bat", "stop.bat", "clean.bat", "README.md")
foreach ($item in $copyItems) {
    $src = Join-Path $Root $item
    if (-not (Test-Path -LiteralPath $src)) { continue }
    $dst = Join-Path $stage $item
    if ((Get-Item -LiteralPath $src).PSIsContainer) {
        Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force
    } else {
        Copy-Item -LiteralPath $src -Destination $dst -Force
    }
}
Get-ChildItem -LiteralPath (Join-Path $stage "app") -Recurse -Directory -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq "__pycache__" } |
    ForEach-Object { [System.IO.Directory]::Delete($_.FullName, $true) }

# ---------------------------------------------------------------- 打 zip
$zipName = "yue2-code-$version.zip"
$zipPath = Join-Path $Out $zipName
if (Test-Path -LiteralPath $zipPath) { [System.IO.File]::Delete($zipPath) }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    $files = Get-ChildItem -LiteralPath $stage -Recurse -File -Force
    foreach ($file in $files) {
        $rel = $file.FullName.Substring($stage.Length + 1).Replace("\", "/")
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $rel) | Out-Null
    }
} finally {
    $zip.Dispose()
}
[System.IO.Directory]::Delete($stage, $true)

$sha = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLower()
$size = (Get-Item -LiteralPath $zipPath).Length
$zipMB = [math]::Round($size / 1MB, 2)

# ---------------------------------------------------------------- 清单
if (-not $UpdateUrl) {
    $UpdateUrl = "https://gitee.com/<owner>/<repo>/releases/download/v$version/$zipName"
}
$manifest = [ordered]@{
    version      = $version
    channel      = $Channel
    url          = $UpdateUrl
    sha256       = $sha
    size         = $size
    changelog    = $Changelog
    published_at = (Get-Date -Format "yyyy-MM-dd")
    min_version  = $MinVersion
}
$manifestPath = Join-Path $Out "latest.json"
$json = $manifest | ConvertTo-Json
[System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ""
Write-Host "发布包已生成" -ForegroundColor Green
Write-Host "  zip     : $zipPath"
Write-Host "  manifest: $manifestPath"
Write-Host ("  size    : {0} MB   sha256: {1}" -f $zipMB, $sha)
Write-Host ""
Write-Host "上传到 Gitee（仓库建好后）：" -ForegroundColor Cyan
Write-Host "  1. 把 update.json 的 update_url 改成真实 raw 地址，重新打包整合包。"
Write-Host "  2. 在 Gitee 发一个 Release（标签 v$version），把 zip 作为附件上传。"
Write-Host "  3. 把 latest.json 提交到仓库的 releases/ 目录并推送。"
Write-Host "  4. 确认 latest.json 里的 url 指向该 Release 附件的下载地址。"
Write-Host ""