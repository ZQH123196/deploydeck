# CLI 命令面

> 契约来源：[Phase 2 spec](specs/deploydeck-phase2.md) 第 12 节、[Phase 3 spec](specs/deploydeck-phase3-shell.md) 第 3 与第 4 节、各工单验收。
> 实现入口：`src/cli/main.ts`；命令实现：`src/cli/commands/`；依赖装配：`src/cli/dependencies.ts`。
> 退出码与错误行格式见本文第 5 节。操作步骤版见 [操作手册](OPERATIONS.md)。

CLI 是唯一稳定接口。TUI、Web、Agent 都调用同一批命令，人也能直接跑。

外部项目接 deploydeck 时先读 [操作手册](OPERATIONS.md)。本文是命令的逐个参考。

## 1. 通用约定

### 1.1 `--json`

每条命令都支持 `--json`。它既可写在根命令之前，也可写在具体命令之后：

```bash
deploydeck --json status
deploydeck status --json
```

判据：`--json` 模式下 stdout 只有**一行一个 JSON 对象**，没有别的行。
进度、引擎日志与错误信息一律走 stderr。人读模式的结果走 stdout，进度走 stderr。

### 1.2 目录

| 目录 | 默认位置 | 谁能写 |
|---|---|---|
| 配置目录 | `~/.config/deploydeck` | 人写，机器只读 |
| 状态目录 | `~/.local/state/deploydeck` | 机器写 |

环境变量一览。环境变量只有一个读取入口（`src/config/paths.ts`），命令与动作模块不直接读：

| 变量 | 默认值 | 用途 |
|---|---|---|
| `DEPLOYDECK_CONFIG_DIR` | `~/.config/deploydeck` | 配置目录 |
| `DEPLOYDECK_STATE_DIR` | `~/.local/state/deploydeck` | 状态目录 |
| `DEPLOYDECK_CDP_PORT` | `9222` | 专用 Chrome 的 CDP 端口 |
| `DEPLOYDECK_CHROME_PROFILE_DIR` | WSL 下 `%LOCALAPPDATA%\deploydeck\chrome-profile`，其余 `<状态目录>/chrome-profile` | 专用 Chrome 的 user-data-dir |
| `DEPLOYDECK_CHROME_EXECUTABLE` | 按平台查找 | 专用 Chrome 可执行文件绝对路径 |
| `DEPLOYDECK_WINDOWS_PROFILE_ROOT` | `%LOCALAPPDATA%` | WSL 下 Chrome profile 的 Windows 根目录 |
| `DEPLOYDECK_BALANCE_WARN_BELOW_YUAN` | 无 | 余额告警阈值（元）。`guard` 必填，不配则启动报错 |

配置目录下 `profiles/<id>.jsonc` 与 `projects/<id>.jsonc` 分别放部署配置与项目清单。
完整布局见 [状态目录布局](state-layout.md)。

### 1.3 命令清单

| 命令 | 作用 |
|---|---|
| `profile list` | 列出配置目录里的全部部署配置 |
| `plan create` | 创建一份计划（授权窗口） |
| `plan show [planId]` | 列出全部生效计划，或显示单份 |
| `run` | 在生效计划下执行部署 |
| `status` | 查看生效计划、绑定实例的状态、单价、花费与账本摘要 |
| `teardown <planId>` | 销毁计划绑定的实例，确认消失后写账本并关闭计划 |
| `login` | 打开专用 Chrome，等人登录完成 |
| `guard` | 前台常驻守护：过期计划销毁、预算熔断、余额告警 |
| `shell <instanceId>` | 连到运行中实例的交互式终端 |
| `shell <instanceId> -- <command>` | 在 PTY 里跑一条命令并返回退出码 |
| `plan extend` | 未实现（Phase 3），退出码 2 |
| `ledger` | 未实现（Phase 3），退出码 2 |

## 2. 命令

### 2.1 `profile list`

```bash
deploydeck profile list [--json]
```

读 `<配置目录>/profiles/`。任一文件非法时一次报完全部问题，退出码 2。

