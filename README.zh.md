[English](README.md) | 中文

# dsh-win-multi-bash

适用于 DeepSeek Harness 的 Windows multi-bash 插件：`git_bash` / `wsl_bash` 模型工具 + `shell-select` 执行器，在唯一的 `ctx.shell` 席位上路由 Git Bash、WSL 与 pwsh。pwsh 保持默认，未调用 bash 系工具前现有行为完全不变。

## 功能一览

| 工具名 | 后端 | 方言 | 说明 |
| --- | --- | --- | --- |
| `git_bash` | git-bash | MSYS | `request.shell: 'git-bash'`，Git for Windows 工具链 |
| `wsl_bash` | wsl-bash | Linux | `request.shell: 'wsl-bash'`，WSL 发行版内 Linux userland |
| `pwsh`（原有） | pwsh | — | 选择器默认路由，行为与未装插件时完全一致 |

- `shell-select` 占据唯一的 `ctx.shell` 席位，按 `request.shell ?? default` 路由；`default` 保持 `pwsh`。
- 可执行文件解析与沙箱探测全部惰性化：未安装 Git Bash / WSL 不影响 pwsh，首次使用时才响亮报错。
- Git Bash 自动查找，顺序为：显式 `gitBash.bashPath` → 常见 Program Files 位置 → PATH 上的 `bash.exe`（**绝不选** Windows 的 WSL 启动器 `System32\bash.exe`——本工具是 MSYS 而非 WSL）→ 从 PATH 上 `git.exe` 布局目录反推的 Git 安装根（因此通过 `git` 可达的安装无需钉定即可找到）→ 最后读取 `HKLM\SOFTWARE\GitForWindows` 注册表安装路径（Git for Windows 安装器必写该键，覆盖自定义盘符与便携安装）。
- 沙箱 `auto`：Git Bash 探测 windows-acl runner，WSL 探测发行版内 `bwrap`；探测失败如实降级为无限制运行并如实报告。显式 `sandbox: bwrap` 而发行版缺少 bubblewrap 时，在首次执行 `wsl_bash` 命令时响亮报错（不会拖垮启动），其余后端不受影响。
- 所有行在 host 平面注册：无论会话使用哪个 agent preset，都能看到这两个工具。

## 沙箱行为（重要，请先阅读 ⚠️）

三个后端的文件沙箱**能力不同**，使用前务必确认：

| 后端 | 沙箱机制 | enforcement | 探针失败时的行为 |
| --- | --- | --- | --- |
| `pwsh` | windows-acl 受限令牌（restricted-token runner） | partial | 无探针——始终受限 |
| `wsl_bash` | 发行版内 `bwrap`（bubblewrap） | full | 无沙箱运行，结果不携带沙箱事实 |
| `git_bash` | windows-acl runner 包 MSYS bash | partial（探针通过时） | 探针失败则无沙箱运行，结果不携带沙箱事实 |

> ⚠️ **`git_bash` 在 Git for Windows 部署下通常无法沙箱化。** windows-acl runner 以受限令牌拉起 MSYS `bash.exe` 时 `CreateProcessAsUserW` 返回 Win32 error 2（`cmd.exe`、`pwsh.exe` 均可正常拉起）；`sandbox: auto` 的探针失败后按契约降级为**无限制运行**。**不要假设 `git_bash` 受 DSH 沙箱保护**——敏感操作请改用 `pwsh`（受限令牌生效）或 `wsl_bash`（bwrap 生效），或走显式升级审批。
>
> ⚠️ **`wsl_bash` 的沙箱依赖发行版内的 bubblewrap。** 未安装 bwrap 时 `auto` 同样降级为无限制运行；探针结果在**宿主进程生命周期内缓存**——安装 bwrap 后必须重启 `dsh web`（或改动 shell 设置节触发后端重建）才会重新探测。
>
> ⚠️ **拒绝判定要求命令以非零退出结束。** 被拦截的写操作若以成功命令收尾（如 `echo nope > /etc/x; echo done`），整体退出码为 0，不会标记 `[sandbox: file access denied]`（与上游 bash-sandbox 的判定规则一致，避免误报）。
>
> 沙箱只约束**文件系统效果**（`workspace-write` / `read-only`），不限制网络、进程等其它资源。
> **`requireSandbox`：探针失败时拒绝无沙箱运行（可选强化）。** 两个后端均支持 `requireSandbox: true`（默认 `false`，保持既有降级行为）。开启后，探针失败（git-bash 的 windows-acl 不可用 / wsl-bash 缺少 bwrap）时：`danger-full-access` 模式下照常放行（无沙箱运行等价于显式全权批准），`read-only` / `workspace-write` 模式下**拒绝执行**并报错，提示修复沙箱或升级到 `danger-full-access`。同时工具层会声明沙箱并开放 `sandbox_permissions` 升级参数，使模型可以走审批升级。示例：

