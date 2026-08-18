<#
.SYNOPSIS
    热拔 dsh-win-multi-bash（自包含版）：从 profile 的 cordis.patch.yml 删除
    managed 块，并移除 profile node_modules 里的插件 junction。
    dsh web 会热重载，移除后新会话不再有 git_bash / wsl_bash 工具。

.PARAMETER ProfileName
    目标 profile 名，默认 web。
#>
[CmdletBinding()]
param(
    [string]$ProfileName = 'web'
)

$ErrorActionPreference = 'Stop'

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$patchPath = Join-Path $dshHome "profiles\$ProfileName\cordis.patch.yml"
$linkPath = Join-Path $dshHome "profiles\$ProfileName\node_modules\dsh-win-multi-bash"

$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$removed = $false

if (Test-Path $patchPath) {
    $existing = [System.IO.File]::ReadAllText($patchPath, $utf8NoBom)
    $pattern = '(?s)# --- dsh-win-multi-bash managed.*?# --- end dsh-win-multi-bash managed ---\r?\n?'
    $removed = $existing -match $pattern
    if ($removed) {
        [System.IO.File]::WriteAllText($patchPath, [regex]::Replace($existing, $pattern, ''), $utf8NoBom)
        Write-Host "[dsh-win-multi-bash] 已从 $patchPath 移除 managed 块。热重载后新会话不再有 git_bash / wsl_bash 工具。"
    } else {
        Write-Host "[dsh-win-multi-bash] $patchPath 中没有 managed 块。"
    }
}

if (Test-Path $linkPath) {
    $item = Get-Item $linkPath -Force
    if ($item.LinkType -eq 'Junction') {
        # PS 5.1 的 Remove-Item 删 junction 会抛 NullReferenceException（已知 bug），
        # 用 cmd rmdir（只删链接本身，绝不触碰链接目标）。
        cmd /c rmdir "$linkPath"
        Write-Host "[dsh-win-multi-bash] 已移除插件 junction: $linkPath"
    } else {
        Write-Host "[dsh-win-multi-bash] $linkPath 存在但不是 junction，未动（请手动处理）"
    }
}

if (-not $removed -and -not (Test-Path $linkPath)) {
    Write-Host "[dsh-win-multi-bash] 若你是用 bundle 路径安装的（dsh plugin add），请运行: dsh plugin --profile $ProfileName remove dsh-win-multi-bash"
}
