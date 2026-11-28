# deploydeck

声明式部署执行内核。它按计划创建容器、部署项目、验证产物、销毁容器。

## 定位

deploydeck 是执行内核，不是 Agent 外壳。

Agent、TUI、Web 三个界面都是它的客户端。内核本身不依赖任何模型。

这条边界是硬约束。模型不可用时，人仍然能完成全部部署动作。

## 它解决什么问题

1. 云端 GPU 按小时计费。忘记关机就会持续烧钱。
2. 每次部署新建容器。失败后容器可能残留在云端。
3. 多台机器、多家云厂商的操作方式各不相同。

deploydeck 把这些收敛成一条链路：

```
申请计划 → 获取实例 → 等 SSH 就绪 → 健康检查 → 销毁容器 → 确认容器消失
```

每一步都留日志。容器销毁后，日志仍然在本机。

装环境、拉代码、起服务不在链路里。它们由使用者经 `shell` 在实例上自行执行。
`run` 成功只保证「实例已获取、已连通、健康检查通过」，不保证业务服务可用。

## 当前状态

Phase 2 命令面已接通，真机全链路已实测通过（2026-11-25，AutoDL 标准容器实例）：
开关机、平台定时关机、克隆、改名、`run` 全绿、`teardown` 释放并确认消失。
实测结论与踩到的坑见 `docs/refs/autodl/console-selectors.md`。

真机测试现在是可复跑的套件，见下文「测试」。

| 能力 | 状态 |
|---|---|
| 部署清单（Profile / Project）校验 | 可用 |
| `profile list` | 可用 |
| `plan create` / `plan show`（`--balance` 可读账户余额） | 可用 |
| `run`：开机复用或克隆、等 SSH 就绪、预算与余额复核、平台定时关机、健康检查、逐步日志 | 可用 |
| `status`：生效计划、实例状态、单价、花费、账本摘要 | 可用 |
| `teardown`：销毁、终态验证、账本结算、计划关闭 | 可用 |
| `login`：打开专用 Chrome 等人登录 | 可用 |
| `shell`：连到运行中实例的交互式终端（PTY），也给 `--` 之后的命令走 `exec` 跑一条 | 可用 |
| `power`：开机或关机，并核实终态 | 可用；真机未验证 |
| `switch`：关机 → 按目标形态开机 → 复验形态 | 可用；真机未验证 |
| `creds`：读取实例的 SSH 登录信息，密码只进 stdout | 可用 |
| `tunnel`：把实例的远端端口转发到本机回环 | 可用 |
| 无卡模式开机（`powerOnMode: no-gpu`） | 可用；真机未验证 |
| `guard`：计划层守护（过期计划销毁、预算熔断、余额告警） | 可用；系统级自启动未实现 |
| AutoDL provider：控制台动作 + SSH 数据面 | 已接入 |
| 首批接入样例：asyncProxyServer | 配置就绪；真机未验证 |
| `plan extend` / `ledger` | 未实现 |
| `guard` 系统级自启动 | 未实现 |

未实现的命令打印 `[NOT IMPLEMENTED]`，退出码 2。

## 测试

两套测试，分开跑，不混在一起。

| 套件 | 入口 | 跑什么 | 花钱 |
|---|---|---|---|
| 常规单测 | `pnpm test` | `src/**/*.spec.ts`，全部假通道，几百毫秒 | 否 |
| 真机测试 | `pnpm test:e2e` | `e2e/**/*.e2e.test.ts`，连真实控制台与 SSH | **是** |

真机测试会开关机、克隆、释放真实实例，耗时较长。它与常规测试完全分开：
`pnpm test` 永远不跑它，只能经 `pnpm test:e2e` 显式触发，且必须给三个环境变量
（开关、源实例 ID、批准的花费额度），缺一个就拒绝，不做任何控制台动作。
预计花费与授权命令见 `e2e/README.md`。

真机测试的浏览器与人正在用的 Chrome 完全分开：它用独立的 e2e profile，并且后台启动。

## 快速开始

```bash
pnpm install
pnpm build
node dist/cli/main.js --help
```

开发期直接跑 TypeScript：

```bash
pnpm dev -- --help
```

配置目录默认是 `~/.config/deploydeck`。你可以用环境变量覆盖：

| 变量 | 默认值 | 用途 |
|---|---|---|
| `DEPLOYDECK_CONFIG_DIR` | `~/.config/deploydeck` | 存放 `profiles/` 与 `projects/` |
| `DEPLOYDECK_STATE_DIR` | `~/.local/state/deploydeck` | 存放计划、运行记录、账本、日志 |
| `DEPLOYDECK_CDP_PORT` | `9222` | 专用 Chrome 的 CDP 端口 |
| `DEPLOYDECK_CHROME_PROFILE_DIR` | WSL 下 `%LOCALAPPDATA%\deploydeck\chrome-profile`，其余 `<状态目录>/chrome-profile` | 专用 Chrome 的 user-data-dir。不落配置目录：Chrome 会往里写登录态，配置目录机器只读。WSL 下必须落 Windows 本地磁盘，`\\wsl.localhost` 上的 LevelDB 加锁失败会让登录态写不进磁盘 |
| `DEPLOYDECK_CHROME_LAUNCH_BACKGROUND` | `0` | 后台启动 Chrome：窗口最小化、不抢前台。只支持 WSL 调 Windows Chrome；其他平台置 `1` 会直接报错 |
| `DEPLOYDECK_WINDOWS_PROFILE_ROOT` | `%LOCALAPPDATA%` | WSL 下 Chrome profile 的 Windows 根目录 |
| `DEPLOYDECK_CHROME_EXECUTABLE` | 按平台自动查找 | 专用 Chrome 可执行文件绝对路径。自动查找失败时用它指定 |
| `DEPLOYDECK_BALANCE_WARN_BELOW_YUAN` | 无默认值 | 余额告警阈值，元。只有 `guard` 需要；不配置时 `guard` 启动即报错 |