> ```yaml
> # cordis.patch.yml 的 win-mb-shell-select 行
> config:
>   backends: [git-bash, wsl-bash, pwsh]
>   default: pwsh
>   gitBash: { requireSandbox: true }
>   wslBash: { requireSandbox: true }
> ```

> 注意：`requireSandbox` 与 `sandbox: none` 互斥使用——显式 `none` 是用户主动放弃沙箱，保持放行；`requireSandbox` 只管「想沙箱但探针失败」的情形。

### 为 `wsl_bash` 启用 bwrap 沙箱

`wsl_bash` 的沙箱需要发行版内有 bubblewrap。Ubuntu/Debian 系安装：

```bash
wsl.exe -d Ubuntu-24.04 -e sudo apt-get install -y bubblewrap   # 从 Windows 侧直接安装
wsl.exe -d Ubuntu-24.04 -e bash -c "command -v bwrap && bwrap --version"   # 验证
```

- 探针探测的是 `wsl -l -q` 的**第一个发行版**；若目标发行版不是第一个，在 `cordis.patch.yml` 的 `wslBash.wslDistro` 钉定它，并**在该发行版内**安装 bwrap（如 `Ubuntu-24.04`；`docker-desktop` 无 bash，不可用）。
- `sudo` 可能需要密码（取决于发行版的 sudoers 配置）；脚本化请用 `apt-get install -y`。
- 其它发行版系：Fedora `dnf install bubblewrap`，Alpine `apk add bubblewrap`。
- 装完后**必须重启 `dsh web`**（或改动 shell 设置节触发后端重建）——探针结果在宿主进程生命周期内缓存，重启前 `wsl_bash` 仍按无沙箱运行。

## 路径转换（MSYS 自动改写）

Git Bash 在调用原生 Windows 程序时会把形如 `/root` 的 POSIX 路径自动改写成 Windows 路径（如 `<Git 根目录>\root`），这是 MSYS 的标准行为，不是本插件的缺陷。在 `git_bash` 里直接调用 `wsl.exe`（或其他原生 exe）并传 POSIX 路径时会被改写而失败：

```bash
wsl.exe -e ls /root                       # ✗ ls: cannot access 'D:/Program Files/Git/root'
MSYS_NO_PATHCONV=1 wsl.exe -e ls /root    # ✓ 原样传递
```

- 需要原样传参时，给命令加 `MSYS_NO_PATHCONV=1`（或 `MSYS2_ARG_CONV_EXCL="*"`），也可用 `//` 前缀转义单个参数。
- WSL 相关操作**推荐直接用 `wsl_bash` 工具**：它从 Node 直接 spawn `wsl.exe`，命令以 base64 载荷进入发行版，引号与 Linux 路径原样传递，不存在改写问题。
- 插件自身的内部路径（Git Bash 探测、bwrap 工作区根、workdir）都由 Node 直接传递，不受 MSYS 改写影响。

## 包内容

完整功能实现以纯 ESM JS 打包在 `lib/`（无构建步骤），只依赖 dsh 的已发布基础包：

```
lib/
├── shell-select/   ShellSelectExecutor（ctx.shell 选择器）
├── bash-git/       GitBashExecutor（MSYS）
├── bash-wsl/       WslBashExecutor（WSL，base64 载荷）
├── tool-bash/      工具工厂 + git_bash / wsl_bash 实例
└── vendor/         运行器失败分类与 bwrap 配置辅助模块
```

若部署的 base bundle 已自带 `shell-select` 行，插件的 patch 会禁用该行、由本插件选择器占据席位（两个提供者会冲突）；基座没有该行时此条目是无害 no-op。

## 前置条件

- dsh profile 含已发布的 `@deepseek-ai` 基础包（任何标准部署都有）。
- 主机上有 Git Bash 和/或 WSL（缺失的后端仅首次使用时报错，不影响 pwsh）。

## 插拔方式（二选一，互斥！）

两种方式插入同一组行。**同时使用**会报 `duplicate loader entry id`，不要混用。

### 方式 A：热插（推荐，无需重启）