人读输出一行一份配置，列：ID、项目、provider、开机形态、时长、预算、失败后策略、是否锁定 commit。
开机形态列写「有卡」或「无卡」，对应 Profile 的 `powerOnMode`。

`--json` 输出形状：

```json
{ "profiles": [ { "id": "asyncproxy-dev", "project": "asyncproxy-server", "...": "..." } ] }
```

### 2.2 `plan create`

```bash
deploydeck plan create --profile <id> [--ttl <minutes>] [--budget <yuan>] [--json]
```

读配置目录里的 Profile，用 provider 的静态能力声明校验（不打开浏览器），落盘一份计划。
`--ttl` 与 `--budget` 覆盖 Profile 里的默认值。

`--json` 输出形状：

```json
{
  "plan": { "id": "plan-...", "profileId": "asyncproxy-dev", "createdAt": "...", "expiresAt": "...", "budgetCapYuan": 6, "spentYuan": 0, "state": "active", "instanceId": null },
  "timedShutdownAt": "2026-11-25T03:40:00+08:00",
  "onDeployFailure": "keep-container"
}
```

`timedShutdownAt` = `expiresAt` 减 5 分钟安全余量（spec 第 7.4 节）。

### 2.3 `plan show`

```bash
deploydeck plan show [planId] [--balance] [--json]
```

- 不带参数：列出全部生效计划及剩余时长。
- 带参数：显示单份计划。计划不存在时退出码 1。
- `--balance`：打开控制面读账户余额。不带时输出明确写「余额未读取」，不拿预算余量冒充余额。
  需要读余额时会检查登录态，未登录退出码 2。

`--json` 输出形状（单份：`plan`；列表：`plans`）：

```json
{
  "plan": { "...": "..." },
  "remainingMinutes": 59,
  "spentYuan": 0.5,
  "remainingBudgetYuan": 5.5,
  "state": "active",
  "timedShutdownAt": "2026-11-25T03:40:00+08:00",
  "balanceYuan": 100.5
}
```

```json
{ "plans": [ { "...": "同上，单份 PlanView" } ], "balanceYuan": 100.5 }
```

`balanceYuan` 为 `null` 表示本次没有读取余额（没给 `--balance`，或控制面不可用）。

### 2.4 `run`

```bash
deploydeck run --plan <planId> [--commit <sha>] [--run-id <id>] [--json]
deploydeck run --profile <profileId> [--create-plan] [--commit <sha>] [--run-id <id>] [--json]
```

`--plan` 与 `--profile` 必须且只能给一个。

| 参数 | 含义 |
|---|---|
| `--plan <planId>` | 直接用这份计划 |
| `--profile <profileId>` | 找该 Profile 的生效计划：恰好一份用它；多于一份报错并列出 id；一份都没有则失败 |
| `--create-plan` | 显式授权 `--profile` 在没有生效计划时新建一份。只能与 `--profile` 一起用 |
| `--commit <sha>` | 部署的代码版本，4-40 位十六进制。Profile 的 `requirePinnedCommit=true` 时必填。给了它时引擎先执行 `sync-commit` 步骤：`fetch` → `checkout --force` → 回验 HEAD；仓库不存在时先按 `project.repository` 克隆 |
| `--run-id <id>` | 指定执行 id。测试注入固定值用；默认由 CLI 生成 `run-<时间戳>-<随机>` |

两条路径都要过「有生效计划」这一关（spec 第 9.1 节）。没有生效计划时 `--profile` 报业务失败
（退出码 1），错误信息给出 `deploydeck plan create --profile <id>` 与 `--create-plan` 两条出路；
`run` 自己不会创建计划。

顺序判据：CLI 先定 run id、建 `runs/<runId>/`，再把 provider 的 `logDir` 指到该目录，
最后把同一个 id 交给执行引擎。控制台截图因此落进本次 run 的目录。

未登录（控制台页面出现登录入口）时退出码 2，且不会创建 provider：不点任何按钮、不动任何实例。

`--json` 输出形状：

