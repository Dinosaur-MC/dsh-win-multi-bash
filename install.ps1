<#
.SYNOPSIS
    热插 dsh-win-multi-bash（自包含版）：把插件链接进 profile 的 node_modules，
    并把接线块写入 profile 的 cordis.patch.yml。dsh web 会热重载该文件，无需重启。

.DESCRIPTION
    本插件自带全部功能实现（lib/ 下打包的执行器与工具实例），只依赖已发布的
    @deepseek-ai 基础包。脚本做两件事：

      1) 在 <profile>/node_modules/dsh-win-multi-bash 建立指向本插件目录的
         junction，让组合行（name: 'dsh-win-multi-bash/...'）能解析到本包代码；
      2) 把 managed 接线块写入 profile 的 cordis.patch.yml（幂等：先删旧块再生成）。

    接线块是统一的（自包含版不再区分 insert/override 形态）：
      - pwsh-sandbox 静态禁用（其 pwsh 后端由本插件选择器的 pwsh: 分区持有）；
      - base 的 shell-select 行（若存在，即 base 已自带该接线）静态禁用，
        避免两个 ctx.shell 提供者抢席位；
      - 插入本插件的 win-mb-shell-select / win-mb-tool-git / win-mb-tool-wsl 行。

    可选：检测到本机 Git Bash 位于运行时默认探测路径之外（如非默认盘符的
    安装目录，或 PATH 里只有 C:\WINDOWS\system32\bash.exe 这个 WSL 启动器）
    时，自动在 shell-select 配置里写入 gitBash.bashPath 覆盖（探测所得的真实
    路径，非硬编码），保证 git_bash 工具路由到真正的 MSYS bash。

.PARAMETER ProfileName
    目标 profile 名，默认 web（即 ~/.dsh/profiles/web）。

.PARAMETER Force
    即使检测到该插件已作为 bundle 装入 profile（dsh plugin add 路径），也继续。
    两种路径同时存在会导致组合行重复，正常情况下应互斥。
#>
[CmdletBinding()]
param(
    [string]$ProfileName = 'web',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$pluginRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome "profiles\$ProfileName"
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
$profileNodeModules = Join-Path $profileDir 'node_modules'
$linkPath = Join-Path $profileNodeModules 'dsh-win-multi-bash'

if (-not (Test-Path $profileDir)) { throw "profile 不存在: $profileDir" }
if (-not (Test-Path $patchPath)) { throw "profile patch 不存在: $patchPath" }

# ── 0. 互斥检查：bundle 路径（dsh plugin add）与本热插路径不能同时使用 ─────
$manifestPath = Join-Path $profileDir 'package.json'
if (-not $Force -and (Test-Path $manifestPath)) {
    $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.dependencies.PSObject.Properties.Name -contains 'dsh-win-multi-bash') {
        throw '检测到 dsh-win-multi-bash 已作为 bundle 装入本 profile（dsh plugin add 路径）。' +
              '两种插拔路径互斥（组合行会重复导致 loader 报 duplicate entry id）。' +
              '请先用 `dsh plugin --profile <name> remove dsh-win-multi-bash` 卸载 bundle，' +
              '或加 -Force 强制继续（不推荐）。'
    }
}

# ── 1. 把插件链接进 profile node_modules（组合行解析 'dsh-win-multi-bash/...'） ─
if (-not (Test-Path $profileNodeModules)) {
    New-Item -ItemType Directory -Path $profileNodeModules -Force | Out-Null
}
if (Test-Path $linkPath) {
    $item = Get-Item $linkPath -Force
    if ($item.LinkType -eq 'Junction') {
        if ($item.Target -ieq $pluginRoot) {
            Write-Host "[dsh-win-multi-bash] 插件 junction 已存在且指向正确: $linkPath"
        } else {
            Write-Host "[dsh-win-multi-bash] 插件 junction 指向旧位置 ($($item.Target))，重建"
            cmd /c rmdir "$linkPath"
            New-Item -ItemType Junction -Path $linkPath -Target $pluginRoot | Out-Null
        }
    } else {
        Write-Host "[dsh-win-multi-bash] $linkPath 已存在但不是 junction，跳过（请手动确认其内容）"
    }
} else {
    New-Item -ItemType Junction -Path $linkPath -Target $pluginRoot | Out-Null
    Write-Host "[dsh-win-multi-bash] 已建立插件 junction: $linkPath"
}

# ── 1b. 插件本地运行时 junction：打包代码按真实路径解析 @deepseek-ai/*，
#        需要插件目录自带 node_modules/@deepseek-ai 指向本机 profile 运行时 ──
$runtimeScope = Join-Path $dshHome 'profiles\node_modules\@deepseek-ai'
$pluginScope = Join-Path $pluginRoot 'node_modules\@deepseek-ai'
if (Test-Path $runtimeScope) {
    if (-not (Test-Path $pluginScope)) {
        New-Item -ItemType Directory -Path (Join-Path $pluginRoot 'node_modules') -Force | Out-Null
        New-Item -ItemType Junction -Path $pluginScope -Target $runtimeScope | Out-Null
        Write-Host "[dsh-win-multi-bash] 已建立插件本地运行时 junction: $pluginScope"
    } elseif ((Get-Item $pluginScope -Force).Target -ine $runtimeScope) {
        Write-Host "[dsh-win-multi-bash] $pluginScope 指向 $((Get-Item $pluginScope -Force).Target)，期望 $runtimeScope —— 请手动处理"
    }
} else {
    Write-Host "[dsh-win-multi-bash] 警告：未找到运行时 $runtimeScope，打包代码的 @deepseek-ai 依赖将无法解析"
}