```powershell
# 安装
powershell -ExecutionPolicy Bypass -File .\install.ps1            # 默认 profile: web
powershell -ExecutionPolicy Bypass -File .\install.ps1 -ProfileName <name>

# 卸载
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

脚本把包链接进 `<profile>/node_modules/`（junction），维护包内 `node_modules/@deepseek-ai` junction（打包代码解析基础包所需），并把 managed 接线块写入 profile 的 `cordis.patch.yml`——`dsh web` 热重载该文件，**立即生效，无需重启**。脚本幂等，并会自动检测默认探测路径之外的 Git Bash（读取 `HKLM:\SOFTWARE\GitForWindows` 写入 `gitBash.bashPath`）。

### 方式 B：bundle 安装（便携，需重启）

```powershell
# 安装（二选一）
dsh plugin --profile web add dsh-win-multi-bash                    # npm 发布包（推荐）
dsh plugin --profile web add github:@Dinosaur-MC/dsh-win-multi-bash   # GitHub 仓库源

# 卸载
dsh plugin --profile web remove dsh-win-multi-bash
```

依赖 `pnpm`（dsh plugin 是 pnpm 转发器）；bundle 层在启动时装配，**需要重启 dsh web** 生效。适用于任意 profile（首次使用会自动初始化）。

## 验证

```powershell
powershell -ExecutionPolicy Bypass -File .\smoke\run.ps1
```

在 profile 运行时上 boot 真实组合（不修改任何 profile），验证 `git_bash` / `wsl_bash` 注册并真实执行，含显式 `bashPath` 变体；需要 node >= 20。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 新会话看不到 `git_bash` / `wsl_bash` | 检查 profile patch 里 managed 块存在、profile `node_modules/dsh-win-multi-bash` junction 存在、包内 `node_modules/@deepseek-ai` junction 存在（重跑 install.ps1）；确认运行中 `dsh web` 热重载生效 |
| 引导失败 `duplicate loader entry id` | 两种插拔方式混用了；先卸载其中一种 |
| 引导失败 `Cannot find package '@deepseek-ai/...'` | 包内 `node_modules/@deepseek-ai` junction 缺失（重跑 install.ps1），或 profile 运行时基础包不完整 |
| `git_bash` 执行报找不到 bash | Git Bash 不在默认探测路径：重跑 install.ps1（注册表自动检测），或手动设置 `gitBash.bashPath` |
| `wsl_bash` 执行报错 | `wsl.exe --status` 是否有默认发行版；可在 `wslBash.wslDistro` 指定发行版名 |
| `wsl_bash` 报 `bwrap was not found` | 已配置 `sandbox: bwrap` 但发行版内没有 bubblewrap：按上方「沙箱行为 → 为 `wsl_bash` 启用 bwrap 沙箱」安装（`sudo apt-get install -y bubblewrap`）并重启 `dsh web`，或改用 `sandbox: auto` / `none` |
| `wsl_bash` 沙箱报 bwrap runner 失败 | bwrap 的工作区根取 Windows 盘符路径的 Linux 侧（`/mnt/<盘符>/...`）：UNC 工作区根会响亮报错；发行版自定义了 automount 根（wsl.conf `automount.root`）时需要相应配置 |
| `git_bash` 里调 `wsl.exe` 等原生程序传 POSIX 路径报 `No such file or directory` | MSYS 把 `/root` 等改写成 `<Git 根目录>\root`：加 `MSYS_NO_PATHCONV=1` / `MSYS2_ARG_CONV_EXCL="*"`，或用 `//` 前缀；WSL 操作直接改用 `wsl_bash` 工具 |
| 安装 bubblewrap 后 `wsl_bash` 仍无沙箱 | bwrap 探针结果在宿主进程生命周期内缓存：重启 `dsh web`，或改动 shell 设置节触发后端重建后再试 |
| 执行报 `shell-select: backend "x" is not enabled` | backends 列表与工具名不匹配；保持 `backends: [git-bash, wsl-bash, pwsh]` |

## 文件布局

```
dsh-win-multi-bash/
├── package.json            # dsh.bundle 清单；exports 暴露 ./shell-select ./tool-git-bash ./tool-wsl-bash
├── cordis.patch.yml        # 组合接线（即文档）
├── install.ps1             # 方式 A 热插（junction + managed 块 + Git Bash 检测）
├── uninstall.ps1           # 方式 A 热拔
├── LICENSE / THIRD_PARTY_NOTICES
├── lib/                    # 打包实现（纯 ESM JS，无构建步骤）
└── smoke/                  # 冒烟测试（不随包发布）
```
