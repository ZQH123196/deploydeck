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
申请计划 → 创建容器 → 部署 → 验证 → 销毁容器 → 确认容器消失
```

每一步都留日志。容器销毁后，日志仍然在本机。

## 当前状态

骨架阶段。

| 能力 | 状态 |
|---|---|
| 部署清单与 Profile 校验 | 可用 |
| `profile list` | 可用 |
| `plan create` / `plan show` / `plan extend` | 未实现 |
| `run` 部署执行 | 未实现 |
| `teardown` 销毁与终态验证 | 未实现 |
| AutoDL provider | 只有能力声明，未接入 API |
| local provider | 只有能力声明 |

未实现的命令打印 `[NOT IMPLEMENTED]`，退出码 2。

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
| `DEPLOYDECK_CONFIG_DIR` | `~/.config/deploydeck` | 存放 profiles |
| `DEPLOYDECK_STATE_DIR` | `~/.local/state/deploydeck` | 存放计划、运行记录、账本、日志 |

仓库里的 `examples/` 是一份配置样例。把它复制到配置目录后即可被识别。

## 分层

| 层 | 职责 | 是否知道 AI 存在 |
|---|---|---|
| L1 领域模型 | 定义 Profile、Project、Plan、Run 的形状 | 否 |
| L2 provider | 在某类资源上创建、执行、销毁 | 否 |
| L3 计划与预算 | 有效期、预算上限、三重关机 | 否 |
| L4 执行引擎 | 步骤编排、失败语义、终态验证 | 否 |
| L5 命令服务 | 唯一入口，人机共用 | 否 |
| L6 界面与 Agent | CLI、TUI、Web、Agent 接入 | 是 |

详细判据见 [docs/architecture.md](docs/architecture.md)。

## 文档

- [Phase 2 spec](docs/specs/deploydeck-phase2.md) —— 本期的设计与验收标准
- [施工工单](docs/tickets/) —— 按依赖序编号
- [AutoDL 文档快照](docs/refs/autodl/) —— 离线可查的平台口径
- [术语表](GLOSSARY.md)
- [架构与分层判据](docs/architecture.md)
- [provider 能力契约](docs/provider-contract.md)
- [计划、预算与关机](docs/plan-and-budget.md)

## 退出码

| 退出码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 业务失败。部署失败、计划无效、预算不足 |
| 2 | 需要人工介入。配置错误、未实现、容器未确认消失 |

## License

MIT
