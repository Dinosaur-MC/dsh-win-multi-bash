[English](README.md) | 中文

# dsh-win-multi-bash

[![npm version](https://img.shields.io/npm/v/dsh-win-multi-bash.svg)](https://www.npmjs.com/package/dsh-win-multi-bash)
[![license](https://img.shields.io/npm/l/dsh-win-multi-bash.svg)](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/dsh-win-multi-bash.svg)](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/package.json)
[![GitHub stars](https://img.shields.io/github/stars/Dinosaur-MC/dsh-win-multi-bash.svg)](https://github.com/Dinosaur-MC/dsh-win-multi-bash/stargazers)
![dsh ≥ 0.1.7-rc.2](https://img.shields.io/badge/dsh-%E2%89%A5%200.1.7--rc.2-blue.svg)
![platform: windows](https://img.shields.io/badge/platform-windows-0078d4.svg)
![dialects: MSYS, WSL, MSYS2](https://img.shields.io/badge/dialects-MSYS%20%7C%20WSL%20%7C%20MSYS2-4c1.svg)
[![已收录于 dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/dinosaur-mc/dsh-win-multi-bash)

适用于 DeepSeek Harness 的 Windows multi-bash 插件：`git_bash` / `wsl_bash` 两个模型工具，各自持有自己的 Git Bash / WSL 执行器。插件不碰 `ctx.shell` 席位——该席位仍由 dsh 自带的 pwsh 执行器持有——因此 pwsh 行为与未装插件时完全一致。

## 功能一览

| 工具名 | 后端 | 方言 | 说明 |
| --- | --- | --- | --- |
| `git_bash` | git-bash | MSYS | 自带 `GitBashExecutor`；Git for Windows 工具链 |
| `wsl_bash` | wsl-bash | Linux | 自带 `WslBashExecutor`；WSL 发行版内 Linux userland |
| `terminal` | git-bash / wsl-bash / msys2-bash | MSYS / Linux / MSYS2 | 交互式 PTY 会话；后端由 `shell` 指定的方言决定 |
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
> ⚠️ **拒绝判定要求命令以非零退出结束。** 被拦截的写操作若以成功命令收尾（如 `echo nope > /etc/x; echo done`），整体退出码为 0，不会标记 `[sandbox: file access denied]`（与上游 bash-sandbox 的判定规则一致，避免误报）。此后的 `sandbox` 值刻意收窄：受限运行**成功**报 `denied: false`；**失败且 stderr 命中本后端拒绝方言**报 `denied: true`；**失败但一条都不命中**则**完全不给 `denied`**，改附 `[sandbox: the command failed without matching this backend's denial dialect; see stderr]` —— 我们不对「没人观测到的拒绝」下断言。未被包裹的运行只报 `{mode, unconfined: true}`：沙箱之外的运行谈不上被沙箱拒绝。
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

- **windows-acl 后端对「恰好一个目录」是有状态的。** 它按 (会话, 工作区根) 只物化**一个**私有临时根 —— `%TEMP%\dsh-<6 个字母数字>` —— 并在整个会话里复用这个缓存路径；其 runner 把 `--temp` 当作「必须已存在」的入参，所以路径缺失就是硬失败（`windows-acl-run: --temp is not an existing directory: <路径>`，退出码 127），而且该会话之后**每一次被包裹的 spawn** 都会失败，直到它回来。手工重建该目录只恢复**存在性**：seam 的写授权（`tempWriteSid` 的 ACE）不会回来，受限子进程写自己的 `%TEMP%` 仍然被拒。因此本插件在 `git_bash` / `msys2_bash` 行下一条被包裹的命令上**重建该目录并重新施加 seam 自己的写授权** —— 这就是 `guardSandboxTemp`（默认开，见「运行时配置」）。本机 2026-10-16 实测（由本包自己的审计复现；临时的装置脚本属工作区产物，不随包发布）：没有授权时被包裹的 `cmd.exe` 写自己的 `%TEMP%` 报「拒绝访问。」；有授权时写入成功；删掉私有根后 runner 以 127 退出并打出上面那条签名；自愈之后同一条被包裹的写再次成功。

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

`git_bash` / `wsl_bash` 的工具描述刻意保持最小：只写各自方言自身的内容——shell 与调用形式、方言的路径与环境变量写法、（`git_bash` 还带）MSYS 路径注记。两者共有的内容由插件核心行（包行 `win-mb-plugin`）拥有的**唯一**一段 `tool:win-mb-bash` 提示词承载：每次调用全新 shell 与 `workdir` 规则、`[exit code: N]` 标记及 `&&` / `set -o pipefail` 串接规则、`$DSH_*` 环境事实、沙箱行为、输出截断、删除/移动前的目标路径校验、未设变量的 `${VAR:?}` 兜底、后台任务与升级契约。更长的方言说明（MSYS 路径改写、WSL base64 载荷）放在本文档而不是模型可见的描述里。

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

**核心行无法被标成只读**：dsh 的插件管理只锁三类行——它自己的"受保护模块"名单里的行、它自己那一行、以及它的 profile patch 无法唯一定位的行（`readOnlyReason: "management-required" | "unaddressable"`）；第三方组合包没有任何清单字段可以声明"本行只读"。因此这里的做法是让"关掉核心行"不可能造成半坏状态：用户真正要开关的是两个工具行，而上面第三行就是关掉核心行后的全部后果。两行变三行：0.3.0 / 0.3.1 **只**交付过 `win-mb-tool-git` 与 `win-mb-tool-wsl`，因此未迁移的手工接线 profile 仍然能解析并加载这两个工具、行为不变；缺的只是核心行——共有指导会回落到各自描述里（见上），并且面板上没有 **配置** 入口（0.3.1 本来也没有）。重跑 `dsh plugin --profile web add dsh-win-multi-bash`，或手工把 `win-mb-plugin` 行补进 profile 的 `cordis.patch.yml`，即可拿到核心行。0.3.1 与 0.4.0 之间的开发提交里短暂存在过的独立 `win-mb-shell-prompt` 行**已直接删除**——任何已发布版本都不曾声明它，0.4.0 也不再为该名字提供模块。若你的 profile 仍带着它，启动时会报一个"未激活条目"（模块无法解析），此外不受影响：两个工具照常加载，且因为没有小节拥有者，各自描述会自带那段共有指导。

两点注意：**运行时**关掉某行对小节立即生效（每次装配都重新解析），但已加载的工具行仍保留它注册时的描述，因此"关掉核心行→兜底接管"要等该工具行重载或重启才发生。另外，启动期经 cordis logger 发出的警告，会被 app-boot 的收集器留着用于失败报告、但在成功启动且默认日志级别下丢弃——所以**真正保证模型不丢指导的是兜底文本，而不是那条日志**。

## 交互式终端会话（`terminal`）

`terminal` 运行**持久 PTY 会话** —— 一个真正活着的交互式 shell，跨调用保持，因此当前目录、导出的变量、别名、函数与后台作业都留得住。适合 REPL、调试器、`ssh`、数据库客户端、TUI 程序，或任何依赖 shell 状态的工作流。

| action | 作用 |
|---|---|
| `open` | 开启会话，返回 `sessionId`、pid、cwd 与启动输出。 |
| `send` | 写入 `text`（默认补回车，除 `submit: false`）并返回回复。 |
| `read` | 只读新输出；`offset` 可按全流字节偏移重读。 |
| `signal` | 向前台进程组投递信号。在本平台上只有 `SIGINT`（Ctrl+C）真正到达 shell —— 见下面「信号」条。 |
| `close` | 结束会话并等待其会话树静默。 |
| `list` | 你拥有的会话。 |

- **后端就是方言注册表。** `shell` 取自声明了交互会话能力的方言 —— `git_bash`、`wsl_bash`、`msys2_bash` —— 每个执行器自己给出交互 argv（`bash.exe -i`，或 `wsl.exe --cd <目录> [-d <发行版>] -- bash -i`）。`terminal.defaultShell` 决定默认值；没声明会话能力的方言永不会被列出。
- **每个会话一条交互 shell，并用用户自己的启动文件。** 只加 `-i`，**不**加 `--noprofile --norc` —— 会话存在的意义就是留住那些启动文件设的别名与导出函数。
- **"停顿即结束"是错的。** `send`/`signal` 在输出安静 `quietMs` 后返回，并报 `waitReason: "quiet"`；tty 会在毫秒级回显输入，所以安静往往在命令结束前很久就开始。`timeout` 表示等待撞到 `waitMs` 且会话仍在运行。两种情况都请再 `read`；`quiet` **故意不**声称"已完成"。
- **输出是流，所以有上限、且如实上报。** 每个会话保留最近 `maxBufferBytes`（默认 1 MiB）的**已清洗**文本，并分开报两件事：`truncated`（该会话某刻丢过输出）与 `lossy`（本次读取要的偏移已经滑出窗口，于是返回的是整段保留尾而不是增量）。ANSI 转义会被剥离；这里没有终端模拟器，所以用回车重绘一行的程序会变成多行。
- **会话有上限、会被回收、且是进程内的。** `maxSessions`（默认 8）会具名拒绝下一次 `open`；`idleMs`（默认 10 分钟）内没有 `send`/`read`/`signal` 的会话会被终止，之后用它的 id 会被告知"已被空闲回收"，而不是含糊的 unknown。会话**不**跨 `dsh` 重启存活。
- **会话不是作业。** 它不注册进 `ctx.jobs`，`job_kill` 够不到它：`close` 是唯一的结束方式，空闲回收兜底。
- **PTY 会话未包裹运行，并且会说。** 文件沙箱包裹的是被 spawn 命令的 argv；终端会话由另一条 provider 调用分配，而在本机上 windows-acl runner 根本起不了 MSYS bash（见上，本机实测 `0xC0000142`），因此没有诚实的办法去包裹它。每次 `open` 都携带该事实；`terminal.allowUnconfined: false` 会让 `open` 直接拒绝而不是无保护运行。
- **本平台上只有 `SIGINT` 能到达 shell，其余四个都会明说。** 本机实测：win32 的 ConPTY 终端 `pid` 恒为 `0`，provider 的前台进程组查询返回同一个 0，而它的 kill 路径首行就是 `if (pid <= 0) return` —— 所以 `SIGTERM` 会**返回成功却什么都没送到**，`SIGKILL` 也因同样原因被 provider 拒绝。本工具因此把 `SIGTERM`/`SIGKILL` **具名拒绝**，而不是返回一个"送到了"的成功；`SIGTSTP`/`SIGHUP` 由 provider 拒绝并原样转达；`SIGINT` 以 Ctrl+C 字节投递，确实能打断前台命令（验证过：打断 `sleep 30` 后会话仍可继续使用）。
- **两个 provider 事实值得知道。** Windows 上 `pid` 是 `0`（ConPTY），仅供展示；`inspectActivity()` 在那里恒为 `unknown`，所以就绪判定回落到"输出静默" —— 在能作答的 provider 上，`idle` 立即结算，`busy` 会继续等。
- **默认值是测出来的，不是猜的。** `quietMs` 500 ms 相对实测最坏块间间隔（216 ms，`ls -la /usr/bin | head -80` 跑 18 次）留了约 2.3 倍余量；1 MiB 正是单条 `seq 1 200000` 越过的边界（原生 1,489,391 B；经本插件的转义剥离后剩 1,289,146 B = 1.229 MiB，而环形缓冲计的就是后者），这也让 `truncated` 可被观察到；`waitMs` 10 秒用 40×200 ms 的 ticker 验证过（返回部分输出且会话存活）；启动预算覆盖实测约 460 ms 到首提示符。以上每一项都能在插件面板的行上即时改。

## 运行时配置（插件管理面板）

两个工具行各自携带配置，且每个可配置项都声明了 `.volatile()`——这正是运行时设置服务能够寻址它们的条件。因此 Web 侧栏 **插件** 页可以直接编辑：侧栏打开 **插件** → 打开 `dsh-win-multi-bash` 包 → 每个行都有 **配置** 页。该页由浏览器半边（`lib/client.js`，通过 `dsh.client` 与 `./client` 导出声明）注册进页面的 `plugins.row.config` 槽位，key 为 `dsh-win-multi-bash#<行 id>`；保存经 `settings` / `ctx.configForms` 写入 profile 的 Cordis patch——与手改落点相同，没有自建 HTTP 路由、没有第二份设置文件，也不用碰 YAML。

这也是接线块要插入第三行的原因（`win-mb-plugin`，`name: 'dsh-win-multi-bash'`）：`dsh-client-modules` 发现浏览器半边的方式是把行的**裸包名**解析到其 `package.json` 再读 `dsh.client`（`locatePkgJson` → `exactPackageSpecifier`，对子路径返回 `undefined`）。两个工具行都是子路径，缺了这一行浏览器半边永远不会被服务，行上也就没有任何配置入口。它的模块（`lib/index.js`）就是包 main，同时拥有那段共有提示词小节——**插件本身一行，每个工具一行**。

| 行 | 可配置项（按页面顺序） |
|---|---|
| `git_bash` | 后台任务（`enableRunInBackground`）；`cwd`、`timeoutMs`、`maxTimeoutMs`、`maxOutputBytes`、`maxSpillBytes`、`graceMs`；`bashPath`；沙箱立场（`auto` / `none`）；`probeTimeoutMs`；`requireSandbox`；未包裹运行提示（`sandboxNotice`：默认 `once`，`always` 则每条降级运行都保留短标记）|
| `wsl_bash` | 同一个**工具层**开关（`enableRunInBackground`），外加 `wslBash` 下同一组、`wslPath`、`wslDistro`，且沙箱立场多一个 `bwrap` |
| `terminal` | 交互会话：`defaultShell`（`open` 默认用哪个方言）、`maxSessions`、`idleMs`、`rows` / `cols`、`maxBufferBytes`、`waitMs` / `quietMs` / `maxWaitMs`、`allowUnconfined`，外加每方言一个可执行文件钉定（`gitBash.bashPath`、`wslBash.wslPath` / `wslDistro`、`msys2Bash.bashPath`） |

该列表就是每个行 `Config` schema 的 volatile 投影——审计把两侧对齐（主机 config 的 `volatilePaths` 对浏览器半边的字段表），所以给后端加了字段却忘了 `.volatile()` 不会悄悄只留在 YAML，页面也不可能提供 Host 会拒绝的字段。

- **活引用**：volatile 字段是活引用，执行器在使用时通过 `.get()` 读取。路径、发行版、沙箱立场、超时与强化开关的改动对下一条命令即生效，无需重载该行。
- **两项需要该行下次加载**（因为它们塑造的是工具 **schema** 而不是单次调用）：`enableRunInBackground`（对外广告的 `run_in_background` 参数）与升级面（`sandbox_permissions`，加载时按探针结论广告）。
- **另有一个行为开关刻意不上页面。** `promoteOnTimeout`（默认开）让到达超时的前台命令继续作为后台任务运行——在任务工具里可见、可 kill——而不是把它杀掉，与 dsh 自带 bash 工具一致。它是非 volatile 的，因为它属于部署立场而非活旋钮：写在行的 YAML 里，在该行下次加载时生效。若 `enableRunInBackground: false`，或组合里没有 job registry，超时仍与以前一样直接杀掉命令。
- **被带外删除的沙箱私有临时目录会自愈（`guardSandboxTemp`，默认开）。** `git_bash` / `msys2_bash` 行每一条被包裹的命令都会读取 seam 即将交给 windows-acl runner 的 `--temp` —— 即后端为这个 (会话, 工作区根) 缓存的路径 —— 当这个私有根确实缺失时，重建它并重新施加 seam 自己的写授权（`tempWriteSid` + `AclWriteGrant`，与 `dsh-sandbox-local` 自己的调用相同）。它**幂等、即时生效、且不删除任何东西**：唯一接受的目标是「不存在的、绝对的、位于某个 OS 临时根本身之下、且不在任何工作区根内的 `dsh-<6 个字母数字>` **直接子目录**」；其它一切——环境临时根本身、嵌套路径、锁目录、转存目录、形状不符的名字、已存在的目录——都会具名拒绝。`AclWriteGrant` 来自 `@deepseek-ai/dsh-sandbox-windows-acl`，通过 lazy import 获取（声明为 optional peer，**无新增运行期依赖**）；解析不到时仍然只重建目录（仅存在性），插件会告警说明授权**没有**恢复。该开关**只在插件自己那一页列出一次**（`dsh-win-multi-bash`），不在各个工具行上；关掉它即从下一条命令起停止一切自愈。
- **自愈开关只在插件自己那一页列出一次**（`dsh-win-multi-bash`），绝不在工具行上：一个部署级取值同时管住守护、每行的内联执行前检查与所有行；`enableRunInBackground` 仍属工具层，所以那一个确实每行都有。两条如实限制：`wsl_bash` 走 bwrap，从不物化 `--temp` 目录，所以该旋钮在那一行无效；自愈只在真的发生「被包裹的运行」的地方才可能发生 —— 在 windows-acl runner 无法启动 MSYS bash 的宿主机上（本机实测：`git_bash` 每次调用都返回 `sandbox.unconfined: true`），git 行根本到不了 runner，既不会因此变砖、也无法在那里自愈。
- **没被沙箱包裹的运行会明说——默认每行只说一次。** 命令未被沙箱包裹时，结果带 `sandbox.unconfined: true`。若原因是 `sandbox: auto` 的探针失败（我们替你降级），该行的**第一条**这类运行会带完整说明：`[sandbox: not applied — the confinement probe found no usable sandbox, so this command ran unconfined under <mode> mode; repair the sandbox or set sandbox: none on this tool row to accept unconfined runs]`。之后的行为由该行的 `sandboxNotice` 旋钮决定：`once`（默认）保持安静——结构化事实仍在每条结果里，什么都没藏，只是不再让同一句话把真正的输出挤出上下文；`always` 则在每条降级运行上保留那句短标记 `[sandbox: not applied — ran unconfined under <mode> mode; reason and fix stated once per plugin load]`。无论哪种形态，这条提示都发给模型最先读到的那条通道：前景结果、promoted 结果、或真后台 job 的终态 detail。显式 `sandbox: none` 只带事实、不发任何提示；`danger-full-access` 两者都不带——它的 `mode` 已经说明了它是什么。
- **第三个方言默认关闭。** `msys2_bash`（MSYS2 自带的 `usr/bin/bash.exe`，与 Git Bash 并列的第二套工具链）是**可选启用**的：在 Plugins 面板开启 `win-mb-tool-msys2` 行即可挂载；若 MSYS2 装在非默认位置，用 `msys2Bash.bashPath` 固定。它**继承** MSYS 机制而不是复制一份，并且报告**自己的**事实（`$MSYSTEM`、`pacman`）而不是 Git Bash 的。
- **文本旋钮保存时 trim，不可用的值只告警、绝不改写。** 文本字段（路径、发行版名）保存前会 trim，并把 trim 后的值回显出来，做到所见即所存；清空字段表示清除该值。若值不满足**页面能做的语法判断**（路径非绝对、发行版名含空格或引号、数字非有限），页面会给出告警，但**仍然按你输入的原样保存**：插件**从不改写或删除你的配置**。这个值到底能不能用，由**运行时**判断：执行器告警一次，回退到默认（shell 路径回退自动发现；\`wslDistro\` 回退第一个可用发行版），并且**存储里的原值一直不动**，直到你自己再次保存。
- **拒绝方言按主机学一次。** 受限探针成功后，该行会在工作区根之外做**一次注定被拒的无害写**，把这次拒绝文本留作**额外签名**（与后端自带的签名表取并集），这样后端没枚举到的本地化拒绝也能被判出来。探针目标事后必须不存在；万一存在，该行会删掉它并弃用这次发现。学不到就静默退化，**绝不影响该行加载** —— 而在 runner 根本无法启动 shell 的宿主机上，既不会发生限制也不会发生发现。本机实测成本：WSL/bwrap 路径约 **+321 ms**，每次行加载一次。
- **Windows 上 workspace-write 的边界是「对象」形状的，而且在某些宿主机上根本不可用。** 本机 win32 实测（2026-10-14）：ACL 后端的授权跟随**对象**而不是路径 —— 在**工作区内创建**的文件即使随后被链到**界外**的名字上，仍然保留授权（经界外名字写入会落到区内那个文件），而在**界外创建**的对象永远不会获得授权（两个方向都对着 `icacls` 实测过），且读取完全不受限。同一台宿主上 runner **无法启动 MSYS bash**（`0xc0000142`、`NtCreateDirectoryObject(\BaseNamedObjects\…) : 0xC0000022`），于是 `sandbox: auto` **每一次调用**都降级、`git_bash` 始终无沙箱运行 —— 这件事由结构化事实在**每条结果**上如实上报，正文里则每行说一次，**后台 job 的终态 detail 里也有那句提示**（基座 job view 没有 sandbox 字段，那句提示是后台路径唯一的通道）。请把 `sandbox: auto` 当护栏而非绝对边界，把 `requireSandbox: true` 当 fail-closed 立场：在那样的宿主上它会**拒绝每一条命令**而不是降级 —— 在 runner 能启动 shell 之前，`git_bash` 在那里不可用。
- **后台参数的广告只跟配置走，不跟注册表走**：只要 `enableRunInBackground` 开着，`run_in_background`（以及跟随它的家族段那句后台指导）就会出现；在没有任务注册表的组合里调用它会**响亮失败**（`background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs`）。dsh 自带工具的做法是重注册自己、在注册表缺席时把这个参数撤掉。本工厂不重注册：**「随 boot 顺序静默消失的参数」比「带着理由拒绝的参数」更糟**，因此这里选择确定性广告 + 调用期响亮失败。
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
├── terminal-session.js  PTY 会话注册表（有界输出、就绪判定、回收）
├── sandbox-temp-guard.js 沙箱私有临时目录自愈
└── vendor/         运行器失败分类与 bwrap 配置辅助模块
```

由于本插件没有任何行注册为 `ctx.shell`，patch 只插入自己的两个工具行、不禁用任何行：基座自身的 shell 接线（Windows 上是 `pwsh-sandbox`，其他平台是 `bash-sandbox`）保持原样，pwsh 无论本插件是否加载都正常工作。

## 前置条件

- dsh profile 含已发布的 `@deepseek-ai` 基础包（任何标准部署都有）。
- 主机上有 Git Bash 和/或 WSL（缺失的后端仅首次使用时报错，不影响 pwsh）。

## 安装与卸载

安装只有一条路径：`dsh plugin`（pnpm 转发器）。它把包装进 profile，bundle 层再应用本包自己的 `cordis.patch.yml`（由 `dsh.bundle.patch` 声明），由后者插入这三行——没有任何脚本去手工接线。

```powershell
# 安装（二选一）
dsh plugin --profile web add dsh-win-multi-bash                    # npm 发布包（推荐）
dsh plugin --profile web add github:@Dinosaur-MC/dsh-win-multi-bash   # GitHub 仓库源

# 卸载
dsh plugin --profile web remove dsh-win-multi-bash
```

依赖 `pnpm`；bundle 层在启动时装配，改动**需要重启 `dsh web`** 才生效。适用于任意 profile（首次使用会自动初始化）。

手工等价物是 profile 的 `cordis.patch.yml`：本包 `cordis.patch.yml` 里声明的 `insert:` 行（该文件即组合接线，行内自带文档）可以手工写进 profile patch。不要两者同时做——手工块与 bundle 安装并存会让 loader 报重复 entry id。

## 验证

```powershell
powershell -ExecutionPolicy Bypass -File .\smoke\run.ps1
```

在 profile 运行时上 boot 真实组合（不修改任何 profile），验证 `git_bash` / `wsl_bash` 注册并真实执行（含显式 `bashPath` 变体），并断言 `ctx.shell` 仍由基座自带的行提供——这正是本插件曾经弄坏的那一点。需要 node `^22.19.0 || >=24.0.0`——即本包声明的 `engines.node` 范围。

```powershell
powershell -ExecutionPolicy Bypass -File .\smoke\audit.ps1
```

改为运行完整审计套件：vendor 辅助模块、executor 内部与工具配置 schema 的纯单元覆盖，外加真实 `cordis.patch.yml` 与各类错误配置的 boot 集成矩阵。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 新会话看不到 `git_bash` / `wsl_bash` | 检查 profile 的 `cordis.patch.yml` 里有这三行、且 profile 能解析到 `dsh-win-multi-bash`（`dsh plugin --profile web list`）；bundle 层在启动时装配，需重启运行中的 `dsh web` |
| 引导失败 `duplicate loader entry id` | 这些行出现了两次——profile patch 里的手工块与 bundle 安装并存；删掉其中一个 |
| 引导失败 `Cannot find package '@deepseek-ai/...'` | profile 运行时缺少基础包（任何标准部署都有）；用 `dsh plugin --profile web add dsh-win-multi-bash` 重装 |
| `git_bash` 执行报找不到 bash（或去 spawn WSL 的 `WindowsApps\bash.exe` 别名并报 `spawn ... ENOENT`） | Git Bash 不在探测路径，或失效的 WSL 应用执行别名遮蔽了解析：删除 `%LOCALAPPDATA%\Microsoft\WindowsApps\bash.exe`（设置 → 应用 → 高级应用设置 → 应用执行别名），或手动设置 `gitBash.bashPath` |
| `wsl_bash` 执行报错 | `wsl.exe --status` 是否有默认发行版；可在 `wslBash.wslDistro` 指定发行版名 |
| `wsl_bash` 报 `bwrap was not found` | 已配置 `sandbox: bwrap` 但发行版内没有 bubblewrap：按上方「沙箱行为 → 为 `wsl_bash` 启用 bwrap 沙箱」安装（`sudo apt-get install -y bubblewrap`）并重启 `dsh web`，或改用 `sandbox: auto` / `none` |
| `wsl_bash` 沙箱报 bwrap runner 失败 | bwrap 的工作区根取 Windows 盘符路径的 Linux 侧（`/mnt/<盘符>/...`）：UNC 工作区根会响亮报错；发行版自定义了 automount 根（wsl.conf `automount.root`）时需要相应配置 |
| `git_bash` 里调 `wsl.exe` 等原生程序传 POSIX 路径报 `No such file or directory` | MSYS 把 `/root` 等改写成 `<Git 根目录>\root`：加 `MSYS_NO_PATHCONV=1` / `MSYS2_ARG_CONV_EXCL="*"`，或用 `//` 前缀；WSL 操作直接改用 `wsl_bash` 工具 |
| 被包裹的命令突然报 `windows-acl-run: --temp is not an existing directory: …`（或 `sandbox-unavailable`），且之后每次调用都失败 | 该会话的沙箱私有临时根被带外删掉了——系统临时文件清理器、手工 `rmdir`、崩溃的同族进程。只要 `guardSandboxTemp` 开着（默认），一条 `git_bash` / `msys2_bash` 命令就会重建它并重新施加写授权；重试一次即可。若该行报告 `sandbox.unconfined: true`，说明它在本机根本到不了 ACL runner、无法自愈：重启 `dsh web` 以取得新的私有根。手工重建目录只恢复存在性（受限子进程写自己的 `%TEMP%` 仍被拒） |
| 安装 bubblewrap 后 `wsl_bash` 仍无沙箱 | bwrap 探针结果在宿主进程生命周期内缓存：重启 `dsh web`，或编辑 profile patch 触发工具行重载后再试 |
| 启动告警 `win-mb-tool-git … waiting for service: shell`（或 dsh 自带的 `tool-pwsh` / `permission-presets` 如此） | 没有任何行提供 `ctx.shell`。本插件已不提供该席位：检查基座的 `pwsh-sandbox` 行是否被别的 patch 禁用了 |
| `terminal` 说某会话「gone — closed by the idle reaper」 | 该会话在 `terminal.idleMs`（默认 10 分钟）内没有 `send`/`read`/`signal`，已被终止。开一个新会话，或在终端行上把 `idleMs` 调大。 |
| `terminal` 报 `waitReason: "quiet"`，而命令明显还没结束 | 这正是 `quiet` 的含义：输出安静了，而**不是**「命令结束了」（tty 会在毫秒级回显输入）。再 `read` 一次，或在终端行上把 `waitMs` / `quietMs` 调大。 |
| `terminal` 报 `truncated: true` | 该会话产生的输出超过了 `terminal.maxBufferBytes`（默认 1 MiB），最旧的输出已被丢弃。调大上限，或更频繁地 `read`。 |
| `terminal` 以 `allowUnconfined` 为由拒绝开启会话 | 该行被设为 `terminal.allowUnconfined: false`；PTY 会话无法被文件沙箱包裹，因此它宁可拒绝也不无保护运行。改回 `true` 即可接受未包裹会话。 |

## 文件布局

```
dsh-win-multi-bash/
├── package.json            # dsh.bundle + dsh.client 清单；exports 暴露 . ./client ./tool-git-bash ./tool-wsl-bash
├── cordis.patch.yml        # 组合接线（即文档）
├── .gitattributes          # 所有文本文件 LF，二进制例外
├── LICENSE / THIRD_PARTY_NOTICES
├── lib/                    # 打包实现（纯 ESM JS，无构建步骤）
└── smoke/                  # 冒烟测试（不随包发布）
```
