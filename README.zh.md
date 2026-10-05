[English](README.md) | 中文

# dsh-win-multi-bash

适用于 DeepSeek Harness 的 Windows multi-bash 插件：`git_bash` / `wsl_bash` 两个模型工具，各自持有自己的 Git Bash / WSL 执行器。插件不碰 `ctx.shell` 席位——该席位仍由 dsh 自带的 pwsh 执行器持有——因此 pwsh 行为与未装插件时完全一致。

## 功能一览

| 工具名 | 后端 | 方言 | 说明 |
| --- | --- | --- | --- |
| `git_bash` | git-bash | MSYS | 自带 `GitBashExecutor`；Git for Windows 工具链 |
| `wsl_bash` | wsl-bash | Linux | 自带 `WslBashExecutor`；WSL 发行版内 Linux userland |
| `pwsh`（dsh 自带） | pwsh | — | 由基座的 `pwsh-sandbox` 行提供，本插件完全不介入 |

- 每个工具自行构建并驱动自己的执行器，都不注册为 `ctx.shell`；因此该席位——以及所有 inject `shell` 的插件（dsh 的 `tool-pwsh`、`permission-presets` 等）——不受本插件加载影响。
- 为什么不再有选择器：dsh 0.1.7 删除了 `ShellExecRequest.shell`，也就是 0.1.7 之前 `shell-select` 用来路由的字段。路由输入没了，只有工具自己知道要哪个 shell——选择器已无从可选，随之取消。
- 可执行文件解析与沙箱探测全部惰性化：未安装 Git Bash / WSL 不影响 pwsh，首次使用时才响亮报错。
- Git Bash 自动查找，顺序为：显式 `gitBash.bashPath` → 从 PATH 上 `git.exe` 布局目录反推的 Git 安装根（因此通过 `git` 可达的安装无需钉定即可找到，即使不在常见位置）→ 每个固定盘上的常见 Program Files 布局（`C:\Program Files\Git`、`D:\Program Files\Git` 等）→ PATH 上的 `bash.exe` → 最后读取 `HKLM\SOFTWARE\GitForWindows` 注册表安装路径（Git for Windows 安装器必写该键，覆盖便携安装）。Windows 的 WSL 启动器 `System32\bash.exe` 与 `WindowsApps` 应用执行别名目录**绝不入选**，且候选必须是真实普通文件——符号链接 / reparse point 一律拒绝——因此失效的 WSL `bash.exe` 别名永远无法遮蔽真实 Git Bash（本工具是 MSYS 而非 WSL）。
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
> ⚠️ **`wsl_bash` 的沙箱依赖发行版内的 bubblewrap。** 未安装 bwrap 时 `auto` 同样降级为无限制运行；探针结果在**宿主进程生命周期内缓存**——安装 bwrap 后必须重启 `dsh web`（或编辑 profile patch 触发工具行重载）才会重新探测。
>
> ⚠️ **拒绝判定要求命令以非零退出结束。** 被拦截的写操作若以成功命令收尾（如 `echo nope > /etc/x; echo done`），整体退出码为 0，不会标记 `[sandbox: file access denied]`（与上游 bash-sandbox 的判定规则一致，避免误报）。
>
> 沙箱只约束**文件系统效果**（`workspace-write` / `read-only`），不限制网络、进程等其它资源。
> **`requireSandbox`：探针失败时拒绝无沙箱运行（可选强化）。** 两个后端均支持 `requireSandbox: true`（默认 `false`，保持既有降级行为）。开启后，探针失败（git-bash 的 windows-acl 不可用 / wsl-bash 缺少 bwrap）时：`danger-full-access` 模式下照常放行（无沙箱运行等价于显式全权批准），`read-only` / `workspace-write` 模式下**拒绝执行**并报错，提示修复沙箱或升级到 `danger-full-access`。同时工具层会声明沙箱并开放 `sandbox_permissions` 升级参数，使模型可以走审批升级。示例：

