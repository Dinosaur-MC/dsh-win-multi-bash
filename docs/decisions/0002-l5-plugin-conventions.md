# 0002 · L5 通过插件的代码规范与启动流程对照

日期：2026-11-03 · 对象：`dsh-win-multi-bash` 与两个在 dsh 0.2.1-rc.5 上通过 L5 的同族插件

## 样本

| 插件 | 版本 | 来源 | 验证 |
| --- | --- | --- | --- |
| `dsh-gitbash-shell` | 0.48.0 | npm | dsh.so 工件页：L5 运行已测，通过（dsh 0.2.1-rc.5） |
| `dsh-gitbash` | 0.1.1 | git（commit `4317a6b`） | dsh.so 工件页：L5 运行已测，通过（dsh 0.2.1-rc.5） |
| `dsh-win-multi-bash` | 0.7.7 | npm | 工件页：0.7.6 那次 L5 失败（boot failed）；本机 0.7.6 / 0.7.7 均可启动 |

## 清单与元数据差异

| 项 | 两个 L5 插件 | 本插件 | 影响 |
| --- | --- | --- | --- |
| `dsh.plugin.json` | 有（id / version / main / engines / contributes） | 无 | 静态扫描与仓库级清单读取的规范件；缺失减少可被识别信息 |
| `dsh.compatibility.dshReleases` | 有（逐版本 `compatible` 映射） | 无 | 站点展示与兼容判断的显式声明 |
| `dsh.client.inject` | 有（列出声明的客户端包 id） | 无，但 `lib/client.js` 直接 `require('@deepseek-ai/dsh-client-ui-primitives')` | **契约缺口**：客户端要求的模块没有在清单里声明 |
| `engines.dsh` | `>=0.1.7-rc` / 未声明 | `>=0.1.7-rc.2 <0.3.0-0` | 本插件的上界更窄，0.2.x 内不受影响 |
| 行 id | 单个行，id 与设置命名空间一致（`gitbash-shell`） | 六个行，核心行 id `win-mb-plugin` ≠ 包名 | DSH 按行 id 定位配置表单；行 id 与包名不一致时依赖备胎 key |
| 测试 | `node --test` 多文件 | 单文件 `smoke/audit.test.mjs` + prepare | 不影响运行，但覆盖面窄 |
| CI | `ci.yml` + `npm-publish.yml` | 单 `ci.yml`（Node 22/24） | 发布自动化弱一档 |

## 启动流程差异

- **模块顶层**：两者顶层只做 import 与常量；所有注册落在 `apply` 内的 `ctx.effect` / `ctx.inject` / `ctx.on`。本插件顶层同样只 import，但 `apply` 里多做了三件宿主相关的事：方言注册表校验、私有临时目录守卫（timer + confine 钩子）、`systemPrompt.section` 注册。
- **`apply` 内的等待**：两者没有 `await` 任何子进程；本插件的工具行在 `apply` 中 `await executor.resolveSandboxMode()`（有 try/catch 与探测超时，最坏情况等一次探测）。这属于「apply 期间可能变慢」的差异，不是失败源。
- **可选服务**：两者都用 `ctx.inject([...])` 拿可选能力；本插件同样如此（sandbox / webServer / connection）。
- **客户端半边**：两者在 `dsh.client` 里声明 `inject` 与 `platform`；本插件只声明 `platform`。

## 本机复现（对照实验）

| 场景 | 结果 |
| --- | --- |
| 隔离 DSH_HOME，npm 0.7.6，`dsh web --no-open` | 启动成功，`curl /` → HTTP 401 |
| 隔离 DSH_HOME，npm 0.7.7，`dsh web --no-open` | 启动成功，`curl /` → HTTP 401 |
| 隔离 DSH_HOME，npm 0.7.7，PATH 去掉 Git Bash、ProgramFiles 指向非 Git 目录 | 启动成功，`curl /` → HTTP 401 |

三种场景都没有出现 `boot failed`；工件页那次两项 `0ms` 的检查仍然指向其沙盒 runner，而不是本插件的启动代码。

## 结论与建议

1. **补 `dsh.client.inject`**：按 `lib/client.js` 实际 `require` 的客户端包逐条声明（当前已知 `@deepseek-ai/dsh-client-ui-primitives`）。这是与 L5 样本最直接的一处规范缺口。
2. **补 `dsh.compatibility`**：`dsh` 范围沿用 `engines.dsh`，`dshReleases` 逐版本写 `compatible`（至少覆盖 0.2.1-rc.2 到 rc.5 与本机实测版本）。
3. **补 `dsh.plugin.json`**：`id` 用包名、`version`、`main`、`engines`、`contributes`（本插件可用 `{ tools: [], skills: [] }`）。
4. **考虑把核心行 id 对齐设置命名空间**（`win-mb-plugin` → 包名或反之），减少对备胎 key 的依赖；此项改动大，先评估配置迁移成本。
5. **`apply` 不做等待**：把 `resolveSandboxMode()` 的 await 从行装配路径移到首次命令的惰性路径，让 apply 严格同步完成。此项需要改动工具行契约，排在 1–3 之后。
6. 上述完成后发一版，让 dsh.so 重测最新版本；若仍报 0ms 的 boot failed，再按其 runner 复现。

