# 状态目录布局

> 契约来源：[Phase 2 spec](specs/deploydeck-phase2.md) 第 11 节。
> 实现见 `src/state/store.ts`（状态存储）与 `src/state/ledger-store.ts`（账本）。
> 计划与单价缓存的落点见 `src/plan/`。

## 1. 目录分离

| 目录 | 内容 | 谁写 | 默认位置 |
|---|---|---|---|
| 配置目录 | Profile、Project | 人写，机器只读 | `~/.config/deploydeck` |
| 状态目录 | Plan、Run、账本、日志、截图 | 机器写 | `~/.local/state/deploydeck` |

环境变量 `DEPLOYDECK_CONFIG_DIR`、`DEPLOYDECK_STATE_DIR` 可以覆盖默认位置，见 `src/config/paths.ts`。

判据：机器不得改写配置目录里的文件。

## 2. 状态目录结构

```text
<状态目录>/
├── plans/                     计划，一条计划一份
│   └── <planId>.jsonc
├── prices/                    单价缓存，一个部署配置的每种开机形态一份
│   └── <profileId>-<slot>.jsonc  单价、观测时刻、gpuSpec；slot = gpu | no-gpu
├── runs/                      执行记录与现场
│   ├── <runId>.jsonc          执行记录：步骤、命令、退出码、耗时
│   └── <runId>/               本次执行的证据目录
│       ├── logs/              每步的完整命令输出
│       ├── screenshots/       预留：按步骤截图（当前未写入）
│       └── *.png / *.jsonl    控制台动作的截图与动作日志（见 2.1）
├── shell/                     不带 run 的命令证据（见 2.2）
│   └── <instanceId>/
│       └── command.log        `shell -- <命令>` 的完整输出
├── ledger.jsonl               账本，一行一个实例生命周期，只追加
├── ssh-known-hosts.txt        SSH 主机密钥指纹，一行一个端点，可手工删行
├── chrome-profile/            非 WSL 时的专用 Chrome user-data-dir（WSL 下改落 Windows 本地磁盘）
└── locks/                     锁文件，短生命周期，正常释放后消失
    └── <name>.lock
```

| 路径 | 内容 | 写者 |
|---|---|---|
| `plans/<planId>.jsonc` | 计划 | 计划命令（工单 09） |
| `prices/<profileId>-<slot>.jsonc` | 单价缓存：单价、观测时刻、gpuSpec。`slot` 是开机形态，取 `gpu` 或 `no-gpu` | 执行引擎（工单 10） |
| `runs/<runId>.jsonc` | 执行记录 | 执行引擎（工单 10） |
| `runs/<runId>/logs/<stepId>.log` | 一步一份：`health-check` 是 SSH 命令完整输出，控制台动作与内置判定是引擎写的开始与结束记录 | 执行引擎与 SSH 通道（工单 10） |
| `runs/<runId>/screenshots/` | 预留目录；当前没有写入者（见 2.1） | — |
| `shell/<instanceId>/command.log` | `shell -- <命令>` 的完整输出，只覆盖这一形态 | `shell` 命令的非交互形态 |
| `ledger.jsonl` | 账本 | 账本存储（工单 11） |
| `ssh-known-hosts.txt` | SSH 主机密钥指纹 | SSH 通道（工单 07） |
| `chrome-profile/` | 专用 Chrome 的 user-data-dir：控制台登录态与浏览器缓存。仅非 WSL 时使用 | 专用 Chrome 进程 |
| `locks/<name>.lock` | 锁 | 状态存储（工单 11） |

判据：状态存储只接受相对路径。任何相对路径都落在状态目录内。上表是 Phase 2 的约定落点，新增落点必须在本表登记。

单价缓存按开机形态分槽：有卡与无卡单价不同源，同一个槽比较必然被判成漂移。
`slot` 取值只允许 `gpu` 与 `no-gpu`，由 `src/plan/price-cache.ts` 的 `resolvePriceSlot` 给出：
取实例时已知实测形态用实测值，否则用部署配置的 `powerOnMode`。

旧版落点 `prices/<profileId>.jsonc` 不再写入，只在读取 `gpu` 槽时读一次并迁移到新路径，之后删掉旧文件也不影响。

`chrome-profile/` 不落配置目录：浏览器会往里写登录态与缓存，而配置目录由人写、机器只读。

