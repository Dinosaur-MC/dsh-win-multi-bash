<#
.SYNOPSIS
    运行 dsh-win-multi-bash 冒烟测试：在 profile 运行时上 boot 真实组合，
    验证插件自带的 git_bash / wsl_bash 工具注册并真实执行（含显式 bashPath 变体）。

.DESCRIPTION
    在 smoke/node_modules 下建立两个 junction（不修改任何 profile）：
      - @deepseek-ai        → ~/.dsh/profiles/node_modules/@deepseek-ai（运行时基础包）
      - dsh-win-multi-bash  → 插件根目录（本包自身代码）
    跑完删除 junction 与生成的 fixture。需要 node >= 20（本机 v22）。
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

<#
.SYNOPSIS
    探测本机真实 Git Bash 路径（与插件 resolveBashPath 同一策略，绝不硬编码）：
    Program Files 常见位置 → PATH 上的 bash.exe（排除 System32 的 WSL 启动器）
    → 从 PATH 上 git.exe 布局目录（cmd/bin/usr\bin）反推 Git 根。
    探测不到返回 $null。
#>
function Find-GitBash {
    $candidates = [System.Collections.Generic.List[string]]::new()
    foreach ($pf in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if ($pf) {
            $candidates.Add((Join-Path $pf 'Git\bin\bash.exe'))
            $candidates.Add((Join-Path $pf 'Git\usr\bin\bash.exe'))
        }
    }
    $wslLauncher = (Join-Path $env:SystemRoot 'System32\bash.exe').ToLowerInvariant()
    $roots = [System.Collections.Generic.List[string]]::new()
    $seen = @{}
    foreach ($pe in ($env:PATH -split ';')) {
        $t = $pe.Trim().Trim('"')
        if (-not $t) { continue }
        $candidates.Add((Join-Path $t 'bash.exe'))
        $base = Split-Path -Leaf $t
        if ($base -ne 'cmd' -and $base -ne 'bin') { continue }
        $parent = Split-Path -Parent $t
        $root = if ($base -eq 'cmd' -or (Split-Path -Leaf $parent) -ne 'usr') { $parent } else { Split-Path -Parent $parent }
        if (-not (Test-Path (Join-Path $t 'git.exe'))) { continue }
        $key = $root.ToLowerInvariant()
        if (-not $seen.ContainsKey($key)) {
            $seen[$key] = $true
            $roots.Add($root)
        }
    }
    foreach ($root in $roots) {
        $candidates.Add((Join-Path $root 'usr\bin\bash.exe'))
        $candidates.Add((Join-Path $root 'bin\bash.exe'))
    }
    foreach ($c in $candidates) {
        if ($c.ToLowerInvariant() -eq $wslLauncher) { continue }
        if (Test-Path $c) { return $c }
    }
    return $null
}

try {
    New-Item -ItemType Directory -Path $nmDir -Force | Out-Null
    Ensure-Junction $linkPlugin $pluginRoot
    Ensure-Junction $linkScope $runtimeScope

    $tpl = [System.IO.File]::ReadAllText((Join-Path $smoke 'fixture.template.cordis.yml'))
    $default = $tpl.Replace('__BASH_PATH__', '')
    [System.IO.File]::WriteAllText((Join-Path $smoke 'fixture.default.cordis.yml'), $default, [System.Text.UTF8Encoding]::new($false))

    Write-Host '=== default (schema-default bash resolution) ==='
    node (Join-Path $smoke 'driver.mjs') (Join-Path $smoke 'fixture.default.cordis.yml')

    $gitBash = Find-GitBash
    if ($gitBash) {
        Write-Host ''
        Write-Host "=== pinned (explicit gitBash.bashPath → $gitBash) ==="
        $pinned = $tpl.Replace('__BASH_PATH__', $gitBash)
        [System.IO.File]::WriteAllText((Join-Path $smoke 'fixture.pinned.cordis.yml'), $pinned, [System.Text.UTF8Encoding]::new($false))
        node (Join-Path $smoke 'driver.mjs') (Join-Path $smoke 'fixture.pinned.cordis.yml')
    } else {
        Write-Host ''
        Write-Host '=== pinned (skipped: 本机未探测到 Git Bash，无法构造显式 bashPath 变体) ==='
    }
} finally {
    # PS 5.1 的 Remove-Item 删 junction 会抛 NullReferenceException（已知 bug），
    # 一律用 cmd rmdir（只删链接本身，绝不触碰链接目标）。
    if (Test-Path $linkPlugin) { cmd /c rmdir "$linkPlugin" 2>$null | Out-Null }
    if (Test-Path $linkScope) { cmd /c rmdir "$linkScope" 2>$null | Out-Null }
    if (Test-Path $nmDir) { cmd /c rmdir /s /q "$nmDir" 2>$null | Out-Null }
    Remove-Item (Join-Path $smoke 'fixture.default.cordis.yml') -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $smoke 'fixture.pinned.cordis.yml') -Force -ErrorAction SilentlyContinue
}
