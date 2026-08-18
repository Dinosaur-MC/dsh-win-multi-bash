<#
.SYNOPSIS
    运行 dsh-win-multi-bash 综合审计测试：单元测试（helpers/schema/executor
    internals）+ 真实 boot 集成测试（工具矩阵、路由、沙箱、后台任务、patch 语义）。

.DESCRIPTION
    与 run.ps1 相同的 junction 方案（不修改任何 profile）：
      - @deepseek-ai        → ~/.dsh/profiles/node_modules/@deepseek-ai
      - dsh-win-multi-bash  → 插件根目录
    跑完删除 junction。需要 node >= 20（本机 v22）。
    退出码 0 = 全部通过。
#>
$ErrorActionPreference = 'Stop'

$smoke = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginRoot = Split-Path -Parent $smoke
$runtimeScope = Join-Path $env:USERPROFILE '.dsh\profiles\node_modules\@deepseek-ai'
$nmDir = Join-Path $smoke 'node_modules'
$linkPlugin = Join-Path $nmDir 'dsh-win-multi-bash'
$linkScope = Join-Path $nmDir '@deepseek-ai'

if (-not (Test-Path $runtimeScope)) { throw "未找到运行时: $runtimeScope（先安装/更新 dsh profile 运行时）" }

# 打包代码按真实路径解析 @deepseek-ai/*，插件目录需要本地 junction
$pluginScope = Join-Path $pluginRoot 'node_modules\@deepseek-ai'
if (-not (Test-Path $pluginScope)) {
    New-Item -ItemType Directory -Path (Join-Path $pluginRoot 'node_modules') -Force | Out-Null
    New-Item -ItemType Junction -Path $pluginScope -Target $runtimeScope | Out-Null
}

function Ensure-Junction([string]$Path, [string]$Target) {
    if (Test-Path $Path) {
        $item = Get-Item $Path -Force
        if ($item.LinkType -eq 'Junction' -and $item.Target -ieq $Target) { return }
        throw "$Path 已存在且不是指向 $Target 的 junction，请手动处理"
    }
    New-Item -ItemType Junction -Path $Path -Target $Target | Out-Null
}

try {
    New-Item -ItemType Directory -Path $nmDir -Force | Out-Null
    Ensure-Junction $linkPlugin $pluginRoot
    Ensure-Junction $linkScope $runtimeScope

    node (Join-Path $smoke 'audit.test.mjs')
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    # PS 5.1 的 Remove-Item 删 junction 会抛 NullReferenceException（已知 bug），
    # 一律用 cmd rmdir（只删链接本身，绝不触碰链接目标）。
    if (Test-Path $linkPlugin) { cmd /c rmdir "$linkPlugin" 2>$null | Out-Null }
    if (Test-Path $linkScope) { cmd /c rmdir "$linkScope" 2>$null | Out-Null }
    if (Test-Path $nmDir) { cmd /c rmdir /s /q "$nmDir" 2>$null | Out-Null }
}