> ```yaml
> # cordis.patch.yml 的 win-mb-tool-git / win-mb-tool-wsl 行：
> # 每个工具行只带自己后端的配置分区
> - id: win-mb-tool-git
>   name: 'dsh-win-multi-bash/tool-git-bash'
>   config:
>     gitBash: { requireSandbox: true }
>
> - id: win-mb-tool-wsl
>   name: 'dsh-win-multi-bash/tool-wsl-bash'
>   config:
>     wslBash: { requireSandbox: true }
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
- 装完后**必须重启 `dsh web`**（或编辑 profile patch 触发工具行重载）——探针结果在宿主进程生命周期内缓存，重启前 `wsl_bash` 仍按无沙箱运行。

## 工具提示词（面向模型的描述）

`git_bash` / `wsl_bash` 的工具描述刻意保持最小：只写各自方言自身的内容——shell 与调用形式、方言的路径与环境变量写法、（`git_bash` 还带）MSYS 路径注记。两者共有的内容由 `win-mb-shell-prompt` 行注册的**唯一**一段 `tool:win-mb-bash` 提示词承载：每次调用全新 shell 与 `workdir` 规则、`[exit code: N]` 标记及 `&&` / `set -o pipefail` 串接规则、`$DSH_*` 环境事实、沙箱行为、输出截断、删除/移动前的目标路径校验、未设变量的 `${VAR:?}` 兜底、后台任务与升级契约。更长的方言说明（MSYS 路径改写、WSL base64 载荷）放在本文档而不是模型可见的描述里。

这两个工具都用 `bash -c`，因此上述安全提示采用 `tool-bash` 的 bash 版措辞而非 `tool-pwsh` 的：bash 里 `$HOME` 是可赋值的普通变量，pwsh 的「不要给自动变量赋值」那句在此会误导；bash 对计算路径的兜底就是上面的 `${VAR:?}` 写法——它让未设变量直接报错，而不是静默展开成空串。

`git_bash` 的描述还带一条路径格式提示：

> MSYS paths work inside Git Bash only — dsh's file tools (`read`, `write`, `edit`) on Windows take native `C:\...` paths.

即命令输出里的 MSYS 路径（如 `/d/WorkSpace/foo`）在交给 dsh 文件工具前要转成 Windows 形式（`D:\WorkSpace\foo`）；而在 bash 命令内部，MSYS 路径才是 shell 期望的写法。

**`workdir` 接受原生、MSYS 与 WSL 挂载三种写法。** 模型在被告知方言路径是 MSYS／WSL 形式后，自然会用同样的形式写 `workdir`；解析器因此把单字母盘符形式（`/c/...`）与 WSL 挂载形式（`/mnt/c/...`）在交给 `spawn` 之前转成原生 `C:\...`，而 MSYS 的 POSIX 根（`/etc`、`/usr`、`/tmp`）与发行版侧路径（如 `/mnt/data`）保持原样，相对路径仍相对会话工作区解析。在此转换之前，MSYS 形式的 `workdir` 会以 `spawn <shell> ENOENT` 失败——一个「找不到 shell」的假象，实际是 cwd 不可用。

**整个家族只注册一段提示词小节，而不是每个工具一段。** 该小节（`tool:win-mb-bash`，由**包行／核心行**拥有，不属于任何一个工具）承载上述共有指导：每次结果都要核对 `[exit code: N]` 标记，且依赖前一步的后续命令要用 `&&` 或 `set -o pipefail` 串接——`;` 不会因失败中止，而 `cmd | tail` 返回的是 `tail` 的状态而非 `cmd` 的。这属于「如何组合多步命令」的跨调用指导，因此放在提示词里而不是单次调用的 schema 里；它也让运行时自带的截尾能力成为「不必用管道限制输出」的理由。提示词小节存放在**按名字索引的单一全局层**里：两个行注册同一个名字会直接抛错，而两个名字装同样的文本就是重复——0.3.1 上两段描述分别为 1299 与 2164 字符、其中 1117 字符逐字节相同，退出码那段还被装配了两次。因此小节的文本在**每次装配时**按实际挂载的工具重新解析（`ctx.tools.get`）：`git_bash` 与 `wsl_bash` 保持可独立开关，只挂其一、两者都挂、或都不挂，各自都只渲染出恰好一份正确文本（都不挂时不渲染任何 shell 指导）。其排序取 dsh `TOOL_BASH` / `TOOL_PWSH` 两个段位的中值（读自 `ctx.systemPrompt.getSectionOrder`）。升级契约段与后台任务句只在实际挂载的工具确实声明了 `sandbox_permissions` / `run_in_background` 时才出现。该小节从不从别的行的描述里取事实，因此 dsh 的 `tool-pwsh` 在或不在组合里它都自足；pwsh 自身描述与它重合的句子，是第三方行无法删掉的残留。

**行开关：各组合的实际行为。** 接线块一共三行——核心行 + 每个工具一行——面板上都能单独开关，所以组合空间值得写清楚。只有一个组合会改变**文本**形态，且没有任何组合会丢信息：

| `win-mb-plugin`（核心行） | `win-mb-tool-git` / `win-mb-tool-wsl` | 结果 |
|---|---|---|
| 开 | 任意子集 | 目标形态：工具只说自己方言的事实，共有指导由核心行的小节说一次，并随实际挂载的子集变化（不广告 `sandbox_permissions` 的工具也不会看到升级段）。 |
| 开 | **都关** | 没有家族工具被挂载，小节解析为空文本，渲染出的提示词里既没有那段指导、也没有这一节。两个配置页随各自的行走。 |
| **关** | 任意子集 | Web 端没有包行可解析 `dsh.client`，于是不下发浏览器半边，面板上没有 **配置** 入口。工具照旧可用：小节不在了，共有指导改由每个工具自己的描述承载（兜底，同时记一条警告）。 |

**核心行无法被标成只读**：dsh 的插件管理只锁三类行——它自己的"受保护模块"名单里的行、它自己那一行、以及它的 profile patch 无法唯一定位的行（`readOnlyReason: "management-required" | "unaddressable"`）；第三方组合包没有任何清单字段可以声明"本行只读"。因此这里的做法是让"关掉核心行"不可能造成半坏状态：用户真正要开关的是两个工具行，而上面第三行就是关掉核心行后的全部后果。原先独立的提示行已并入核心行；仍声明 `win-mb-shell-prompt` 的旧接线不会被破坏——那个模块现在是迁移垫片，在核心行已组合时不注册任何东西，并提示那一步怎么删。

两点注意：**运行时**关掉某行对小节立即生效（每次装配都重新解析），但已加载的工具行仍保留它注册时的描述，因此"关掉核心行→兜底接管"要等该工具行重载或重启才发生。另外，启动期经 cordis logger 发出的警告，会被 app-boot 的收集器留着用于失败报告、但在成功启动且默认日志级别下丢弃——所以**真正保证模型不丢指导的是兜底文本，而不是那条日志**。

## 运行时配置（插件管理面板）

两个工具行各自携带配置，且每个可配置项都声明了 `.volatile()`——这正是运行时设置服务能够寻址它们的条件。因此 Web 侧栏 **插件** 页可以直接编辑：侧栏打开 **插件** → 打开 `dsh-win-multi-bash` 包 → 每个行都有 **配置** 页。该页由浏览器半边（`lib/client.js`，通过 `dsh.client` 与 `./client` 导出声明）注册进页面的 `plugins.row.config` 槽位，key 为 `dsh-win-multi-bash#<行 id>`；保存经 `settings` / `ctx.configForms` 写入 profile 的 Cordis patch——与手改落点相同，没有自建 HTTP 路由、没有第二份设置文件，也不用碰 YAML。

