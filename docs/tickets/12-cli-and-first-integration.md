# 12 CLI 命令面与首批接入

## 目标

给出稳定的命令面，并用一个真实项目跑通全链路。

## 背景

CLI 是唯一稳定接口。TUI、Web、Agent 都调用同一批命令。首批接入选 asyncProxyServer：它无外部资产、无凭据、无端口冲突。

## 范围

1. 命令面：`profile list`、`plan create`、`plan show`、`run`、`status`、`teardown`、`login`。
2. 每条命令支持 `--json`，退出码符合 spec 第 12 节。
3. `asyncProxyServer` 的部署配置与项目清单样例。
4. 端到端验证：克隆或开机 → SSH 部署 → 健康检查 → 设定时关机，全流程留日志。

## 不做

不做 `plan extend`、`ledger`、`guard`。它们属于 Phase 3。

## 验收

1. `run --profile asyncproxy-dev --json` 输出机器可读结果，含实例 ID、单价、步骤列表。
2. 真机跑一次，服务起来并健康检查通过。
3. 部署后控制台该实例已设置定时关机。

## 依赖

01 至 11。

## 备注

真机验证由人发起。它会产生费用。
