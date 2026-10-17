[English](README.md) | 中文

# dsh-win-multi-bash

[![npm version](https://img.shields.io/npm/v/dsh-win-multi-bash.svg)](https://www.npmjs.com/package/dsh-win-multi-bash)
[![license](https://img.shields.io/npm/l/dsh-win-multi-bash.svg)](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/dsh-win-multi-bash.svg)](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/package.json)
[![GitHub stars](https://img.shields.io/github/stars/Dinosaur-MC/dsh-win-multi-bash.svg)](https://github.com/Dinosaur-MC/dsh-win-multi-bash/stargazers)
![dsh ≥ 0.1.7-rc.2](https://img.shields.io/badge/dsh-%E2%89%A5%200.1.7--rc.2-blue.svg)
![platform: windows](https://img.shields.io/badge/platform-windows-0078d4.svg)
![dialects: MSYS, WSL, MSYS2, SSH](https://img.shields.io/badge/dialects-MSYS%20%7C%20WSL%20%7C%20MSYS2%20%7C%20SSH-4c1.svg)
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/dinosaur-mc/dsh-win-multi-bash)

DeepSeek Harness 的 Windows 多 bash 插件。**`git_bash`**（Git for Windows / MSYS）默认开启；**`wsl_bash`**（WSL）、**`msys2_bash`**（MSYS2 UCRT64）与 **`ssh_bash`**（经 OpenSSH 的远端 shell）按需开启。**`terminal`** 在调用之间保留一个真正的 PTY 会话。

每个方言持有自己的执行器，且**没有任何工具注册 `ctx.shell`**——该席位始终归基座自带的 pwsh，因此 pwsh 的行为与未装本插件时完全一致。

## 工具

| 工具 | 后端 | 说明 |
| --- | --- | --- |
| `git_bash` | Git for Windows（MSYS） | **默认开启**；持有 `GitBashExecutor` |
| `wsl_bash` | WSL Linux | **按需开启**；持有 `WslBashExecutor`；首次加载会探测发行版 |
| `msys2_bash` | MSYS2 UCRT64 | **按需开启**；持有 `Msys2BashExecutor`；MSYS2 自己的 `$MSYSTEM` 与 `pacman` |
| `ssh_bash` | 远端（SSH） | **按需开启**；持有 `SshBashExecutor`；每次调用一条命令；目标属于部署配置 |
| `terminal` | 以上任意后端 | 持久 PTY 会话：`open` / `send` / `read` / `signal` / `close` / `list` |
| `pwsh` | dsh 自带 | 不受影响；由基座的 `pwsh-sandbox` 行提供 |

只有 `git_bash` 与 `terminal` 默认开启。另外三行默认关闭，因为每行都挂载一台机器未必具备的工具链（或主机）；请在**插件**页按需启用。在许多 Git for Windows 主机上，windows-acl runner 无法启动 MSYS bash，所以 `git_bash` 会以未包裹方式运行并如实说明——需要沙箱时请用 `wsl_bash`（bwrap）或 dsh 自带的 pwsh。详见[沙箱行为](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/sandbox.md)。

## 安装

唯一安装路径是 `dsh plugin`（一个 pnpm 转发器）。bundle 层会应用本包自己的 `cordis.patch.yml`，插入它的行。

```powershell
dsh plugin --profile web add dsh-win-multi-bash                    # npm 包（推荐）
dsh plugin --profile web add github:@Dinosaur-MC/dsh-win-multi-bash # GitHub 源码
dsh plugin --profile web remove dsh-win-multi-bash                 # 卸载
```

需要 `pnpm`。bundle 层在启动时组装，改动后请**重启 `dsh web`**。不要把手写的相同行再写进 profile 的 `cordis.patch.yml`：loader 会拒绝重复的 entry id。细节与手工等价写法见[配置](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/configuration.md)。

## 快速开始

- **`git_bash`** 装好即可用。每次调用启动一个全新的 MSYS bash；`workdir` 接受原生、MSYS（`/c/...`）与 WSL automount（`/mnt/c/...`）三种写法。
- **`wsl_bash` / `msys2_bash`**：在插件页启用 `win-mb-tool-wsl` / `win-mb-tool-msys2`。只有自动探测不够时才需要 pin `wslBash.wslDistro` 或 `msys2Bash.bashPath`。
- **`ssh_bash`**：启用 `win-mb-tool-ssh` 并 pin `sshBash.sshHost`（主机名或 `~/.ssh/config` 别名），需要时再设 `sshUser` / `sshPort`。目标永远不是工具参数；没有主机的行会拒绝每一次调用。单次调用使用 `BatchMode=yes`，请用密钥认证；要回答首次连接提问，用 `terminal` 的 `shell: "ssh_bash"` 会话形态。
- **`terminal`**：`open` 开会话，`send`（`submit: true`）发命令，`read` 读回复，`close` 结束。工作目录、导出的变量与别名会跨调用保留。会话是进程内的、有上限、空闲会被回收，且**不是**后台任务。
- 每行在插件页都有**配置**入口：路径、超时、沙箱立场、会话上限，以及部署级的自愈开关。除非某个旋钮决定工具 schema，改动都是即时的。

## 设计概览

- **只说不曾观测到的事实。** 成功且被包裹的运行报 `denied: false`；失败且匹配后端拒绝方言的报 `denied: true`；失败但匹配不上的不报 `denied`。未包裹运行报 `unconfined: true`。远端 SSH 运行报 `sandbox: { mode, remote: true }`，绝不借用本地判词。
- **平台原生的调用卡片。** 本插件的工具调用渲染成平台自己的 shell 卡：完整的终端 labels、座位提供的 `useDisclosure`、仅头部的后台卡，以及平台的 exit capsule。见[会话行](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/conversation-rows.md)。
- **一个方言一条声明。** 方言 = 一个执行器文件 + 一条注册表声明；工具模块、提示词成员、patch 行、配置分区、包 exports 与客户端行都由它派生。声明不自洽会在加载时直接报错。见[架构](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/architecture.md)与[设计原则](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/principles.md)。
- **只有一段共享提示词。** 核心行拥有唯一的 `tool:win-mb-bash` 小节，其文本随实际挂载的工具变化；每个工具描述只保留自己的方言事实。
- **配置即时生效，用户输入优先。** 能即时的旋钮都声明为 `.volatile()`；页面从不改写或删除你输入的值，保存带 revision 围栏。见[配置](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/configuration.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [架构](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/architecture.md) | 行、执行器、方言注册表、提示词小节、客户端半边与调用流 |
| [设计原则](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/principles.md) | 实现必须遵守的规则：诚实事实、派生面、平台一致性、live 与 schema 旋钮 |
| [沙箱行为](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/sandbox.md) | 各后端能力、Windows 限制、bwrap、自愈、SSH 的远端作用域 |
| [终端会话](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/terminal.md) | PTY 生命周期、信号、上限、SSH 会话、实测默认值 |
| [会话行](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/conversation-rows.md) | 一次调用如何变成平台的 shell 卡 |
| [配置](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/configuration.md) | 插件页、每行的旋钮、live 语义、分阶段保存 |
| [验证](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/verification.md) | 开发运行时、两个测试入口、可选的 live SSH 往返 |
| [故障排查](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/troubleshooting.md) | 症状 → 修复 |

详细文档以英文维护；本 README 是双语入口与发布摘要。

## 验证

```bash
npm ci                  # 一次：安装钉定的 0.2.1-rc.2 开发运行时
pnpm test               # 启动真实组合、跑真实命令、失败即判据
pnpm run test:audit     # 完整审计套件
DSH_AUDIT_SSH_HOST=ubuntu_tx node smoke/prepare.mjs audit   # 可选：live SSH 往返
```

两个入口都是开发工具：发布 tarball 不包含 `smoke/`。`pnpm test` 在工具缺失、描述错误、`ctx.shell` 席位丢失或任一命令失败时退出非零；审计会声明并统计 skip。细节见[验证](https://github.com/Dinosaur-MC/dsh-win-multi-bash/blob/main/docs/verification.md)。

## 环境要求

- Windows，以及一个带已发布 `@deepseek-ai` 基础包的 dsh 部署。
- Git Bash / WSL / MSYS2 只在启用对应后端时需要；缺后端不会影响 pwsh。
- `ssh_bash` 需要 OpenSSH 客户端、可达主机，以及无需交互提示的凭据。
- Node `^22.19.0 || >=24.0.0`（本包声明范围），安装需要 `pnpm`。

## 文件布局

```
dsh-win-multi-bash/
├── package.json            # dsh.bundle + dsh.client；每个工具子路径的 exports
├── cordis.patch.yml        # 组合接线（行内注释）
├── lib/                    # 普通 ESM 实现（无构建步骤）
├── smoke/                  # 开发验证（不随包发布）
├── docs/                   # 架构、原则、沙箱、终端、会话行、配置、验证、故障排查
└── LICENSE / THIRD_PARTY_NOTICES
```

`docs/` 与 `smoke/` 仅存在于仓库；`npm pack` 只发布 `package.json` 的 `files` 白名单。

## 许可

MIT。见 [LICENSE](LICENSE)；上游声明见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)。