**WSL 下调 Windows Chrome 时，profile 不落状态目录，改落 Windows 本地磁盘。**
原因：Windows Chrome 无法给 `\\wsl.localhost\...` 上的 LevelDB 加锁。
Local Storage 写不进磁盘，而 AutoDL 的登录态正在 Local Storage 里（`token` 与 `user` 两个键）。
后果是每次启动都弹「打开您的个人资料时出了点问题」，且每次都要重新登录。

默认位置 `%LOCALAPPDATA%\deploydeck\chrome-profile`，可用 `DEPLOYDECK_WINDOWS_PROFILE_ROOT` 改根目录。
取值见 `src/config/paths.ts` 的 `resolveChromeProfileDirForChrome`。
WSL 下启动 Chrome 前会校验路径，落 `\\wsl.localhost\` 或 `\\wsl$\` 直接报错。

### 2.1 控制台证据按 run 分目录

CLI 在执行前先定 run id、建 `runs/<runId>/`，再把 provider 的 `logDir` 指到该目录。
控制台动作的前后截图与动作日志（例如 `teardown.jsonl`）因此落在本次 run 目录根下。
单独执行 `teardown` 时，`logDir` 指到绑定该实例那次 run 的目录。

判据：执行引擎的装配自检要求 provider 的 `logDir` 落在本次 run 目录内，否则抛 `ConfigError`
且零控制台动作。反过来，谁在打开 provider 之前没定下 run id，谁就会在第一次执行时拿到这个错误。

`runs/<runId>/screenshots/` 仍由执行记录创建，但当前没有写入者：
`StepResult.screenshotPaths` 恒为空数组，`Provider` 端口没有把截图路径回传的位置。

### 2.2 不带 run 的命令证据目录

命令不只是 `run`。`shell`、`creds`、`tunnel`、`power`、`switch` 都会在控制台上动作或建立连接，
它们各自产出截图与动作日志。

判据：**不带 run 的命令，证据目录一律 `<状态目录>/<命令名>/<instanceId>/`。**

```text
<状态目录>/
├── shell/<instanceId>/     终端命令的完整输出（command.log，只覆盖 `shell -- <命令>` 形态）
├── creds/<instanceId>/     取凭据时的控制台截图与动作日志
├── tunnel/<instanceId>/    建端口转发时的控制台证据
├── power/<instanceId>/     开机与关机动作的截图与动作日志
├── switch/<instanceId>/    切换开机形态的截图与动作日志
└── runs/<runId>/           一次 run 执行的全部现场（只有这一种）
```

`runs/` 下**只允许有 `<runId>` 一级目录**。它是「一次 `run` 执行的全部现场」的唯一落点。
命令证据塞进 `runs/` 会让这条判据失去意义：事后按 `runs/<runId>` 找不到的东西，
就不知道该去哪找。新增命令要写证据时，按 `<命令名>/<instanceId>/` 建目录，不要进 `runs/`。

判据：不要声称 `runs/<runId>/screenshots/` 已经有内容。

## 3. 文件格式

| 扩展名 | 格式 | 读 | 写 |
|---|---|---|---|
| `.jsonc` | JSONC | 容忍注释与尾逗号 | 输出不带注释的 JSON |
| `.jsonl` | 一行一条 JSON | 严格 JSON，逐行按 schema 校验，空行忽略 | 只在尾部追加一行 |

判据：状态文件只供阅读。人工修改通过命令完成。

### 3.1 人工注释会在机器重写时丢失

判据：机器重写状态文件时不再保留人工注释。状态文件只供阅读，人工修改通过命令完成。

具体行为：

1. 读取时容忍人工注释与尾逗号。
2. 写入时重写整个文件，注释、空行与手工调整的格式全部丢失。
3. 手工改动如果破坏了结构或不符合 schema，读取抛 `StateFileInvalidError`，不会静默跳过。

因此不要手工编辑状态文件。需要改状态时用命令。

例外是 `ssh-known-hosts.txt`：它的设计目标就是让人能手工删一行。见 3.2 节。

### 3.2 ssh-known-hosts.txt

主机密钥指纹记录。一行一个 SSH 端点，字段以制表符分隔。

| 序号 | 字段 | 含义 |
|---|---|---|
| 1 | 主机 | 例如 `region-xx.autodl.com` |
| 2 | 端口 | 实例的 SSH 端口 |
| 3 | 指纹 | 主机公钥的 sha256，OpenSSH 写法 `SHA256:...` |
| 4 | 实例 ID | 便于人核对是哪台实例 |
| 5 | 首次记录时刻 | 北京时间 ISO 串 |

以 `#` 开头的行是注释。端点没有记录时机器追加一行；已有记录且指纹一致时放行；指纹不一致抛 `HostKeyChangedError`，退出码 2，不自动更新。