```json
{
  "runId": "run-20261125-023500-1a2b",
  "planId": "plan-20261125-023000-9f8e",
  "mode": "reuse",
  "instanceId": "af9c49bd44-8ee624d7",
  "commitSha": null,
  "state": "succeeded",
  "unitPriceYuanPerHour": 1.2,
  "timedShutdownAt": "2026-11-25T03:40:00+08:00",
  "steps": [
    {
      "stepId": "power-on",
      "kind": "console",
      "command": "powerOn(af9c49bd44-8ee624d7)",
      "exitCode": 0,
      "startedAt": "2026-11-25T02:35:01+08:00",
      "finishedAt": "2026-11-25T02:35:20+08:00",
      "stdoutTail": "",
      "stderrTail": "",
      "stdoutBytes": 0,
      "stderrBytes": 0,
      "logPath": "/home/.../runs/run-20261125-023500-1a2b/logs/power-on.log",
      "screenshotPaths": []
    }
  ]
}
```

走 `--profile --create-plan` 且当场新建计划时，多一个 `createdPlanId` 字段。

### 2.5 `status`

```bash
deploydeck status [--json]
```

列出全部生效计划、绑定的实例、实例当前状态、单价、累计花费，以及账本行数与最近 5 行。
没有生效计划时不打开控制台（省掉一次登录态检查）；有生效计划时需要读控制台，
未登录时退出码 2。

`--json` 输出形状：

```json
{
  "plans": [
    {
      "planId": "plan-...",
      "profileId": "asyncproxy-dev",
      "state": "active",
      "expiresAt": "2026-11-25T03:45:00+08:00",
      "remainingMinutes": 59,
      "instanceId": "af9c49bd44-8ee624d7",
      "instanceStatus": "running",
      "instanceStatusRaw": "运行中",
      "gpuSpec": "RTX 5090(32GB)",
      "unitPriceYuanPerHour": 1.2,
      "spentYuan": 0.5,
      "budgetCapYuan": 6
    }
  ],
  "ledger": {
    "status": "present",
    "entryCount": 1,
    "recentEntries": [ { "...": "账本行，最多 5 行" } ]
  }
}
```

单价来自 `prices/<profileId>.jsonc` 的最近一次观测。没观测过时为 `null`。

`ledger.status` 区分「账本文件不存在」（`missing`）与「账本存在但为空」（`present` + `entryCount: 0`）。
文件不存在时人读输出也明说，不冒充 0 行。

### 2.6 `teardown`

```bash
deploydeck teardown <planId> [--json]
```

销毁计划绑定的实例，确认该实例从控制台列表消失后：

1. 写一行账本（同一实例生命周期只写一行，重复执行不重复记账）。
2. 把该行金额加到计划的 `spentYuan`。
3. 计划转 `closed`。

未确认消失时计划转 `ESCALATED`，退出码 2，不自动重试。
计划不存在、已关闭、未绑定实例时退出码 1。
实例已不在控制台列表、但账本没有它的记录时退出码 2：停止时刻无法确定，不编金额。

执行记录缺 `instanceAcquiredAt`、`gpuSpec`、`unitPriceYuanPerHour` 任一字段时退出码 2，
不做任何销毁动作：错误信息说清缺哪个字段、去 `runs/<runId>.jsonc` 核对。
账本文件丢失但计划上已有 `spentYuan` 时同样退出码 2：继续结算会重复记账。

未登录时退出码 2，且不改动任何实例。

`--json` 输出形状：

```json
{
  "planId": "plan-...",
  "instanceId": "af9c49bd44-8ee624d7",
  "state": "closed",
  "ledgerEntry": { "planId": "...", "runId": "...", "instanceId": "...", "gpuSpec": "...", "startedAt": "...", "stoppedAt": "...", "unitPriceYuanPerHour": 1.2, "amountYuan": 0.6 },
  "spentYuan": 1.1,
  "budgetCapYuan": 6,
  "budgetExhausted": false
}
```

`ledgerEntry` 为 `null` 表示该实例生命周期已有账本行，本次未重复记账。

### 2.7 `login`

