[English](README.md) | 中文

# dsh-win-multi-bash

[![npm version](https://img.shields.io/npm/v/dsh-win-multi-bash.svg)](https://www.npmjs.com/package/dsh-win-multi-bash)
[![license](https://img.shields.io/npm/l/dsh-win-multi-bash.svg)](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/dsh-win-multi-bash.svg)](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/package.json)
[![GitHub stars](https://img.shields.io/github/stars/Dinosaur-MC/dsh-win-multi-bash.svg)](https://github.com/Dinosaur-MC/dsh-win-multi-bash/stargazers)
![dsh ≥ 0.1.7-rc.2 < 0.3](https://img.shields.io/badge/dsh-%E2%89%A5%200.1.7--rc.2%20%3C%200.3-blue.svg)
![platform: windows](https://img.shields.io/badge/platform-windows-0078d4.svg)
![dialects: MSYS, WSL, MSYS2, SSH](https://img.shields.io/badge/dialects-MSYS%20%7C%20WSL%20%7C%20MSYS2%20%7C%20SSH-4c1.svg)
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/dinosaur-mc/dsh-win-multi-bash)

DeepSeek Harness 的 Windows 多 bash 插件。**`git_bash`**（Git for Windows / MSYS）默认开启；**`wsl_bash`**（WSL）、**`msys2_bash`**（MSYS2 UCRT64）、**`ssh_shell`**（池化 SSH 通道、仅密钥、多主机）与 **`ssh_scp`**（同一行上的 SFTP 传输）按需开启。**`terminal`** 在调用之间保留一个真正的 PTY 会话。

每个方言持有自己的执行器，且**没有任何工具注册 `ctx.shell`**——该席位始终归基座自带的 pwsh，因此 pwsh 的行为与未装本插件时完全一致。

## 工具

| 工具 | 后端 | 说明 |
| --- | --- | --- |
| `git_bash` | Git for Windows（MSYS） | **默认开启**；持有 `GitBashExecutor` |
| `wsl_bash` | WSL Linux | **按需开启**；持有 `WslBashExecutor`；首次加载会探测发行版 |
| `msys2_bash` | MSYS2 UCRT64 | **按需开启**；持有 `Msys2BashExecutor`；MSYS2 自己的 `$MSYSTEM` 与 `pacman` |
| `ssh_shell` | 远端（SSH） | **按需开启**；持有 `SshShellExecutor`；每主机一条池化连接，每次调用一条通道 |
| `ssh_scp` | 远端（SSH） | **随 `ssh_shell` 按需开启**；同一执行器与池化连接上的 SFTP 文件/目录传输；仅前台 |
| `terminal` | 以上任意后端 | 持久 PTY 会话：`open` / `send` / `read` / `signal` / `close` / `list` |
| `pwsh` | dsh 自带 | 不受影响；由基座的 `pwsh-sandbox` 行提供 |

只有 `git_bash` 与 `terminal` 默认开启；另外三行按需开启。`git_bash` 常以未包裹方式运行——详见[沙箱行为](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/sandbox.md)。

## 环境要求

- dsh `0.1.7-rc.2` 到 `0.2.x` —— `package.json` 的 `engines.dsh` 声明的就是这个窗口。更新的 dsh 会拒绝本插件。
- Windows，以及一个提供已发布 `@deepseek-ai` 基础包的 dsh 部署。
- Git Bash / WSL / MSYS2 只在启用对应后端时需要；缺后端不会影响 pwsh。
- `ssh_shell` / `ssh_scp` 需要 `sshShell.hosts` 下主机的仅密钥访问，且主机密钥已在 `known_hosts` 中。
- Node `^22.19.0 || >=24.0.0`（本包声明范围），安装需要 `pnpm`。

## 安装

用 `dsh plugin`（pnpm 转发）安装：它会应用本包自己的 `cordis.patch.yml` bundle 层，把这些行插进组合。

```powershell
dsh plugin --profile web add dsh-win-multi-bash                    # npm 包（推荐）
dsh plugin --profile web add github:@Dinosaur-MC/dsh-win-multi-bash # GitHub 源码
dsh plugin --profile web remove dsh-win-multi-bash                 # 卸载
```

需要 `pnpm`。bundle 层在启动时组装，改动后请**重启 `dsh web`**。不要把手写的相同行再写进 profile 的 `cordis.patch.yml`：loader 会拒绝重复的 entry id。

## 快速开始

- **`git_bash`** 装好即可用。每次调用启动一个全新的 MSYS bash；`workdir` 接受原生、MSYS（`/c/...`）与 WSL automount（`/mnt/c/...`）三种写法。
- **`wsl_bash` / `msys2_bash`**：在插件页启用 `win-mb-tool-wsl` / `win-mb-tool-msys2`。只有自动探测不够时才需要 pin `wslBash.wslDistro` 或 `msys2Bash.bashPath`。
- **`ssh_shell`**：启用 `win-mb-tool-ssh`，在 `sshShell.hosts` 下添加主机（`alias`、`host`、`user`、`keyPath`；需要时再加 `port` / `startupCommand` / `default`）。调用时指定别名（只有一台主机标 `default` 时才可以省略）；没有主机的行会拒绝每一次调用。仅密钥认证、严格主机密钥——迁移说明见[配置](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/configuration.md)。主机默认 `approval: session`：每会话一次、经专用卡片提问；`trusted` 永不提问。主机在配置页的**主机表**中编辑——每台一张卡，最多一台默认。每行有**测试连接**：用该行当前（未保存）的值拨号，校验主机密钥并完成密钥认证（不执行远端命令），行内显示指纹或失败阶段；保存仍需显式点击。
- **`ssh_scp`**：同一行也做传输——`action: "upload" | "download"`、`localPath`（除非 `danger-full-access`，否则必须在工作区内；校验是词法的，不会解引用工作区内的符号链接）、`remotePath`（绝对 POSIX；Windows OpenSSH 用 `/C:/...`）、`recursive` 传目录树、`timeoutMs`（默认 5 分钟）。仅前台；结果为 `{ ok, bytes, files?, error? }` 外加 `sandbox` 事实（允许外部路径时含 `outsideWorkspace`），失败是带 phase 与别名的结果值。
- **`terminal`**：`open` 开会话，`send`（`submit: true`）发命令，`read` 读回复，`close` 结束。工作目录、导出的变量与别名会跨调用保留。会话是进程内的、有上限、空闲会被回收，且**不是**后台任务；Session 头部面板会列出并停止它们。
- 每行在插件页都有**配置**入口：路径、超时、沙箱立场、会话上限，以及部署级的自愈开关。除非某个旋钮决定工具 schema，改动都是即时的。

## 设计概览

- **只说不曾观测到的事实。** 成功且被包裹的运行报 `denied: false`；失败且匹配后端拒绝方言的报 `denied: true`；失败但匹配不上的不报 `denied`。未包裹运行报 `unconfined: true`。远端 SSH 运行报 `sandbox: { mode, remote: true }`。
- **平台原生的调用卡片。** 本插件的 shell 工具使用平台的 shell 卡；`ssh_scp` 走通用行。见[会话行](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/conversation-rows.md)。
- **每主机一条连接，每次调用一条通道。** `ssh_shell` 复用池化的 ssh2 客户端，并为每次调用开一条独立 exec 通道——相互隔离、可并行、可取消。`ssh_scp` 的传输共用这条池化连接，每次操作一条 SFTP 会话。
- **一个方言一条声明。** 方言 = 一个执行器文件 + 一条注册表声明；工具模块、提示词成员、patch 行、配置分区、包 exports 与客户端行都由它派生。声明不自洽会在加载时直接报错。见[架构](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/architecture.md)。
- **只有一段共享提示词。** 核心行拥有唯一的 `tool:win-mb-bash` 小节，其文本随实际挂载的工具变化；每个工具描述只保留自己的方言事实。
- **配置即时生效，用户输入优先。** 能即时的旋钮都声明为 `.volatile()`；页面从不改写你输入的值，保存带 revision 围栏。

## 文档

| 文档 | 内容 |
| --- | --- |
| [架构](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/architecture.md) | 行、执行器、注册表、SSH 池与传输、客户端半边 |
| [设计原则](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/principles.md) | 实现必须遵守的规则：诚实事实、派生面、平台一致性、live 与 schema 旋钮 |
| [沙箱行为](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/sandbox.md) | 各后端能力、Windows 限制、bwrap、自愈、SSH 的远端作用域 |
| [终端会话](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/terminal.md) | PTY 生命周期、信号、上限、SSH 会话、实测默认值 |
| [会话行](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/conversation-rows.md) | 一次调用如何变成平台的 shell 卡 |
| [配置](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/configuration.md) | 插件页、SSH 主机与传输、live 语义、分阶段保存 |
| [验证](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/verification.md) | 开发运行时、两个测试入口、可选的 live SSH 往返 |
| [故障排查](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/troubleshooting.md) | 症状 → 修复 |

详细文档以英文维护；本 README 是双语入口与发布摘要。

## 验证

```bash
npm ci                  # 一次：安装钉定的 0.2.1-rc.2 开发运行时
pnpm test               # 启动真实组合、跑真实命令、失败即判据
pnpm run test:audit     # 完整审计套件
DSH_AUDIT_SSH_HOST=me node smoke/prepare.mjs audit   # 可选：live SSH 往返
```

两个入口都是开发工具：发布 tarball 不包含 `smoke/`。`pnpm test` 在工具缺失、描述错误、`ctx.shell` 席位丢失或任一命令失败时退出非零；审计会声明并统计 skip。

## 文件布局

```
dsh-win-multi-bash/
├── package.json            # dsh.bundle + dsh.client + engines.dsh；每个工具子路径的 exports
├── cordis.patch.yml        # 组合接线（行内注释）
├── lib/                    # 普通 ESM 实现（无构建步骤）
├── smoke/                  # 开发验证（不随包发布）
├── docs/                   # 架构、原则、沙箱、终端、会话行、配置、验证、故障排查
└── LICENSE / THIRD_PARTY_NOTICES
```

`docs/` 与 `smoke/` 仅存在于仓库；`npm pack` 只发布 `package.json` 的 `files` 白名单。

## 许可

MIT。见 [LICENSE](LICENSE)；上游声明见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)。
