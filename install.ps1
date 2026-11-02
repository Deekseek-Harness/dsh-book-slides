<#
  把「精讲台」装进 DSH 的 web profile。

  做两件事：
    1. dsh plugin --profile web add <本目录>   —— pnpm 把本地目录链进 profile
    2. 把 dsh-book-slides 写进 profile package.json 的 dsh.profile.bundles

  跑完要重启 DSH 才会出现「精讲」图标。重复运行是安全的。

  卸载：
    dsh plugin --profile web remove dsh-book-slides
    再把 dsh-book-slides 从 bundles 里删掉（本脚本不会代劳）
#>
$ErrorActionPreference = 'Stop'

$pluginDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$packageName = 'dsh-book-slides'
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome 'profiles\web'
$profilePkg = Join-Path $profileDir 'package.json'

if (-not (Test-Path $profilePkg)) {
  throw "找不到 web profile：$profilePkg（先跑一次 dsh web，让 profile 初始化）"
}

Write-Host "[1/2] 把 $pluginDir 链进 web profile ..." -ForegroundColor Cyan
& dsh plugin --profile web add $pluginDir
if ($LASTEXITCODE -ne 0) { throw "pnpm add 失败（退出码 $LASTEXITCODE）" }

Write-Host "[2/2] 把 $packageName 写进 dsh.profile.bundles ..." -ForegroundColor Cyan
$json = Get-Content -LiteralPath $profilePkg -Raw -Encoding utf8 | ConvertFrom-Json
if (-not $json.dsh) { throw 'profile package.json 里没有 dsh 段，拒绝乱改' }
if (-not $json.dsh.profile) { $json.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) }
$bundles = @()
if ($json.dsh.profile.bundles) { $bundles = @($json.dsh.profile.bundles) }
if ($bundles -contains $packageName) {
  Write-Host "      已经在 bundles 里了，跳过。" -ForegroundColor DarkGray
} else {
  $bundles += $packageName
  $json.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force
  $json | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $profilePkg -Encoding utf8
  Write-Host "      已加入：" -NoNewline; Write-Host ($bundles -join ', ')
}

Write-Host ''
Write-Host ' 装好了。重启 DSH 之后，左侧栏会出现「精讲」图标。' -ForegroundColor Green
Write-Host ' 数据目录：' -NoNewline; Write-Host (Join-Path $dshHome 'book-slides')