```bash
deploydeck login [--timeout <seconds>] [--json]
```

打开专用 Chrome 并等到页面不再出现登录入口。`--timeout` 默认 300 秒。
不填账号密码：登录只由人完成。超时退出码 2。

`--json` 输出形状：

```json
{ "url": "https://www.autodl.com/console/instance/list", "elapsedMs": 12000, "screenshotPaths": [] }
```

### 2.8 `guard`

```bash
deploydeck guard [--interval-minutes <n>] [--once] [--json]
```

前台常驻守护，实现 spec 第 9.3 节的第二层（计划层）与第三层（余额层）。每轮做三件事：

1. 过期的生效计划：绑定了实例就执行销毁链；确认消失后写账本、把金额记回 `spentYuan`、
   计划转 `closed`；未确认消失则计划转 `escalated`，打 error 日志。没有绑定实例的过期
   计划直接转 `closed`（没有可销毁对象）。
2. 仍生效但 `spentYuan >= budgetCapYuan` 的计划：销毁并转 `closed`。
3. 读账户余额；低于 `DEPLOYDECK_BALANCE_WARN_BELOW_YUAN` 时打 warn。

| 参数 | 含义 |
|---|---|
| `--interval-minutes <n>` | 巡检间隔分钟数。**默认 5**（spec 第 9.3 节的判据） |
| `--once` | 只巡一轮就退出。测试与人工排查用 |
| `--json` | 只与 `--once` 一起用；输出一轮巡检报告 |

判据：

- 浏览器连不上时**降级为告警，不静默**：记 error 日志、本轮剩余计划动作留给下一轮，
  进程不退出，已有实例不受影响。
- `guard` 的退出码不因 `escalated` 或降级而改变：它是常驻进程，`--once` 完成一轮即 0。
- 余额告警阈值必须显式配置。没有 `DEPLOYDECK_BALANCE_WARN_BELOW_YUAN` 时启动期报错（退出码 2），
  信息说明要配哪个变量。
- 系统级自启动（pm2 / systemd）属 Phase 3，本期不做。

`--once --json` 输出形状：

```json
{
  "startedAt": "2026-11-25T03:20:00+08:00",
  "activePlanCount": 1,
  "expiredPlanIds": ["plan-..."],
  "overBudgetPlanIds": [],
  "closedPlanIds": ["plan-..."],
  "escalatedPlanIds": [],
  "balanceYuan": 100.5,
  "balanceWarning": false,
  "degraded": false
}
```

### 2.9 `shell`

```bash
deploydeck shell <instanceId> [--term <term>] [--json]
deploydeck shell <instanceId> -- <command...>
```

两种形态：

| 形态 | 判据 | 需要本地 tty |
|---|---|---|
| 交互 | 没给 `--` 之后的命令 | 是 |
| 非交互 | 给了 `--` 之后的命令 | 否 |

**连接前置校验**（顺序固定，任一步不过都不建立 SSH 连接）：

1. 交互形态先查本地 tty。不是 tty 抛 `INTERACTIVE_TERMINAL_REQUIRED`（退出码 2）。
2. 打开控制台通道并判登录态。未登录抛 `LOGIN_REQUIRED`（退出码 2）。
3. 读实例列表。实例不在列表抛 `INSTANCE_NOT_FOUND`（退出码 1）。
4. 判实例状态。不是运行中抛 `INSTANCE_NOT_RUNNING`（退出码 1）。

**不做的检查**：

- 不校验计划。计划外手工开机的实例照样能连。
- 不读单价、不设定时关机、不写账本、不改执行记录。
- 不自动开机。要连已关机实例，先自己把它开起来。

**会话行为**：

1. 分配 PTY（`$TERM` 由 `--term` 给出，默认 `xterm-256color`）。
2. 窗口尺寸跟随本地终端。本地终端改变尺寸时通知远端。
3. 主机密钥指纹校验规则与 `run` 完全一致：首次记录，变化即 `HOST_KEY_CHANGED`（退出码 2）。
4. 交互形态下远端字节直接写进真实终端，不写进 stdout 抽象。stdin 直接转发给远端。

