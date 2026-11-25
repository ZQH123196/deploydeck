# 01 控制台探针

## 目标

把控制台里尚未实测的交互点探明，产出选择器清单与流程截图。

## 背景

Phase 2 的控制面全部依赖 AutoDL 控制台 DOM。已实测：实例列表、更多菜单、定时关机对话框、CDP 点击。未实测：克隆选主机页面、SSH 登录列展开、定时关机时间输入控件。

## 范围

1. 从一台已关机实例进入克隆流程，走到选主机页面，不点最终确认。记录页面 URL、可选主机列表、规格展示字段、地区字段。
2. 展开 SSH 登录列，记录登录指令与密码的呈现方式、是否需要复制按钮。
3. 在定时关机对话框里填入一个时间，记录「预计消费」的显示位置与刷新时机。填完按取消。
4. 记录每个交互点用到的 CSS 选择器。
5. 全部截图落盘，路径写进本 ticket 的产出说明。

## 不做

不改任何实例状态。不完成克隆。不设置定时关机。

## 验收

1. 产出 `docs/refs/autodl/console-selectors.md`，逐条列出选择器与作用。
2. 产出克隆流程、SSH 列、定时关机对话框三组截图。
3. 记录「选主机页面的规格与地区字段名」，供 05 号 ticket 使用。

## 依赖

无。

## 产出

- 选择器与交互清单：`docs/refs/autodl/console-selectors.md`
- 选择器常量：`src/console/selectors.ts`
- 页内脚本构造工具：`src/console/dom.ts`
- 截图目录：`docs/refs/autodl/screenshots/`
  - `instance-list.png`：实例列表页
  - `more-menu.png`：「更多」下拉菜单
  - `timed-shutdown-dialog.png`：定时关机对话框（已填时间，显示预计消费）
  - `clone-dialog.png`：克隆实例对话框
  - `clone-host-page.png`：选主机页
- 平台事实补充：`docs/refs/autodl/facts.md` 第 11 节

实测日期 2026-11-25。未实测项（SSH 登录列展开、开机、设置定时关机、
克隆创建、释放）在清单第 4 节逐条列出原因。