# ── 2. 本机 Git Bash 探测：默认解析会落空或落到 WSL 启动器时写 bashPath 覆盖 ──
$gitBashOverride = $null
$regInstall = $null
try { $regInstall = (Get-ItemProperty 'HKLM:\SOFTWARE\GitForWindows' -ErrorAction SilentlyContinue).InstallPath } catch { }
$regBash = if ($regInstall) { Join-Path $regInstall 'usr\bin\bash.exe' } else { $null }

# 复刻运行时 candidateBashPaths 的探测顺序（ProgramFiles → ProgramFiles(x86) → PATH）
$candidates = [System.Collections.Generic.List[string]]::new()
foreach ($pf in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if ($pf) {
        $candidates.Add((Join-Path $pf 'Git\bin\bash.exe'))
        $candidates.Add((Join-Path $pf 'Git\usr\bin\bash.exe'))
    }
}
foreach ($pe in ($env:PATH -split ';')) {
    $t = $pe.Trim().Trim('"')
    if ($t) { $candidates.Add((Join-Path $t 'bash.exe')) }
}
$firstExisting = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($null -ne $firstExisting) {
    $desc = (Get-Item $firstExisting).VersionInfo.FileDescription
    if ($desc -match 'Bash Launcher' -or $firstExisting -ieq 'C:\WINDOWS\system32\bash.exe') {
        Write-Host "[dsh-win-multi-bash] 默认解析会命中 WSL 启动器 ($firstExisting)，不是 Git Bash"
        if ($regBash -and (Test-Path $regBash)) { $gitBashOverride = $regBash }
    }
} elseif ($regBash -and (Test-Path $regBash)) {
    Write-Host '[dsh-win-multi-bash] 默认探测路径未找到 Git Bash，使用注册表安装路径'
    $gitBashOverride = $regBash
}
if ($gitBashOverride) { Write-Host "[dsh-win-multi-bash] gitBash.bashPath 覆盖 → $gitBashOverride" }

# ── 3. 生成 managed 块（统一形态） ───────────────────────────────────────────
$now = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$gitBashLines = if ($gitBashOverride) {
    "        gitBash:`n          bashPath: '$gitBashOverride'"
} else { '' }

$block = @"
# --- dsh-win-multi-bash managed (auto-generated by install.ps1 at $now; do not edit) ---
# Windows 多 bash 后端（自包含插件）：git_bash / wsl_bash 工具 + shell-select 路由。
- id: pwsh-sandbox
  disabled: true

- id: shell-select
  disabled: true

- insert:
    - id: win-mb-shell-select
      name: 'dsh-win-multi-bash/shell-select'
      disabled: !!js process.platform !== 'win32'
      config:
        backends: [git-bash, wsl-bash, pwsh]
        default: pwsh
$gitBashLines
        # 沙箱强化（可选）：探针失败时拒绝无沙箱运行，仅 danger-full-access 放行：
        #   gitBash: { requireSandbox: true }
        #   wslBash: { requireSandbox: true }
    - id: win-mb-tool-git
      name: 'dsh-win-multi-bash/tool-git-bash'
      disabled: !!js process.platform !== 'win32'
    - id: win-mb-tool-wsl
      name: 'dsh-win-multi-bash/tool-wsl-bash'
      disabled: !!js process.platform !== 'win32'
# --- end dsh-win-multi-bash managed ---
"@

# ── 4. 幂等写入：删旧块 → 追加新块（UTF-8 无 BOM） ─────────────────────────
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$existing = if (Test-Path $patchPath) { [System.IO.File]::ReadAllText($patchPath, $utf8NoBom) } else { '' }
$pattern = '(?s)# --- dsh-win-multi-bash managed.*?# --- end dsh-win-multi-bash managed ---\r?\n?'
$cleaned = [regex]::Replace($existing, $pattern, '')
$separator = if ($cleaned -and -not $cleaned.EndsWith("`n")) { "`n" } else { '' }
$newContent = $cleaned + $separator + $block
[System.IO.File]::WriteAllText($patchPath, $newContent, $utf8NoBom)

Write-Host ''
Write-Host "[dsh-win-multi-bash] 已写入 $patchPath"
Write-Host "[dsh-win-multi-bash] dsh web 正在运行时，watchUserPatches 会热重载本块 —— 新会话即可看到 git_bash / wsl_bash 工具（无需重启）。"
Write-Host "[dsh-win-multi-bash] 卸载：运行 uninstall.ps1（热移除 + 移除插件 junction，无需重启）。"