这也是接线块要插入第三行的原因（`win-mb-plugin`，`name: 'dsh-win-multi-bash'`）：`dsh-client-modules` 发现浏览器半边的方式是把行的**裸包名**解析到其 `package.json` 再读 `dsh.client`（`locatePkgJson` → `exactPackageSpecifier`，对子路径返回 `undefined`）。两个工具行都是子路径，缺了这一行浏览器半边永远不会被服务，行上也就没有任何配置入口。它的模块（`lib/index.js`）就是包 main，同时拥有那段共有提示词小节——**插件本身一行，每个工具一行**。

| 行 | 可配置项（按页面顺序） |
|---|---|
| `git_bash` | 后台任务（`enableRunInBackground`）；`cwd`、`timeoutMs`、`maxTimeoutMs`、`maxOutputBytes`、`maxSpillBytes`、`graceMs`；`bashPath`；沙箱立场（`auto` / `none`）；`probeTimeoutMs`；`requireSandbox` |
| `wsl_bash` | `wslBash` 下同一组，外加 `wslPath`、`wslDistro`，且沙箱立场多一个 `bwrap` |

该列表就是每个行 `Config` schema 的 volatile 投影——审计把两侧对齐（主机 config 的 `volatilePaths` 对浏览器半边的字段表），所以给后端加了字段却忘了 `.volatile()` 不会悄悄只留在 YAML，页面也不可能提供 Host 会拒绝的字段。