仓库里的 `examples/` 是一份配置样例。把 `examples/profiles/` 与 `examples/projects/`
复制到配置目录后即可被识别（目录名必须分别是 `profiles` 与 `projects`）。

### 首次真机运行前的准备

真机验证会产生费用，由人工发起。跑之前先确认这四件事：

1. **专用 Chrome 已登录**：执行 `deploydeck login`，在打开的窗口里完成控制台登录。
   登录态存在专用 user-data-dir 里，与日常浏览互不干扰。未登录时 `run`、`teardown`
   返回退出码 2，且不改动任何实例；`status` 在需要读控制台（有生效计划）时同样返回 2。
2. **配置目录里有 Profile 与 Project**：`profiles/<id>.jsonc` 与 `projects/<id>.jsonc`。
   从 `examples/` 复制后按实际环境改 `workdir`、`gpuPreference`、`ttlMinutes`、`budgetCapYuan`
   与 `cloneSourceInstanceName`。
3. **控制台里有一台已关机实例作为克隆源**：Profile 的 `cloneSourceInstanceName` 必须指向它
   （写名字或实例 ID）。走克隆路径时以它为模板；没有同名实例时才会用克隆。
   源实例不合适时 `run` 会在动手前报错并列出可用的已关机实例。
4. **状态目录可写且不在配置目录内**：默认 `~/.local/state/deploydeck`。状态目录落在配置目录内时，
   构造状态存储即报错（配置目录由人写，机器只读）。

### 一次取实例

```bash
deploydeck login
deploydeck profile list
deploydeck plan create --profile asyncproxy-dev
deploydeck run --plan <planId>
deploydeck status
deploydeck teardown <planId>
```

`run` 结束后实例已开机、SSH 已连通。装环境、拉代码、起服务由你自己执行：

```bash
deploydeck shell <instanceId> -- '<命令>'
```

`run` 成功只说明实例已就绪可连。业务服务是否可用要由你自己的命令确认。

计划过期后的兜底是 `deploydeck guard`：它每 5 分钟巡检一次过期计划并销毁绑定实例，
同时做预算熔断与余额告警。系统级自启动（pm2 / systemd）属 Phase 3，本期需要人把它挂在
终端或自管的常驻进程里。余额告警阈值必须显式配置：

```bash
DEPLOYDECK_BALANCE_WARN_BELOW_YUAN=20 deploydeck guard --once
```

完整命令、参数与 `--json` 输出形状见 [CLI 命令面](docs/cli.md)。

## 分层

| 层 | 职责 | 是否知道 AI 存在 |
|---|---|---|
| L1 领域模型 | 定义 Profile、Project、Plan、Run 的形状 | 否 |
| L2 provider | 在某类资源上创建、执行、销毁 | 否 |
| L3 计划与预算 | 有效期、预算上限、两重关机与余额告警 | 否 |
| L4 执行引擎 | 步骤编排、失败语义、终态验证 | 否 |
| L5 命令服务 | 唯一入口，人机共用 | 否 |
| L6 界面与 Agent | CLI、TUI、Web、Agent 接入 | 是 |

详细判据见 [docs/architecture.md](docs/architecture.md)。

## 文档

- [操作手册](docs/OPERATIONS.md) —— 外部项目怎么接入、怎么跑、机器读者怎么调。**只看一份就从这里开始**
- [Phase 2 spec](docs/specs/deploydeck-phase2.md) —— 实例获取链路的设计与验收标准
- [Phase 3 spec](docs/specs/deploydeck-phase3-shell.md) —— 交互式终端与无卡模式开机
- [施工工单](docs/tickets/) —— 按依赖序编号
- [CLI 命令面](docs/cli.md) —— 命令、参数、`--json` 输出形状、退出码、例行操作
- [状态目录布局](docs/state-layout.md) —— 计划、执行记录、账本、日志、锁的落点与格式
- [AutoDL 文档快照](docs/refs/autodl/) —— 离线可查的平台口径
- [AutoDL 控制台选择器清单](docs/refs/autodl/console-selectors.md) —— 页面结构与点击规则
- [术语表](GLOSSARY.md)
- [架构与分层判据](docs/architecture.md)
- [provider 能力契约](docs/provider-contract.md)
- [计划、预算与关机](docs/plan-and-budget.md)

## 退出码

| 退出码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 业务失败。计划无效、预算不足、余额不足、健康检查失败、实例不在运行中 |
| 2 | 需要人工介入。配置错误、未登录、命令未实现、实例未确认消失、克隆超时 |

退出码由错误类自带（`src/errors.ts`），CLI 只透传。逐条说明见 [CLI 命令面](docs/cli.md) 第 5 节。

## License

MIT