判据：删除某一行即让该端点按首次连接重新记录。落点由 `resolveKnownHostsPath` 给出（`src/config/paths.ts`）。

## 4. 原子写与锁

### 4.1 原子写

```mermaid
flowchart LR
  A[取得锁] --> B[同目录写临时文件]
  B --> C[fsync 文件]
  C --> D[rename 覆盖目标]
  D --> E[尽力 fsync 目录]
  E --> F[释放锁]
```

判据：并发读写时，读到的文件要么是完整的旧版本，要么是完整的新版本，不会读到半个文件。

临时文件名以 `.` 开头、以 `.tmp` 结尾。进程崩溃可能留下临时文件，可以安全删除。

### 4.2 锁

| 项 | 约定 |
|---|---|
| 落点 | `<状态目录>/locks/<name>.lock` |
| 创建 | `O_EXCL` 独占创建（Node 的 `writeFile` 加 `wx`）。创建与占用是同一个原子动作 |
| 等待 | 拿不到锁按 `lockRetryIntervalMs` 重试，直到 `lockTimeoutMs` |
| 超时 | 抛 `StateLockTimeoutError`，退出码 2 |
| 释放 | 锁内动作抛错也释放。锁文件已被删除时释放视为成功 |
| 崩溃 | 进程崩溃会留下锁文件。错误信息给出锁文件路径与持有者进程号；确认没有其它 deploydeck 进程在运行后删除它 |

判据：写状态必须走「临时文件加改名」的原子写，并持有锁文件。读状态不需要加锁。

多步读改写必须整段包在 `withLock` 内。存储层不替调用方猜锁名：哪些动作互斥由业务决定。

### 4.3 参数必须显式

`createStateStore` 要求显式给出 `lockTimeoutMs` 与 `lockRetryIntervalMs`。两者都是并发参数，存储层不设默认值。

## 5. 账本

1. 落点 `ledger.jsonl`，一行一个实例生命周期。
2. 字段由 `LedgerEntrySchema` 定义（`src/state/ledger.ts`），含义见 spec 第 11.4 节。
3. 只追加，不重写。旧行一字不改。
4. 读回时逐行按 schema 校验。任意一行非法即报错并指出行号，不跳过。
5. 单行内禁止注释：JSONL 按行解析，一行必须是一条完整 JSON。
6. 时刻字段是北京时间 ISO 串（带 `+08:00` 后缀），由写入方生成。
7. 账本封口一行后，把该行金额记回 `plan.spentYuan`（见 [计划、预算与关机](plan-and-budget.md) 第 7.1 节）。
   同一实例生命周期只写一行，重复执行 `teardown` 不重复记账。

## 6. 配置目录保护

1. `resolve` 只接受相对路径。绝对路径或含 `..` 一律抛 `ConfigError`。
2. 任何落在配置目录内的路径一律抛 `ConfigError`，信息说明「配置目录由人写，机器只读」。
3. 状态目录不得位于配置目录内。构造状态存储时即拒绝。

判据：机器不得改写配置目录里的文件。

## 7. 错误与退出码

| 错误 | 代码 | 退出码 | 触发条件 |
|---|---|---|---|
| `StateFileMissingError` | `STATE_FILE_MISSING` | 1 | 读的状态文件不存在 |
| `StateFileInvalidError` | `STATE_FILE_INVALID` | 2 | 文件不是合法 JSONC，或内容不符合 schema |
| `StateLockTimeoutError` | `STATE_LOCK_TIMEOUT` | 2 | 取锁等待超过上限 |
| `ConfigError` | `CONFIG_INVALID` | 2 | 路径越界、写配置目录、参数非法 |

读不存在的文件不返回空值：空账本与账本文件丢失必须能区分。

落法：账本存储的 `readSnapshot` 返回 `{ status: 'missing' }` 或
`{ status: 'present', entries }`，不把缺失翻译成空数组。`status` 的 JSON 输出里有同名
`ledger.status` 字段；`teardown` 在「账本丢失但计划已有 spentYuan」时拒绝结算，
避免重复记账。

## 8. 跨进程压测

`scripts/state-store-stress.ts` 手动运行，不进自动测试：

```bash
./node_modules/.bin/tsx scripts/state-store-stress.ts
```

两个子进程共享同一状态目录，各写 100 次。跑完校验：计数器无丢写、账本行数与唯一性、运行记录完整性、临时文件与锁无残留。任一项不符即退出码 1，并保留状态目录供人工查看。