- **活引用**：volatile 字段是活引用，执行器在使用时通过 `.get()` 读取。路径、发行版、沙箱立场、超时与强化开关的改动对下一条命令即生效，无需重载该行。
- **两项需要该行下次加载**（因为它们塑造的是工具 **schema** 而不是单次调用）：`enableRunInBackground`（对外广告的 `run_in_background` 参数）与升级面（`sandbox_permissions`，加载时按探针结论广告）。
- **暂存而非即输即写**：页面暂存草稿，仅 **保存** 时写入，并以读取时的 revision 做栅栏；Host 拒绝的保存会保留草稿。清空路径或发行版会提交一次 clear，撤销覆盖并让内置探测重新生效。
- 该页仅在 Host 服务该行命名空间时存在（`whileServed`），因此被关掉的行不会显示配置入口。

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
├── bash-git/       GitBashExecutor（MSYS）
├── bash-wsl/       WslBashExecutor（WSL，base64 载荷）
├── tool-bash/      工具工厂 + git_bash / wsl_bash 实例、
│                   后端持有逻辑（types/backend.js）
└── vendor/         运行器失败分类与 bwrap 配置辅助模块
```

由于本插件没有任何行注册为 `ctx.shell`，patch 只插入自己的两个工具行、不禁用任何行：基座自身的 shell 接线（Windows 上是 `pwsh-sandbox`，其他平台是 `bash-sandbox`）保持原样，pwsh 无论本插件是否加载都正常工作。

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

在 profile 运行时上 boot 真实组合（不修改任何 profile），验证 `git_bash` / `wsl_bash` 注册并真实执行（含显式 `bashPath` 变体），并断言 `ctx.shell` 仍由基座自带的行提供——这正是本插件曾经弄坏的那一点。需要 node >= 20。

```powershell
powershell -ExecutionPolicy Bypass -File .\smoke\audit.ps1
```

改为运行完整审计套件：vendor 辅助模块、executor 内部与工具配置 schema 的纯单元覆盖，外加真实 `cordis.patch.yml` 与各类错误配置的 boot 集成矩阵。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 新会话看不到 `git_bash` / `wsl_bash` | 检查 profile patch 里 managed 块存在、profile `node_modules/dsh-win-multi-bash` junction 存在、包内 `node_modules/@deepseek-ai` junction 存在（重跑 install.ps1）；确认运行中 `dsh web` 热重载生效 |
| 引导失败 `duplicate loader entry id` | 两种插拔方式混用了；先卸载其中一种 |
| 引导失败 `Cannot find package '@deepseek-ai/...'` | 包内 `node_modules/@deepseek-ai` junction 缺失（重跑 install.ps1），或 profile 运行时基础包不完整 |
| `git_bash` 执行报找不到 bash（或去 spawn WSL 的 `WindowsApps\bash.exe` 别名并报 `spawn ... ENOENT`） | Git Bash 不在探测路径，或失效的 WSL 应用执行别名遮蔽了解析：删除 `%LOCALAPPDATA%\Microsoft\WindowsApps\bash.exe`（设置 → 应用 → 高级应用设置 → 应用执行别名），重跑 install.ps1（注册表自动检测），或手动设置 `gitBash.bashPath` |
| `wsl_bash` 执行报错 | `wsl.exe --status` 是否有默认发行版；可在 `wslBash.wslDistro` 指定发行版名 |
| `wsl_bash` 报 `bwrap was not found` | 已配置 `sandbox: bwrap` 但发行版内没有 bubblewrap：按上方「沙箱行为 → 为 `wsl_bash` 启用 bwrap 沙箱」安装（`sudo apt-get install -y bubblewrap`）并重启 `dsh web`，或改用 `sandbox: auto` / `none` |
| `wsl_bash` 沙箱报 bwrap runner 失败 | bwrap 的工作区根取 Windows 盘符路径的 Linux 侧（`/mnt/<盘符>/...`）：UNC 工作区根会响亮报错；发行版自定义了 automount 根（wsl.conf `automount.root`）时需要相应配置 |
| `git_bash` 里调 `wsl.exe` 等原生程序传 POSIX 路径报 `No such file or directory` | MSYS 把 `/root` 等改写成 `<Git 根目录>\root`：加 `MSYS_NO_PATHCONV=1` / `MSYS2_ARG_CONV_EXCL="*"`，或用 `//` 前缀；WSL 操作直接改用 `wsl_bash` 工具 |
| 安装 bubblewrap 后 `wsl_bash` 仍无沙箱 | bwrap 探针结果在宿主进程生命周期内缓存：重启 `dsh web`，或编辑 profile patch 触发工具行重载后再试 |
| 启动告警 `win-mb-tool-git … waiting for service: shell`（或 dsh 自带的 `tool-pwsh` / `permission-presets` 如此） | 没有任何行提供 `ctx.shell`。本插件已不提供该席位：检查基座的 `pwsh-sandbox` 行是否被别的 patch 禁用了 |

## 文件布局

```
dsh-win-multi-bash/
├── package.json            # dsh.bundle 清单；exports 暴露 ./tool-git-bash ./tool-wsl-bash
├── cordis.patch.yml        # 组合接线（即文档）
├── install.ps1             # 方式 A 热插（junction + managed 块 + Git Bash 检测）
├── uninstall.ps1           # 方式 A 热拔
├── LICENSE / THIRD_PARTY_NOTICES
├── lib/                    # 打包实现（纯 ESM JS，无构建步骤）
└── smoke/                  # 冒烟测试（不随包发布）
```
