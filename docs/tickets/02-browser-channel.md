# 02 浏览器通道与登录态

## 目标

deploydeck 能启动并连接到专用 Chrome，能判定登录态，能在未登录时停下。

## 背景

已实测：从 WSL 调 Windows Chrome 加 `--remote-debugging-port`，WSL 侧可连 CDP。JS `.click()` 对 Element Plus 按钮无效，必须用 `Input.dispatchMouseEvent`。

## 范围

1. 启动专用 Chrome：独立 user-data-dir、固定 CDP 端口、目标 URL 可配。
2. 连接 CDP：WebSocket 会话、请求超时、断线后重连一次。
3. 登录态检测：读页面是否出现登录入口。
4. `deploydeck login` 子命令：打开窗口、等待登录完成、打印结果。
5. 未登录时任何控制面动作立即失败，退出码 2。

## 不做

不做账号密码自动登录。不保存任何凭据。

## 验收

1. 冷启动无 Chrome 时，命令能拉起 Chrome 并连上。
2. 未登录时执行控制面动作，退出码 2，错误信息包含「请在专用 Chrome 窗口重新登录」。
3. `login` 子命令在登录完成后 5 秒内返回成功。

## 依赖

无。

## 备注

本机是 WSL 加 Windows Chrome。Linux 与 macOS 下的实现留接口，不在本期验收。