**退出码**：

| 情况 | 退出码 |
|---|---|
| 会话正常结束 | 远端 shell 的退出码 |
| 非交互形态下远端命令退出码非 0 | 远端退出码（经 `ShellFailedError` 转成 0/1/2 由 `errors.ts` 裁决） |
| 没拿到远端退出码（连接中断等） | 2（`SHELL_FAILED`） |
| 没有本地 tty（交互形态） | 2（`INTERACTIVE_TERMINAL_REQUIRED`） |
| 实例不在运行中 | 1（`INSTANCE_NOT_RUNNING`） |

判据：没拿到退出码不得当 0。远端命令是否执行完未知，必须人工核对。

**`--json` 输出形状**（只与非交互形态一起用）：

```json
{
  "instanceId": "af9c49bd44-8ee624d7",
  "command": "apt-get update",
  "exitCode": 0,
  "transportFailure": null
}
```

判据：交互形态与 `--json` 互斥，同时给出即抛 `SHELL_FAILED`（退出码 2）。

## 3. 例行操作

### 3.1 首次准备

1. 把 `examples/profiles/*.jsonc` 与 `examples/projects/*.jsonc` 复制到配置目录对应子目录。
2. 按实际环境改 Profile 的实例名、规格优先级、时长、预算与克隆源实例名。
3. 执行 `deploydeck login`，在专用 Chrome 窗口里完成登录。
4. 执行 `deploydeck profile list` 确认配置能被解析。

### 3.2 一次部署

```bash
deploydeck plan create --profile asyncproxy-dev
deploydeck run --plan <planId>
deploydeck status
```

### 3.3 收工

```bash
deploydeck teardown <planId>
```

平台定时关机是主要保障（到计划过期时刻自动关机）。`teardown` 是提前收工。
计划过期但实例仍在时，`teardown` 同样可以执行。
`guard` 是计划层兜底：它运行期间，过期计划绑定的实例会被销毁。系统级自启动属 Phase 3，
本期需要人保持 `deploydeck guard` 在跑。

### 3.4 未登录

`run`、`status`、`teardown` 遇到未登录返回 2，且不改动任何实例：

```bash
deploydeck login
deploydeck run --plan <planId>
```

### 3.5 机器读者

```bash
deploydeck status --json | jq '.plans[] | { planId, instanceId, spentYuan }'
```

## 4. 人读输出与机器输出的边界

| 流 | 人读模式 | `--json` 模式 |
|---|---|---|
| stdout | 命令结果 | 唯一一个 JSON 对象（一行） |
| stderr | 进度、日志、错误 | 进度、日志、错误 |

判据：`--json` 模式下 stdout 里不允许出现人读文字。命令实现不得直接写 `process.stdout`。

## 5. 退出码

| 退出码 | 含义 | 例子 |
|---|---|---|
| 0 | 成功 | 命令完成并能读到结果 |
| 1 | 业务失败 | 计划不存在或已过期、脚本失败、预算不足、健康检查失败 |
| 2 | 需要人工 | 配置非法、未登录、克隆超时、实例未确认消失、克隆配额耗尽、命令未实现、没有本地 tty、终端会话丢失退出码 |

错误类自带 `exitCode`（`src/errors.ts`），CLI 只透传，不另建映射表。

### 5.1 错误行格式

`DeploydeckError` 写到 stderr 的行固定是 `<错误码>` 加中文消息：

```text
[PLAN_INVALID] 计划不存在：plan-20261126190100-29b7。请先执行 plan create。
```

判据：错误码在行首方括号里。退出码只有三个值，区分不了具体失败原因，机器读者按错误码分叉。
错误码全集见 `src/errors.ts` 的 `DeploydeckErrorCode`。

`guard` 例外：`escalated` 与控制面降级只记日志，不改变退出码。
参数解析错误（例如缺必填参数）由 commander 抛出，CLI 统一转成退出码 1 并打印可读信息。
未经包装的异常打印 `[UNEXPECTED]` 加消息与栈，退出码 1。
